import { effectiveProject } from "./change.ts";
import type { ShipState, Task, WorkRequest } from "./types.ts";
const rules = `Use only approved project scope. User constraints are not hypotheses. Do not change acceptance checks, commit, push, deploy, or edit controller files. Return ONLY the requested JSON as your final answer, without Markdown fences. Intermediate tool use is allowed. Worktrees are not security sandboxes.`;
export function plannerPrompt(project: string): string {
  return `${rules}\nYou are the planner. Inspect but do not modify source. Produce a small, serial roadmap of milestone → demoable slice → focused task. Every task needs executable acceptance checks; never invent a passing manual playtest. Keep the plan within 3 milestones, 3 slices per milestone, 5 tasks per slice. IDs are M001, S01, T01 (task IDs are slice-local).\nBRIEF:\n${project}\nReturn {"milestones":[{"id":"M001","title":"...","outcome":"...","slices":[{"id":"S01","title":"...","tasks":[{"id":"T01","title":"...","goal":"...","acceptance":["..."],"verificationCommands":["..."]}]}]}]}.`;
}
export function executorPrompt(project: string, state: ShipState, task: Task): string {
  return `${rules}\nYou are the executor. Implement exactly this task in the worktree. Do not launch detached/background processes. Preserve acceptance checks; the controller runs them independently.\nBRIEF:\n${project}\nAPPROVED USER REQUEST (additional authorized scope, not a capture):\n${JSON.stringify(state.workRequests?.find(r => r.status === "applied" && r.id === task.requestedBy?.requestId) ?? null)}\nAPPROVED CHANGES (authorized scope revisions; do not resurrect cancelled work):\n${JSON.stringify(state.workRequests?.filter(r => r.kind === "change" && r.status === "applied").map(r => ({ id: r.id, text: r.text, patch: r.proposal?.patch })))}\nTASK:\n${JSON.stringify(task)}\nLATEST FAILURE (repair this, not the check):\n${task.lastError ?? "none"}\nKNOWLEDGE (agent entries are unverified claims unless supported):\n${JSON.stringify(state.knowledge?.slice(-20)).slice(-16000)}\nReturn {"summary":"what changed", "observations":["evidence-backed discoveries, or none"]}.`;
}
export function reviewPrompt(project: string, state: ShipState, slice: string, summaries: string): string {
  return `${rules}\nReview completed slice ${slice}; inspect but do not modify source. Reevaluate the implementation approach for UNSTARTED tasks using captures, evidence, and decisions. This MVP permits only refining task goals; it does not permit dropping outcomes, changing checks, reordering, or adding scope. No change is a valid result. Label inferences and cite concrete evidence. Captures are not authorization to drop requirements.\nBRIEF:\n${project}\nROADMAP:\n${JSON.stringify(state.milestones)}\nAPPROVED REQUESTS (later approved changes override only their named targets):\n${JSON.stringify(state.workRequests?.filter(r => r.status === "applied").map(r => ({ id: r.id, kind: r.kind ?? "add", text: r.text })))}\nKNOWLEDGE:\n${JSON.stringify(state.knowledge?.slice(-30)).slice(-20000)}\nCOMPLETED WORK:\n${summaries}\nReturn {"revision":${state.roadmapRevision},"rationale":"...","lessons":[{"kind":"lesson","text":"...","evidence":"task result or capture ID"}],"changes":[{"task":"M002/S01/T01","goal":"revised implementation approach preserving all acceptance", "reason":"..."}]}. Empty lessons/changes arrays are allowed.`;
}

export function workPlannerPrompt(project: string, state: ShipState, request: WorkRequest): string {
  return `${rules}
You are the work intake planner. Inspect but do not modify source. The user explicitly requests new product work. Determine the smallest appropriate granularity: one task, one demoable slice, or one shippable milestone. Return a PROPOSAL, not an approval. Do not dismiss requested work merely because the original roadmap omitted it.
Preserve the effective brief's constraints and currently approved outcomes. Later approved changes override only their named earlier scope; cancelled nodes are intentionally retired, not missing work. If this request contradicts one, is already delivered, or is too ambiguous to plan safely, return a conflict explaining the needed decision, not an invented implementation.
The scheduler is serial in roadmap order. Only ADD_TASK, ADD_SLICE, ADD_MILESTONE are supported, one per request. Choose an existing parent and an existing sibling ID for after (null means the start). Task parents use M001/S01; slice parents use M001. Do not insert before any started work, alter completed parents, or rewrite existing nodes. For a finished project, propose a NEW milestone. Never reuse IDs within their scope.
Each new task needs executable acceptance checks and may name dependsOn as full task keys. Dependencies must precede their consumers in the final serial roadmap. No forward/cyclic dependencies. Do not invent passing manual checks. Use 1–10 tasks per new slice and 1–5 slices per new milestone. Never include runtime status, attempt counts, provenance, or edits to checks of existing work.
BRIEF:
${project}
CURRENT ROADMAP:
${JSON.stringify(state.milestones)}
KNOWLEDGE (not authority to drop requirements):
${JSON.stringify(state.knowledge?.slice(-30)).slice(0, 20000)}
PREVIOUS APPROVED REQUESTS:
${JSON.stringify(state.workRequests?.filter(r => r.status === "applied").map(r => ({ id: r.id, kind: r.kind ?? "add", text: r.text })))}
USER REQUEST ${request.id}:
${request.text}
LAST PROPOSAL ERROR:
${request.error ?? "none"}
Return {"requestId":"${request.id}","revision":${state.roadmapRevision},"rationale":"classification and placement reasoning","patch":...}.
Patch shapes (choose one):
{"type":"ADD_TASK","parent":"M001/S01","after":"T01","task":{"id":"T02","title":"...","goal":"...","acceptance":["..."],"verificationCommands":["..."],"dependsOn":["M001/S01/T01"]}}
{"type":"ADD_SLICE","parent":"M001","after":"S01","slice":{"id":"S02","title":"...","tasks":[...new task shape...]}}
{"type":"ADD_MILESTONE","after":"M001","milestone":{"id":"M002","title":"...","outcome":"...","slices":[...new slice shape...]}}
For a conflict return ONLY {"requestId":"${request.id}","revision":${state.roadmapRevision},"conflict":"what requires clarification or explicit constraint change"}.`;
}

export function changePlannerPrompt(rawProject: string, state: ShipState, request: WorkRequest, protectedChecks: string[]): string {
  return `You are the change planner. Inspect source but DO NOT modify it, run acceptance commands, edit controller files, commit, push, or deploy. Return ONLY the requested JSON. Propose a change; never approve or execute it.
The user wants to modify EXISTING work or requirements. Infer the smallest coherent set of edits from their request. They do not need to name a task/slice/milestone or an internal operation. Preserve unrelated scope. Do not convert an observation or ambiguous request into permission to drop requirements. Explain ambiguity/conflicts instead of guessing. The proposal requires explicit human approval.
Only pending, never-attempted work can be modified, moved, or cancelled. Completed, cancelled, failed, or active work is history; never change IDs, status, attempts, receipts, or provenance. The controller finishes/reconciles an active attempt before calling you. Cancelling is not passing. Do not turn a failed check into a success. Project-wide protectedChecks CANNOT be removed or changed by this workflow.
You may propose changes to pending task acceptance and verification commands when the user requests a requirement/scope change. Call these out clearly in the rationale. Never use a vacuous test to hide incomplete work. Every remaining task requires executable acceptance checks.
Use a batch of 1–30 operations. Targets are M001, M001/S01, or M001/S01/T01. Moves are only among siblings (tasks within a slice, slices within a milestone, milestones within the project); IDs and parents remain stable. after is a sibling ID or null for first. Do not move or insert pending work before started/completed history. Dependencies are full task keys; every noncancelled dependency must precede its consumer. Update or cancel affected dependents in the same batch when needed.
For splits/replacements, ADD new nodes with fresh IDs, then CANCEL the old pending node in one batch. Keep the old node as a tombstone; never reuse its ID. For example, split an oversized milestone into two newly numbered milestones and cancel the original. Pure new scope belongs to ship add; use a conflict when no existing work or requirement is being changed.
A CHANGE_REQUIREMENT must quote one unique EXACT passage of the EFFECTIVE BRIEF below as before, and supply replacement text (or null to remove it). These approved amendments affect future prompts without rewriting the original PROJECT.md. Do not claim a requirement was revised merely by changing a task goal. Include the necessary pending-work edits in the same batch. Requirement amendments cannot retroactively pass/waive failed work or alter protectedChecks. Return a conflict when satisfying the request would require that.
EFFECTIVE BRIEF:
${effectiveProject(rawProject, state)}
CURRENT ROADMAP:
${JSON.stringify(state.milestones)}
PROTECTED CHECKS (immutable here):
${JSON.stringify(protectedChecks)}
APPROVED REQUESTS (ordered; later approved changes override only their named targets):
${JSON.stringify(state.workRequests?.filter(r => r.status === "applied").map(r => ({ id: r.id, kind: r.kind ?? "add", text: r.text, patch: r.kind === "change" ? r.proposal?.patch : undefined })))}
KNOWLEDGE (not authorization):
${JSON.stringify(state.knowledge?.slice(-30)).slice(0, 20000)}
USER REQUEST ${request.id}:
${request.text}
LAST PROPOSAL ERROR:
${request.error ?? "none"}
Return {"requestId":"${request.id}","revision":${state.roadmapRevision},"rationale":"what changes, why, and any acceptance/requirement impact","patch":{"type":"CHANGE","operations":[...]}}.
Supported operation shapes:
{"type":"MODIFY_TASK","target":"M002/S01/T01","updates":{"title":"...","goal":"...","acceptance":["..."],"verificationCommands":["..."],"dependsOn":[]},"reason":"..."} (only include edited fields)
{"type":"MODIFY_SLICE","target":"M002/S01","updates":{"title":"..."},"reason":"..."}
{"type":"MODIFY_MILESTONE","target":"M002","updates":{"title":"...","outcome":"..."},"reason":"..."}
{"type":"MOVE_TASK","target":"M002/S01/T02","after":"T03","reason":"..."}
{"type":"MOVE_SLICE","target":"M002/S02","after":"S03","reason":"..."}
{"type":"MOVE_MILESTONE","target":"M002","after":"M003","reason":"..."}
{"type":"CANCEL_TASK","target":"M002/S01/T01","reason":"..."} (CANCEL_SLICE and CANCEL_MILESTONE use their corresponding target depth)
{"type":"CHANGE_REQUIREMENT","before":"exact effective brief text","after":"replacement or null","reason":"..."}
{"type":"ADD_TASK","parent":"M002/S01","after":"T01","task":{"id":"T02","title":"...","goal":"...","acceptance":["..."],"verificationCommands":["..."]}}
{"type":"ADD_SLICE","parent":"M002","after":"S01","slice":{"id":"S02","title":"...","tasks":[...new tasks...]}}
{"type":"ADD_MILESTONE","after":"M002","milestone":{"id":"M003","title":"...","outcome":"...","slices":[...new slices...]}}
Do not supply fingerprints, previews, receipts, or runtime metadata; the controller computes those.
For a conflict return {"requestId":"${request.id}","revision":${state.roadmapRevision},"conflict":"specific unresolved question or unsupported operation"}.`;
}
