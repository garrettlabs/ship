import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Milestone, ShipState, Task, Worker } from "./types.ts";
import { appendEvent, loadConfig, loadState, saveState, shipDir, writeRoadmapView } from "./store.ts";
import { commitAll, runCommand } from "./git.ts";
import { executorPrompt, plannerPrompt } from "./prompts.ts";

function nextPending(state: ShipState): {m:any;s:any;t:Task}|null {
  for (const m of state.milestones) for (const s of m.slices) for (const t of s.tasks) if (t.status === "pending" || t.status === "failed") return {m,s,t};
  return null;
}

function parsePlan(text: string): Milestone[] {
  const first = text.indexOf("{"); const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Planner did not return JSON");
  const raw = JSON.parse(text.slice(first, last + 1));
  if (!Array.isArray(raw.milestones) || raw.milestones.length === 0) throw new Error("Planner returned no milestones");
  return raw.milestones.map((m:any) => ({
    id: String(m.id), title: String(m.title), outcome: String(m.outcome ?? m.title), status: "pending",
    slices: (m.slices ?? []).map((s:any) => ({
      id: String(s.id), title: String(s.title), status: "pending",
      tasks: (s.tasks ?? []).map((t:any) => ({ id:String(t.id), title:String(t.title), goal:String(t.goal), acceptance:Array.isArray(t.acceptance)?t.acceptance.map(String):[], verificationCommands:Array.isArray(t.verificationCommands)?t.verificationCommands.map(String):[], status:"pending", attempts:0 }))
    }))
  }));
}

function refreshStatuses(state: ShipState): void {
  for (const m of state.milestones) {
    for (const s of m.slices) {
      s.status = s.tasks.length > 0 && s.tasks.every(t => t.status === "passed") ? "complete" : s.tasks.some(t => t.status === "running" || t.status === "verifying" || t.status === "passed") ? "active" : "pending";
    }
    m.status = m.slices.length > 0 && m.slices.every(s => s.status === "complete") ? "complete" : m.slices.some(s => s.status === "active" || s.status === "complete") ? "active" : "pending";
  }
  if (state.milestones.length > 0 && state.milestones.every(m => m.status === "complete")) state.phase = "complete";
}

export class Controller {
  private root: string;
  private worker: Worker;
  constructor(root: string, worker: Worker) { this.root = root; this.worker = worker; }

  async step(): Promise<"progress"|"complete"|"blocked"> {
    const state = await loadState(this.root);
    const config = await loadConfig(this.root);
    if (state.paused) return "blocked";
    const project = await readFile(path.join(shipDir(this.root), "PROJECT.md"), "utf8");

    if (state.milestones.length === 0) {
      state.phase = "planning"; await saveState(this.root, state);
      await appendEvent(this.root, { type: "planning_started", roadmapRevision: state.roadmapRevision });
      const result = await this.worker.run(plannerPrompt(project), this.root);
      if (!result.ok) return await this.block(state, `Planning failed: ${result.error ?? "unknown error"}`);
      try {
        state.milestones = parsePlan(result.text);
      } catch (e:any) { return await this.block(state, `Invalid planner output: ${e.message}`); }
      state.roadmapRevision++;
      state.phase = "idle";
      state.lastProgressAt = new Date().toISOString();
      await saveState(this.root, state); await writeRoadmapView(this.root, state);
      await appendEvent(this.root, { type: "roadmap_created", roadmapRevision: state.roadmapRevision });
      return "progress";
    }

    refreshStatuses(state);
    if (state.phase === "complete") { await saveState(this.root, state); await writeRoadmapView(this.root, state); return "complete"; }
    const found = nextPending(state);
    if (!found) return await this.block(state, "No runnable task exists, but project is not complete");
    const {m,s,t} = found;
    if (t.attempts >= config.limits.maxTaskAttempts) return await this.block(state, `${t.id} exhausted ${t.attempts} attempts`);

    state.current = { milestoneId: m.id, sliceId: s.id, taskId: t.id };
    state.phase = "executing"; t.status = "running"; t.attempts++;
    await saveState(this.root, state); await appendEvent(this.root, { type: "task_started", taskId: t.id, attempt: t.attempts });

    const result = await this.worker.run(executorPrompt(project, state, t), this.root);
    if (!result.ok) {
      t.status = "failed"; t.lastError = result.error ?? "worker failed"; state.phase = "idle";
      await saveState(this.root, state); await appendEvent(this.root, { type: "task_worker_failed", taskId: t.id, error: t.lastError });
      return "progress";
    }

    state.phase = "verifying"; t.status = "verifying"; await saveState(this.root, state);
    for (const command of t.verificationCommands) {
      const check = await runCommand(this.root, command);
      await appendEvent(this.root, { type: "verification", taskId: t.id, command, ok: check.ok, output: check.output.slice(-4000) });
      if (!check.ok) {
        t.status = "failed"; t.lastError = `Verification failed: ${command}`; state.phase = "idle";
        await saveState(this.root, state); await writeRoadmapView(this.root, state);
        return "progress";
      }
    }

    const attemptDir = path.join(shipDir(this.root), "attempts");
    await import("node:fs/promises").then(fs => fs.mkdir(attemptDir, { recursive: true }));
    await writeFile(path.join(attemptDir, `${m.id}-${s.id}-${t.id}-a${t.attempts}.md`), `# ${t.id} attempt ${t.attempts}\n\n${result.text}\n`, "utf8");
    const sha = await commitAll(this.root, `ship: ${m.id}/${s.id}/${t.id} ${t.title}`);
    t.status = "passed"; delete t.lastError; state.phase = "idle"; state.lastProgressAt = new Date().toISOString();
    refreshStatuses(state);
    await saveState(this.root, state); await writeRoadmapView(this.root, state);
    await appendEvent(this.root, { type: "task_completed", taskId: t.id, commit: sha });
    return state.phase === "complete" ? "complete" : "progress";
  }

  private async block(state: ShipState, reason: string): Promise<"blocked"> {
    state.phase = "blocked"; state.blockedReason = reason; await saveState(this.root, state); await appendEvent(this.root, { type: "blocked", reason }); return "blocked";
  }
}
