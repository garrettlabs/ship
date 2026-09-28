import type { FutureMilestone, Milestone, ShipState, Task } from "./types.ts";

export interface AutonomyDecision { safe: boolean; reasons: string[]; }

const consequential = /\b(?:drop\s+(?:a\s+)?table|truncate|wipe|purge|erase|delet(?:e|ing|ion)|remov(?:e|ing|al)|destructive|irreversible|migrat(?:e|ion|ing)|schema\s+change|deploy(?:ment)?|publish(?:ing)?|release|rollout|production|secrets?|credentials?|passwords?|private\s+keys?|api\s+keys?|tokens?|auth(?:entication|orization|n|z)?|permission\s+changes?|billing|payments?|pricing|budget|spending|cost\s+limit)\b/i;
const explicitChoice = /\b(?:choose\s+(?:between|one\s+of)|either\s+.+\s+or\s+|product\s+decision|trade-?off|conflicting\s+(?:requirements?|options?|choices?)|user\s+(?:must|needs?\s+to)\s+(?:decide|choose|approve)|ask\s+(?:the\s+)?user|requires?\s+(?:user|human|manual|stakeholder|product)\s+(?:approval|sign-?off|decision|evaluation|review)|human\s+(?:evaluation|approval|sign-?off)|manual\s+(?:acceptance|approval|sign-?off))\b/i;
const approvalGate = /\b(?:user|human|manual|stakeholder|product|customer)\s*(?:-\s*)?(?:approval|acceptance|sign-?off|evaluation|decision|review)\b/i;
const protectedCheck = /\b(?:security[ -]review|independent[ -]review|protected[ -]check)\b/i;
const badStatus: Record<string, true> = { cancelled: true, superseded: true, deferred: true };
const ordinaryTypes: Record<string, true> = { implementation: true, bugfix: true, refactor: true, test: true, documentation: true };

function taskKey(milestone: Milestone, slice: Milestone["slices"][number], task: Task): string {
  return `${milestone.id}/${slice.id}/${task.id}`;
}

function tasks(plan: readonly Milestone[]): Map<string, Task> {
  const result = new Map<string, Task>();
  for (const milestone of plan) for (const slice of milestone.slices) for (const task of slice.tasks) {
    result.set(taskKey(milestone, slice, task), task);
  }
  return result;
}

function changed(before: Task | undefined, after: Task): boolean {
  if (!before) return true;
  // Derived routing and run-state are not planner edits; these are the proposed work contract.
  return ["title", "objective", "goal", "acceptance", "affectedFiles", "affectedDomains", "taskType", "uncertainty", "risk", "profile", "verificationRequirements", "verificationCommands", "verificationPlan", "dependencies", "status"]
    .some(field => JSON.stringify(before[field as keyof Task]) !== JSON.stringify(after[field as keyof Task]));
}

function ownedPath(path: string): string | undefined {
  if (typeof path !== "string" || !path.trim() || path.includes("\\") || path.startsWith("/") || /^[a-z]:/i.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment === "*" || segment === "**")) return undefined;
  return segments.join("/").toLowerCase();
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sessionOwners(state: ShipState): string[] {
  return [state.nativeBatch?.sessionId, state.nativePlanning?.sessionId, state.pendingJudgment?.sessionId,
    state.discovery?.status === "researching" ? state.discovery.sessionId : undefined].filter((id): id is string => !!id);
}

/** Classify the proposed scope, never grant permission to omit reviews or verification. */
export function classifyAutonomousApproval(state: ShipState, proposedMilestones: Milestone[], futureOutline?: FutureMilestone[]): AutonomyDecision {
  const reasons: string[] = [];
  const refuse = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (state.autonomy !== "yolo") refuse("Autonomous approval requires yolo mode");
  if (state.paused || state.phase === "blocked") refuse("Run is paused or blocked");
  if (state.activeAttempt || state.nativeBatch || state.nativePlanning || state.pendingJudgment) refuse("Active work must settle before approval");
  if (state.discovery && !state.discovery.goalSet) refuse("Explicit user goal is missing");
  if (state.pendingProposal?.status === "pending") {
    if (state.pendingProposal.approvalBoundary === "explicit") refuse("Proposal requires explicit user approval");
    if (state.pendingProposal.targetRevision !== state.roadmapRevision) refuse("Proposal revision is stale");
    if (JSON.stringify(state.pendingProposal.milestones) !== JSON.stringify(proposedMilestones)) refuse("Proposed milestones differ from pending proposal");
    if (futureOutline !== undefined && JSON.stringify(state.pendingProposal.futureMilestones ?? []) !== JSON.stringify(futureOutline)) refuse("Future outline differs from pending proposal");
    const owner = state.pendingProposal.sessionId;
    if (owner && sessionOwners(state).some(session => session !== owner)) refuse("Proposal belongs to another active session");
  }
  if (!Array.isArray(proposedMilestones) || !proposedMilestones.length) {
    refuse("Executable roadmap is missing");
    return { safe: false, reasons };
  }
  const oldMilestones = new Map(state.milestones.map(milestone => [milestone.id, milestone]));
  const oldTasks = tasks(state.milestones);
  const nextTasks = tasks(proposedMilestones);
  const proposedOutline = futureOutline ?? state.pendingProposal?.futureMilestones ?? [];
  if (JSON.stringify(proposedOutline) !== JSON.stringify(state.futureMilestones ?? [])) {
    refuse("Future outline changes unapproved scope");
  }
  if (state.milestones.length && proposedMilestones.some(milestone => !oldMilestones.has(milestone.id))) refuse("New milestone expands the approved goal");
  for (const old of state.milestones) if (!proposedMilestones.some(milestone => milestone.id === old.id)) refuse(`Milestone ${old.id} was removed`);
  const ownership: { key: string; path: string; changed: boolean }[] = [];
  for (const milestone of proposedMilestones) {
    const previousMilestone = oldMilestones.get(milestone.id);
    if (previousMilestone && (previousMilestone.title !== milestone.title || previousMilestone.outcome !== milestone.outcome || badStatus[milestone.status] && !badStatus[previousMilestone.status])) refuse(`Milestone ${milestone.id} changes the approved outcome`);
    if (consequential.test(`${milestone.title} ${milestone.outcome}`) || explicitChoice.test(`${milestone.title} ${milestone.outcome}`)) refuse(`Milestone ${milestone.id} needs user review`);
    for (const slice of milestone.slices) {
      const previousSlice = previousMilestone?.slices.find(item => item.id === slice.id);
      if (previousSlice && (previousSlice.title !== slice.title || badStatus[slice.status] && !badStatus[previousSlice.status])) refuse(`Slice ${milestone.id}/${slice.id} changes approved scope`);
      if (consequential.test(slice.title) || explicitChoice.test(slice.title)) refuse(`Slice ${milestone.id}/${slice.id} needs user review`);
      for (const task of slice.tasks) {
        const key = taskKey(milestone, slice, task);
        const previous = oldTasks.get(key);
        const isChanged = changed(previous, task);
        // Commands are executable shell text, not descriptive scope. Only exact commands
        // already present on this stable task in the approved roadmap may inherit approval.
        if ((task.verificationCommands ?? []).some(command => !previous?.verificationCommands?.includes(command)))
          refuse(`${key} introduces planner-authored verification commands requiring explicit user approval`);
        for (const file of task.affectedFiles ?? []) {
          const normalized = ownedPath(file);
          if (!normalized) refuse(`${key} has unknown file ownership`);
          else ownership.push({ key, path: normalized, changed: isChanged });
        }
        if (!isChanged) continue;
        if (previous && (previous.attempts > 0 || previous.status !== "pending")) refuse(`${key} has already started`);
        if (badStatus[task.status] || task.status !== "pending") refuse(`${key} changes or omits functionality`);
        if (!ordinaryTypes[task.taskType]) refuse(`${key} is not ordinary reversible implementation work`);
        if (task.risk !== "LOW" || task.uncertainty !== "LOW" || task.effectiveUncertainty === "HIGH" || task.effectiveUncertainty === "UNKNOWN" || (task.profile?.risk ?? 10) >= 7 || (task.profile?.uncertainty ?? 10) >= 7) refuse(`${key} has high or unknown risk/uncertainty`);
        const description = [task.title, task.objective, task.goal, ...(task.acceptance ?? []), ...(task.verificationRequirements ?? []), ...(task.affectedDomains ?? []), ...(task.affectedFiles ?? [])].join(" ");
        if (consequential.test(description) || explicitChoice.test(description)) refuse(`${key} is consequential or requires a product decision`);
        if (approvalGate.test(description)) refuse(`${key} requires human acceptance or approval`);
        if (!Array.isArray(task.acceptance) || !task.acceptance.length || task.acceptance.some(item => !item?.trim()) ||
            !Array.isArray(task.verificationRequirements) || !task.verificationRequirements.length || task.verificationRequirements.some(item => !item?.trim()) ||
            !Array.isArray(task.verificationCommands) ||
            !Array.isArray(task.verificationPlan?.requirements) || !task.verificationPlan.requirements.length) refuse(`${key} has missing acceptance or verification`);
        if (previous && (!previous.acceptance.every(item => task.acceptance.includes(item)) ||
            !previous.verificationRequirements.every(item => task.verificationRequirements.includes(item)) ||
            !previous.verificationCommands.every(item => task.verificationCommands.includes(item)) ||
            !previous.verificationPlan.requirements.every(item => task.verificationPlan.requirements.some(next => next.kind === item.kind && next.command === item.command && next.reason === item.reason)))) refuse(`${key} removes acceptance or protected verification`);
        // Review requirements remain required work. Their presence is not a reason to skip or reject the proposal.
        if (task.verificationPlan.requirements.some(item => protectedCheck.test(item.reason) && !["security-review", "independent-review"].includes(item.kind))) refuse(`${key} misclassifies a protected review`);
        if (!Array.isArray(task.affectedFiles) || !task.affectedFiles.length) refuse(`${key} has unknown file ownership`);
        if (!Array.isArray(task.affectedDomains) || !task.affectedDomains.length || task.affectedDomains.some(domain => !domain?.trim())) refuse(`${key} has unknown domain ownership`);
      }
    }
  }
  for (const [key, previous] of oldTasks) if (!nextTasks.has(key)) refuse(`${key} removes planned functionality`);
  for (let index = 0; index < ownership.length; index++) for (let other = 0; other < index; other++) {
    if ((ownership[index].changed || ownership[other].changed) && ownership[index].key !== ownership[other].key &&
        overlaps(ownership[index].path, ownership[other].path)) refuse(`Overlapping file ownership: ${ownership[other].key} and ${ownership[index].key}`);
  }
  return { safe: reasons.length === 0, reasons };
}

/** Only the initiating session may resume; this does not waive any required checks. */
export function canContinueAutonomously(state: ShipState, sessionId: string): { safe: boolean; reason?: string } {
  if (state.autonomy !== "yolo") return { safe: false, reason: "Autonomous continuation requires yolo mode" };
  if (!sessionId?.trim()) return { safe: false, reason: "Current session is unknown" };
  if (state.autonomySessionId !== sessionId) return { safe: false, reason: "Yolo mode belongs to another session" };
  if (state.paused || state.phase === "blocked") return { safe: false, reason: "Run is paused or blocked" };
  if (state.discovery && !state.discovery.goalSet) return { safe: false, reason: "Explicit user goal is missing" };
  const owners = sessionOwners(state);
  if (owners.some(owner => owner !== sessionId)) return { safe: false, reason: "Active work belongs to another session" };
  if (state.activeAttempt || state.workspace) return { safe: false, reason: "Standalone work requires explicit recovery" };
  if (state.pendingProposal?.status === "pending" && (state.pendingProposal.approvalBoundary === "explicit" || state.pendingProposal.sessionId && state.pendingProposal.sessionId !== sessionId)) return { safe: false, reason: "Proposal awaits user approval or belongs to another session" };
  if (state.milestones.some(m => m.slices.some(s => s.tasks.some(t => ["pending", "running", "verifying"].includes(t.status) &&
    [...t.acceptance, ...t.verificationRequirements].some(item => approvalGate.test(item)))))) return { safe: false, reason: "Human evaluation must be approved by the user" };
  return { safe: true };
}
