import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DependencyGraph } from "./dependency-graph.ts";
import { previewRepoCheckReconciliation } from "./reconciliation.ts";
import type { ShipState } from "./types.ts";
import { targetProgress } from "./run-target.ts";

const summaryLimit = 2_000;
const detailLimit = 4_000;
const shipPath = (root: string, ...parts: string[]) => path.join(root, ".ship", ...parts);
const short = (value: unknown, limit = 180): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const bounded = (lines: string[], limit: number): string => {
  let result = "";
  for (const line of lines) {
    if (result.length + line.length + 1 > limit) return result.trimEnd() + "\n… more available with /ship status <Mxx/Sxx/Txx>";
    result += `${line}\n`;
  }
  return result.trimEnd();
};

async function inboxSummary(root: string, state: ShipState): Promise<{ changes: string[]; captures: number; controls: number }> {
  let names: string[];
  try { names = await readdir(shipPath(root, "inbox")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { changes: [], captures: 0, controls: 0 }; throw error; }
  const processed = new Set(state.processedInbox ?? []);
  const pending = names.filter(name => name.endsWith(".json") && !processed.has(name)).sort();
  const changes: string[] = [];
  let captures = 0, controls = 0;
  for (const name of pending) {
    const message = JSON.parse(await readFile(shipPath(root, "inbox", name), "utf8")) as Record<string, unknown>;
    if (message.type === "capture") captures++;
    else if (message.type === "pause" || message.type === "resume") controls++;
    else if (message.type === "add" || message.type === "change") changes.push(`${message.type} ${short(message.type === "add" ? message.title : message.task, 60)} (r${message.revision})`);
  }
  return { changes, captures, controls };
}

interface EventRecord { type?: string; task?: string; command?: string; ok?: boolean; at?: string; }
async function recentVerification(root: string, passed: ReadonlySet<string>): Promise<EventRecord | undefined> {
  let file;
  try { file = await open(shipPath(root, "events.jsonl"), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const event = JSON.parse(lines[index]) as EventRecord;
        if (event.type === "verification" && event.ok === true && typeof event.task === "string" && passed.has(event.task)) return event;
      } catch { /* An incomplete or unrelated log line is not evidence. */ }
    }
    return undefined;
  } finally { await file.close(); }
}

/** Read-only projection of a persisted snapshot; root must already be resolved by the caller. */
export async function formatStatus(root: string, state: ShipState, taskKey?: string): Promise<string> {
  const entries = state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(task => ({ key: `${m.id}/${s.id}/${task.id}`, milestone: m, slice: s, task }))));
  const graph = entries.length ? new DependencyGraph(state.milestones) : undefined;
  const passed = new Set(entries.filter(entry => entry.task.status === "passed").map(entry => entry.key));
  const verified = await recentVerification(root, passed);
  const inbox = await inboxSummary(root, state);
  const pending = state.pendingProposal;
  const history = state.proposalHistory ?? [];
  const rejected = state.rejectedEdits ?? [];
  if (taskKey) {
    const found = entries.find(entry => entry.key === taskKey);
    if (!found) return `Unknown task ${short(taskKey, 100)}. Use a stable key such as M001/S01/T01.`;
    const { task, milestone, slice } = found;
    const prerequisites = graph?.dependencies.get(found.key) ?? [];
    const byKey = new Map(entries.map(entry => [entry.key, entry.task]));
    const assignment = state.nativeBatch?.assignments.find(item => item.key === found.key);
    const lines = [
      `${found.key}: ${short(task.title, 180)} [${task.status}]`,
      `Milestone ${milestone.id}: ${short(milestone.title)} · Slice ${slice.id}: ${short(slice.title)}`,
      `Goal: ${short(task.goal, 400)}`,
      `Prerequisites: ${prerequisites.map(key => `${key} [${byKey.get(key)?.status ?? "unknown"}]`).join(", ") || "none"}`,
      `Acceptance: ${task.acceptance.length ? task.acceptance.map(value => short(value, 220)).join("; ") : "none"}`,
      `Route: ${task.executionRoute}; ${task.execution.role} (${task.execution.mode})${task.execution.specialist ? `; specialist ${task.execution.specialist}` : ""}`,
      `Verification: ${task.verificationPlan.requirements.map(requirement => `${requirement.kind}${requirement.command ? ` (${short(requirement.command, 100)})` : ""}`).join("; ") || "none"}`,
      `History: ${task.attempts} attempt(s)${task.lastError ? `; last error: ${short(task.lastError, 350)}` : ""}${assignment ? `; ${state.nativeBatch?.stage} ${assignment.status}${assignment.summary ? `: ${short(assignment.summary, 280)}` : ""}` : ""}`,
      `Evidence: ${task.evidenceRefs?.length ? task.evidenceRefs.map(ref => short(ref, 180)).join("; ") : verified?.task === found.key ? `events.jsonl verification ${short(verified.command, 120)} (${verified.at ?? "time unknown"})` : task.status === "passed" ? "passed in roadmap; no recent verification artifact available" : "not yet verified"}`,
    ];
    return bounded(lines, detailLimit);
  }
  const activeMilestone = state.milestones.find(m => m.id === state.current?.milestoneId) ??
    state.milestones.find(m => m.status === "active") ??
    state.milestones.find(m => m.status === "pending");
  const activeSlice = activeMilestone?.slices.find(s => s.id === state.current?.sliceId) ??
    activeMilestone?.slices.find(s => s.status === "active") ??
    activeMilestone?.slices.find(s => s.status === "pending");
  const targetKeys = state.runTarget?.keys.length ? new Set(state.runTarget.keys) : undefined;
  const inTarget = (key: string) => !targetKeys || targetKeys.has(key);
  const running = entries.filter(entry => inTarget(entry.key) && (entry.task.status === "running" || entry.task.status === "verifying"));
  const ready = (graph?.readyTasks() ?? []).filter(node => inTarget(node.key));
  const blocked = (graph?.blockedTasks() ?? []).filter(node => inTarget(node.key));
  const deferredDependencies = graph?.order.flatMap(node => {
    if (!inTarget(node.key) || ["passed", "cancelled", "superseded", "deferred"].includes(node.task.status)) return [];
    const unresolved = (graph.dependencies.get(node.key) ?? []).filter(key => {
      const status = entries.find(entry => entry.key === key)?.task.status;
      return status === "cancelled" || status === "superseded" || status === "deferred";
    });
    return unresolved.length ? [`${node.key} needs ${unresolved.join(", ")}`] : [];
  }) ?? [];
  const remaining = entries.filter(entry => !["passed", "cancelled", "superseded", "deferred"].includes(entry.task.status));
  const lines = [
    `${short(state.projectName, 80)}: ${state.phase}${state.paused ? " (paused)" : ""}; roadmap r${state.roadmapRevision}, ${entries.length} tasks, ${state.dispatches ?? 0} dispatches`,
    `Current: ${activeMilestone ? `${activeMilestone.id} ${short(activeMilestone.title, 65)}` : "none"}${activeSlice ? ` / ${activeSlice.id} ${short(activeSlice.title, 65)}` : ""}`,
    `Roadmap: ${passed.size} verified/passed, ${remaining.length} remaining${entries.length - passed.size - remaining.length ? `, ${entries.length - passed.size - remaining.length} deferred/cancelled/superseded` : ""}`,
  ];
  lines.push(`Mode: ${state.autonomy === "yolo" ? "yolo" : "supervised"}${state.autonomy === "yolo" ? " (same-session only)" : ""}`);
  if (state.runTarget?.keys.length) {
    const target = state.runTarget;
    const progress = targetProgress(state, target);
    const scoped = new Set(target.keys);
    const verifiedCount = entries.filter(entry => scoped.has(entry.key) && entry.task.status === "passed").length;
    const label = target.scope === "all" ? "whole roadmap" : target.scope === "milestone" ? `through milestone ${target.id}` : `${target.scope} ${target.id}`;
    lines.push(`Run target: ${label}; ${verifiedCount}/${target.keys.length} verified/total${progress.complete ? " (target complete)" : ""}${progress.invalid ? `; ${short(progress.invalid, 100)}` : ""}`);
  } else lines.push(state.runTarget ? "Run target: awaiting approved roadmap; default first incomplete milestone" : "Run target: not selected; next /ship run chooses the first incomplete milestone (status is read-only)");
  if (state.discovery) lines.push(`Discovery: ${state.discovery.status}${state.discovery.goalSet ? " (goal set)" : " (no goal)"}`);
  if (state.handoff) lines.push(`Clean handoff checkpoint: ${short(state.handoff.nextAction, 150)}; /ship resume validates Git branch, HEAD, dirty content and roadmap before transfer`);
  if (state.nativePlanning) lines.push(`Planning: awaiting plan ${state.nativePlanning.id}`);
  if (running.length) lines.push(`Running: ${running.slice(0, 3).map(entry => `${entry.key} [${entry.task.status}${state.nativeBatch?.assignments.some(a => a.key === entry.key) ? `/${state.nativeBatch.stage}` : ""}] ${short(entry.task.title, 65)}`).join("; ")}${running.length > 3 ? ` (+${running.length - 3} more)` : ""}`);
  if (ready.length) lines.push(`Next ready: ${ready.slice(0, 3).map(node => `${node.key} ${short(node.task.title, 65)}`).join("; ")}${ready.length > 3 ? ` (+${ready.length - 3} more)` : ""}`);
  if (blocked.length) lines.push(`Blocked prerequisites: ${blocked.slice(0, 2).map(node => `${node.key} needs failed ${node.failedAncestors.join(", ")}`).join("; ")}${blocked.length > 2 ? ` (+${blocked.length - 2} more)` : ""}; repair failed ancestors first`);
  if (deferredDependencies.length) lines.push(`Unavailable prerequisites: ${deferredDependencies.slice(0, 2).join("; ")}${deferredDependencies.length > 2 ? ` (+${deferredDependencies.length - 2} more)` : ""}; revise the dependency or restore its prerequisite`);
  if (state.blockedReason) lines.push(`Blocked: ${short(state.blockedReason, 240)}; inspect cause then /ship resume or /ship recover as appropriate`);
  if (entries.length) {
    try {
      const policy = await previewRepoCheckReconciliation(root, state);
      if (policy.changes.length) lines.push(`Verification policy changed: ${policy.changes.length} added/removed/replaced checks; ${policy.affectedTaskKeys.length} affected tasks. Review with /ship reconcile before more dispatch.`);
    } catch (error) {
      lines.push(`Verification policy could not be inspected: ${short(String(error), 180)}; resolve before /ship run`);
    }
  }
  if (pending) lines.push(`Plan approval: ${pending.id} [${pending.status}] ${short(pending.impactedSummary.join("; "), 130)}; review and approve or reject before applying`);
  if (state.futureMilestones?.length) lines.push(`Future milestones: ${state.futureMilestones.length} deferred from active scope`);
  const lastRejected = [...history].reverse().find(item => item.status === "rejected" && item.reason);
  if (lastRejected) lines.push(`Rejected plan ${lastRejected.id}: ${short(lastRejected.reason, 130)}`);
  if (rejected.length) lines.push(`Rejected change ${rejected.at(-1)!.id}: ${short(rejected.at(-1)!.reason, 130)}`);
  if (inbox.changes.length) lines.push(`Queued changes (${inbox.changes.length}): ${inbox.changes.slice(0, 2).join("; ")}${inbox.changes.length > 2 ? " …" : ""}; apply at safe boundary`);
  if (inbox.controls) lines.push(`Queued controls: ${inbox.controls}`);
  lines.push(`Captured ideas: ${(state.knowledge ?? []).filter(k => k.kind === "capture").length + inbox.captures}${inbox.captures ? ` (${inbox.captures} queued)` : ""}`);
  if (verified) {
    const evidence = entries.find(entry => entry.key === verified.task)?.task.evidenceRefs?.at(-1);
    lines.push(`Last verified: ${verified.task} ${short(verified.command, 90)}; evidence ${short(evidence ?? ".ship/events.jsonl", 160)} (${verified.at ?? "time unknown"})`);
  }
  else {
    const withEvidence = entries.findLast(entry => entry.task.status === "passed" && entry.task.evidenceRefs?.length);
    lines.push(withEvidence
      ? `Verified evidence (time unavailable): ${withEvidence.key}; ${short(withEvidence.task.evidenceRefs!.at(-1), 160)}`
      : "Last verified: none recorded");
  }
  if (entries.length) lines.push(`Details: /ship status ${entries[0]!.key} (use a task's stable key)`);
  return bounded(lines, summaryLimit);
}
