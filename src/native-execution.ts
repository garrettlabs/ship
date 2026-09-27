import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DependencyGraph } from "./dependency-graph.ts";
import { tasks, refresh, parsePlan, recomputeJudgedTask } from "./model.ts";
import { plannerPrompt } from "./prompts.ts";
import { runCheck } from "./process.ts";
import { acquireLock } from "./lock.ts";
import { discoverRepoChecks } from "./verification.ts";
import { appendEvent, atomicJson, consumeInbox, loadConfig, loadState, saveState, shipDir, writeRoadmapView } from "./store.ts";
import { gitDirtySnapshot, readProjectProfile, type GitDirtySnapshot } from "./project-profile.ts";
import { assertNoProcess } from "./process.ts";
import type { Milestone, NativeAssignment, NativeBatch, RepoCheck, ShipConfig, ShipState } from "./types.ts";
import { applyDecision, confidenceThreshold, eligibleRoles, fallback, hashJudgmentRequest, judgmentTimeoutMs, parseChoice, parseSemanticAnswers, semanticTaskTypes } from "./judgment.ts";
import type { ExecutionRole, RoutingDecision } from "./types.ts";

export interface RoleCandidate { role: ExecutionRole; model?: string; pricing?: { input: number; output: number }; capability?: number; estimatedTaskCost?: string; }
export interface RoutingContext { candidates: RoleCandidate[]; jevAvailable: boolean; }

export interface NativeOutcome { batchId: string; assignmentId: string; status: "passed" | "failed" | "partial"; summary: string; }
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
function instructions(root: string, batch: NativeBatch, state: ShipState): string {
  const graph = new DependencyGraph(state.milestones);
  const entries = tasks(state);
  const lines = batch.assignments.map(assignment => {
    const task = entries.find(entry => entry.key === assignment.key)!.t;
    const prerequisites = graph.dependencies.get(assignment.key)!;
    const name = `Ship${assignment.id.replaceAll("-", "").slice(0, 26)}`;
    if (batch.stage === "reviewing") return `- ${assignment.key} [${assignment.id}]: Independently review completed work against: ${task.acceptance.join("; ")}. ${task.verificationPlan.requirements.filter(r => !r.command).map(r => `${r.kind}: ${r.reason}`).join("; ")}. Use OMP task tool agent: "${task.execution.verificationSpecialist ?? "reviewer"}", name: "${name}", and include assignment ID ${assignment.id} in its task text; not the original writer. Await substantive review findings before reporting.`;
    const route = task.execution;
    const agent = route.specialist ?? (route.role === "smol" ? "sonic" : "task");
    const dispatch = route.mode === "main" ? "Work directly in the main session without a subagent"
      : `Use OMP task tool with agent: "${agent}", name: "${name}", and include assignment ID ${assignment.id} in its task text${route.role === "plan" || route.role === "slow" ? `; SHIP's public before_subagent_spawn hook resolves its configured @${route.role} model role` : ""}, await its actual result`;
    return `- ${assignment.key} [${assignment.id}]: ${task.title}. Goal: ${task.goal}. Objective: ${task.objective}. Acceptance: ${task.acceptance.join("; ")}. Dependencies already passed: ${prerequisites.join(", ") || "none"}. Owned files: ${task.affectedFiles.join(", ") || "unspecified"}; domains: ${task.affectedDomains.join(", ") || "unspecified"}. ${dispatch}. Stored route: ${route.role}${route.specialist ? `/${route.specialist}` : ""}; ${route.reason}. ${task.lastError ? `Previous failure (repair only within scope): ${task.lastError}` : ""}`;
  });
  const reporting = `After each assignment finishes, call ship_outcome with batchId ${batch.id}, its assignmentId, status passed/failed/partial, and a concrete summary of actual results. Report failures and partial work honestly; do not claim success from intention. SHIP runs required verification itself and will issue a follow-up batch only after every assignment has reported. Do not launch any separate SHIP process for these assignments.`;
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
  const ready = graph.readyTasks();
  if (!ready.length) return undefined;
  const first = ready[0];
  const safe = new Set(graph.parallelCandidatePairs().filter(([a, b]) => a.key === first.key || b.key === first.key).map(([a, b]) => a.key === first.key ? b.key : a.key));
  const chosen = [first];
  for (const node of ready.slice(1)) {
    if (!safe.has(node.key) || [node, ...chosen].some(item => item.task.execution.mode === "main" || item.task.execution.role === "plan" || item.task.execution.role === "slow")) continue;
    if (chosen.slice(1).every(other => graph.parallelCandidatePairs().some(([a, b]) => (a.key === node.key && b.key === other.key) || (b.key === node.key && a.key === other.key)))) chosen.push(node);
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
  if (state.paused || state.phase === "blocked") return `SHIP ${state.paused ? "paused" : `blocked: ${state.blockedReason}`}. No assignments dispatched.`;
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
  if (!state.milestones.length) {
    if ((state.planningFailures ?? 0) >= config.limits.maxTaskAttempts || (state.dispatches ?? 0) >= config.limits.maxDispatches) {
      state.phase = "blocked"; state.blockedReason = "Native planning attempt or dispatch budget exhausted";
      await persist(root, state, "blocked", { reason: state.blockedReason }); return `SHIP blocked: ${state.blockedReason}`;
    }
    if (state.nativePlanning && state.nativePlanning.sessionId !== sessionId) return "SHIP planning belongs to another OMP session; resume it there.";
    if (!state.nativePlanning) {
      state.nativePlanning = { id: randomUUID(), sessionId, attempts: 0 };
      state.dispatches = (state.dispatches ?? 0) + 1;
    }
    state.phase = "planning"; await persist(root, state, "native_planning_started", { planning: state.nativePlanning.id });
    const profile = await readProjectProfile(root);
    const dirty = state.preexistingWork;
    const context = [
      profile.facts.instructions.length ? `Existing repository instructions (read these first; they take precedence over SHIP defaults): ${profile.facts.instructions.join(", ")}` : "",
      profile.facts.ecosystems.length ? `Observed ecosystems: ${profile.facts.ecosystems.join(", ")}` : "",
      profile.facts.packageManagers.length ? `Observed package managers: ${profile.facts.packageManagers.join(", ")}` : "",
      Object.keys(profile.facts.commands).length ? `Observed declared verification commands: ${JSON.stringify(profile.facts.commands)}` : "",
      profile.facts.layout.length ? `Observed source/workspace layout: ${profile.facts.layout.join(", ")}` : "",
      profile.facts.ci.length ? `Existing CI workflows (inspect for authoritative checks): ${profile.facts.ci.join(", ")}` : "",
      profile.facts.migrations.length ? `Observed migration tooling: ${profile.facts.migrations.join(", ")}` : "",
      profile.unknowns.length ? `Unresolved facts (investigate if relevant; never assume): ${profile.unknowns.join(", ")}` : "",
      dirty?.paths.length || dirty?.truncated ? `Git branch ${dirty.branch ?? "(unknown)"}; preexisting user changes: ${dirty.paths.join(", ")}${dirty.truncated ? " (more paths omitted)" : ""}. Do not overwrite these paths; plan explicit disjoint ownership or reconnaissance before changes.` : "",
    ].filter(Boolean).join("\n");
    const brief = await readFile(path.join(shipDir(root), "PROJECT.md"), "utf8");
    return `SHIP OMP-native planning for ${root}. Use OMP task tool agent: "task", name: "ShipPlanner", to inspect without modifying files. Pass the entire planner task text below verbatim as the task agent's task prompt; do not summarize it or replace its JSON contract with a prose request. Await the agent's final answer, which MUST be raw JSON only (no Markdown, fences, or commentary) with the full milestones -> slices -> tasks schema below. In the main session, call ship_plan with planningId ${state.nativePlanning.id} and plan set to that complete raw JSON answer, not a Markdown summary or a partial plan.\n\nPLANNER TASK TEXT (pass everything below verbatim):\n${plannerPrompt(context ? `${brief}\n\nRepository observations (profile is a cache; inspect current source before decisions):\n${context}` : brief)}`;
  }
  if (tasks(state).every(entry => entry.t.status === "passed")) {
    const checks = [...new Set((state.repoChecks ?? []).filter(check => check.kind === "integration").map(check => check.command))];
    for (const [index, command] of checks.entries()) {
      const directory = path.join(shipDir(root), "attempts");
      await mkdir(directory, { recursive: true });
      let result;
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
    await persist(root, state, "project_completed"); return "SHIP complete: all tasks passed required verification and configured integration checks.";
  }
  const ready = new DependencyGraph(state.milestones).readyTasks();
  reconcileDirtyPaths(state, currentGit, ready);
  const conflict = ownershipConflict(state, ready);
  if (conflict) {
    state.phase = "blocked"; state.blockedReason = conflict;
    await persist(root, state, "blocked", { reason: conflict }); return `SHIP blocked: ${conflict}`;
  }
  if (config.judgment?.enabled) {
    const next = new DependencyGraph(state.milestones).readyTasks().find(node => node.task.routingDecision.reason === "disabled");
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
    const failed = graph.readyTasks().find(node => node.task.attempts >= config.limits.maxTaskAttempts);
    state.phase = "blocked";
    state.blockedReason = failed ? `${failed.key} exhausted its persistent repair budget` : (state.dispatches ?? 0) >= config.limits.maxDispatches ? "Persistent dispatch budget exhausted" : "No task is ready; unresolved prerequisites remain";
    await persist(root, state, "blocked", { reason: state.blockedReason }); return `SHIP blocked: ${state.blockedReason}`;
  }
  state.nativeBatch = batch; state.phase = "executing";
  await persist(root, state, "native_batch_started", { batch: batch.id, tasks: batch.assignments.map(a => a.key) });
  return instructions(root, batch, state);
}
export function startNativeRun(root: string, sessionId: string, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root);
    if (state.workspace) throw new Error("Standalone worktree state cannot be reused in OMP's checkout; use a fresh native project");
    if (state.activeAttempt) throw new Error("A standalone controller attempt is active; reconcile it before OMP-native execution");
    if (!state.preexistingWork) {
      const snapshot = await gitDirtySnapshot(root);
      state.preexistingWork = { branch: snapshot.branch, paths: snapshot.paths, ...(snapshot.truncated ? { truncated: true } : {}), ...(snapshot.unknown ? { unknown: true } : {}) };
      await saveState(root, state);
    }
    await readProjectProfile(root);
    await consumeInbox(root, state);
    return advance(root, state, await loadConfig(root), sessionId, routing);
  });
}
/** Explicit recovery is allowed only after the caller confirms every former OMP worker is dead. */
export function recoverNativeRun(root: string, sessionId: string, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    await assertNoProcess(root);
    const state = await loadState(root), config = await loadConfig(root);
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
    return advance(root, state, config, sessionId, routing);
  });
}
export function submitNativePlan(root: string, sessionId: string, planningId: string, plan: string, routing?: RoutingContext): Promise<string> {
  return serialized(root, async () => {
    const state = await loadState(root), config = await loadConfig(root);
    if (state.workspace || state.nativeBatch || state.milestones.length || !state.nativePlanning ||
        state.nativePlanning.id !== planningId || state.nativePlanning.sessionId !== sessionId) throw new Error("Stale or foreign native planning assignment");
    await readProjectProfile(root);
    const current = await gitDirtySnapshot(root);
    if (state.preexistingWork) {
      state.preexistingWork.paths = [...new Set([...state.preexistingWork.paths, ...current.paths])].slice(0, 256);
      state.preexistingWork.truncated ||= current.truncated || state.preexistingWork.paths.length < new Set([...state.preexistingWork.paths, ...current.paths]).size;
      state.preexistingWork.unknown ||= current.unknown;
    }
    state.nativePlanning.attempts++;
    let approved: { checks: RepoCheck[]; milestones: Milestone[] };
    try {
      if (plan.length > 1_000_000) throw new Error("Planning output exceeds 1 MB");
      const checks = await discoverRepoChecks(root);
      approved = { checks, milestones: parsePlan(plan, checks, true) };
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
    state.repoChecks = approved.checks;
    state.milestones = approved.milestones;
    state.roadmapRevision++;
    delete state.nativePlanning;
    state.phase = "idle";
    await persist(root, state, "native_roadmap_created");
    return advance(root, state, config, sessionId, routing);
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

/** Record only a successfully completed OMP task result, correlated to its named assignment. */
export function confirmNativeSpecialist(root: string, sessionId: string, assignmentId: string, agent: string): Promise<void> {
  return serialized(root, async () => {
    const state = await loadState(root), batch = state.nativeBatch;
    if (!batch || batch.sessionId !== sessionId || batch.awaitingBudget) return;
    const assignment = batch.assignments.find(item => item.id === assignmentId && item.status === "pending");
    if (!assignment) return;
    const task = tasks(state).find(item => item.key === assignment.key)!.t;
    const expected = batch.stage === "reviewing" ? task.execution.verificationSpecialist ?? "reviewer" : task.execution.specialist;
    if (expected !== agent) return;
    assignment.specialistDispatched = true;
    await saveState(root, state);
  });
}

async function verify(root: string, state: ShipState, assignment: NativeAssignment, config: ShipConfig): Promise<boolean> {
  const task = tasks(state).find(entry => entry.key === assignment.key)!.t;
  task.status = "verifying"; state.phase = "verifying";
  await persist(root, state, "verification_started", { task: assignment.key });
  const commands = [...new Set([...(config.protectedChecks ?? []), ...task.verificationPlan.requirements.flatMap(requirement => requirement.command ? [requirement.command] : [])])];
  const checks: { command: string; ok: boolean; code: number | null; output: string }[] = [];
  const directory = path.join(shipDir(root), "attempts"); await mkdir(directory, { recursive: true });
  const evidence = path.join(directory, `native-${assignment.id}.verification.json`);
  for (const [index, command] of commands.entries()) {
    let result;
    try { result = await runCheck(root, command, root, config.verificationTimeoutMs ?? 300_000, undefined, path.join(directory, `native-${assignment.id}-check-${index}.log`)); }
    catch (error) { task.status = "failed"; task.lastError = `Verification could not execute: ${command}: ${String(error)}`; await atomicJson(evidence, { checks, passed: false, error: task.lastError }); return false; }
    checks.push({ command, ok: result.ok, code: result.code, output: result.output });
    await atomicJson(evidence, { checks, passed: false });
    await appendEvent(root, { type: "verification", task: assignment.key, command, ok: result.ok, code: result.code });
    if (!result.ok) { task.status = "failed"; task.lastError = `Verification ${result.timedOut ? "timed out" : "failed"}: ${command}\n${result.output}`; return false; }
  }
  const missing = task.verificationPlan.requirements.filter(requirement => !requirement.command && !["independent-review", "security-review"].includes(requirement.kind));
  if (!checks.length || missing.length) { task.status = "failed"; task.lastError = !checks.length ? "No executable verification check was run" : `Required verification has no executable evidence: ${missing.map(r => r.kind).join(", ")}`; await atomicJson(evidence, { checks, passed: false, error: task.lastError }); return false; }
  await atomicJson(evidence, { checks, passed: true });
  return true;
}

async function settle(root: string, state: ShipState, config: ShipConfig, sessionId: string, routing?: RoutingContext): Promise<string> {
  const batch = state.nativeBatch!;
  const reviews: NativeAssignment[] = [];
  for (const entry of batch.assignments) {
    const task = tasks(state).find(item => item.key === entry.key)!.t;
    if (entry.status !== "passed") { task.status = "failed"; task.lastError = `${entry.status} ${batch.stage}: ${entry.summary}`; continue; }
    if (batch.stage === "reviewing") { task.status = "passed"; delete task.lastError; continue; }
    if (task.status !== "passed" && !await verify(root, state, entry, config)) continue;
    if (task.verificationPlan.requirements.some(r => r.kind === "independent-review" || r.kind === "security-review")) reviews.push({ id: randomUUID(), key: entry.key, status: "pending" });
    else { task.status = "passed"; delete task.lastError; }
  }
  delete state.nativeBatch;
  if (reviews.length) {
    state.nativeBatch = { id: randomUUID(), sessionId, revision: state.roadmapRevision, stage: "reviewing", assignments: reviews, awaitingBudget: true };
    state.phase = "idle";
    await persist(root, state, "native_review_required", { tasks: reviews.map(r => r.key) });
    return advance(root, state, config, sessionId, routing);
  }
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
    if (!outcome.summary?.trim() || outcome.summary.length > 16_000) throw new Error("Provide a concrete outcome summary (up to 16,000 characters)");
    assignment.status = outcome.status; assignment.summary = outcome.summary;
    await mkdir(path.join(shipDir(root), "attempts"), { recursive: true });
    await atomicJson(path.join(shipDir(root), "attempts", `native-${assignment.id}.result.json`), { batch: batch.id, task: assignment.key, stage: batch.stage, ...outcome });
    await persist(root, state, "native_outcome", { batch: batch.id, task: assignment.key, status: outcome.status });
    if (batch.assignments.some(entry => entry.status === "pending")) return "Outcome recorded. Await every assignment in the batch before proceeding.";
    batch.settling = true;
    await persist(root, state, "native_batch_settling", { batch: batch.id });
    return settle(root, state, config, sessionId, routing);
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
