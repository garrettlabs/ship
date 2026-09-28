import { randomUUID } from "node:crypto";
import { DependencyGraph } from "./dependency-graph.ts";
import { normalizePlan, taskMetadata } from "./model.ts";
import type { FutureMilestone, Milestone, PlanningHints, RoadmapProposal, ShipState, Task } from "./types.ts";

export interface ProposalInput {
  request: string; sessionId?: string; milestones: Milestone[];
  futureMilestones?: FutureMilestone[]; impactedSummary: string[];
}
export type DraftTask = Pick<Task, "id" | "title" | "goal" | "acceptance" | "verificationCommands"> &
  Partial<Pick<Task, "objective">> & PlanningHints;
export type RoadmapOperation =
  | { type: "add-milestone"; id: string; title: string; outcome: string; slices: { id: string; title: string; tasks: DraftTask[] }[] }
  | { type: "add-slice"; milestone: string; id: string; title: string; tasks: DraftTask[] }
  | { type: "add-task"; slice: string; task: DraftTask }
  | { type: "revise-task"; task: string; title?: string; objective?: string; goal?: string; acceptance?: string[]; verificationCommands?: string[]; dependencies?: string[] }
  | { type: "split-task"; task: string; replacements: DraftTask[] }
  | { type: "set-status"; target: string; status: "pending" | "deferred" | "cancelled" | "superseded" };
export interface OperationsInput extends Omit<ProposalInput, "milestones"> { operations: RoadmapOperation[]; }

/** Apply planner-authored operations to a clone, never exposing runtime lifecycle fields to the planner. */
export function stageRoadmapOperations(state: ShipState, input: OperationsInput): ShipState {
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100) throw new Error("Expected 1–100 roadmap operations");
  const candidate = structuredClone(state.milestones);
  const taskFromDraft = (draft: DraftTask): Task => {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("Invalid draft task");
    const allowed = ["id", "title", "objective", "goal", "acceptance", "verificationCommands", "taskType", "uncertainty", "dependencies", "profile", "affectedFiles", "affectedDomains", "verificationRequirements"];
    if (Object.keys(draft).some(key => !allowed.includes(key))) throw new Error("Planner cannot override task lifecycle or classification");
    const created = taskMetadata(draft as unknown as Record<string, unknown>, true, state.repoChecks);
    created.status = "pending"; created.attempts = 0;
    return created;
  };
  const sliceAt = (key: string) => {
    const [mid, sid, extra] = key.split("/");
    if (extra || !mid || !sid) throw new Error(`Invalid slice key: ${key}`);
    const slice = candidate.find(m => m.id === mid)?.slices.find(s => s.id === sid);
    if (!slice) throw new Error(`Unknown slice: ${key}`);
    return slice;
  };
  const taskAt = (key: string) => {
    const [mid, sid, tid, extra] = key.split("/");
    if (extra || !mid || !sid || !tid) throw new Error(`Invalid task key: ${key}`);
    const slice = sliceAt(`${mid}/${sid}`);
    const task = slice.tasks.find(t => t.id === tid);
    if (!task) throw new Error(`Unknown task: ${key}`);
    return { slice, task };
  };
  for (const operation of input.operations) {
    if (!operation || typeof operation !== "object") throw new Error("Invalid roadmap operation");
    const allowedFields: Record<RoadmapOperation["type"], string[]> = {
      "add-milestone": ["type", "id", "title", "outcome", "slices"],
      "add-slice": ["type", "milestone", "id", "title", "tasks"],
      "add-task": ["type", "slice", "task"],
      "revise-task": ["type", "task", "title", "objective", "goal", "acceptance", "verificationCommands", "dependencies"],
      "split-task": ["type", "task", "replacements"],
      "set-status": ["type", "target", "status"],
    };
    if (!Object.hasOwn(allowedFields, operation.type) || Object.keys(operation).some(key => !allowedFields[operation.type].includes(key))) throw new Error("Forbidden roadmap operation field");
    switch (operation.type) {
      case "add-milestone":
        if (!/^M[0-9]{2,}$/.test(operation.id) || !operation.title?.trim() || !operation.outcome?.trim() || !Array.isArray(operation.slices) || !operation.slices.length) throw new Error("Invalid new milestone");
        candidate.push({ id: operation.id, title: operation.title, outcome: operation.outcome, status: "pending",
          slices: operation.slices.map(s => ({ id: s.id, title: s.title, status: "pending", tasks: s.tasks.map(taskFromDraft) })) });
        break;
      case "add-slice": {
        const milestone = candidate.find(m => m.id === operation.milestone);
        if (!milestone || !/^S[0-9]{2,}$/.test(operation.id) || !operation.title?.trim() || !Array.isArray(operation.tasks) || !operation.tasks.length) throw new Error("Invalid new slice");
        milestone.slices.push({ id: operation.id, title: operation.title, status: "pending", tasks: operation.tasks.map(taskFromDraft) });
        break;
      }
      case "add-task":
        sliceAt(operation.slice).tasks.push(taskFromDraft(operation.task));
        break;
      case "revise-task": {
        const { task } = taskAt(operation.task);
        if (task.status !== "pending" || task.attempts) throw new Error(`Cannot revise started task: ${operation.task}`);
        const allowed = ["type", "task", "title", "objective", "goal", "acceptance", "verificationCommands", "dependencies"];
        if (Object.keys(operation).some(key => !allowed.includes(key))) throw new Error("Forbidden revision field");
        const revised = { ...task };
        for (const field of ["title", "objective", "goal", "acceptance", "verificationCommands", "dependencies"] as const) {
          if (operation[field] !== undefined) Object.assign(revised, { [field]: operation[field] });
        }
        if (["objective", "goal", "acceptance", "verificationCommands"].some(field =>
          JSON.stringify(task[field as keyof Task]) !== JSON.stringify(revised[field as keyof Task])))
          revised.acceptanceRevision = (task.acceptanceRevision ?? 0) + 1;
        Object.assign(task, taskMetadata(revised, false, state.repoChecks));
        break;
      }
      case "split-task": {
        const { slice, task } = taskAt(operation.task);
        if (task.status !== "pending" || task.attempts || !Array.isArray(operation.replacements) || operation.replacements.length < 2) throw new Error("Cannot split started task or split without replacements");
        task.status = "superseded";
        task.supersededBy = operation.replacements.map(replacement => `${operation.task.slice(0, operation.task.lastIndexOf("/"))}/${replacement.id}`);
        slice.tasks.push(...operation.replacements.map(taskFromDraft));
        break;
      }
      case "set-status": {
        if (!["pending", "deferred", "cancelled", "superseded"].includes(operation.status)) throw new Error("Invalid roadmap status");
        const parts = operation.target.split("/");
        const entry = parts.length === 3 ? taskAt(operation.target) : undefined;
        if (entry) {
          if (entry.task.status === "passed" || entry.task.attempts) throw new Error("Cannot change started task status");
          entry.task.status = operation.status;
        } else if (parts.length === 2) {
          const slice = sliceAt(operation.target);
          if (slice.tasks.some(t => t.status === "passed" || t.attempts)) throw new Error("Cannot change started slice status");
          slice.status = operation.status;
          for (const task of slice.tasks) if (operation.status === "pending" ? task.status === "deferred" : task.status === "pending") task.status = operation.status;
        } else if (parts.length === 1) {
          const milestone = candidate.find(m => m.id === operation.target);
          if (!milestone || milestone.slices.some(s => s.tasks.some(t => t.status === "passed" || t.attempts))) throw new Error("Cannot change started milestone status");
          milestone.status = operation.status;
          for (const slice of milestone.slices) {
            if (operation.status === "pending" ? slice.status === "deferred" : slice.status === "pending") slice.status = operation.status;
            for (const task of slice.tasks) if (operation.status === "pending" ? task.status === "deferred" : task.status === "pending") task.status = operation.status;
          }
        } else throw new Error("Invalid status target");
        break;
      }
      default: throw new Error("Unknown roadmap operation");
    }
  }
  const pendingCount = candidate.reduce((count, milestone) => count + milestone.slices.reduce((sum, slice) => sum + slice.tasks.filter(task => task.status === "pending").length, 0), 0);
  const previousPending = state.milestones.reduce((count, milestone) => count + milestone.slices.reduce((sum, slice) => sum + slice.tasks.filter(task => task.status === "pending").length, 0), 0);
  if (pendingCount - previousPending > 24) throw new Error("Proposal exceeds bounded next executable scope (24 new pending tasks)");
  return stageRoadmapProposal(state, { ...input, milestones: candidate });
}

function indexed(plan: readonly Milestone[]): Map<string, Task> {
  return new Map(plan.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => [`${m.id}/${s.id}/${t.id}`, t] as const))));
}

function checkCandidate(state: ShipState, candidate: Milestone[]): void {
  const old = indexed(state.milestones), next = indexed(candidate);
  const oldGraph = state.milestones.length ? new DependencyGraph(state.milestones) : undefined;
  const newGraph = new DependencyGraph(candidate);
  const derived = new Set(["dependencyLevel", "complexity", "risk", "classificationSignals", "classificationRationale", "parallelEligible", "executionRoute", "execution", "routingDecision", "verificationPlan", "effectiveTaskType", "effectiveUncertainty"]);
  const durable = (task: Task) => Object.fromEntries(Object.entries(task).filter(([key]) => !derived.has(key)));
  for (const [key, previous] of old) {
    const replacement = next.get(key);
    if (previous.status === "passed" || previous.attempts > 0 || ["running", "verifying"].includes(previous.status)) {
      if (!replacement || JSON.stringify(durable(previous)) !== JSON.stringify(durable(replacement)))
        throw new Error(`Cannot alter started task or passed evidence: ${key}`);
    } else if (replacement) {
      // A deleted or omitted prerequisite does not become implicitly satisfied.
      const unresolved = oldGraph?.dependencies.get(key)?.filter(dep => old.get(dep)?.status !== "passed") ?? [];
      const retained = newGraph.dependencies.get(key) ?? [];
      for (const dep of unresolved) {
        if (retained.includes(dep)) continue;
        const successors = next.get(dep)?.status === "superseded" ? next.get(dep)?.supersededBy : undefined;
        if (!successors?.length || !successors.every(successor => retained.includes(successor) && ["pending", "passed"].includes(next.get(successor)?.status ?? "")))
          throw new Error(`Cannot remove unfinished prerequisite ${dep} from ${key} without all replacement tasks`);
      }
    }
  }
  const retired = new Set((state.proposalHistory ?? []).filter(p => p.status === "approved").flatMap(p => [...indexed(p.milestones).keys()]));
  for (const [key, task] of next) {
    if (!old.has(key) && (task.status !== "pending" || task.attempts !== 0 || retired.has(key))) throw new Error(`New task must have an unused stable ID and pending status: ${key}`);
  }
}

export function stageRoadmapProposal(state: ShipState, input: ProposalInput): ShipState {
  if (!input.request?.trim() || !Array.isArray(input.impactedSummary) || input.impactedSummary.some(x => typeof x !== "string" || !x.trim())) throw new Error("Proposal needs request and valid impact summary");
  if (state.pendingProposal?.status === "pending") throw new Error("A roadmap proposal is awaiting approval");
  if (input.futureMilestones?.some(m => !/^M[0-9]{2,}$/.test(m.id) || !m.title?.trim() || !m.outcome?.trim() || (m.approach !== undefined && !m.approach.trim()))) throw new Error("Invalid future outline");
  const milestones = normalizePlan(structuredClone(input.milestones), false, state.repoChecks);
  if (!state.milestones.length && milestones.reduce((count, m) => count + m.slices.reduce((sum, s) => sum + s.tasks.filter(t => t.status === "pending").length, 0), 0) > 24)
    throw new Error("Initial proposal exceeds bounded next executable scope (24 pending tasks); use future outline");
  if (input.futureMilestones && (new Set(input.futureMilestones.map(m => m.id)).size !== input.futureMilestones.length ||
      input.futureMilestones.some(m => milestones.some(active => active.id === m.id)))) throw new Error("Future outline IDs must be unique and outside active scope");
  checkCandidate(state, milestones);
  const prior = indexed(state.milestones), proposed = indexed(milestones);
  const consequential = (state.milestones.length > 0 && milestones.some(m => !state.milestones.some(old => old.id === m.id))) ||
    [...prior].some(([key, task]) => {
      const nextTask = proposed.get(key);
      return !nextTask || nextTask.status !== task.status ||
        !!nextTask && (JSON.stringify(task.dependencies) !== JSON.stringify(nextTask.dependencies) ||
          JSON.stringify(task.acceptance) !== JSON.stringify(nextTask.acceptance) ||
          JSON.stringify(task.verificationCommands) !== JSON.stringify(nextTask.verificationCommands));
    }) ||
    [...proposed].some(([key, task]) => !prior.has(key) && (task.risk !== "LOW" || task.uncertainty !== "LOW")) ||
    /\b(delete|destroy|drop|revoke|publish|deploy|release|payment|billing|production|irreversible)\b/i.test(input.request);
  const next = structuredClone(state);
  next.pendingProposal = { id: randomUUID(), request: input.request, sessionId: input.sessionId,
    targetRevision: state.roadmapRevision, milestones, futureMilestones: input.futureMilestones === undefined ? undefined : structuredClone(input.futureMilestones),
    impactedSummary: [...input.impactedSummary], approvalBoundary: consequential ? "explicit" : "routine", status: "pending", createdAt: new Date().toISOString() };
  return next;
}

export function approveRoadmapProposal(state: ShipState): ShipState {
  const proposal = state.pendingProposal;
  if (!proposal || proposal.status !== "pending") throw new Error("No pending roadmap proposal");
  if (proposal.targetRevision !== state.roadmapRevision) throw new Error("Stale roadmap proposal");
  if (state.activeAttempt || state.nativeBatch || state.nativePlanning || state.pendingJudgment ||
      ["executing", "verifying", "reviewing"].includes(state.phase)) throw new Error("Cannot approve roadmap during active work");
  const milestones = normalizePlan(structuredClone(proposal.milestones), false, state.repoChecks);
  checkCandidate(state, milestones);
  const next = structuredClone(state);
  next.milestones = milestones;
  next.futureMilestones = structuredClone((proposal.futureMilestones ?? state.futureMilestones ?? []).filter(m => !milestones.some(active => active.id === m.id)));
  next.roadmapRevision++;
  next.pendingProposal = undefined;
  next.proposalHistory = [...(state.proposalHistory ?? []), { ...proposal, status: "approved" }];
  if (next.phase === "complete") next.phase = "idle";
  return next;
}

export function rejectRoadmapProposal(state: ShipState, reason: string): ShipState {
  if (!state.pendingProposal || state.pendingProposal.status !== "pending") throw new Error("No pending roadmap proposal");
  if (!reason?.trim()) throw new Error("Rejection reason required");
  const next = structuredClone(state);
  next.proposalHistory = [...(next.proposalHistory ?? []), { ...next.pendingProposal!, status: "rejected", reason }];
  next.pendingProposal = undefined;
  return next;
}
