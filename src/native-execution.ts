import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acceptanceFingerprint, evaluateTaskEvidence, outputRequirements, type TaskEvidence } from "./evidence.ts";
import { DependencyGraph } from "./dependency-graph.ts";
import { tasks, refresh, parsePlan, recomputeJudgedTask } from "./model.ts";
import { plannerPrompt } from "./prompts.ts";
import { buildPlannerContext, buildWorkerContext } from "./context.ts";
import { canContinueAutonomously, classifyAutonomousApproval } from "./autonomy.ts";
import { approveRoadmapProposal, rejectRoadmapProposal, stageRoadmapOperations, stageRoadmapProposal, type RoadmapOperation } from "./roadmap-proposals.ts";
import { runCheck } from "./process.ts";
import { acquireLock } from "./lock.ts";
import { discoverRepoChecks } from "./verification.ts";
import { assertApprovedRepoCheck, previewRepoCheckReconciliation } from "./reconciliation.ts";
import { buildHandoffCheckpoint } from "./handoff.ts";
import { captureHandoffGit } from "./handoff-git.ts";
import { appendEvent, atomicJson, consumeInbox, loadConfig, loadState, saveState, shipDir, writeRoadmapView } from "./store.ts";
import { gitDirtySnapshot, readProjectProfile, type GitDirtySnapshot } from "./project-profile.ts";
import { recoverDiscovery, restartDiscovery, setDiscoveryGoal } from "./project.ts";
import { assertNoProcess } from "./process.ts";
import type { Milestone, NativeAssignment, NativeBatch, ShipConfig, ShipState, Task } from "./types.ts";
import { reconcileRunTarget, resolveRunTarget, targetContains, targetProgress, type RunTargetRequest } from "./run-target.ts";
import { applyDecision, confidenceThreshold, eligibleRoles, fallback, hashJudgmentRequest, judgmentTimeoutMs, parseChoice, parseSemanticAnswers, semanticTaskTypes } from "./judgment.ts";
import type { ExecutionRole, RoutingDecision } from "./types.ts";

export interface RoleCandidate { role: ExecutionRole; model?: string; pricing?: { input: number; output: number }; capability?: number; estimatedTaskCost?: string; }
export interface RoutingContext { candidates: RoleCandidate[]; jevAvailable: boolean; }

export interface NativeOutcome { batchId: string; assignmentId: string; status: "passed" | "failed" | "partial"; summary: string; evidence?: TaskEvidence; }
/** Reject extra keys (especially forged human approvals) before persisting agent input. */
function validateOutcomeEvidence(value: unknown): asserts value is TaskEvidence {
  const record = (input: unknown, keys: readonly string[]): input is Record<string, unknown> =>
    !!input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => keys.includes(key));
  const text = (input: unknown, limit = 16_000): input is string => typeof input === "string" && input.length <= limit;
  const list = (input: unknown): input is unknown[] => Array.isArray(input) && input.length <= 100;
  if (!record(value, ["acceptanceFingerprint", "commands", "reviews", "research"]) ||
    (value.acceptanceFingerprint !== undefined && !text(value.acceptanceFingerprint, 80)) ||
    (value.commands !== undefined && (!list(value.commands) || !value.commands.every(item =>
      record(item, ["command", "ok"]) && text(item.command, 4_096) && typeof item.ok === "boolean"))) ||
    (value.reviews !== undefined && (!list(value.reviews) || !value.reviews.every(item =>
      record(item, ["kind", "ok"]) && ["security-review", "independent-review"].includes(String(item.kind)) && typeof item.ok === "boolean"))) ||
    (value.research !== undefined && (!record(value.research, ["path", "fingerprint", "acceptanceFingerprint", "answer", "findings"]) ||
      !text(value.research.path, 4_096) || !text(value.research.fingerprint, 80) ||
      !text(value.research.acceptanceFingerprint, 80) || !text(value.research.answer) ||
      !list(value.research.findings) || !value.research.findings.every(item =>
        record(item, ["criterion", "finding", "support"]) && text(item.criterion, 4_096) &&
        text(item.finding) && text(item.support))))) throw new Error("Invalid bounded SHIP evidence");
}
const locks = new Map<string, Promise<void>>();
async function serialized<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  locks.set(root, next);
  await previous;
  try {
    const unlock = await acquireLock(root);
    try { return await fn(); } finally { await unlock(); }
  } finally { release(); if (locks.get(root) === next) locks.delete(root); }
}

async function persist(root: string, state: ShipState, type: string, detail: Record<string, unknown> = {}) {
  refresh(state);
  await saveState(root, state);
  await writeRoadmapView(root, state);
  await appendEvent(root, { type, ...detail });
}
function instructions(root: string, batch: NativeBatch, state: ShipState, workerContexts: readonly string[] = []): string {
  const graph = new DependencyGraph(state.milestones);
  const entries = tasks(state);
  const lines = batch.assignments.map(assignment => {
    const task = entries.find(entry => entry.key === assignment.key)!.t;
    const prerequisites = graph.dependencies.get(assignment.key)!;
    const name = `Ship${assignment.id.replaceAll("-", "").slice(0, 26)}`;
    if (batch.stage === "reviewing") return `- ${assignment.key} [${assignment.id}]: Independently review completed work against: ${task.acceptance.join("; ")}. ${task.verificationPlan.requirements.filter(r => !r.command).map(r => `${r.kind}: ${r.reason}`).join("; ")}. Prior verified evidence: ${JSON.stringify(assignment.evidence ?? {}).slice(0, 8_000)}. Use OMP task tool agent: "${task.execution.verificationSpecialist ?? "reviewer"}", name: "${name}", and include assignment ID ${assignment.id} in its task text; not the original writer. ${task.execution.verificationSpecialist === "security-reviewer" ? "Report your native security-reviewer coverage_summary, findings and any deferred work; substantive findings or deferred work cannot pass." : "Report your native reviewer overall_correctness verdict and findings; actionable findings or an adverse/unknown verdict cannot pass."} Await substantive review findings before reporting.`;
    const route = task.execution;
    const agent = route.specialist ?? (route.role === "smol" ? "sonic" : "task");
    const dispatch = route.mode === "main" ? "Work directly in the main session without a subagent"
      : `Use OMP task tool with agent: "${agent}", name: "${name}", and include assignment ID ${assignment.id} in its task text${route.role === "plan" || route.role === "slow" ? `; SHIP's public before_subagent_spawn hook resolves its configured @${route.role} model role` : ""}, await its actual result`;
    return `- ${assignment.key} [${assignment.id}]: ${task.title}. Goal: ${task.goal}. Objective: ${task.objective}. Acceptance: ${task.acceptance.join("; ")}. Current acceptance fingerprint: ${acceptanceFingerprint(task, task.acceptanceRevision ?? 0)} (revision ${task.acceptanceRevision ?? 0}); supply this in research evidence. Dependencies already passed: ${prerequisites.join(", ") || "none"}. Owned files: ${task.affectedFiles.join(", ") || "unspecified"}; domains: ${task.affectedDomains.join(", ") || "unspecified"}. ${dispatch}. Stored route: ${route.role}${route.specialist ? `/${route.specialist}` : ""}; ${route.reason}. ${task.lastError ? `Previous failure (repair only within scope): ${task.lastError}` : ""}\nBounded worker context (include verbatim in assignment prompt):\n${workerContexts[batch.assignments.indexOf(assignment)] ?? "Read task context from the approved roadmap before work."}`;
  });
  const reporting = `After each assignment finishes, call ship_outcome with batchId ${batch.id}, its assignmentId, status passed/failed/partial, and a concrete summary of actual results. For research/design/documentation include evidence.research with a workspace-relative artifact path, its sha256 content fingerprint, acceptanceFingerprint for the current task acceptance revision, a substantive answer present in the artifact, and supported findings for every exact acceptance criterion. Do not invent executable commands or reviewer verdicts; SHIP verifies those itself. Human approval only comes from /ship verify in the main session after all other checks. Report failures and partial work honestly; do not claim success from intention. SHIP runs required verification itself and will issue a follow-up batch only after every assignment has reported. Do not launch any separate SHIP process for these assignments.`;
  return `SHIP OMP-native ${batch.stage} batch for ${root}, roadmap revision ${batch.revision}. ${batch.assignments.length > 1 ? "These tasks form a proven safe parallel group with disjoint ownership: dispatch in ONE OMP task tool batch when task.batch is enabled; otherwise launch separate OMP eval agent() calls concurrently with the same agent names and await all results. Do not run verification/build/formatters in parallel with sibling edits." : "Perform this one assignment before asking SHIP for successors."}${state.preexistingWork?.paths.length ? `\nPreexisting user changes (DO NOT overwrite, discard, reset or claim ownership): ${state.preexistingWork.paths.join(", ")}. Preserve unrelated changes; stop if work unexpectedly overlaps.` : ""}\n${lines.join("\n")}\n${reporting}`;
}

function normalizedPath(value: string): string {
  const relative = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return process.platform === "win32" ? relative.toLowerCase() : relative;
}
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function ownershipConflict(state: ShipState, candidate: readonly { key: string }[]): string | undefined {
  const work = state.preexistingWork;
  if (!work || (!work.paths.length && !work.truncated && !work.unknown)) return undefined;
  if (work.unknown || work.truncated) return "Git changes cannot be fully inspected for safe ownership";
  const entries = tasks(state);
  for (const assignment of candidate) {
    const task = entries.find(entry => entry.key === assignment.key)!.t;
    if (!task.affectedFiles.length) return `${assignment.key} has no declared file ownership while the checkout contains user changes`;
    for (const owned of task.affectedFiles) {
      const file = normalizedPath(owned);
      if (!file || file === "." || file.startsWith("/") || file.includes("..") || /[*?{}]/.test(file)) return `${assignment.key} has uncertain file ownership: ${owned}`;
      const conflicting = work.paths.find(dirty => overlaps(normalizedPath(dirty), file));
      if (conflicting) return `${assignment.key} overlaps preexisting user change ${conflicting}`;
    }
  }
}

/** A successful OMP process is not a passing review. Unknown or conflicting verdicts fail closed. */
export function reviewVerdict(payload: unknown): "correct" | "incorrect" | "unknown" {
  const seen = new Set<unknown>();
  const visit = (value: unknown): "correct" | "incorrect" | "unknown" => {
    if (typeof value === "string") {
      try { return visit(JSON.parse(value)); } catch { /* The result may be formatted text. */ }
      const verdicts = [...value.matchAll(/\b(?:overall_correctness\s*["':= ]+\s*|patch is\s+)(correct|incorrect)\b/gi)].map(match => match[1].toLowerCase());
      return verdicts.length && verdicts.every(item => item === verdicts[0]) ? verdicts[0] as "correct" | "incorrect" : "unknown";
    }
    if (!value || typeof value !== "object" || seen.has(value)) return "unknown";
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.status === "invalid" || record.status === "unavailable") return "unknown";
    const verdicts: ("correct" | "incorrect")[] = [];
    if ("coverage_summary" in record) {
      if (typeof record.coverage_summary !== "string" || !record.coverage_summary.trim() ||
          (record.findings !== undefined && !Array.isArray(record.findings)) ||
          (record.deferred !== undefined && !Array.isArray(record.deferred)) ||
          (record.reviewed_paths !== undefined && (!Array.isArray(record.reviewed_paths) || record.reviewed_paths.some(item => typeof item !== "string")))) return "unknown";
      if ((record.deferred as unknown[] | undefined)?.length) return "unknown";
      const findings = record.findings as { severity?: unknown }[] | undefined;
      if (findings?.some(finding => !finding || !["critical", "high", "medium", "low", "informational"].includes(String(finding.severity)))) return "unknown";
      verdicts.push(findings?.some(finding => finding.severity !== "informational") ? "incorrect" : "correct");
    } else if (record.findings !== undefined) {
      if (!Array.isArray(record.findings) || record.findings.some(finding => !finding || !Number.isInteger(finding.priority) || finding.priority < 0 || finding.priority > 3)) return "unknown";
      if (record.findings.some(finding => finding.priority < 3)) verdicts.push("incorrect");
    }
    if (record.overall_correctness === "correct" || record.overall_correctness === "incorrect") verdicts.push(record.overall_correctness);
    else if ("overall_correctness" in record) return "unknown";
    for (const key of ["data", "structuredOutput", "structured", "summary", "output", "resultText"]) {
      if (key in record) {
        const verdict = visit(record[key]);
        if (verdict !== "unknown") verdicts.push(verdict);
      }
    }
    return verdicts.length && verdicts.every(item => item === verdicts[0]) ? verdicts[0] : "unknown";
  };
  return visit(payload);
}

async function fingerprint(root: string, filename: string): Promise<string> {
  try {
    const fullPath = path.join(root, filename);
    const stat = await lstat(fullPath);
    if (stat.isDirectory()) return "directory";
    if (!stat.isFile()) return "unknown";
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(fullPath)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

/** Capture this batch's owned paths without blessing edits to earlier, unrelated task files. */
async function snapshotOwned(root: string, state: ShipState, batch: NativeBatch): Promise<void> {
  const current = await gitDirtySnapshot(root);
  if (current.unknown || current.truncated) {
    delete state.ownedSnapshots;
    return;
  }
  const owned = batch.assignments.flatMap(assignment => tasks(state).find(entry => entry.key === assignment.key)!.t.affectedFiles.map(normalizedPath));
  const paths = [...new Set([...owned, ...current.paths.filter(filename => owned.some(file => overlaps(normalizedPath(filename), file)))])];
  const previous = state.ownedSnapshots ?? {};
  const unchanged = Object.fromEntries(Object.entries(previous).filter(([filename]) => !owned.some(file => overlaps(filename, file))));
  state.ownedSnapshots = { ...unchanged, ...Object.fromEntries(await Promise.all(paths.map(async filename => [normalizedPath(filename), await fingerprint(root, filename)]))) };
}

async function interveningEdit(root: string, state: ShipState, current: GitDirtySnapshot, ready: readonly { task: Task }[]): Promise<string | undefined> {
  const owned = tasks(state).filter(entry => entry.t.attempts > 0).flatMap(entry => entry.t.affectedFiles.map(normalizedPath));
  const next = ready.flatMap(entry => entry.task.affectedFiles.map(normalizedPath));
  if (!owned.length || !next.length) return;
  if ((current.unknown || current.truncated) && owned.some(file => next.some(target => overlaps(file, target)))) return "Cannot establish whether previously owned files changed since the last task";
  const snapshots = state.ownedSnapshots;
  for (const filename of [...new Set([...current.paths, ...Object.keys(snapshots ?? {})])]) {
    const normalized = normalizedPath(filename);
    if (!owned.some(file => overlaps(normalized, file)) || !next.some(file => overlaps(normalized, file))) continue;
    if (!snapshots || snapshots[normalized] === "unknown" || snapshots[normalized] !== await fingerprint(root, filename)) return `Previously owned file changed after its task: ${filename}`;
  }
}

/** Changes outside previously owned task paths remain user-owned, even between batches. */
function reconcileDirtyPaths(state: ShipState, current: GitDirtySnapshot, ready: readonly { task: { affectedFiles: string[] } }[]): void {
  const work = state.preexistingWork;
  if (!work) return;
  const attempted = tasks(state).filter(entry => entry.t.attempts > 0);
  const owned = attempted.flatMap(entry => entry.t.affectedFiles.map(normalizedPath));
  const legacyUnknown = attempted.some(entry => !entry.t.affectedFiles.length);
  const nextOwned = ready.flatMap(entry => entry.task.affectedFiles.map(normalizedPath));
  const existing = new Set(work.paths.map(normalizedPath));
  for (const dirty of current.paths) {
    const filename = normalizedPath(dirty);
    if (existing.has(filename) || owned.some(file => overlaps(filename, file))) continue;
    // Older roadmaps without ownership cannot attribute their own newly created files.
    // Still guard every new dirty file a known upcoming task might touch.
    if (legacyUnknown && !nextOwned.some(file => overlaps(filename, file))) continue;
    if (work.paths.length === 256) { work.truncated = true; break; }
    work.paths.push(dirty);
    existing.add(filename);
  }
  work.truncated ||= current.truncated;
  work.unknown ||= current.unknown;
}

function chooseBatch(state: ShipState, config: ShipConfig, sessionId: string): NativeBatch | undefined {
  const graph = new DependencyGraph(state.milestones);
  const ready = graph.readyTasks().filter(node => targetContains(state.runTarget!, node.key));
  if (!ready.length) return undefined;
  const first = ready[0];
  const safe = new Set(graph.parallelCandidatePairs().filter(([a, b]) => a.key === first.key || b.key === first.key).map(([a, b]) => a.key === first.key ? b.key : a.key));
  const chosen = [first];
  for (const node of ready.slice(1)) {
    if (!safe.has(node.key) || [node, ...chosen].some(item => item.task.execution.mode === "main" || item.task.execution.role === "plan" || item.task.execution.role === "slow")) continue;
    if (chosen.length < Math.max(1, config.limits.maxParallelTasks ?? 2) && chosen.slice(1).every(other => graph.parallelCandidatePairs().some(([a, b]) => (a.key === node.key && b.key === other.key) || (b.key === node.key && a.key === other.key)))) chosen.push(node);
  }
  const capacity = config.limits.maxDispatches - (state.dispatches ?? 0);
  const eligible = chosen.filter(node => node.task.attempts < config.limits.maxTaskAttempts).slice(0, capacity);
  if (config.judgment?.enabled && eligible.some(node => node.task.routingDecision.reason === "disabled")) throw new Error("Cannot dispatch an undecided parallel task");
  if (!eligible.length) return undefined;
  const batch: NativeBatch = { id: randomUUID(), sessionId, revision: state.roadmapRevision, stage: "executing", assignments: eligible.map(node => ({ id: randomUUID(), key: node.key, status: "pending" })) };
  for (const node of eligible) { node.task.attempts++; node.task.status = "running"; }
  state.dispatches = (state.dispatches ?? 0) + eligible.length;
  return batch;
}
async function advance(root: string, state: ShipState, config: ShipConfig, sessionId: string, routing?: RoutingContext): Promise<string> {
  if (state.discovery && !state.discovery.goalSet) return "SHIP blocked: discovery has no explicit goal. Use /ship add \"goal\" or /ship change \"goal\" before planning.";
  if (state.paused) {
    if (!state.handoff && !state.nativeBatch && !state.nativePlanning && !state.pendingJudgment &&
        !state.activeAttempt && !state.milestones.some(m => m.slices.some(s => s.tasks.some(t => ["running", "verifying"].includes(t.status))))) {
      try {
        state.handoff = buildHandoffCheckpoint(state, root, await captureHandoffGit(root));
        await persist(root, state, "native_handoff_checkpoint", { sessionId });
      } catch (error) {
        await persist(root, state, "native_paused_without_handoff", { reason: String(error) });
        return `SHIP paused; no transferable checkpoint: ${String(error)}. No assignments dispatched.`;
      }
    }
    return `SHIP paused${state.handoff ? " with validated checkpoint available for /ship resume" : ""}. No assignments dispatched.`;
  }
  if (state.phase === "blocked") return `SHIP blocked: ${state.blockedReason}. No assignments dispatched.`;
  if (state.pendingJudgment) {
    if (state.pendingJudgment.sessionId !== sessionId) return "SHIP judgment belongs to another OMP session; resume it there.";
    const timeout = config.judgment?.timeoutMs ?? judgmentTimeoutMs;
    if (config.judgment?.enabled && Date.now() - state.pendingJudgment.requestedAt < timeout) return `SHIP judgment ${state.pendingJudgment.id} is pending. Call jev_ask once, or ship_judgment with status unavailable if the tool cannot be called.`;
    const task = tasks(state).find(entry => entry.key === state.pendingJudgment!.key)?.t;
    const reason = config.judgment?.enabled ? "timeout" : "disabled";
    if (task) { task.routingDecision = fallback(task, reason); task.execution = applyDecision(task, task.routingDecision); }
    delete state.pendingJudgment;
    await persist(root, state, "native_judgment_fallback", { reason });
  }
  const currentGit = await gitDirtySnapshot(root);
  if (state.preexistingWork && currentGit.branch !== state.preexistingWork.branch) {
    state.phase = "blocked"; state.blockedReason = "Git branch changed since SHIP established task ownership; inspect work before resuming";
    await persist(root, state, "blocked", { reason: state.blockedReason }); return `SHIP blocked: ${state.blockedReason}`;
  }
  // Finish already-dispatched assignments against their persisted policy; review drift before further dispatch.
  if (state.nativeBatch) {
    const batch = state.nativeBatch;
    if (batch.sessionId !== sessionId) return "SHIP batch belongs to a different OMP session; report outstanding outcomes there.";
    if (batch.awaitingBudget) {
      if ((state.dispatches ?? 0) + batch.assignments.length > config.limits.maxDispatches) {
        state.phase = "blocked"; state.blockedReason = "Persistent dispatch budget exhausted before required independent review";
        await persist(root, state, "blocked", { reason: state.blockedReason }); return `SHIP blocked: ${state.blockedReason}`;
      }
      delete batch.awaitingBudget;
      state.dispatches = (state.dispatches ?? 0) + batch.assignments.length;
      state.phase = "verifying";
      await persist(root, state, "native_review_started", { tasks: batch.assignments.map(r => r.key) });
      return instructions(root, batch, state);
    }
    return batch.settling || batch.assignments.every(entry => entry.status !== "pending") ? settle(root, state, config, sessionId, routing) : `SHIP batch ${batch.id} is already assigned; report outstanding assignment outcomes before dispatching new work.`;
  }
  if (state.milestones.length && (await previewRepoCheckReconciliation(root, state)).changes.length)
    return "SHIP declared repository checks changed. Review additions, removals and affected evidence with /ship reconcile before dispatching more work.";
  const pendingHuman = tasks(state).filter(entry => (!state.runTarget || targetContains(state.runTarget, entry.key)) &&
    entry.t.status === "verifying" && outputRequirements(entry.t).includes("human-evaluation"));
  if (pendingHuman.length) return `SHIP awaiting main-session human approval for ${pendingHuman.map(entry => entry.key).join(", ")}. Use /ship verify before dispatching more work.`;
  if (state.pendingProposal) return `SHIP proposal ${state.pendingProposal.id} awaits approval. ${state.pendingProposal.impactedSummary.join("; ")}. Approve or reject before running work.`;
  if (state.nativePlanning || !state.milestones.length) {
    if ((state.planningFailures ?? 0) >= config.limits.maxTaskAttempts || (!state.nativePlanning && (state.dispatches ?? 0) >= config.limits.maxDispatches)) {
      state.phase = "blocked"; state.blockedReason = "Native planning attempt or dispatch budget exhausted";
      await persist(root, state, "blocked", { reason: state.blockedReason }); return `SHIP blocked: ${state.blockedReason}`;
    }
    if (state.nativePlanning && state.nativePlanning.sessionId !== sessionId) return "SHIP planning belongs to another OMP session; resume it there.";
    if (!state.nativePlanning) {
      state.nativePlanning = { id: randomUUID(), sessionId, attempts: 0, targetRevision: state.roadmapRevision };
      state.dispatches = (state.dispatches ?? 0) + 1;
    }
    state.phase = "planning"; await persist(root, state, "native_planning_started", { planning: state.nativePlanning.id });
    const context = await buildPlannerContext(root, state);
    const revision = state.milestones.length > 0;
    const outline = revision ? `\nCurrent approved roadmap (IDs and status; preserve existing tasks):\n${JSON.stringify(state.milestones.map(m => ({ id: m.id, title: m.title, outcome: m.outcome, slices: m.slices.map(s => ({ id: s.id, title: s.title, tasks: s.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, dependencies: t.dependencies })) })) })).slice(0, 20)).slice(0, 8_000)}\nCurrent future outline: ${JSON.stringify(state.futureMilestones ?? []).slice(0, 2_000)}` : "";
    return `SHIP OMP-native ${revision ? "revision" : "initial"} planning for ${root}. Use OMP task tool agent: "task", name: "ShipPlanner", to inspect without modifying files. Pass the entire planner task text below verbatim as the task agent's task prompt; do not summarize it or replace its JSON contract with a prose request. Await the agent's final answer, which MUST be raw JSON only (no Markdown, fences, or commentary). In the main session, call ship_plan with planningId ${state.nativePlanning.id} and plan set to that complete raw JSON answer.\n\nPLANNER TASK TEXT (pass everything below verbatim):\n${plannerPrompt(`${context}${outline}`, revision)}`;
  }
  if (!state.runTarget) {
    state.runTarget = resolveRunTarget(state);
    await persist(root, state, "native_target_selected", { scope: state.runTarget.scope, id: state.runTarget.id });
  }
  const progress = targetProgress(state, state.runTarget!);
  if (progress.invalid) {
    state.phase = "blocked"; state.blockedReason = progress.invalid;
    await persist(root, state, "blocked", { reason: progress.invalid });
    return `SHIP blocked: ${progress.invalid}`;
  }
  if (tasks(state).every(entry => ["passed", "deferred", "cancelled", "superseded"].includes(entry.t.status))) {
    const checks = [...new Set((state.repoChecks ?? []).filter(check => check.kind === "integration").map(check => check.command))];
    for (const [index, command] of checks.entries()) {
      const directory = path.join(shipDir(root), "attempts");
      await mkdir(directory, { recursive: true });
      let result;
      try { await assertApprovedRepoCheck(root, state, command); }
      catch (error) {
        return `SHIP declared repository checks changed. ${String(error)} No stale integration check was run.`;
      }
      try { result = await runCheck(root, command, root, config.verificationTimeoutMs ?? 300_000, undefined, path.join(directory, `native-integration-${index}.log`)); }
      catch (error) {
        state.phase = "blocked"; state.blockedReason = `Integration check could not execute: ${command}: ${String(error)}`;
        await persist(root, state, "integration_failed", { command }); return `SHIP blocked: ${state.blockedReason}`;
      }
      await atomicJson(path.join(directory, `native-integration-${index}.json`), { command, ok: result.ok, code: result.code, output: result.output });
      if (!result.ok) {
        state.phase = "blocked"; state.blockedReason = `Integration check ${result.timedOut ? "timed out" : "failed"}: ${command}\n${result.output}`;
        await persist(root, state, "integration_failed", { command }); return `SHIP blocked: ${state.blockedReason}`;
      }
    }
    state.phase = "complete"; delete state.blockedReason;
    await persist(root, state, "project_completed"); return "SHIP complete: all active tasks passed required verification; deferred, cancelled and superseded work remains visible in the roadmap.";
  }
  if (progress.complete) {
    state.phase = "complete"; delete state.blockedReason;
    await persist(root, state, "native_target_completed", { scope: state.runTarget!.scope, id: state.runTarget!.id });
    return `SHIP target complete: ${state.runTarget!.scope} ${state.runTarget!.id ?? "all"} passed required verification.`;
  }
  const ready = new DependencyGraph(state.milestones).readyTasks().filter(node => targetContains(state.runTarget!, node.key));
  reconcileDirtyPaths(state, currentGit, ready);
  const intervening = await interveningEdit(root, state, currentGit, ready);
  if (intervening) {
    state.phase = "blocked"; state.blockedReason = intervening;
    await persist(root, state, "blocked", { reason: intervening }); return `SHIP blocked: ${intervening}`;
  }
  const conflict = ownershipConflict(state, ready);
  if (conflict) {
    state.phase = "blocked"; state.blockedReason = conflict;
    await persist(root, state, "blocked", { reason: conflict }); return `SHIP blocked: ${conflict}`;
  }
  if (config.judgment?.enabled) {
    const next = ready.find(node => node.task.routingDecision.reason === "disabled");
    if (next) {
      const task = next.task;
      const eligible = eligibleRoles(task, routing?.candidates.map(c => c.role) ?? []);
      if (!routing?.jevAvailable || eligible.length < 2) {
        task.routingDecision = fallback(task, !routing?.jevAvailable ? "unavailable" : "unconfigured");
        task.execution = applyDecision(task, task.routingDecision);
        await persist(root, state, "native_judgment_fallback", { task: next.key, reason: task.routingDecision.reason });
        return advance(root, state, config, sessionId, routing);
      }
      const id = randomUUID();
      const criteria = Object.fromEntries(eligible.map(role => [role, `OMP role ${role}; choose for reliable completion at minimum estimated cost`]));
      const candidates = routing!.candidates.filter(c => eligible.includes(c.role)).map(c => {
        const estimate = c.pricing ? ((3_000 + task.profile.complexity * 1_000) * c.pricing.input +
          (700 + task.profile.complexity * 400) * c.pricing.output) / 1_000_000 : undefined;
        return { ...c, capability: c.role === "smol" ? 3 : c.role === "task" ? 6 : 9,
          ...(estimate === undefined ? {} : { estimatedTaskCost: estimate < 0.01 ? "under $0.01" :
            estimate < 0.05 ? "$0.01–$0.05" : estimate < 0.2 ? "$0.05–$0.20" : "over $0.20" }) };
      });
      const options = (items: readonly (string | number)[]) => Object.fromEntries(items.map(item => [String(item), String(item)]));
      const request = {
        state: { correlation: id, objective: task.objective, type: task.taskType, complexity: task.profile.complexity,
          uncertainty: task.profile.uncertainty, risk: Math.max(task.profile.risk, task.risk === "HIGH" ? 8 : 1),
          traits: task.profile.traits, candidates },
        questions: {
          [id]: { type: "choice", instructions: "Which eligible OMP role is the lowest-cost option likely to complete this task reliably without unnecessary capability? Select only a listed role.", criteria },
          [`${id}.taskType`]: { type: "choice", instructions: "Classify semantic task type. Respect the planner objective and explicit safety requirements; do not reinterpret dependencies or verification results.", criteria: options(semanticTaskTypes) },
          [`${id}.complexity`]: { type: "choice", instructions: "Select task complexity 1–10 based on reasoning, coupling and scope; the planner score is authoritative as a safety floor.", criteria: options([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
          [`${id}.uncertainty`]: { type: "choice", instructions: "Classify uncertainty from available task evidence. Do not erase unknown or high uncertainty from planner evidence.", criteria: options(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]) },
          [`${id}.risk`]: { type: "choice", instructions: "Classify risk, preserving security, migration and destructive signals; SHIP enforces the deterministic risk floor.", criteria: options(["LOW", "HIGH", "UNKNOWN"]) },
        },
      };
      state.pendingJudgment = { id, sessionId, revision: state.roadmapRevision, key: next.key, requestedAt: Date.now(), eligible, requestHash: hashJudgmentRequest(request) };
      await persist(root, state, "native_judgment_requested", { task: next.key, id });
      return `SHIP OMP-native judgment ${id} for ${next.key}. In the MAIN session call the PUBLIC jev_ask tool exactly once using ${JSON.stringify(request)}. SHIP observes the public tool result and advances automatically. If jev_ask is unavailable, disabled, unconfigured, or cannot be called, call ship_judgment with id ${id} and status unavailable. Do not launch assignment work until SHIP issues its next batch.`;
    }
  }
  const batch = chooseBatch(state, config, sessionId);
  if (!batch) {
    const graph = new DependencyGraph(state.milestones);
    const failed = graph.readyTasks().filter(node => targetContains(state.runTarget!, node.key))
      .find(node => node.task.attempts >= config.limits.maxTaskAttempts);
    const unavailable = graph.order.filter(node => targetContains(state.runTarget!, node.key)).find(node => ["pending", "failed", "deferred", "cancelled", "superseded"].includes(node.task.status) &&
      (["deferred", "cancelled", "superseded"].includes(node.task.status) ||
        (graph.dependencies.get(node.key) ?? []).some(key => ["deferred", "cancelled", "superseded"].includes(tasks(state).find(entry => entry.key === key)?.t.status ?? ""))));
    state.phase = "blocked";
    state.blockedReason = failed ? `${failed.key} exhausted its persistent repair budget` :
      unavailable ? `${unavailable.key} or one of its prerequisites is deferred, cancelled or superseded; revise its prerequisites or restore the prerequisite` :
      (state.dispatches ?? 0) >= config.limits.maxDispatches ? "Persistent dispatch budget exhausted" : "No target task is ready; unresolved prerequisites remain (possibly outside the selected target)";
    await persist(root, state, "blocked", { reason: state.blockedReason }); return `SHIP blocked: ${state.blockedReason}`;
  }
  const contexts = await Promise.all(batch.assignments.map(assignment => buildWorkerContext(root, state, assignment.key)));
  state.nativeBatch = batch; state.phase = "executing";
  await persist(root, state, "native_batch_started", { batch: batch.id, tasks: batch.assignments.map(a => a.key) });
  return instructions(root, batch, state, contexts);
}
/** Establish the first goal under the same project lock as discovery approval. */
export function setNativeDiscoveryGoal(root: string, request: string): Promise<void> {
  return serialized(root, () => setDiscoveryGoal(root, request));
}
/** Restart cancelled research under the same project lock as submission and goal setting. */
export function restartNativeDiscovery(root: string, sessionId: string): Promise<string> {
  return serialized(root, () => restartDiscovery(root, sessionId));
}


/** Discovery is research only. The correlated main session and user must both approve persistence. */
export function submitNativeDiscovery(root: string, sessionId: string, discoveryId: string, summary: string,
  approve: (summary: string) => Promise<boolean>): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (!state.discovery || state.discovery.id !== discoveryId || state.discovery.sessionId !== sessionId ||
        state.discovery.status !== "researching" || state.discovery.goalSet || state.nativePlanning || state.nativeBatch ||
        state.milestones.length) throw new Error("Stale or foreign discovery assignment");
    if (!summary.trim() || summary.length > 6000) throw new Error("Discovery summary must contain 1–6000 characters");
    const file = path.join(shipDir(root), "DISCOVERY.md");
    let existing: string | undefined;
    try { existing = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing !== undefined && (!existing.trim() || existing.length > 6001))
      throw new Error("Unapproved DISCOVERY.md exists but is empty or too large; inspect it before continuing");
    const proposed = summary.trim() + "\n";
    const reviewed = existing ?? proposed;
    const previous = existing !== undefined && existing !== proposed;
    if (!await approve(previous
      ? `An unapproved DISCOVERY.md survived interrupted approval. Review and approve the existing summary below instead of the new research result:\n\n${reviewed}`
      : reviewed)) {
      state.discovery.status = "cancelled";
      await saveState(root, state);
      return "SHIP discovery cancelled; no summary approved. Use /ship init to restart discovery.";
    }
    if (existing === undefined) {
      try { await writeFile(file, proposed, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== proposed) throw error;
      }
    } else if (await readFile(file, "utf8") !== existing) {
      throw new Error("DISCOVERY.md changed during approval; review it again before continuing");
    }
    state.discovery.status = "approved";
    await saveState(root, state);
    return "SHIP discovery approved and saved to .ship/DISCOVERY.md. No goal was inferred; use /ship add \"goal\" or /ship change \"goal\" before /ship run.";
  });
}

export function startNativeRun(root: string, sessionId: string, routing?: RoutingContext, request?: RunTargetRequest): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (state.discovery && !state.discovery.goalSet) return "SHIP blocked: discovery has no explicit goal. Use /ship add \"goal\" or /ship change \"goal\" before planning.";
    if (state.workspace) throw new Error("Standalone worktree state cannot be reused in OMP's checkout; use a fresh native project");
    if (state.activeAttempt) throw new Error("A standalone controller attempt is active; reconcile it before OMP-native execution");
    if (request && (state.nativeBatch || state.pendingJudgment || state.nativePlanning))
      throw new Error("Cannot change run target while native work or planning is active");
    if (request || !state.runTarget || (state.milestones.length && state.phase === "complete" &&
        targetProgress(state, state.runTarget).complete &&
        tasks(state).some(entry => !["passed", "deferred", "cancelled", "superseded"].includes(entry.t.status)))) {
      state.runTarget = resolveRunTarget(state, request);
      await persist(root, state, "native_target_selected", { scope: state.runTarget.scope, id: state.runTarget.id });
    }
    if (!state.preexistingWork) {
      const snapshot = await gitDirtySnapshot(root);
      state.preexistingWork = { branch: snapshot.branch, paths: snapshot.paths, ...(snapshot.truncated ? { truncated: true } : {}), ...(snapshot.unknown ? { unknown: true } : {}) };
      await saveState(root, state);
    }
    await readProjectProfile(root);
    await consumeInbox(root, state);
    if (state.phase === "complete" && !state.nativeBatch && !state.nativePlanning &&
        tasks(state).some(entry => !["passed", "deferred", "cancelled", "superseded"].includes(entry.t.status))) state.phase = "idle";
    return advance(root, state, await loadConfig(root), sessionId, routing);
  });
}
/** Explicit recovery is allowed only after the caller confirms every former OMP worker is dead. */
export function recoverNativeRun(root: string, sessionId: string, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    await assertNoProcess(root);
    const state = await loadState(root), config = await loadConfig(root);
    if (state.discovery && !state.discovery.goalSet) {
      if (state.discovery.status === "researching") return recoverDiscovery(root, sessionId);
      return "SHIP blocked: discovery has no explicit goal. Use /ship init to restart cancelled discovery, or /ship add \"goal\" or /ship change \"goal\" after approval.";
    }
    if (state.workspace || state.activeAttempt) throw new Error("Standalone execution requires separate recovery");
    if (state.nativeBatch) {
      const batch = state.nativeBatch;
      if (batch.awaitingBudget) {
        batch.sessionId = sessionId;
        await persist(root, state, "native_review_recovered", { batch: batch.id });
        return `SHIP blocked: ${state.blockedReason}`;
      }
      if (batch.assignments.some(a => a.status === "pending")) {
        for (const assignment of batch.assignments) if (assignment.status === "pending") {
          assignment.status = "failed"; assignment.summary = "Worker terminated without reporting; explicitly recovered after confirming it is dead";
        }
        batch.settling = true;
      }
      batch.sessionId = sessionId;
      await persist(root, state, "native_worker_recovered", { batch: batch.id });
    } else if (state.nativePlanning) {
      state.planningFailures = (state.planningFailures ?? 0) + 1;
      delete state.nativePlanning;
      state.phase = "idle";
      await persist(root, state, "native_planning_recovered");
    } else if (state.pendingJudgment) {
      const pending = state.pendingJudgment;
      const task = tasks(state).find(entry => entry.key === pending.key)?.t;
      if (task) { task.routingDecision = fallback(task, "unavailable"); task.execution = applyDecision(task, task.routingDecision); }
      delete state.pendingJudgment;
      await persist(root, state, "native_judgment_recovered", { task: pending.key });
    }
    if (state.phase === "blocked" && state.nativeBatch?.awaitingBudget) return `SHIP blocked: ${state.blockedReason}`;
    if (state.phase === "blocked") { state.phase = "idle"; delete state.blockedReason; }
    await consumeInbox(root, state);
    if (!state.runTarget) {
      state.runTarget = resolveRunTarget(state);
      await persist(root, state, "native_target_selected", { scope: state.runTarget.scope, id: state.runTarget.id });
    }
    return advance(root, state, config, sessionId, routing);
  });
}
/** Draft initial or revised scope without changing the approved roadmap or dispatching work. */
export function requestNativePlan(root: string, sessionId: string, request: string, intent: "add" | "change" | "expand", routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (!request?.trim() || !["add", "change", "expand"].includes(intent)) throw new Error("A change request and valid intent are required");
    if (state.discovery && !state.discovery.goalSet) throw new Error("Discovery needs an explicit goal before planning");
    if (state.workspace || state.activeAttempt || state.nativeBatch || state.pendingJudgment || state.nativePlanning || state.pendingProposal)
      throw new Error("Finish active work or resolve the pending proposal before requesting another plan");
    if (state.paused || state.phase === "blocked") throw new Error("Resume or resolve the blocked run before planning");
    const snapshot = await gitDirtySnapshot(root);
    if (state.preexistingWork && snapshot.branch !== state.preexistingWork.branch) throw new Error("Git branch changed since SHIP established ownership");
    if (!state.preexistingWork) state.preexistingWork = { branch: snapshot.branch, paths: snapshot.paths, truncated: snapshot.truncated, unknown: snapshot.unknown };
    const config = await loadConfig(root);
    if ((state.dispatches ?? 0) >= config.limits.maxDispatches) throw new Error("Persistent dispatch budget exhausted");
    state.nativePlanning = { id: randomUUID(), sessionId, attempts: 0, request: request.trim(), intent, targetRevision: state.roadmapRevision };
    state.dispatches = (state.dispatches ?? 0) + 1;
    await persist(root, state, "native_plan_requested", { intent, planning: state.nativePlanning.id });
    return advance(root, state, config, sessionId, routing);
  });
}

export function submitNativePlan(root: string, sessionId: string, planningId: string, plan: string, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root), config = await loadConfig(root);
    if (state.workspace || state.nativeBatch || state.pendingProposal || !state.nativePlanning ||
        state.nativePlanning.id !== planningId || state.nativePlanning.sessionId !== sessionId ||
        state.nativePlanning.targetRevision !== undefined && state.nativePlanning.targetRevision !== state.roadmapRevision)
      throw new Error("Stale or foreign native planning assignment");
    if (state.discovery && !state.discovery.goalSet) throw new Error("Discovery has no explicit goal; native planning is forbidden");
    const current = await gitDirtySnapshot(root);
    if (state.preexistingWork) {
      if (current.branch !== state.preexistingWork.branch) throw new Error("Git branch changed since SHIP established ownership");
      const paths = [...new Set([...state.preexistingWork.paths, ...current.paths])];
      state.preexistingWork.paths = paths.slice(0, 256);
      state.preexistingWork.truncated ||= current.truncated || paths.length > 256;
      state.preexistingWork.unknown ||= current.unknown;
    }
    state.nativePlanning.attempts++;
    let staged: ShipState;
    try {
      if (typeof plan !== "string" || plan.length > 1_000_000) throw new Error("Planning output exceeds 1 MB or is not text");
      const raw: unknown = JSON.parse(plan.trim());
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Planner answer must be a JSON object");
      const answer = raw as Record<string, unknown>;
      const summary = answer.impactedSummary;
      if (summary !== undefined && (!Array.isArray(summary) || summary.some(item => typeof item !== "string" || !item.trim()))) throw new Error("Invalid impactedSummary");
      const outline = answer.futureMilestones;
      if (outline !== undefined && !Array.isArray(outline)) throw new Error("Invalid futureMilestones");
      if (state.milestones.length) {
        if (!Array.isArray(answer.operations) || "milestones" in answer) throw new Error("Revision requires operations, not a replacement roadmap");
        if (!state.nativePlanning.request) throw new Error("Revision planning request is missing");
        staged = stageRoadmapOperations(state, {
          request: state.nativePlanning.request, sessionId, operations: answer.operations as RoadmapOperation[],
          impactedSummary: (summary as string[] | undefined) ?? ["Requested roadmap revision"],
          futureMilestones: (outline ?? state.futureMilestones) as ShipState["futureMilestones"],
        });
      } else {
        if (state.milestones.length || !Array.isArray(answer.milestones) || "operations" in answer) throw new Error("Initial draft requires milestones");
        const checks = await discoverRepoChecks(root);
        const milestones = parsePlan(plan, checks, true);
        const candidate = { ...state, repoChecks: checks };
        staged = stageRoadmapProposal(candidate, {
          request: state.nativePlanning.request ?? (await readFile(path.join(shipDir(root), "PROJECT.md"), "utf8")).trim(),
          sessionId, milestones, futureMilestones: outline as ShipState["futureMilestones"],
          impactedSummary: (summary as string[] | undefined) ?? ["Initial executable slice and future outline"],
        });
      }
    } catch (error) {
      state.planningFailures = (state.planningFailures ?? 0) + 1;
      if (state.nativePlanning.attempts >= config.limits.maxTaskAttempts || (state.dispatches ?? 0) >= config.limits.maxDispatches) {
        state.phase = "blocked"; state.blockedReason = `Native planning budget exhausted: ${String(error)}`;
        await persist(root, state, "blocked", { reason: state.blockedReason });
        return `SHIP blocked: ${state.blockedReason}`;
      }
      state.dispatches = (state.dispatches ?? 0) + 1;
      await persist(root, state, "native_planning_failed", { error: String(error) });
      return `SHIP planning rejected: ${String(error)}. Fix the plan JSON and call ship_plan again with planningId ${planningId}.`;
    }
    delete staged.nativePlanning;
    staged.phase = "idle";
    await persist(root, staged, "native_proposal_staged", { proposal: staged.pendingProposal?.id });
    if (staged.autonomy === "yolo" && canContinueAutonomously(staged, sessionId).safe &&
        classifyAutonomousApproval(staged, staged.pendingProposal!.milestones, staged.pendingProposal!.futureMilestones).safe) {
      const approved = approveRoadmapProposal(staged);
      approved.runTarget = !approved.runTarget || !approved.runTarget.keys.length ?
        resolveRunTarget(approved, approved.runTarget?.scope === "all" ? { scope: "all" } : undefined) :
        reconcileRunTarget(approved, approved.runTarget);
      await persist(root, approved, "native_proposal_auto_approved");
      return advance(root, approved, config, sessionId, routing);
    }
    return `SHIP proposal ${staged.pendingProposal!.id} staged for approval; no work dispatched. ${staged.pendingProposal!.impactedSummary.join("; ")}. Preview and approve or reject the proposal before running.`;
  });
}

export function approveNativeProposal(root: string, sessionId: string, run: boolean, routing: RoutingContext | undefined, previewedProposal: string, request?: RunTargetRequest): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (!state.pendingProposal || state.pendingProposal.sessionId !== sessionId) throw new Error("Proposal belongs to another session or is missing");
    if (typeof previewedProposal !== "string" || JSON.stringify(state.pendingProposal) !== previewedProposal)
      throw new Error("Proposal changed since preview; inspect and approve the current proposal instead");
    if (state.paused || state.phase === "blocked") throw new Error("Resume or resolve the blocked run before approval");
    const current = await gitDirtySnapshot(root);
    if (state.preexistingWork && current.branch !== state.preexistingWork.branch) throw new Error("Git branch changed since SHIP established ownership");
    const approved = approveRoadmapProposal(state);
    approved.runTarget = request ? resolveRunTarget(approved, request) :
      !approved.runTarget || !approved.runTarget.keys.length ? resolveRunTarget(approved) :
        reconcileRunTarget(approved, approved.runTarget);
    await persist(root, approved, "native_proposal_approved", { sessionId });
    return run ? advance(root, approved, await loadConfig(root), sessionId, routing) : `SHIP roadmap revision ${approved.roadmapRevision} approved; no assignments dispatched.`;
  });
}

export function rejectNativeProposal(root: string, sessionId: string, reason: string): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (!state.pendingProposal || state.pendingProposal.sessionId !== sessionId) throw new Error("Proposal belongs to another session or is missing");
    const rejected = rejectRoadmapProposal(state, reason);
    await persist(root, rejected, "native_proposal_rejected", { sessionId, reason });
    return "SHIP proposal rejected; approved roadmap unchanged.";
  });
}


/** The public spawn event only routes a proposed child; it never proves completion. */
export function routeNativeSpawn(root: string, sessionId: string, spawnKey: string | undefined, agent: string, available: (alias: string) => boolean): Promise<string | undefined> {
  if (!spawnKey?.includes("Ship")) return Promise.resolve(undefined);
  return serialized(root, async () => {
    const state = await loadState(root), batch = state.nativeBatch;
    if (!batch || batch.sessionId !== sessionId || batch.awaitingBudget) return undefined;
    const assignment = batch.assignments.find(item => spawnKey.includes(`Ship${item.id.replaceAll("-", "").slice(0, 26)}`));
    if (!assignment || assignment.status !== "pending") return undefined;
    const task = tasks(state).find(item => item.key === assignment.key)!.t;
    const expected = batch.stage === "reviewing" ? task.execution.verificationSpecialist ?? "reviewer"
      : task.execution.specialist ?? (task.execution.role === "smol" ? "sonic" : "task");
    if (agent !== expected) throw new Error(`SHIP ${assignment.key} requires OMP agent ${expected}, not ${agent}`);
    // Later OMP hooks may still block this spawn. Only a completed task result
    // can confirm a specialist, never this pre-spawn routing event.
    if (batch.stage !== "executing" || !["plan", "slow"].includes(task.execution.role)) return undefined;
    const alias = `@${task.execution.role}`;
    if (!available(alias)) throw new Error(`OMP model role ${alias} is unavailable; configure it before dispatching ${assignment.key}`);
    assignment.routed = true;
    await saveState(root, state);
    return alias;
  });
}

/** Record a correlated completed result, including the review verdict rather than only process success. */
export function confirmNativeSpecialist(root: string, sessionId: string, assignmentId: string, agent: string, result?: unknown): Promise<void> {
  return serialized(root, async () => {
    const state = await loadState(root), batch = state.nativeBatch;
    if (!batch || batch.sessionId !== sessionId || batch.awaitingBudget) return;
    const assignment = batch.assignments.find(item => item.id === assignmentId && item.status === "pending");
    if (!assignment) return;
    const task = tasks(state).find(item => item.key === assignment.key)!.t;
    const expected = batch.stage === "reviewing" ? task.execution.verificationSpecialist ?? "reviewer" : task.execution.specialist;
    if (expected !== agent) return;
    assignment.specialistDispatched = true;
    if (batch.stage === "reviewing") assignment.reviewVerdict ??= reviewVerdict(result);
    await saveState(root, state);
  });
}

async function verify(root: string, state: ShipState, assignment: NativeAssignment, config: ShipConfig): Promise<boolean> {
  const task = tasks(state).find(entry => entry.key === assignment.key)!.t;
  task.status = "verifying"; state.phase = "verifying";
  // Verification uses the persisted policy; changed declarations await explicit reconciliation.
  const acceptance = acceptanceFingerprint(task, task.acceptanceRevision ?? 0);
  // Agent-supplied command/review claims never count as native verification.
  assignment.evidence = { research: assignment.evidence?.research, acceptanceFingerprint: acceptance, commands: [], reviews: assignment.evidence?.reviews ?? [] };
  await persist(root, state, "verification_started", { task: assignment.key });
  const commands = [...new Set([...(config.protectedChecks ?? []), ...task.verificationPlan.requirements.flatMap(requirement => requirement.command ? [requirement.command] : [])])];
  const checks: { command: string; ok: boolean; code: number | null; output: string }[] = [];
  const directory = path.join(shipDir(root), "attempts"); await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, `native-${assignment.id}.verification.json`);
  task.evidenceRefs = [...new Set([...(task.evidenceRefs ?? []), path.relative(root, evidencePath)])];
  for (const [index, command] of commands.entries()) {
    let result;
    try { await assertApprovedRepoCheck(root, state, command); }
    catch (error) {
      task.status = "failed";
      task.lastError = `Verification stopped before executing ${command}: ${String(error)}`;
      await atomicJson(evidencePath, { checks, passed: false, error: task.lastError });
      return false;
    }
    try { result = await runCheck(root, command, root, config.verificationTimeoutMs ?? 300_000, undefined, path.join(directory, `native-${assignment.id}-check-${index}.log`)); }
    catch (error) { task.status = "failed"; task.lastError = `Verification could not execute: ${command}: ${String(error)}`; await atomicJson(evidencePath, { checks, passed: false, error: task.lastError }); return false; }
    checks.push({ command, ok: result.ok, code: result.code, output: result.output });
    await atomicJson(evidencePath, { checks, passed: false });
    await appendEvent(root, { type: "verification", task: assignment.key, command, ok: result.ok, code: result.code });
    if (!result.ok) { task.status = "failed"; task.lastError = `Verification ${result.timedOut ? "timed out" : "failed"}: ${command}\n${result.output}`; return false; }
    assignment.evidence.commands!.push({ command, ok: true });
  }
  const missing = task.verificationPlan.requirements.filter(requirement => !requirement.command && !["independent-review", "security-review"].includes(requirement.kind));
  if ((!checks.length && !outputRequirements(task).includes("research-artifact") && !["review", "security-review"].includes(task.taskType)) || missing.length) {
    task.status = "failed";
    task.lastError = !checks.length && !missing.length ? "No executable verification check was run" : `Required verification has no executable evidence: ${missing.map(r => r.kind).join(", ")}`;
    await atomicJson(evidencePath, { checks, passed: false, error: task.lastError }); return false;
  }
  assignment.verifiedCommands = checks.map(check => check.command);
  task.evidence = assignment.evidence;
  await atomicJson(evidencePath, { checks, passed: true, acceptanceFingerprint: acceptance, research: assignment.evidence.research });
  return true;
}
async function saveAssignmentEvidence(root: string, batch: NativeBatch, entry: NativeAssignment): Promise<void> {
  await atomicJson(path.join(shipDir(root), "attempts", `native-${entry.id}.result.json`), {
    batchId: batch.id, assignmentId: entry.id, task: entry.key, stage: batch.stage,
    status: entry.status, summary: entry.summary, evidence: entry.evidence,
    verifiedCommands: entry.verifiedCommands, reviewVerdict: entry.reviewVerdict,
  });
}

async function settle(root: string, state: ShipState, config: ShipConfig, sessionId: string, routing?: RoutingContext): Promise<string> {
  const batch = state.nativeBatch!;
  // Complete the already-dispatched batch against its persisted verification policy.
  const reviews: NativeAssignment[] = [];
  const awaitingHuman: string[] = [];
  for (const entry of batch.assignments) {
    const task = tasks(state).find(item => item.key === entry.key)!.t;
    if (task.status === "passed") continue;
    if (entry.status !== "passed") { task.status = "failed"; task.lastError = `${entry.status} ${batch.stage}: ${entry.summary}`; continue; }
    if (batch.stage === "reviewing" && (!entry.specialistDispatched || entry.reviewVerdict !== "correct")) {
      task.status = "failed"; task.lastError = `Required review ${entry.reviewVerdict ?? "unknown"}: ${entry.summary}`; continue;
    }
    if (batch.stage === "reviewing" && entry.evidence?.acceptanceFingerprint !== acceptanceFingerprint(task, task.acceptanceRevision ?? 0)) {
      task.status = "failed"; task.lastError = "Review was dispatched against stale acceptance evidence"; continue;
    }
    if (!await verify(root, state, entry, config)) {
      task.evidence = entry.evidence;
      await saveAssignmentEvidence(root, batch, entry);
      continue;
    }
    await saveAssignmentEvidence(root, batch, entry);
    if (batch.stage === "executing" && (task.verificationPlan.requirements.some(r => r.kind === "independent-review" || r.kind === "security-review") ||
      task.risk === "HIGH" || task.taskType === "security-review")) {
      task.evidence = entry.evidence;
      reviews.push({ id: randomUUID(), key: entry.key, status: "pending", evidence: entry.evidence, verifiedCommands: entry.verifiedCommands });
      continue;
    }
    if (batch.stage === "reviewing") {
      const kind = task.execution.verificationSpecialist === "security-reviewer" ? "security-review" : "independent-review";
      entry.evidence = { ...entry.evidence, reviews: [...(entry.evidence?.reviews ?? []), { kind, ok: true }] };
      await saveAssignmentEvidence(root, batch, entry);
    }
    task.evidence = entry.evidence;
    const evaluation = await evaluateTaskEvidence({ root, task, revision: task.acceptanceRevision ?? 0,
      mainSessionId: sessionId, evidence: task.evidence, humanApproval: state.humanApprovals?.[entry.key] });
    const human = "Current acceptance requires main-session UI-approved human evaluation";
    if (!evaluation.ok && !(evaluation.missing.length === 1 && evaluation.missing[0] === human)) {
      task.status = "failed"; task.lastError = `Evidence missing: ${evaluation.missing.join("; ")}`; continue;
    }
    if (!evaluation.ok && evaluation.missing.length === 1 && evaluation.missing[0] === human) state.humanEvidenceSessionId = sessionId;
    if (!evaluation.ok) {
      task.status = "verifying"; awaitingHuman.push(entry.key); continue;
    }
    task.status = "passed"; delete task.lastError;
  }
  if (batch.stage === "executing") await snapshotOwned(root, state, batch);
  if (reviews.length) {
    delete state.nativeBatch;
    state.nativeBatch = { id: randomUUID(), sessionId, revision: state.roadmapRevision, stage: "reviewing", assignments: reviews, awaitingBudget: true };
    state.phase = "idle";
    await persist(root, state, "native_review_required", { tasks: reviews.map(r => r.key) });
    return advance(root, state, config, sessionId, routing);
  }
  if (awaitingHuman.length) {
    state.phase = "reviewing";
    await persist(root, state, "native_human_evidence_required", { tasks: awaitingHuman });
    return `SHIP awaiting main-session human approval for ${awaitingHuman.join(", ")}. Use /ship verify for each task; no other assignments will dispatch.`;
  }
  if (!tasks(state).some(item => item.t.status === "verifying" && outputRequirements(item.t).includes("human-evaluation"))) delete state.humanEvidenceSessionId;
  delete state.nativeBatch;
  state.phase = "idle";
  await persist(root, state, "native_batch_finished", { batch: batch.id });
  await consumeInbox(root, state);
  return advance(root, state, config, sessionId, routing);
}
export function reportNativeOutcome(root: string, sessionId: string, outcome: NativeOutcome, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root), config = await loadConfig(root);
    const batch = state.nativeBatch;
    if (!batch || batch.sessionId !== sessionId || batch.id !== outcome.batchId || batch.revision !== state.roadmapRevision) throw new Error("Stale, foreign or unknown SHIP batch");
    if (state.preexistingWork && (await gitDirtySnapshot(root)).branch !== state.preexistingWork.branch) {
      state.phase = "blocked"; state.blockedReason = "Git branch changed since SHIP established task ownership; inspect work before resuming";
      await persist(root, state, "blocked", { reason: state.blockedReason });
      return `SHIP blocked: ${state.blockedReason}`;
    }
    const assignment = batch.assignments.find(entry => entry.id === outcome.assignmentId);
    if (!assignment || assignment.status !== "pending") throw new Error("Unknown or already reported SHIP assignment");
    const task = tasks(state).find(item => item.key === assignment.key)!.t;
    if (batch.awaitingBudget) throw new Error("Required reviewer was not dispatched; increase the dispatch budget and /ship resume");
    if (outcome.status === "passed" && batch.stage === "executing" && task.execution.mode === "delegate" &&
        (task.execution.role === "plan" || task.execution.role === "slow") && !assignment.routed) {
      throw new Error(`OMP ${task.execution.role} role was not confirmed by the public spawn event; cannot accept a successful outcome`);
    }
    if (outcome.status === "passed" && (batch.stage === "reviewing" || task.execution.specialist) && !assignment.specialistDispatched) {
      throw new Error(`OMP ${batch.stage === "reviewing" ? "required reviewer" : task.execution.specialist} completed task result was not confirmed; cannot accept a successful outcome`);
    }
    if (outcome.status === "passed" && batch.stage === "reviewing" && assignment.reviewVerdict !== "correct") {
      throw new Error(`Required reviewer verdict is ${assignment.reviewVerdict ?? "unknown"}; report failed or partial and repair findings`);
    }
    if (!outcome.summary?.trim() || outcome.summary.length > 16_000) throw new Error("Provide a concrete outcome summary (up to 16,000 characters)");
    if (outcome.evidence !== undefined) validateOutcomeEvidence(outcome.evidence);
    assignment.status = outcome.status; assignment.summary = outcome.summary;
    // Only research claims may be agent-supplied. Native checks and reviewer verdicts are independently established.
    if (batch.stage === "executing") assignment.evidence = outcome.evidence?.research ? { research: outcome.evidence.research } : undefined;
    const resultPath = path.join(shipDir(root), "attempts", `native-${assignment.id}.result.json`);
    await mkdir(path.dirname(resultPath), { recursive: true });
    await atomicJson(resultPath, { batch: batch.id, task: assignment.key, stage: batch.stage, ...outcome, evidence: assignment.evidence });
    task.evidenceRefs = [...new Set([...(task.evidenceRefs ?? []), path.relative(root, resultPath)])];
    await persist(root, state, "native_outcome", { batch: batch.id, task: assignment.key, status: outcome.status });
    if (batch.assignments.some(entry => entry.status === "pending")) return "Outcome recorded. Await every assignment in the batch before proceeding.";
    batch.settling = true;
    await persist(root, state, "native_batch_settling", { batch: batch.id });
    return settle(root, state, config, sessionId, routing);
  });
}

/** Only the main-session UI may invoke this action; agent outcomes cannot create human approval. */
export function approveNativeHumanEvidence(root: string, sessionId: string, taskKey: string): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (state.humanEvidenceSessionId !== sessionId || (state.nativeBatch && state.nativeBatch.sessionId !== sessionId))
      throw new Error("Human evidence belongs to another main session or is not pending");
    const task = tasks(state).find(item => item.key === taskKey)?.t;
    if (!task || task.status !== "verifying" || !outputRequirements(task).includes("human-evaluation"))
      throw new Error("Task does not await human evaluation");
    // Human approval remains bound to the persisted policy and current acceptance fingerprint.
    const revision = task.acceptanceRevision ?? 0;
    const evaluation = await evaluateTaskEvidence({ root, task, revision, mainSessionId: sessionId, evidence: task.evidence });
    if (evaluation.missing.length !== 1 || evaluation.missing[0] !== "Current acceptance requires main-session UI-approved human evaluation")
      throw new Error(`Cannot approve stale or incomplete evidence: ${evaluation.missing.join("; ") || "already approved"}`);
    state.humanApprovals ??= {};
    state.humanApprovals[taskKey] = { source: "main-session-ui", sessionId, taskId: task.id, revision,
      acceptanceFingerprint: acceptanceFingerprint(task, revision), approved: true };
    task.status = "passed"; delete task.lastError;
    if (!tasks(state).some(item => item.t.status === "verifying" && outputRequirements(item.t).includes("human-evaluation")))
      delete state.humanEvidenceSessionId;
    await persist(root, state, "native_human_evidence_approved", { task: taskKey, sessionId, revision });
    if (state.nativeBatch && !state.nativeBatch.awaitingBudget &&
      state.nativeBatch.assignments.every(item => item.status !== "pending"))
      return settle(root, state, await loadConfig(root), sessionId);
    if (state.nativeBatch) return `Human evaluation approved for ${taskKey}; complete outstanding reviewer assignments before continuing.`;
    return advance(root, state, await loadConfig(root), sessionId);
  });
}

/** Accept one correlated public OMP tool result (or explicit missing-tool report). */
export function completeNativeJudgment(root: string, sessionId: string, id: string, status: "result" | "unavailable" | "error" | "malformed", response: unknown, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root), config = await loadConfig(root), pending = state.pendingJudgment;
    if (!pending || pending.id !== id || pending.sessionId !== sessionId || pending.revision !== state.roadmapRevision) throw new Error("Stale or foreign SHIP judgment");
    const task = tasks(state).find(entry => entry.key === pending.key)?.t;
    if (!task || task.status !== "pending") throw new Error("Judgment task is no longer pending");
    const timedOut = Date.now() - pending.requestedAt >= (config.judgment?.timeoutMs ?? judgmentTimeoutMs);
    if (status === "result" && config.judgment?.enabled && !timedOut) {
      task.semanticJudgment = parseSemanticAnswers(response, id, config.judgment?.confidenceThreshold ?? confidenceThreshold, task.taskType);
      recomputeJudgedTask(task, state.repoChecks);
    }
    const current = eligibleRoles(task, routing?.candidates.map(c => c.role) ?? []);
    const eligible = pending.eligible.filter(role => current.includes(role));
    const answers = response && typeof response === "object" && "answers" in response && response.answers &&
      typeof response.answers === "object" && !Array.isArray(response.answers) ? response.answers : undefined;
    const raw: unknown = answers && Object.hasOwn(answers, id) ? Reflect.get(answers, id) : undefined;
    const choice = raw && typeof raw === "object" && "type" in raw && raw.type === "choice" ? parseChoice(raw, eligible, config.judgment?.confidenceThreshold ?? confidenceThreshold) : "malformed";
    const reason = !config.judgment?.enabled ? "disabled" : timedOut ? "timeout" : status !== "result" ? status :
      eligible.length < 2 ? "unconfigured" : typeof choice === "string" ? choice : undefined;
    const decision: RoutingDecision = reason ? fallback(task, reason) : choice as RoutingDecision;
    if (reason === "low-confidence" && raw && typeof raw === "object" && "confidence" in raw &&
        typeof raw.confidence === "number" && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1) decision.confidence = raw.confidence;
    task.routingDecision = decision;
    task.execution = applyDecision(task, decision);
    delete state.pendingJudgment;
    await persist(root, state, "native_judgment_completed", { task: pending.key, backend: decision.backend, reason: decision.reason, role: decision.role, confidence: decision.confidence });
    return advance(root, state, config, sessionId, routing);
  });
}
