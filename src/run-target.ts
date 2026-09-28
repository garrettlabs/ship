import type { Milestone, RunTarget, ShipState } from "./types.ts";

export interface RunTargetRequest { scope: "task" | "slice" | "milestone" | "all"; id?: string; }

const keyFor = (milestone: Milestone, slice: Milestone["slices"][number], task: Milestone["slices"][number]["tasks"][number]) =>
  `${milestone.id}/${slice.id}/${task.id}`;
const terminal = (status: string) => ["passed", "deferred", "cancelled", "superseded"].includes(status);

/** Resolve against the approved roadmap, freezing both membership and revision. */
export function resolveRunTarget(state: ShipState, request?: RunTargetRequest): RunTarget {
  if (request && (!["task", "slice", "milestone", "all"].includes(request.scope) ||
      (request.id !== undefined && (typeof request.id !== "string" || !request.id.trim())) ||
      (request.scope === "all" && request.id !== undefined))) throw new Error("Invalid run target request");
  if (request?.scope === "all") return { scope: "all", revision: state.roadmapRevision,
    keys: state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => keyFor(m, s, t)))) };
  const scope = request?.scope ?? "milestone";
  if (!state.milestones.length) {
    if (scope !== "milestone" || request?.id) throw new Error("Run target does not exist in the approved roadmap");
    return { scope: "milestone", revision: state.roadmapRevision, keys: [] };
  }
  if (scope === "milestone") {
    const index = request?.id ? state.milestones.findIndex(m => m.id === request.id) :
      state.milestones.findIndex(m => m.slices.some(s => s.tasks.some(t => !terminal(t.status))));
    if (index < 0 && !request?.id) return { scope: "all", revision: state.roadmapRevision,
      keys: state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => keyFor(m, s, t)))) };
    if (index < 0) throw new Error(`Run target milestone ${request!.id} does not exist`);
    // An explicit future milestone is a bounded prefix: earlier unfinished milestones are prerequisites.
    const milestones = state.milestones.slice(0, index + 1);
    return { scope, id: state.milestones[index].id, revision: state.roadmapRevision,
      keys: milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => keyFor(m, s, t)))) };
  }
  const candidates = state.milestones.flatMap(m => m.slices.flatMap(s =>
    scope === "slice" ? [{ id: s.id, key: `${m.id}/${s.id}`, keys: s.tasks.map(t => keyFor(m, s, t)),
      incomplete: s.tasks.some(t => !terminal(t.status)) }] :
      s.tasks.map(t => ({ id: t.id, key: keyFor(m, s, t), keys: [keyFor(m, s, t)], incomplete: !terminal(t.status) }))));
  const candidate = request?.id ? candidates.find(c => c.id === request.id || c.key === request.id) :
    candidates.find(c => c.incomplete);
  if (!candidate || (request?.id && candidates.filter(c => c.id === request.id || c.key === request.id).length !== 1))
    throw new Error(`Run target ${scope} ${request?.id ?? "next"} is unknown or ambiguous; use its full roadmap key`);
  return { scope, id: candidate.key, revision: state.roadmapRevision, keys: candidate.keys };
}

/** This predicate never treats a dependency outside the selected scope as permission to dispatch it. */
export function targetContains(target: RunTarget, key: string): boolean { return target.keys.includes(key); }
/** Only an explicitly approved roadmap edit may rebase membership; a vanished endpoint stays stale. */
export function reconcileRunTarget(state: ShipState, target: RunTarget): RunTarget {
  if (!state.milestones.length) return target;
  try {
    const updated = resolveRunTarget(state, { scope: target.scope, id: target.id });
    // An exact task cannot silently follow a split, and a milestone prefix cannot
    // absorb a newly inserted milestone merely because it precedes the endpoint.
    if (target.scope === "task" && updated.keys[0] !== target.keys[0]) return target;
    if (target.scope === "milestone") {
      const selectedMilestones = new Set(target.keys.map(key => key.split("/")[0]));
      if (updated.keys.some(key => !selectedMilestones.has(key.split("/")[0]))) return target;
    }
    return updated;
  } catch {
    return target;
  }
}

export function targetProgress(state: ShipState, target: RunTarget): { complete: boolean; remaining: string[]; invalid?: string } {
  if (target.revision !== state.roadmapRevision) return { complete: false, remaining: target.keys,
    invalid: "Run target roadmap revision changed; select a new target explicitly" };
  if (!target.keys.length) return { complete: false, remaining: [],
    invalid: state.milestones.length ? "Run target has no approved tasks" : undefined };
  const known = new Map(state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => [keyFor(m, s, t), t] as const))));
  const missing = target.keys.find(key => !known.has(key));
  if (missing) return { complete: false, remaining: target.keys,
    invalid: `Run target task ${missing} was removed from the approved roadmap` };
  const current = resolveRunTarget(state, { scope: target.scope, id: target.id });
  if (current.keys.length !== target.keys.length || current.keys.some((key, index) => key !== target.keys[index]))
    return { complete: false, remaining: target.keys, invalid: "Run target membership changed; select a new target explicitly" };
  const remaining = target.keys.filter(key => known.get(key)!.status !== "passed");
  return { complete: remaining.length === 0, remaining };
}
