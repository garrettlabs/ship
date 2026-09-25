import { createHash } from "node:crypto";
import type { Addition, AdditionProposal, InboxMessage, Milestone, NewMilestone, NewSlice, NewTask, ShipState, Slice, Task, WorkOrigin, WorkProposal, WorkRequest } from "./types.ts";
import { refresh, strings, tasks, validatePlan } from "./model.ts";

function record(x: unknown): asserts x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Expected an object");
}
function exact(x: Record<string, unknown>, keys: string[]) {
  if (Object.keys(x).some(k => !keys.includes(k))) throw new Error("Unsupported proposal field; additions cannot edit existing work");
}
function text(x: unknown, name: string, limit = 20_000): asserts x is string {
  if (typeof x !== "string" || !x.trim() || x.length > limit) throw new Error(`Invalid ${name}`);
}
function nodeId(x: unknown, prefix: string): asserts x is string {
  if (typeof x !== "string" || !new RegExp(`^${prefix}[0-9]{2,}$`).test(x) || x.length > 12) throw new Error(`Invalid ${prefix} ID`);
}
function newTask(x: unknown): NewTask {
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
function newSlice(x: unknown): NewSlice {
  record(x); exact(x, ["id", "title", "tasks"]); nodeId(x.id, "S"); text(x.title, "slice title", 1000);
  if (!Array.isArray(x.tasks) || !x.tasks.length || x.tasks.length > 10) throw new Error("A new slice needs 1–10 tasks");
  return { id: x.id, title: x.title, tasks: x.tasks.map(newTask) };
}
function newMilestone(x: unknown): NewMilestone {
  record(x); exact(x, ["id", "title", "outcome", "slices"]); nodeId(x.id, "M"); text(x.title, "milestone title", 1000); text(x.outcome, "outcome");
  if (!Array.isArray(x.slices) || !x.slices.length || x.slices.length > 5) throw new Error("A new milestone needs 1–5 slices");
  return { id: x.id, title: x.title, outcome: x.outcome, slices: x.slices.map(newSlice) };
}
function addition(x: unknown): Addition {
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
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(x);
}
export function proposalId(p: AdditionProposal): string { return `P${createHash("sha256").update(canonical(p)).digest("hex")}`; }
function payload(p: WorkProposal): AdditionProposal { return { revision: p.revision, requestId: p.requestId, rationale: p.rationale, patch: p.patch }; }
function insert<T extends { id: string }>(items: T[], node: T, after: string | null) {
  if (items.some(x => x.id === node.id)) throw new Error(`Duplicate ID: ${node.id}`);
  const anchor = after === null ? -1 : items.findIndex(x => x.id === after);
  if (after !== null && anchor < 0) throw new Error(`Missing insertion anchor: ${after}`);
  items.splice(anchor + 1, 0, node);
}
function proposedRoadmap(s: ShipState, p: AdditionProposal, origin: WorkOrigin): Milestone[] {
  if (s.activeAttempt) throw new Error("Wait for active attempt reconciliation before changing the roadmap");
  if (p.revision !== s.roadmapRevision) throw new Error("Stale roadmap revision; reject and submit a fresh request");
  const copy = structuredClone(s.milestones), patch = p.patch;
  const task = (n: NewTask): Task => ({ ...structuredClone(n), status: "pending", attempts: 0, requestedBy: origin });
  const slice = (n: NewSlice): Slice => ({ id: n.id, title: n.title, status: "pending", tasks: n.tasks.map(task), requestedBy: origin });
  if (patch.type === "ADD_TASK") {
    const [mid, sid, extra] = patch.parent.split("/");
    const m = copy.find(x => x.id === mid), parent = m?.slices.find(x => x.id === sid);
    if (!parent || extra !== undefined) throw new Error("Missing parent slice");
    if (parent.tasks.every(t => t.status === "passed")) throw new Error("Completed slice is history; add a follow-up slice or milestone");
    insert(parent.tasks, task(patch.task), patch.after);
  } else if (patch.type === "ADD_SLICE") {
    const parent = copy.find(x => x.id === patch.parent);
    if (!parent) throw new Error("Missing parent milestone");
    if (parent.slices.every(x => x.tasks.every(t => t.status === "passed"))) throw new Error("Completed milestone is history; add a follow-up milestone");
    insert(parent.slices, slice(patch.slice), patch.after);
  } else {
    insert(copy, { id: patch.milestone.id, title: patch.milestone.title, outcome: patch.milestone.outcome, status: "pending", slices: patch.milestone.slices.map(slice), requestedBy: origin }, patch.after);
  }
  validatePlan(copy);
  const existing = new Set(tasks(s).map(x => x.key));
  let sawNew = false;
  for (const entry of tasks({ ...s, milestones: copy })) {
    if (!existing.has(entry.key)) sawNew = true;
    else if (sawNew && (entry.t.attempts > 0 || entry.t.status !== "pending")) throw new Error("Cannot insert before started or completed work");
  }
  return copy;
}
export function parseWorkProposal(s: ShipState, request: WorkRequest, output: string): WorkProposal | { conflict: string } {
  if (output.length > 128_000) throw new Error("Proposal exceeds 128,000 characters");
  const raw: unknown = JSON.parse(output); record(raw);
  if (raw.revision !== s.roadmapRevision || raw.requestId !== request.id) throw new Error("Stale revision or mismatched request ID");
  if ("conflict" in raw) { exact(raw, ["revision", "requestId", "conflict"]); text(raw.conflict, "conflict"); return { conflict: raw.conflict }; }
  exact(raw, ["revision", "requestId", "rationale", "patch"]); text(raw.rationale, "rationale");
  const p: AdditionProposal = { revision: s.roadmapRevision, requestId: request.id, rationale: raw.rationale, patch: addition(raw.patch) };
  const id = proposalId(p);
  proposedRoadmap(s, p, { source: "user", requestId: request.id, proposalId: id });
  return { ...p, id };
}
export function applyWorkProposal(s: ShipState, request: WorkRequest): void {
  const p = request.proposal;
  if (request.status !== "proposed" || !p || p.id !== proposalId(payload(p))) throw new Error("No valid pending proposal");
  if (s.phase === "blocked") throw new Error("Controller is blocked; resolve the blocker before approval");
  const origin: WorkOrigin = { source: "user", requestId: request.id, proposalId: p.id };
  const roadmap = proposedRoadmap(s, payload(p), origin);
  // All validation precedes mutation. The caller persists plan + receipt together.
  s.milestones = roadmap; s.roadmapRevision++;
  request.status = "applied"; request.appliedRevision = s.roadmapRevision;
  request.resolvedAt = new Date().toISOString(); delete request.error;
  if (s.phase === "complete" || s.phase === "waiting") s.phase = "idle";
  refresh(s);
}
export function consumeWorkMessage(s: ShipState, msg: InboxMessage, file: string): boolean {
  s.workRequests ??= [];
  if (msg.type === "add") {
    text(msg.note, "work request");
    const next = Math.max(0, ...s.workRequests.map(r => Number(r.id.slice(1)))) + 1;
    s.workRequests.push({ id: `W${String(next).padStart(4, "0")}`, text: msg.note, source: "user", inboxId: file, createdAt: msg.at, status: "queued", attempts: 0 });
    return true;
  }
  const request = s.workRequests.find(r => r.id === msg.requestId);
  if (!request) throw new Error(`Unknown work request: ${msg.requestId}`);
  if (request.status === "applied" || request.status === "rejected") return true; // Replayed decisions never undo history.
  if (msg.type === "reject") { request.status = "rejected"; request.resolvedAt = msg.at; return true; }
  if (msg.type !== "approve") throw new Error("Unsupported work message");
  // A crash can leave an activeAttempt at a safe-looking CLI boundary. Defer
  // approval until the controller has reconciled it; never mutate underneath it.
  if (s.activeAttempt) return false;
  if (request.status !== "proposed" || !request.proposal || msg.proposalId !== request.proposal.id) {
    request.error = "Approval did not match a pending proposal; inspect before approving again"; return true;
  }
  if (s.phase === "blocked") { request.error = "Approval deferred by a controller blocker; resolve it and approve again"; return true; }
  try { applyWorkProposal(s, request); }
  catch (error) { request.status = "stale"; request.error = String(error); }
  return true;
}
export function invalidateWorkProposals(s: ShipState): boolean {
  let changed = false;
  for (const r of s.workRequests ?? []) {
    if (r.status !== "proposed" || !r.proposal || s.activeAttempt) continue;
    try { proposedRoadmap(s, r.proposal, { source: "user", requestId: r.id, proposalId: r.proposal.id }); }
    catch (error) { r.status = "stale"; r.error = String(error); changed = true; }
  }
  return changed;
}
export function validateWorkRequests(value: unknown): asserts value is WorkRequest[] {
  if (!Array.isArray(value)) throw new Error("Invalid work requests");
  const ids = new Set<string>();
  for (const r of value) {
    record(r); nodeId(r.id, "W"); text(r.text, "work request"); text(r.inboxId, "inbox provenance"); text(r.createdAt, "request date");
    if (r.source !== "user" || ids.has(r.id) || !Number.isSafeInteger(r.attempts) || (r.attempts as number) < 0 || !["queued", "planning", "proposed", "applied", "rejected", "conflict", "failed", "stale"].includes(String(r.status))) throw new Error("Invalid work request state");
    ids.add(r.id);
    if (r.status === "proposed" || r.status === "applied" || r.proposal !== undefined) {
      record(r.proposal); const p = r.proposal;
      if (p.requestId !== r.id || !Number.isSafeInteger(p.revision) || (p.revision as number) < 0) throw new Error("Invalid proposal identity");
      text(p.rationale, "rationale");
      const parsed: AdditionProposal = { requestId: r.id, revision: p.revision as number, rationale: p.rationale, patch: addition(p.patch) };
      if (p.id !== proposalId(parsed)) throw new Error("Proposal content does not match its approval fingerprint");
    }
  }
}
export function describeRequest(r: WorkRequest): string[] {
  const lines = [`${r.id} [${r.status}] ${r.text}`, `Source: user | planning attempts: ${r.attempts}`];
  if (r.error) lines.push(`Notice: ${r.error}`);
  if (!r.proposal) return lines;
  const p = r.proposal, patch = p.patch;
  lines.push(`${patch.type} | roadmap r${p.revision}`, `Reason: ${p.rationale}`, `Placement: ${"parent" in patch ? patch.parent : "project"}, after ${patch.after ?? "start"}`);
  const task = (t: NewTask) => {
    lines.push(`  ${t.id}: ${t.title}`, `    Goal: ${t.goal}`);
    for (const a of t.acceptance) lines.push(`    Acceptance: ${a}`);
    for (const c of t.verificationCommands) lines.push(`    Run (JSON string): ${JSON.stringify(c)}`);
    if (t.dependsOn?.length) lines.push(`    Depends on: ${t.dependsOn.join(", ")}`);
  };
  const slice = (s: NewSlice) => { lines.push(`${s.id}: ${s.title}`); s.tasks.forEach(task); };
  if (patch.type === "ADD_TASK") task(patch.task);
  else if (patch.type === "ADD_SLICE") slice(patch.slice);
  else { lines.push(`${patch.milestone.id}: ${patch.milestone.title}`, `Outcome: ${patch.milestone.outcome}`); patch.milestone.slices.forEach(slice); }
  lines.push(`Proposal: ${p.id}`, "Approval authorizes these new checks to run locally. Existing checks are unchanged.");
  return lines;
}
