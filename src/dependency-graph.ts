import type { Milestone, Task } from "./types.ts";

export interface GraphTask { key: string; task: Task; }
export interface BlockedTask extends GraphTask { failedAncestors: string[]; }

/** A validated snapshot of the plan's dependency edges; task statuses remain live. */
export class DependencyGraph {
  readonly order: GraphTask[];
  readonly levels: GraphTask[][];
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  private readonly byKey: ReadonlyMap<string, GraphTask>;
  private readonly ancestors: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(milestones: readonly Milestone[]) {
    const nodes: GraphTask[] = [];
    const locations: { milestone: string; slice: string }[] = [];
    for (const milestone of milestones) for (const slice of milestone.slices) for (const task of slice.tasks) {
      nodes.push({ key: `${milestone.id}/${slice.id}/${task.id}`, task });
      locations.push({ milestone: milestone.id, slice: slice.id });
    }
    const byKey = new Map(nodes.map(node => [node.key, node]));
    if (byKey.size !== nodes.length) throw new Error("Duplicate task key");
    this.byKey = byKey;
    const dependencies = new Map<string, string[]>();
    const children = new Map(nodes.map(node => [node.key, [] as string[]]));
    const indegree = new Map<string, number>();
    nodes.forEach((node, index) => {
      const resolved: string[] = [];
      for (const reference of node.task.dependencies) {
        const key = reference.includes("/") ? reference : `${locations[index].milestone}/${locations[index].slice}/${reference}`;
        if (!/^M[0-9]{2,}\/S[0-9]{2,}\/T[0-9]{2,}$/.test(key) || !byKey.has(key)) throw new Error(`Missing task dependency: ${reference} for ${node.key}`);
        if (key === node.key) throw new Error(`Self task dependency: ${node.key}`);
        if (resolved.includes(key)) throw new Error(`Duplicate task dependency: ${node.key} references ${key}`);
        resolved.push(key);
        children.get(key)!.push(node.key);
      }
      dependencies.set(node.key, resolved);
      indegree.set(node.key, resolved.length);
    });
    this.dependencies = dependencies;
    const order: GraphTask[] = [];
    const levels = new Map<string, number>();
    // Scan input order at each step, ensuring a stable topological tie-breaker.
    const visited = new Set<string>();
    while (order.length < nodes.length) {
      const node = nodes.find(candidate => !visited.has(candidate.key) && indegree.get(candidate.key) === 0);
      if (!node) {
        const cycle = findCycle(nodes, dependencies, visited);
        throw new Error(`Cyclic task dependency: ${cycle.join(" -> ")}`);
      }
      visited.add(node.key);
      order.push(node);
      levels.set(node.key, Math.max(0, ...dependencies.get(node.key)!.map(dep => levels.get(dep)! + 1)));
      for (const child of children.get(node.key)!) indegree.set(child, indegree.get(child)! - 1);
    }
    this.order = order;
    const grouped: GraphTask[][] = [];
    for (const node of nodes) (grouped[levels.get(node.key)!] ??= []).push(node);
    this.levels = grouped;
    const ancestors = new Map<string, Set<string>>();
    for (const node of order) {
      const previous = new Set<string>();
      for (const dep of dependencies.get(node.key)!) {
        previous.add(dep);
        for (const ancestor of ancestors.get(dep)!) previous.add(ancestor);
      }
      ancestors.set(node.key, previous);
    }
    this.ancestors = ancestors;
  }

  readyTasks(): GraphTask[] {
    return this.order.filter(node => (node.task.status === "pending" || node.task.status === "failed") &&
      this.dependencies.get(node.key)!.every(key => this.byKey.get(key)!.task.status === "passed"));
  }

  blockedTasks(): BlockedTask[] {
    return this.order.flatMap(node => {
      if (node.task.status === "passed") return [];
      const failedAncestors = [...this.ancestors.get(node.key)!].filter(key => this.byKey.get(key)!.task.status === "failed");
      return failedAncestors.length ? [{ ...node, failedAncestors }] : [];
    });
  }

  parallelCandidatePairs(): [GraphTask, GraphTask][] {
    const ready = this.readyTasks();
    const pairs: [GraphTask, GraphTask][] = [];
    for (let i = 0; i < ready.length; i++) for (let j = i + 1; j < ready.length; j++) {
      const left = ready[i], right = ready[j];
      if (this.ancestors.get(left.key)!.has(right.key) || this.ancestors.get(right.key)!.has(left.key)) continue;
      if (safeBoundary(left.task) && safeBoundary(right.task) && disjointOwnership(left.task, right.task)) pairs.push([left, right]);
    }
    return pairs;
  }
}

function findCycle(nodes: GraphTask[], dependencies: ReadonlyMap<string, readonly string[]>, visited: ReadonlySet<string>): string[] {
  const active = new Map<string, number>();
  const done = new Set<string>();
  const route: string[] = [];
  const visit = (key: string): string[] | undefined => {
    const start = active.get(key);
    if (start !== undefined) return [...route.slice(start), key];
    if (done.has(key) || visited.has(key)) return undefined;
    active.set(key, route.length); route.push(key);
    for (const dep of dependencies.get(key)!) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    route.pop(); active.delete(key); done.add(key);
    return undefined;
  };
  for (const node of nodes) {
    const cycle = visit(node.key);
    if (cycle) return cycle;
  }
  return [];
}

function safeBoundary(task: Task): boolean {
  if (task.taskType === "migration" || task.taskType === "integration" || task.risk !== "LOW" || task.uncertainty !== "LOW") return false;
  if (task.classificationSignals.some(signal => ["migration/schema", "persisted data", "destructive operations"].includes(signal))) return false;
  return !/\b(migrat(?:e|ing|ion|ions)|integrat(?:e|ion)|shared[- ]mutable|shared (?:state|data)|database|schema|data pipeline)\b/i.test([task.title, task.objective, task.goal, ...task.affectedDomains].join(" "));
}

function disjointOwnership(left: Task, right: Task): boolean {
  const filesA = left.affectedFiles.map(normalizeOwnership), filesB = right.affectedFiles.map(normalizeOwnership);
  const domainsA = left.affectedDomains.map(normalizeOwnership), domainsB = right.affectedDomains.map(normalizeOwnership);
  if ((!filesA.length && !domainsA.length) || (!filesB.length && !domainsB.length)) return false;
  if ([...filesA, ...filesB, ...domainsA, ...domainsB].some(value => !value || value === "." || value.includes("..") || value.includes("//") || /(^|\/)\.(\/|$)/.test(value) || /[*?{}]/.test(value))) return false;
  // A domain-only declaration cannot rule out collision with another task's file-only scope.
  if ((filesA.length && !filesB.length && !domainsA.length) || (filesB.length && !filesA.length && !domainsB.length)) return false;
  const distinct = (a: string[], b: string[]) => a.every(x => b.every(y => x !== y && !x.startsWith(`${y}/`) && !y.startsWith(`${x}/`)));
  return distinct(filesA, filesB) && distinct(domainsA, domainsB) &&
    !filesA.some(file => domainsB.some(domain => file === domain || file.startsWith(`${domain}/`))) &&
    !filesB.some(file => domainsA.some(domain => file === domain || file.startsWith(`${domain}/`)));
}

function normalizeOwnership(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}
