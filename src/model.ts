import type { Milestone, RepoCheck, Review, RoadmapEdit, ShipState, Task, TaskType, TaskUncertainty } from "./types.ts";
import { classifyTask } from "./task-classification.ts";
import { routeTask } from "./role-router.ts";
import { DependencyGraph } from "./dependency-graph.ts";
import { routeVerification } from "./verification.ts";

function object(x: unknown): asserts x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Expected an object");
}
function text(x: unknown, name: string): asserts x is string {
  if (typeof x !== "string" || !x.trim() || x.length > 24_000) throw new Error(`Invalid ${name}`);
}
export function strings(x: unknown, name: string, nonempty = false): asserts x is string[] {
  if (!Array.isArray(x) || (nonempty && !x.length) || x.some(v => typeof v !== "string" || !v.trim())) throw new Error(`Invalid ${name}`);
}
function id(x: unknown, prefix: string) { if (typeof x !== "string" || !new RegExp(`^${prefix}[0-9]{2,}$`).test(x)) throw new Error(`Invalid ${prefix} ID`); }
function unique(items: { id: string }[]) { if (new Set(items.map(x => x.id)).size !== items.length) throw new Error("Duplicate ID"); }
const taskTypes: TaskType[] = ["reconnaissance", "planning-design", "implementation", "bugfix", "refactor", "test", "documentation", "migration", "integration", "review", "research", "configuration", "security-review"];
const uncertainties: TaskUncertainty[] = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"];
const statuses = ["pending", "running", "verifying", "passed", "failed", "blocked"];
function optionalStrings(x: unknown, name: string): asserts x is string[] | undefined { if (x !== undefined) strings(x, name); }
function taskMetadata(task: Record<string, unknown>, fromPlan: boolean, repoChecks: readonly RepoCheck[] = []): Task {
  object(task); id(task.id, "T"); text(task.title, "task title"); text(task.goal, "goal");
  strings(task.acceptance, "acceptance", true); strings(task.verificationCommands, "verificationCommands", true);
  if (fromPlan && ["status", "attempts", "lastError", "complexity", "risk", "classificationSignals", "classificationRationale", "parallelEligible", "executionRoute", "execution", "verificationPlan"].some(key => key in task)) throw new Error("Planner cannot override task lifecycle or classification");
  if (task.objective !== undefined) text(task.objective, "objective");
  optionalStrings(task.dependencies, "dependencies"); optionalStrings(task.affectedDomains, "affectedDomains");
  optionalStrings(task.affectedFiles, "affectedFiles"); optionalStrings(task.verificationRequirements, "verificationRequirements");
  if (task.taskType !== undefined && !taskTypes.includes(task.taskType as TaskType)) throw new Error("Invalid taskType");
  if (task.uncertainty !== undefined && !uncertainties.includes(task.uncertainty as TaskUncertainty)) throw new Error("Invalid uncertainty");
  const normalized = {
    ...task,
    objective: task.objective ?? task.goal,
    dependencies: task.dependencies ?? [],
    affectedDomains: task.affectedDomains ?? [],
    affectedFiles: task.affectedFiles ?? [],
    taskType: task.taskType ?? "implementation",
    uncertainty: task.uncertainty ?? "UNKNOWN",
    verificationRequirements: task.verificationRequirements ?? task.acceptance,
  } as unknown as Task;
  strings(normalized.verificationRequirements, "verificationRequirements", true);
  const classification = classifyTask(normalized);
  const computed = {
    complexity: classification.complexity, risk: classification.risk,
    classificationSignals: classification.signals, classificationRationale: classification.rationale,
    parallelEligible: classification.parallelEligible, executionRoute: classification.executionRoute,
    execution: routeTask({ ...normalized, complexity: classification.complexity, risk: classification.risk }),
    verificationPlan: routeVerification({ ...normalized, complexity: classification.complexity, risk: classification.risk }, repoChecks),
  };
  for (const key of Object.keys(computed) as (keyof typeof computed)[]) {
    if (!fromPlan && task[key] !== undefined && JSON.stringify(task[key]) !== JSON.stringify(computed[key])) throw new Error(`Invalid persisted ${key}`);
  }
  return { ...normalized, ...computed };
}

export function normalizePlan(value: unknown, fromPlan = false, repoChecks: readonly RepoCheck[] = []): Milestone[] {
  if (!Array.isArray(value)) throw new Error("Expected milestones");
  const normalized = value.map(m => {
    object(m);
    if (fromPlan && "status" in m) throw new Error("Planner cannot override milestone status");
    if (!Array.isArray(m.slices)) throw new Error("Milestone needs slices");
    return { ...m, status: fromPlan ? "pending" : m.status, slices: m.slices.map(s => {
      object(s);
      if (fromPlan && "status" in s) throw new Error("Planner cannot override slice status");
      if (!Array.isArray(s.tasks)) throw new Error("Slice needs tasks");
      return { ...s, status: fromPlan ? "pending" : s.status, tasks: s.tasks.map(t => {
        object(t);
        return taskMetadata(t, fromPlan, repoChecks);
      }) };
    }) };
  }) as Milestone[];
  if (fromPlan) for (const m of normalized) for (const s of m.slices) for (const t of s.tasks) { t.status = "pending"; t.attempts = 0; }
  validatePlan(normalized);
  if (!fromPlan) for (const m of normalized) {
    if (!["pending", "active", "complete"].includes(m.status)) throw new Error("Invalid milestone status");
    for (const s of m.slices) {
      if (!["pending", "active", "complete"].includes(s.status)) throw new Error("Invalid slice status");
      for (const t of s.tasks) if (!statuses.includes(t.status) || !Number.isSafeInteger(t.attempts) || t.attempts < 0) throw new Error("Invalid task state");
    }
  }
  return normalized;
}

export function validatePlan(value: unknown): asserts value is Milestone[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new Error("Expected 1–20 milestones");
  let tasks = 0;
  for (const m of value) {
    object(m); id(m.id, "M"); text(m.title, "milestone title"); text(m.outcome, "outcome");
    if (!Array.isArray(m.slices) || !m.slices.length) throw new Error("Milestone needs slices");
    for (const s of m.slices) {
      object(s); id(s.id, "S"); text(s.title, "slice title");
      if (!Array.isArray(s.tasks) || !s.tasks.length) throw new Error("Slice needs tasks");
      for (const t of s.tasks) {
        object(t); id(t.id, "T"); text(t.title, "task title"); text(t.goal, "goal"); text(t.objective, "objective");
        strings(t.acceptance, "acceptance", true); strings(t.verificationCommands, "verificationCommands", true);
        strings(t.dependencies, "dependencies"); strings(t.affectedDomains, "affectedDomains"); strings(t.affectedFiles, "affectedFiles"); strings(t.verificationRequirements, "verificationRequirements", true);
        if (!taskTypes.includes(t.taskType as TaskType) || !uncertainties.includes(t.uncertainty as TaskUncertainty)) throw new Error("Invalid task metadata");
        if (++tasks > 200) throw new Error("Plan exceeds 200 tasks; reduce scope");
      }
      unique(s.tasks as Task[]);
    }
    unique(m.slices as Milestone["slices"]);
  }
  unique(value);
  new DependencyGraph(value);
}
export function parsePlan(output: string, repoChecks: readonly RepoCheck[] = []): Milestone[] {
  const raw: unknown = JSON.parse(output.trim()); object(raw);
  return normalizePlan(raw.milestones, true, repoChecks);
}
export function tasks(state: ShipState) {
  return state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => ({ m, s, t, key: `${m.id}/${s.id}/${t.id}`, slice: `${m.id}/${s.id}` }))));
}
export function applyRoadmapEdit(state: ShipState, edit: RoadmapEdit): void {
  if (!state.milestones.length) throw new Error("Roadmap has not been loaded");
  if (!Number.isSafeInteger(edit.revision) || edit.revision < 0 || edit.revision !== state.roadmapRevision) throw new Error(`Stale roadmap revision: requested ${edit.revision}, current ${state.roadmapRevision}`);
  if (state.activeAttempt) throw new Error("Cannot edit roadmap during an active attempt");
  // Work against a detached plan: validation failures cannot leave half an edit in memory.
  const plan = structuredClone(state.milestones);
  if (edit.type === "add") {
    const match = /^([^/]+)\/([^/]+)$/.exec(edit.slice);
    const slice = match && plan.find(m => m.id === match[1])?.slices.find(s => s.id === match[2]);
    if (!slice) throw new Error(`Unknown slice: ${edit.slice}`);
    const next = Math.max(0, ...slice.tasks.map(t => Number(t.id.slice(1)))) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Task ID limit exceeded");
    slice.tasks.push(taskMetadata({ id: `T${String(next).padStart(2, "0")}`, title: edit.title, goal: edit.goal, acceptance: [edit.acceptance], verificationCommands: [edit.check] }, true, state.repoChecks));
    const added = slice.tasks[slice.tasks.length - 1]; added.status = "pending"; added.attempts = 0;
  } else {
    const entry = plan.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => ({ key: `${m.id}/${s.id}/${t.id}`, t })))).find(x => x.key === edit.task);
    if (!entry) throw new Error(`Unknown task: ${edit.task}`);
    if (entry.t.status !== "pending" || entry.t.attempts !== 0) throw new Error(`Task ${edit.task} has already started`);
    Object.assign(entry.t, taskMetadata({ ...entry.t, goal: edit.goal, complexity: undefined, risk: undefined, classificationSignals: undefined, classificationRationale: undefined, parallelEligible: undefined, executionRoute: undefined, execution: undefined, verificationPlan: undefined }, false, state.repoChecks));
  }
  validatePlan(plan);
  state.milestones = plan;
  state.roadmapRevision++;
  if (edit.type === "add") {
    state.reviewedSlices = (state.reviewedSlices ?? []).filter(key => key !== edit.slice);
    if (state.phase === "complete") state.phase = "idle";
  }
}
export function refresh(state: ShipState): void {
  for (const m of state.milestones) {
    for (const s of m.slices) s.status = s.tasks.every(t => t.status === "passed") ? "complete" : s.tasks.some(t => t.attempts > 0) ? "active" : "pending";
    m.status = m.slices.every(s => s.status === "complete") ? "complete" : m.slices.some(s => s.status !== "pending") ? "active" : "pending";
  }
}
export function applyReview(state: ShipState, output: string, source: string): Review {
  const raw: unknown = JSON.parse(output); object(raw);
  if (raw.revision !== state.roadmapRevision) throw new Error("Stale roadmap revision");
  text(raw.rationale, "review rationale");
  if (!Array.isArray(raw.changes) || !Array.isArray(raw.lessons) || raw.lessons.length > 10 || raw.changes.length > 20) throw new Error("Invalid review collections");
  const seen = new Set<string>();
  for (const c of raw.changes) {
    object(c); text(c.task, "task key"); text(c.goal, "goal"); text(c.reason, "reason");
    if (Object.keys(c).some(k => !["task", "goal", "reason"].includes(k))) throw new Error("Review cannot change acceptance, commands, IDs, or status");
    const entry = tasks(state).find(t => t.key === c.task);
    if (!entry || entry.t.status !== "pending" || entry.t.attempts !== 0 || seen.has(c.task)) throw new Error("Review target must be a unique, unstarted task");
    seen.add(c.task);
  }
  for (const l of raw.lessons) {
    object(l); text(l.text, "lesson"); text(l.evidence, "evidence");
    if (!["observation", "decision", "assumption", "lesson"].includes(String(l.kind))) throw new Error("Invalid knowledge kind");
  }
  const review = raw as unknown as Review;
  for (const change of review.changes) {
    const task = tasks(state).find(t => t.key === change.task)!.t;
    Object.assign(task, taskMetadata({ ...task, goal: change.goal, complexity: undefined, risk: undefined, classificationSignals: undefined, classificationRationale: undefined, parallelEligible: undefined, executionRoute: undefined, execution: undefined, verificationPlan: undefined }, false, state.repoChecks));
  }
  state.knowledge ??= [];
  for (const lesson of review.lessons) state.knowledge.push({ ...lesson, id: `K${String(state.knowledge.length + 1).padStart(4, "0")}`, source: "agent", evidence: `${source}: ${lesson.evidence}`, at: new Date().toISOString() });
  if (review.changes.length) state.roadmapRevision++;
  return review;
}
