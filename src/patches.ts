import type { Addition, Milestone, NewMilestone, NewSlice, NewTask, ShipState, Slice, Task, WorkOrigin } from "./types.ts";
import { strings, tasks, terminal } from "./model.ts";

export function record(x: unknown): asserts x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Expected an object");
}
export function exact(x: Record<string, unknown>, keys: string[]) {
  if (Object.keys(x).some(k => !keys.includes(k))) throw new Error("Unsupported proposal field");
}
export function text(x: unknown, name: string, limit = 20_000): asserts x is string {
  if (typeof x !== "string" || !x.trim() || x.length > limit) throw new Error(`Invalid ${name}`);
}
export function nodeId(x: unknown, prefix: string): asserts x is string {
  if (typeof x !== "string" || !new RegExp(`^${prefix}[0-9]{2,}$`).test(x) || x.length > 12) throw new Error(`Invalid ${prefix} ID`);
}
export function newTask(x: unknown): NewTask {
  record(x); exact(x, ["id", "title", "goal", "acceptance", "verificationCommands", "dependsOn"]);
  nodeId(x.id, "T"); text(x.title, "task title", 1000); text(x.goal, "goal");
  strings(x.acceptance, "acceptance", true); strings(x.verificationCommands, "verificationCommands", true);
  for (const list of [x.acceptance, x.verificationCommands]) {
    if (list.length > 20) throw new Error("Too many acceptance checks");
    for (const line of list) text(line, "acceptance check", 8000);
  }
  if (x.dependsOn !== undefined) strings(x.dependsOn, "dependsOn");
  return { id: x.id, title: x.title, goal: x.goal, acceptance: [...x.acceptance], verificationCommands: [...x.verificationCommands], ...(x.dependsOn === undefined ? {} : { dependsOn: [...x.dependsOn] }) };
}
export function newSlice(x: unknown): NewSlice {
  record(x); exact(x, ["id", "title", "tasks"]); nodeId(x.id, "S"); text(x.title, "slice title", 1000);
  if (!Array.isArray(x.tasks) || !x.tasks.length || x.tasks.length > 10) throw new Error("A new slice needs 1–10 tasks");
  return { id: x.id, title: x.title, tasks: x.tasks.map(newTask) };
}
export function newMilestone(x: unknown): NewMilestone {
  record(x); exact(x, ["id", "title", "outcome", "slices"]); nodeId(x.id, "M"); text(x.title, "milestone title", 1000); text(x.outcome, "outcome");
  if (!Array.isArray(x.slices) || !x.slices.length || x.slices.length > 5) throw new Error("A new milestone needs 1–5 slices");
  return { id: x.id, title: x.title, outcome: x.outcome, slices: x.slices.map(newSlice) };
}
export function addition(x: unknown): Addition {
  record(x);
  if (x.after !== null) text(x.after, "insertion anchor", 12);
  const after = x.after as string | null;
  if (x.type === "ADD_TASK") {
    exact(x, ["type", "parent", "after", "task"]); text(x.parent, "parent", 25);
    return { type: x.type, parent: x.parent, after, task: newTask(x.task) };
  }
  if (x.type === "ADD_SLICE") {
    exact(x, ["type", "parent", "after", "slice"]); text(x.parent, "parent", 12);
    return { type: x.type, parent: x.parent, after, slice: newSlice(x.slice) };
  }
  if (x.type === "ADD_MILESTONE") {
    exact(x, ["type", "after", "milestone"]);
    return { type: x.type, after, milestone: newMilestone(x.milestone) };
  }
  throw new Error("Only ADD_TASK, ADD_SLICE, and ADD_MILESTONE are supported");
}
export function insert<T extends { id: string }>(items: T[], node: T, after: string | null) {
  if (items.some(x => x.id === node.id)) throw new Error(`Duplicate ID: ${node.id}`);
  const anchor = after === null ? -1 : items.findIndex(x => x.id === after);
  if (after !== null && anchor < 0) throw new Error(`Missing insertion anchor: ${after}`);
  items.splice(anchor + 1, 0, node);
}
export function addToRoadmap(s: ShipState, patch: Addition, origin: WorkOrigin): Milestone[] {
  if (s.activeAttempt) throw new Error("Wait for active attempt reconciliation before changing the roadmap");
  const copy = structuredClone(s.milestones);
  const task = (n: NewTask): Task => ({ ...structuredClone(n), status: "pending", attempts: 0, requestedBy: origin });
  const slice = (n: NewSlice): Slice => ({ id: n.id, title: n.title, status: "pending", tasks: n.tasks.map(task), requestedBy: origin });
  if (patch.type === "ADD_TASK") {
    const [mid, sid, extra] = patch.parent.split("/");
    const m = copy.find(x => x.id === mid), parent = m?.slices.find(x => x.id === sid);
    if (!parent || extra !== undefined) throw new Error("Missing parent slice");
    if (parent.tasks.every(t => terminal(t))) throw new Error("Completed slice is history; add a follow-up slice or milestone");
    insert(parent.tasks, task(patch.task), patch.after);
  } else if (patch.type === "ADD_SLICE") {
    const parent = copy.find(x => x.id === patch.parent);
    if (!parent) throw new Error("Missing parent milestone");
    if (parent.slices.every(x => x.tasks.every(t => terminal(t)))) throw new Error("Completed milestone is history; add a follow-up milestone");
    insert(parent.slices, slice(patch.slice), patch.after);
  } else {
    insert(copy, { id: patch.milestone.id, title: patch.milestone.title, outcome: patch.milestone.outcome, status: "pending", slices: patch.milestone.slices.map(slice), requestedBy: origin }, patch.after);
  }
  const existing = new Set(tasks(s).map(x => x.key));
  let sawNew = false;
  for (const entry of tasks({ ...s, milestones: copy })) {
    if (!existing.has(entry.key)) sawNew = true;
    else if (sawNew && (entry.t.attempts > 0 || entry.t.status !== "pending")) throw new Error("Cannot insert before started or completed work");
  }
  return copy;
}
