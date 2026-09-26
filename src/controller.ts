import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ShipState, Worker, WorkerResult, WorkRequest } from "./types.ts";
import { appendEvent, atomicJson, consumeInbox, loadConfig, loadState, readJson, saveState, shipDir, writeRoadmapView } from "./store.ts";
import { candidateTree, clean, commitCandidate, ensureWorkspace, head, matchesCommit } from "./git.ts";
import { executorPrompt, plannerPrompt, reviewPrompt, workPlannerPrompt, changePlannerPrompt } from "./prompts.ts";
import { applyReview, parsePlan, refresh, tasks, terminal } from "./model.ts";
import { invalidateWorkProposals, parseWorkProposal } from "./work.ts";
import { effectiveProject } from "./change.ts";
import { acquireLock } from "./lock.ts";
import { assertNoProcess, runCheck } from "./process.ts";

export type Step = "progress" | "task" | "complete" | "blocked" | "paused" | "waiting";
export interface ControllerOptions { signal?: AbortSignal; fault?: (at: "after_execute" | "after_verify" | "after_commit") => void; }
export class Controller {
  private root: string; private worker: Worker; private options: ControllerOptions;
  constructor(root: string, worker: Worker, options: ControllerOptions = {}) { this.root = root; this.worker = worker; this.options = options; }

  async step(): Promise<Step> {
    const release = await acquireLock(this.root);
    try { return await this.advance(); } finally { await release(); }
  }
  async run(once = false, onStep: (step: Step) => void = () => {}): Promise<Step> {
    const release = await acquireLock(this.root);
    try {
      for (;;) {
        if (this.options.signal?.aborted) return "paused";
        const result = await this.advance(); onStep(result);
        if (result === "complete" || result === "blocked" || (once && result === "task")) return result;
        if (result === "paused" || result === "waiting") { if (once) return result; await delay(250); }
      }
    } finally { await release(); }
  }
  private async persist(s: ShipState, type: string, detail: Record<string, unknown> = {}) {
    refresh(s); invalidateWorkProposals(s); await saveState(this.root, s); await writeRoadmapView(this.root, s);
    await appendEvent(this.root, { type, ...detail });
  }
  private async block(s: ShipState, reason: string): Promise<Step> {
    s.phase = "blocked"; s.blockedReason = reason;
    await this.persist(s, "blocked", { reason }); return "blocked";
  }
  private async invoke(s: ShipState, prompt: string, cwd: string, log: string): Promise<WorkerResult> {
    s.dispatches = (s.dispatches ?? 0) + 1;
    await saveState(this.root, s);
    return this.worker.run(prompt, cwd, { controlRoot: this.root, signal: this.options.signal, logFile: path.join(shipDir(this.root), "logs", `${log}.log`) });
  }
  private async advance(): Promise<Step> {
    await assertNoProcess(this.root);
    const s = await loadState(this.root), config = await loadConfig(this.root);
    const rawProject = await readFile(path.join(shipDir(this.root), "PROJECT.md"), "utf8");
    const revision = s.roadmapRevision;
    const inboxChanged = await consumeInbox(this.root, s, rawProject);
    const invalidated = invalidateWorkProposals(s, rawProject);
    // Inbox additions/receipts and their generated views are visible even while
    // paused. Applying an approval does not itself authorize resuming execution.
    if (invalidated) await saveState(this.root, s);
    if (inboxChanged || invalidated) await writeRoadmapView(this.root, s);
    if (s.roadmapRevision !== revision) await appendEvent(this.root, { type: "work_applied", revision: s.roadmapRevision });
    if (s.paused || this.options.signal?.aborted) return "paused";
    if (s.phase === "blocked") return "blocked";
    await mkdir(path.join(shipDir(this.root), "logs"), { recursive: true });
    await mkdir(path.join(shipDir(this.root), "attempts"), { recursive: true });
    const cwd = await ensureWorkspace(this.root, s);
    let project: string;
    try { project = effectiveProject(rawProject, s); }
    catch (error) { return this.block(s, String(error)); }
    if (project.length > 60_000) return this.block(s, "Brief exceeds 60,000 characters; provide a focused project brief");
    if (s.activeAttempt) return this.reconcile(s, cwd);
    if (await head(cwd) !== (s.lastHead ?? s.workspace!.baseHead)) return this.block(s, "Unexpected worktree commit; inspect before continuing");
    if (s.partialTree) {
      if (await candidateTree(cwd) !== s.partialTree) return this.block(s, "Partial work was changed outside the controller");
    } else if (!await clean(cwd)) return this.block(s, "Unexpected worktree changes; refusing to include unrelated edits");


    if (!s.milestones.length) {
      if ((s.dispatches ?? 0) >= config.limits.maxDispatches) return this.block(s, "Persistent dispatch budget exhausted");
      if ((s.planningFailures ?? 0) >= config.limits.maxTaskAttempts) return this.block(s, "Planning retry budget exhausted");
      s.phase = "planning"; s.planningFailures = (s.planningFailures ?? 0) + 1;
      await this.persist(s, "planning_started");
      const baseline = await candidateTree(cwd);
      const result = await this.invoke(s, plannerPrompt(project), cwd, `plan-${s.planningFailures}`);
      if (await head(cwd) !== s.workspace!.baseHead || await candidateTree(cwd) !== baseline) return this.block(s, "Planner modified source; changes preserved for inspection");
      try {
        if (!result.ok) throw new Error(result.error ?? "Planner failed");
        s.milestones = parsePlan(result.text);
      } catch (error) {
        s.phase = "idle";
        await this.persist(s, "planning_failed", { error: String(error) });
        if (this.options.signal?.aborted) { s.paused = true; await saveState(this.root, s); return "paused"; }
        if (!result.ok && !result.retryable) return this.block(s, result.error ?? "Non-retryable planner failure");
        return "progress";
      }
      s.roadmapRevision++; s.phase = "idle";
      await this.persist(s, "roadmap_created"); return "progress";
    }
    // Freeze at a safe boundary while a proposal is being reviewed. Otherwise
    // executing its intended parent could complete it and stale the proposal
    // before the user has a chance to approve. Captures never create this gate.
    if (s.workRequests!.some(r => r.status === "proposed" || (r.kind === "change" && ["conflict", "failed", "stale"].includes(r.status)))) {
      if (s.phase !== "waiting") { s.phase = "waiting"; await this.persist(s, "work_awaiting_decision"); }
      return "waiting";
    }
    const request = s.workRequests!.find(r => r.status === "queued" || r.status === "planning");
    if (request) return this.planWork(s, cwd, rawProject, request);
    refresh(s);
    for (const m of s.milestones) for (const slice of m.slices) {
      const key = `${m.id}/${slice.id}`;
      if (slice.status !== "complete" || s.reviewedSlices!.includes(key)) continue;
      if (config.review === false) { s.reviewedSlices!.push(key); continue; }
      if ((s.dispatches ?? 0) >= config.limits.maxDispatches) return this.block(s, "Persistent dispatch budget exhausted");
      const count = (s.reviewAttempts![key] ?? 0) + 1;
      if (count > config.limits.maxTaskAttempts) return this.block(s, `Review retry budget exhausted for ${key}`);
      s.reviewAttempts![key] = count; s.phase = "reviewing";
      await this.persist(s, "review_started", { slice: key });
      const baseline = await candidateTree(cwd);
      const summaries: string[] = [];
      for (const t of slice.tasks.filter(t => t.status === "passed")) {
        const file = path.join(shipDir(this.root), "attempts", `${m.id}-${slice.id}-${t.id}-a${t.attempts}.result.json`);
        summaries.push((await readFile(file, "utf8")).slice(0, 4000));
      }
      const result = await this.invoke(s, reviewPrompt(project, s, key, summaries.join("\n").slice(0, 16000)), cwd, `review-${key.replaceAll("/", "-")}-${count}`);
      if (await head(cwd) !== (s.lastHead ?? s.workspace!.baseHead) || await candidateTree(cwd) !== baseline) return this.block(s, "Reviewer modified source; changes preserved for inspection");
      try {
        if (!result.ok) throw new Error(result.error ?? "Review failed");
        const proposal = applyReview(s, result.text, key);
        await atomicJson(path.join(shipDir(this.root), "attempts", `review-${key.replaceAll("/", "-")}-${count}.json`), proposal);
      } catch (error) {
        s.phase = "idle"; await this.persist(s, "review_failed", { slice: key, error: String(error) });
        if (this.options.signal?.aborted) { s.paused = true; await saveState(this.root, s); return "paused"; }
        if (!result.ok && !result.retryable) return this.block(s, result.error ?? "Non-retryable review failure");
        return "progress";
      }
      s.reviewedSlices!.push(key); s.phase = "idle";
      await this.persist(s, "roadmap_reassessed", { slice: key, revision: s.roadmapRevision }); return "progress";
    }
    const next = tasks(s).find(x => !terminal(x.t));
    if (!next) {
      if (s.workRequests!.some(r => r.status !== "applied" && r.status !== "rejected")) {
        if (s.phase !== "waiting") { s.phase = "waiting"; await this.persist(s, "work_awaiting_decision"); }
        return "waiting";
      }
      s.phase = "complete"; await this.persist(s, "project_completed"); return "complete";
    }
    if ((s.dispatches ?? 0) >= config.limits.maxDispatches) return this.block(s, "Persistent dispatch budget exhausted");
    const { t, key, m, s: slice } = next;
    if (t.status === "running" || t.status === "verifying") return this.block(s, "Legacy interrupted task has no attempt record; manual reconciliation required");
    if (t.attempts >= config.limits.maxTaskAttempts) return this.block(s, `${key} exhausted its persistent repair budget`);
    t.attempts++; t.status = "running"; s.phase = "executing";
    s.current = { milestoneId: m.id, sliceId: slice.id, taskId: t.id };
    s.activeAttempt = { id: `${key.replaceAll("/", "-")}-a${t.attempts}`, key, baseHead: await head(cwd), stage: "executing", commands: [...(config.protectedChecks ?? []), ...t.verificationCommands], revision: s.roadmapRevision };
    await this.persist(s, "task_started", { task: key, attempt: t.attempts });
    const result = await this.invoke(s, executorPrompt(project, s, t), cwd, s.activeAttempt.id);
    if (await head(cwd) !== s.activeAttempt.baseHead) return this.block(s, "Executor committed unexpectedly; preserving work for reconciliation");
    await atomicJson(path.join(shipDir(this.root), "attempts", `${s.activeAttempt.id}.result.json`), result);
    if (!result.ok) {
      const step = await this.failAttempt(s, cwd, result.error ?? "Worker failed");
      if (this.options.signal?.aborted) { s.paused = true; await saveState(this.root, s); return "paused"; }
      if (!result.retryable) return this.block(s, result.error ?? "Non-retryable worker failure");
      await delay(Math.min(2000, 250 * 2 ** (t.attempts - 1))); return step;
    }
    try {
      const report = JSON.parse(result.text);
      if (typeof report.summary !== "string" || !report.summary.trim() || !Array.isArray(report.observations) || report.observations.some((x: unknown) => typeof x !== "string")) throw new Error("Expected summary and observations");
      s.activeAttempt.summary = report.summary;
      for (const observation of report.observations.slice(0, 10)) s.knowledge!.push({ id: `K${String(s.knowledge!.length + 1).padStart(4, "0")}`, kind: "observation", text: observation, source: "agent", evidence: `${s.activeAttempt.id}.result.json`, at: new Date().toISOString() });
    } catch (error) { return this.failAttempt(s, cwd, `Invalid executor result: ${error}`); }
    s.activeAttempt.stage = "verifying"; t.status = "verifying"; s.phase = "verifying";
    s.activeAttempt.tree = await candidateTree(cwd);
    await this.persist(s, "verification_started", { task: key });
    this.options.fault?.("after_execute");
    return this.verify(s, cwd);
  }
  private async planWork(s: ShipState, cwd: string, project: string, request: WorkRequest): Promise<Step> {
    const config = await loadConfig(this.root);
    if ((s.dispatches ?? 0) >= config.limits.maxDispatches) return this.block(s, "Persistent dispatch budget exhausted");
    if (request.attempts >= config.limits.maxTaskAttempts) {
      request.status = "failed"; request.error = `Work planning retry budget exhausted. ${request.error ?? ""}`;
      s.phase = "idle"; await this.persist(s, "work_planning_failed", { request: request.id }); return "progress";
    }
    request.attempts++; request.status = "planning"; s.phase = "planning";
    await this.persist(s, "work_planning_started", { request: request.id, attempt: request.attempts });
    const baseline = await candidateTree(cwd), baseHead = await head(cwd);
    const result = await this.invoke(s, request.kind === "change" ? changePlannerPrompt(project, s, request, config.protectedChecks ?? []) : workPlannerPrompt(effectiveProject(project, s), s, request), cwd, `work-${request.id}-${request.attempts}`);
    if (await head(cwd) !== baseHead || await candidateTree(cwd) !== baseline) {
      request.status = "failed"; request.error = "Work planner modified source";
      return this.block(s, "Work planner modified source; changes preserved for inspection");
    }
    await atomicJson(path.join(shipDir(this.root), "attempts", `work-${request.id}-${request.attempts}.json`), result);
    try {
      if (!result.ok) throw new Error(result.error ?? "Work planner failed");
      const proposal = parseWorkProposal(s, request, result.text, project);
      if ("conflict" in proposal) { request.status = "conflict"; request.error = proposal.conflict; }
      else { request.status = "proposed"; request.proposal = proposal; delete request.error; }
    } catch (error) {
      request.error = String(error);
      request.status = !result.ok && !result.retryable ? "failed" : "queued";
    }
    s.phase = "idle";
    await this.persist(s, "work_proposal_updated", { request: request.id, status: request.status });
    if (this.options.signal?.aborted) { s.paused = true; await saveState(this.root, s); return "paused"; }
    return "progress";
  }
  private async failAttempt(s: ShipState, cwd: string, reason: string): Promise<Step> {
    const a = s.activeAttempt!, task = tasks(s).find(t => t.key === a.key)!.t;
    task.status = "failed"; task.lastError = reason.slice(-16000);
    s.partialTree = await candidateTree(cwd); delete s.activeAttempt; s.phase = "idle";
    await this.persist(s, "task_failed", { task: a.key, attempt: a.id, reason }); return "progress";
  }
  private async reconcile(s: ShipState, cwd: string): Promise<Step> {
    const a = s.activeAttempt!;
    if (!tasks(s).some(x => x.key === a.key)) return this.block(s, "Active attempt references a missing task");
    if (a.stage === "committing") return this.finalize(s, cwd);
    if (await head(cwd) !== a.baseHead) return this.block(s, "Unexpected HEAD while recovering an interrupted attempt");
    if (a.stage === "executing") return this.failAttempt(s, cwd, "Executor interrupted. Partial work preserved; inspect and repair it.");
    return this.verify(s, cwd);
  }
  private async verify(s: ShipState, cwd: string): Promise<Step> {
    const a = s.activeAttempt!, config = await loadConfig(this.root);
    if (!a.tree || await candidateTree(cwd) !== a.tree) return this.block(s, "Source changed since the verification snapshot");
    const checks = [];
    for (const [index, command] of a.commands.entries()) {
      const result = await runCheck(cwd, command, this.root, config.verificationTimeoutMs ?? 300_000, this.options.signal,
        path.join(shipDir(this.root), "logs", `${a.id}-check-${index}.log`));
      checks.push({ command, ...result });
      await atomicJson(path.join(shipDir(this.root), "attempts", `${a.id}.verification.json`), { tree: a.tree, baseHead: a.baseHead, revision: a.revision, checks, passed: false });
      await appendEvent(this.root, { type: "verification", task: a.key, command, ok: result.ok, code: result.code });
      if (!result.ok) {
        const step = await this.failAttempt(s, cwd, `Verification ${result.timedOut ? "timed out" : result.aborted ? "interrupted" : "failed"}: ${command}\n${result.output}`);
        if (this.options.signal?.aborted) { s.paused = true; await saveState(this.root, s); return "paused"; }
        return step;
      }
    }
    if (!checks.length || await head(cwd) !== a.baseHead || await candidateTree(cwd) !== a.tree) return this.block(s, "Verification changed source, changed HEAD, or ran no checks");
    await atomicJson(path.join(shipDir(this.root), "attempts", `${a.id}.verification.json`), { tree: a.tree, baseHead: a.baseHead, revision: a.revision, checks, passed: true });
    a.stage = "committing"; await saveState(this.root, s);
    this.options.fault?.("after_verify");
    return this.finalize(s, cwd);
  }
  private async finalize(s: ShipState, cwd: string): Promise<Step> {
    const a = s.activeAttempt!;
    const evidence = await readJson<{ passed: boolean; tree: string; baseHead: string; revision: number; checks: { command: string; ok: boolean }[] }>(path.join(shipDir(this.root), "attempts", `${a.id}.verification.json`));
    if (!a.tree || !evidence.passed || evidence.tree !== a.tree || evidence.baseHead !== a.baseHead || evidence.revision !== a.revision || JSON.stringify(evidence.checks.map(c => c.command)) !== JSON.stringify(a.commands) || evidence.checks.some(c => !c.ok)) return this.block(s, "Verification evidence does not match commit intent");
    let commit = await head(cwd);
    if (commit === a.baseHead) commit = await commitCandidate(cwd, a.tree, a.baseHead, a.id);
    else if (!await matchesCommit(cwd, commit, a.tree, a.baseHead, a.id)) return this.block(s, "Commit recovery found unrelated history");
    if (!await clean(cwd)) return this.block(s, "Worktree changed after the task commit");
    this.options.fault?.("after_commit");
    const task = tasks(s).find(t => t.key === a.key)!.t;
    task.status = "passed"; delete task.lastError;
    s.lastHead = commit; delete s.partialTree; delete s.activeAttempt;
    s.phase = "idle"; s.lastProgressAt = new Date().toISOString();
    await this.persist(s, "task_completed", { task: a.key, attempt: a.id, commit }); return "task";
  }
}
