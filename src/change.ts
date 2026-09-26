import { createHash } from "node:crypto";
import type { ChangeContext, ChangeOperation, ChangeSet, Milestone, RequirementAmendment, ShipState, Task, WorkOrigin } from "./types.ts";
import { addToRoadmap, addition, exact, newTask, record, text } from "./patches.ts";
import { refresh, tasks, terminal, validatePlan } from "./model.ts";

export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(x);
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function changeContext(s: ShipState, project: string): ChangeContext {
  return { projectHash: fingerprint(project), roadmapHash: fingerprint(s.milestones), requirementsHash: fingerprint({ amendments: s.requirements ?? [], base: s.requirementsBaseHash ?? null }) };
}
function replaceRequirement(project: string, before: string, after: string | null): string {
  const index = project.indexOf(before);
  if (index < 0 || project.indexOf(before, index + 1) >= 0) throw new Error("Requirement must quote one unique, exact passage of the effective brief");
  if (before === after) throw new Error("Requirement change is a no-op");
  const result = project.slice(0, index) + (after ?? "") + project.slice(index + before.length);
  if (!result.trim() || result.length > 60_000) throw new Error("Effective brief must contain 1–60,000 characters");
  return result;
}
export function validateRequirements(s: ShipState): void {
  if (s.requirements === undefined) return;
  if (!Array.isArray(s.requirements)) throw new Error("Invalid requirement amendments");
  const ids = new Set<string>();
  for (const r of s.requirements) {
    record(r); text(r.before, "requirement before"); if (r.after !== null) text(r.after, "requirement after"); text(r.reason, "requirement rationale");
    if (!/^R[0-9]{4,}$/.test(r.id) || ids.has(r.id) || r.origin?.source !== "user" || !/^W[0-9]{2,}$/.test(r.origin.requestId) || !/^P[0-9a-f]{64}$/.test(r.origin.proposalId)) throw new Error("Invalid requirement provenance");
    ids.add(r.id);
  }
  if (s.requirements.length && !/^[0-9a-f]{64}$/.test(s.requirementsBaseHash ?? "")) throw new Error("Requirement amendments need a baseline hash");
}
// PROJECT.md remains user-owned. Approved amendments are an ordered overlay,
// never a second independently editable brief. Drift stops rather than guesses.
export function effectiveProject(raw: string, s: ShipState): string {
  validateRequirements(s);
  if (s.requirements?.length && fingerprint(raw) !== s.requirementsBaseHash) throw new Error("PROJECT.md changed after requirement approval. Restore the original baseline and use ship change; amendments were not silently rebased.");
  let project = raw;
  for (const r of s.requirements ?? []) project = replaceRequirement(project, r.before, r.after);
  return project;
}
function targetKey(x: unknown, depth: number): asserts x is string {
  const re = ["", "^M[0-9]{2,}$", "^M[0-9]{2,}/S[0-9]{2,}$", "^M[0-9]{2,}/S[0-9]{2,}/T[0-9]{2,}$"][depth];
  if (typeof x !== "string" || x.length > 38 || !new RegExp(re).test(x)) throw new Error("Invalid change target");
}
function operation(value: unknown): ChangeOperation {
  record(value); const type = value.type;
  if (typeof type === "string" && type.startsWith("ADD_")) return addition(value);
  text(value.reason, "change reason");
  if (type === "CHANGE_REQUIREMENT") {
    exact(value, ["type", "before", "after", "reason"]); text(value.before, "requirement before"); if (value.after !== null) text(value.after, "requirement after");
    return { type, before: value.before, after: value.after as string | null, reason: value.reason };
  }
  const depth = String(type).endsWith("_TASK") ? 3 : String(type).endsWith("_SLICE") ? 2 : 1;
  targetKey(value.target, depth);
  if (type === "MODIFY_TASK") {
    exact(value, ["type", "target", "updates", "reason"]); record(value.updates);
    exact(value.updates, ["title", "goal", "acceptance", "verificationCommands", "dependsOn"]);
    if (!Object.keys(value.updates).length) throw new Error("Empty task update");
    // Reuse the same bounds and type checks as newly planned work.
    newTask({ id: "T00", title: "placeholder", goal: "placeholder", acceptance: ["placeholder"], verificationCommands: ["placeholder"], ...value.updates });
    return { type, target: value.target, updates: structuredClone(value.updates), reason: value.reason };
  }
  if (type === "MODIFY_SLICE" || type === "MODIFY_MILESTONE") {
    exact(value, ["type", "target", "updates", "reason"]); record(value.updates);
    exact(value.updates, type === "MODIFY_SLICE" ? ["title"] : ["title", "outcome"]);
    if (!Object.keys(value.updates).length) throw new Error("Empty parent update");
    for (const [key, val] of Object.entries(value.updates)) text(val, key, key === "title" ? 1000 : 20_000);
    return { type, target: value.target, updates: structuredClone(value.updates), reason: value.reason } as ChangeOperation;
  }
  if (type === "MOVE_TASK" || type === "MOVE_SLICE" || type === "MOVE_MILESTONE") {
    exact(value, ["type", "target", "after", "reason"]);
    if (value.after !== null) {
      const prefix = depth === 3 ? "T" : depth === 2 ? "S" : "M";
      if (typeof value.after !== "string" || !new RegExp(`^${prefix}[0-9]{2,}$`).test(value.after) || value.after.length > 12) throw new Error("Move anchor must be a sibling ID or null");
    }
    return { type, target: value.target, after: value.after as string | null, reason: value.reason };
  }
  if (type === "CANCEL_TASK" || type === "CANCEL_SLICE" || type === "CANCEL_MILESTONE") {
    exact(value, ["type", "target", "reason"]); return { type, target: value.target, reason: value.reason };
  }
  throw new Error("Unsupported change operation");
}
export function changeSet(value: unknown): ChangeSet {
  record(value); exact(value, ["type", "operations"]);
  if (value.type !== "CHANGE" || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 30) throw new Error("CHANGE requires 1–30 operations");
  const operations = value.operations.map(operation);
  if (operations.every(op => op.type.startsWith("ADD_"))) throw new Error("Pure additions belong to ship add");
  return { type: "CHANGE", operations };
}
function mutable(list: Task[]): void {
  if (!list.length || list.some(t => t.status !== "pending" || t.attempts !== 0)) throw new Error("Only pending, never-started work can be modified, moved, or cancelled; preserve completed/attempted history");
}
function provenance(node: { changedBy?: WorkOrigin[] }, origin: WorkOrigin): void {
  node.changedBy ??= [];
  if (!node.changedBy.some(x => x.proposalId === origin.proposalId)) node.changedBy.push(origin);
}
// Build everything on a clone. A failure in the final operation must not apply
// the preceding operations, requirements, receipts, or cancellation records.
export function changedState(s: ShipState, patch: ChangeSet, origin: WorkOrigin, rawProject: string) {
  if (s.activeAttempt) throw new Error("Wait for active attempt reconciliation before changing the roadmap");
  const draft = structuredClone(s), preview: string[] = [];
  draft.requirements ??= [];
  let project = effectiveProject(rawProject, s);
  const original = tasks(s), frozen = new Map(original.filter(x => x.t.status !== "pending" || x.t.attempts !== 0).map(x => [x.key, canonical(x.t)]));
  const baselineOrder = original.map(x => x.key);
  for (const op of patch.operations) {
    if (op.type === "ADD_TASK" || op.type === "ADD_SLICE" || op.type === "ADD_MILESTONE") {
      draft.milestones = addToRoadmap(draft, op, origin);
      preview.push(`${op.type}: ${JSON.stringify(op)}`); continue;
    }
    if (op.type === "CHANGE_REQUIREMENT") {
      project = replaceRequirement(project, op.before, op.after);
      const id = `R${String(draft.requirements.length + 1).padStart(4, "0")}`;
      draft.requirements.push({ id, before: op.before, after: op.after, reason: op.reason, origin });
      draft.requirementsBaseHash = fingerprint(rawProject);
      preview.push(`${op.type} ${id}`, `  Before: ${JSON.stringify(op.before)}`, `  After: ${JSON.stringify(op.after)}`, `  Reason: ${op.reason}`); continue;
    }
    const [mid, sid, tid] = op.target.split("/");
    const m = draft.milestones.find(m => m.id === mid), slice = m?.slices.find(x => x.id === sid), task = slice?.tasks.find(x => x.id === tid);
    const node = tid ? task : sid ? slice : m;
    if (!node || !m) throw new Error(`Missing change target: ${op.target}`);
    const affected = task ? [task] : slice ? slice.tasks : m.slices.flatMap(x => x.tasks);
    mutable(affected);
    preview.push(`${op.type} ${op.target}`, `  Reason: ${op.reason}`);
    if (op.type === "MODIFY_TASK" || op.type === "MODIFY_SLICE" || op.type === "MODIFY_MILESTONE") {
      let altered = false;
      for (const [key, val] of Object.entries(op.updates)) {
        const before = (node as unknown as Record<string, unknown>)[key] ?? null;
        if (canonical(before) !== canonical(val)) altered = true;
        preview.push(`  ${key} before: ${JSON.stringify(before)}`, `  ${key} after: ${JSON.stringify(val)}`);
      }
      if (!altered) throw new Error("Update does not change any fields");
      Object.assign(node, structuredClone(op.updates)); provenance(node, origin);
    } else if (op.type === "CANCEL_TASK" || op.type === "CANCEL_SLICE" || op.type === "CANCEL_MILESTONE") {
      // Tombstones keep IDs reserved, checks visible, and dependencies auditable.
      preview.push(`  Before: ${JSON.stringify(node, (key, value) => ["changedBy", "requestedBy", "cancellation"].includes(key) ? undefined : value)}`, "  After: cancelled (not passed); original checks and IDs remain in history");
      const cancellation = { reason: op.reason, origin };
      node.cancellation = cancellation;
      for (const t of affected) { t.status = "cancelled"; t.cancellation = cancellation; provenance(t, origin); }
      provenance(node, origin);
    } else {
      if (!("after" in op)) throw new Error("Unsupported move operation");
      const siblings: { id: string }[] = tid ? slice!.tasks : sid ? m.slices : draft.milestones;
      const previous = siblings.map(x => x.id), from = siblings.indexOf(node);
      if (op.after === node.id) throw new Error("Cannot move a node after itself");
      if (op.after !== null && !siblings.some(x => x.id === op.after)) throw new Error("Missing move anchor in the same parent; cross-parent moves are unsupported");
      siblings.splice(from, 1);
      siblings.splice(op.after === null ? 0 : siblings.findIndex(x => x.id === op.after) + 1, 0, node);
      if (canonical(previous) === canonical(siblings.map(x => x.id))) throw new Error("Move does not change order");
      preview.push(`  Order before: ${previous.join(", ")}`, `  Order after: ${siblings.map(x => x.id).join(", ")}`);
      provenance(node, origin);
    }
  }
  validatePlan(draft.milestones); refresh(draft);
  const now = tasks(draft);
  for (const [key, value] of frozen) if (canonical(now.find(x => x.key === key)?.t) !== value) throw new Error("Started/completed history changed");
  // Pending work cannot jump ahead of previously started or retired work. IDs
  // keep their parents; arbitrary path remapping would invalidate old evidence.
  for (const entry of now) {
    if (entry.t.status !== "pending") continue;
    const oldIndex = baselineOrder.indexOf(entry.key), newIndex = now.indexOf(entry);
    for (const key of frozen.keys()) {
      if ((oldIndex < 0 || baselineOrder.indexOf(key) < oldIndex) && now.findIndex(x => x.key === key) > newIndex) throw new Error("Cannot move pending work before started/completed history");
    }
  }
  const surviving = now.filter(x => !terminal(x.t));
  if (!surviving.length) preview.push("No runnable tasks remain after this change. Cancelled work is not verified delivery.");
  if (patch.operations.some(op => op.type === "MODIFY_TASK" && (op.updates.acceptance || op.updates.verificationCommands))) preview.push("WARNING: approval changes acceptance criteria/checks for pending tasks. Project-wide protectedChecks are unchanged.");
  if (draft.requirements.length !== (s.requirements?.length ?? 0)) preview.push("Requirement amendments affect future prompts; they do not waive protectedChecks or retroactively pass failed work.");
  return { milestones: draft.milestones, requirements: draft.requirements, requirementsBaseHash: draft.requirementsBaseHash, preview, project };
}
