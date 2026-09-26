import { createHash } from "node:crypto";
import type { Addition, InboxMessage, NewSlice, NewTask, ProposalPayload, ShipState, WorkOrigin, WorkProposal, WorkRequest } from "./types.ts";
import { refresh, validatePlan } from "./model.ts";
import { addToRoadmap, addition, exact, nodeId, record, text } from "./patches.ts";
import { canonical, changedState, changeContext, changeSet } from "./change.ts";

export function proposalId(p: ProposalPayload): string { return `P${createHash("sha256").update(canonical(p)).digest("hex")}`; }
function payload(p: WorkProposal): ProposalPayload {
  return { revision: p.revision, requestId: p.requestId, rationale: p.rationale, patch: p.patch,
    ...(p.context ? { context: p.context } : {}), ...(p.preview ? { preview: p.preview } : {}) };
}
function proposed(s: ShipState, p: ProposalPayload, origin: WorkOrigin, project?: string) {
  if (s.activeAttempt) throw new Error("Wait for active attempt reconciliation before changing the roadmap");
  if (p.revision !== s.roadmapRevision) throw new Error("Stale roadmap revision; reject and submit a fresh request");
  if (p.patch.type === "CHANGE") {
    if (project === undefined || !p.context || canonical(p.context) !== canonical(changeContext(s, project))) throw new Error("Stale change context (brief, requirements, or roadmap changed); reject and resubmit");
    const result = changedState(s, p.patch, origin, project);
    if (canonical(p.preview) !== canonical(result.preview)) throw new Error("Change preview no longer matches current work");
    return result;
  }
  const milestones = addToRoadmap(s, p.patch, origin); validatePlan(milestones);
  return { milestones, requirements: s.requirements ?? [], requirementsBaseHash: s.requirementsBaseHash };
}
export function parseWorkProposal(s: ShipState, request: WorkRequest, output: string, project?: string): WorkProposal | { conflict: string } {
  if (output.length > 128_000) throw new Error("Proposal exceeds 128,000 characters");
  const raw: unknown = JSON.parse(output); record(raw);
  if (raw.revision !== s.roadmapRevision || raw.requestId !== request.id) throw new Error("Stale revision or mismatched request ID");
  if ("conflict" in raw) { exact(raw, ["revision", "requestId", "conflict"]); text(raw.conflict, "conflict"); return { conflict: raw.conflict }; }
  exact(raw, ["revision", "requestId", "rationale", "patch"]); text(raw.rationale, "rationale");
  const isChange = request.kind === "change";
  const patch = isChange ? changeSet(raw.patch) : addition(raw.patch);
  const p: ProposalPayload = { revision: s.roadmapRevision, requestId: request.id, rationale: raw.rationale, patch };
  if (patch.type === "CHANGE") {
    if (project === undefined) throw new Error("Change planning requires the current project brief");
    p.context = changeContext(s, project);
    p.preview = changedState(s, patch, { source: "user", requestId: request.id, proposalId: "P" + "0".repeat(64) }, project).preview;
  }
  const id = proposalId(p);
  proposed(s, p, { source: "user", requestId: request.id, proposalId: id }, project);
  return { ...p, id };
}
export function applyWorkProposal(s: ShipState, request: WorkRequest, project?: string): void {
  const p = request.proposal;
  if (request.status !== "proposed" || !p || p.requestId !== request.id || (request.kind === "change") !== (p.patch.type === "CHANGE") || p.id !== proposalId(payload(p))) throw new Error("No valid pending proposal");
  if (s.phase === "blocked") throw new Error("Controller is blocked; resolve the blocker before approval");
  const origin: WorkOrigin = { source: "user", requestId: request.id, proposalId: p.id };
  const next = proposed(s, payload(p), origin, project);
  // All validation precedes mutation. The caller persists plan + receipt together.
  s.milestones = next.milestones; s.requirements = next.requirements; s.requirementsBaseHash = next.requirementsBaseHash; s.roadmapRevision++;
  request.status = "applied"; request.appliedRevision = s.roadmapRevision;
  request.resolvedAt = new Date().toISOString(); delete request.error;
  if (s.phase === "complete" || s.phase === "waiting") s.phase = "idle";
  refresh(s);
}
export function consumeWorkMessage(s: ShipState, msg: InboxMessage, file: string, project?: string): boolean {
  s.workRequests ??= [];
  if (msg.type === "add" || msg.type === "change") {
    text(msg.note, "work request");
    const next = Math.max(0, ...s.workRequests.map(r => Number(r.id.slice(1)))) + 1;
    s.workRequests.push({ id: `W${String(next).padStart(4, "0")}`, kind: msg.type, text: msg.note, source: "user", inboxId: file, createdAt: msg.at, status: "queued", attempts: 0 });
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
  try { applyWorkProposal(s, request, project); }
  catch (error) { request.status = "stale"; request.error = String(error); }
  return true;
}
export function invalidateWorkProposals(s: ShipState, project?: string): boolean {
  let changed = false;
  for (const r of s.workRequests ?? []) {
    if (r.status !== "proposed" || !r.proposal || s.activeAttempt) continue;
    // Calls that only persist a transition have no raw brief. Check the plan
    // now; full brief/precondition validation also runs at inbox application.
    try {
      if (r.proposal.patch.type === "CHANGE" && project === undefined) {
        if (r.proposal.revision !== s.roadmapRevision || r.proposal.context?.roadmapHash !== changeContext(s, "").roadmapHash) throw new Error("Stale roadmap revision or plan");
      } else proposed(s, r.proposal, { source: "user", requestId: r.id, proposalId: r.proposal.id }, project);
    }
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
    if (r.kind !== undefined && r.kind !== "add" && r.kind !== "change") throw new Error("Invalid request kind");
    ids.add(r.id);
    if (r.status === "proposed" || r.status === "applied" || r.proposal !== undefined) {
      record(r.proposal); const p = r.proposal;
      if (p.requestId !== r.id || !Number.isSafeInteger(p.revision) || (p.revision as number) < 0) throw new Error("Invalid proposal identity");
      text(p.rationale, "rationale");
      const parsed: ProposalPayload = { requestId: r.id, revision: p.revision as number, rationale: p.rationale, patch: r.kind === "change" ? changeSet(p.patch) : addition(p.patch) };
      if (parsed.patch.type === "CHANGE") {
        record(p.context); exact(p.context, ["projectHash", "roadmapHash", "requirementsHash"]);
        for (const key of ["projectHash", "roadmapHash", "requirementsHash"]) if (!/^[0-9a-f]{64}$/.test(String(p.context[key]))) throw new Error("Invalid change precondition");
        if (!Array.isArray(p.preview) || p.preview.some(v => typeof v !== "string")) throw new Error("Invalid change preview");
        parsed.context = p.context as unknown as NonNullable<ProposalPayload["context"]>; parsed.preview = p.preview as string[];
      } else if (p.context !== undefined || p.preview !== undefined) throw new Error("Unexpected addition context");
      if (p.id !== proposalId(parsed)) throw new Error("Proposal content does not match its approval fingerprint");
    }
  }
}
export function describeRequest(r: WorkRequest): string[] {
  const lines = [`${r.id} [${r.status}] ${r.text}`, `Source: user | ${r.kind ?? "add"} request | planning attempts: ${r.attempts}`];
  if (r.error) lines.push(`Notice: ${r.error}`);
  if (!r.proposal) return lines;
  const p = r.proposal, patch = p.patch;
  if (patch.type === "CHANGE") return [...lines, `CHANGE | roadmap r${p.revision}`, `Reason: ${p.rationale}`, ...(p.preview ?? []), `Proposal: ${p.id}`, "Approval authorizes exactly the displayed changes. Cancelled work is not passed; protectedChecks are unchanged."];
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
