import type { Milestone, Review, ShipState, Task } from "./types.ts";

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
        object(t); id(t.id, "T"); text(t.title, "task title"); text(t.goal, "goal");
        strings(t.acceptance, "acceptance", true); strings(t.verificationCommands, "verificationCommands", true);
        if (++tasks > 200) throw new Error("Plan exceeds 200 tasks; reduce scope");
      }
      unique(s.tasks as Task[]);
    }
    unique(m.slices as Milestone["slices"]);
  }
  unique(value);
}
export function parsePlan(output: string): Milestone[] {
  const raw: unknown = JSON.parse(output.trim()); object(raw); validatePlan(raw.milestones);
  return raw.milestones.map(m => ({ ...m, status: "pending", slices: m.slices.map(s => ({ ...s, status: "pending", tasks: s.tasks.map(t => ({ ...t, status: "pending", attempts: 0 })) })) }));
}
export function tasks(state: ShipState) {
  return state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => ({ m, s, t, key: `${m.id}/${s.id}/${t.id}`, slice: `${m.id}/${s.id}` }))));
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
  for (const change of review.changes) tasks(state).find(t => t.key === change.task)!.t.goal = change.goal;
  state.knowledge ??= [];
  for (const lesson of review.lessons) state.knowledge.push({ ...lesson, id: `K${String(state.knowledge.length + 1).padStart(4, "0")}`, source: "agent", evidence: `${source}: ${lesson.evidence}`, at: new Date().toISOString() });
  if (review.changes.length) state.roadmapRevision++;
  return review;
}
