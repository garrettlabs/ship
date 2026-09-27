import { mkdir, readFile, rename, open, access, appendFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxMessage, RoadmapEdit, ShipConfig, ShipState } from "./types.ts";
import { applyRoadmapEdit, normalizePlan, refresh, strings, tasks } from "./model.ts";
import { DependencyGraph } from "./dependency-graph.ts";
export const shipDir = (root: string) => path.join(root, ".ship");
export const statePath = (root: string) => path.join(shipDir(root), "state.json");
export const configPath = (root: string) => path.join(shipDir(root), "config.json");
export async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(tmp, file);
    // POSIX directory sync makes the rename durable on local filesystems.
    // Windows does not permit fsync on a directory handle.
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(file), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally { await unlink(tmp).catch(() => {}); }
}
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
function validateNativeState(s: ShipState): void {
  const invalid = (detail: string): never => { throw new Error(`Invalid persisted native state: ${detail}`); };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const label = (value: unknown): value is string => typeof value === "string" && !!value.trim();
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!["idle", "planning", "executing", "verifying", "reviewing", "blocked", "complete"].includes(s.phase)) invalid("phase");
  if (!count(s.roadmapRevision) || (s.dispatches !== undefined && !count(s.dispatches)) || (s.planningFailures !== undefined && !count(s.planningFailures))) invalid("counters");
  if (s.nativePlanning !== undefined) {
    const p = s.nativePlanning;
    if (!record(p) || !label(p.id) || !label(p.sessionId) || !count(p.attempts) || s.nativeBatch || s.milestones.length || !["planning", "blocked", "idle"].includes(s.phase)) invalid("planning assignment");
  }
  if (s.nativeBatch !== undefined) {
    const b = s.nativeBatch;
    if (!record(b) || !label(b.id) || !label(b.sessionId) || !count(b.revision) || b.revision !== s.roadmapRevision ||
        !["executing", "reviewing"].includes(b.stage) || !Array.isArray(b.assignments) || !b.assignments.length ||
        (b.settling !== undefined && typeof b.settling !== "boolean") || (b.awaitingBudget !== undefined && typeof b.awaitingBudget !== "boolean") ||
        (b.awaitingBudget && (b.stage !== "reviewing" || b.settling || b.assignments.some(a => a?.status !== "pending"))) ||
        (b.settling && b.assignments.some(a => a?.status === "pending")) ||
        !["executing", "verifying", "idle", "blocked"].includes(s.phase)) invalid("batch");
    const known = new Map(tasks(s).map(item => [item.key, item.t]));
    const ids = new Set<string>(), keys = new Set<string>();
    for (const a of b.assignments) {
      if (!record(a) || !label(a.id) || !label(a.key) || ids.has(a.id) || keys.has(a.key) ||
          !["pending", "passed", "failed", "partial"].includes(a.status) ||
          (a.status === "pending" ? a.summary !== undefined : !label(a.summary)) ||
          (a.routed !== undefined && typeof a.routed !== "boolean") ||
          (a.specialistDispatched !== undefined && typeof a.specialistDispatched !== "boolean") ||
          (a.reviewVerdict !== undefined && !["correct", "incorrect", "unknown"].includes(a.reviewVerdict)) ||
          (a.verifiedCommands !== undefined && (!Array.isArray(a.verifiedCommands) || a.verifiedCommands.some(command => !label(command)))) ||
          !known.has(a.key) || !["running", "verifying"].includes(known.get(a.key)!.status) ||
          (b.stage === "reviewing" && known.get(a.key)!.status !== "verifying")) invalid("batch assignment");
      ids.add(a.id); keys.add(a.key);
    }
  }
  if (s.pendingJudgment !== undefined) {
    const p = s.pendingJudgment;
    if (!record(p) || !label(p.id) || !label(p.sessionId) || !label(p.key) || !count(p.revision) ||
        !label(p.requestHash) || !/^[0-9a-f]{64}$/.test(p.requestHash) ||
        p.revision !== s.roadmapRevision || !count(p.requestedAt) || !Array.isArray(p.eligible) ||
        p.eligible.length < 2 || p.eligible.some(role => !["smol", "task", "slow"].includes(role)) ||
        !tasks(s).some(entry => entry.key === p.key && entry.t.status === "pending") ||
        s.nativeBatch || s.nativePlanning || s.phase !== "idle") invalid("pending judgment");
  }
}

export async function loadState(root: string): Promise<ShipState> {
  const s = await readJson<ShipState>(statePath(root));
  if (!s || s.schemaVersion !== 1 || !Array.isArray(s.milestones) || typeof s.paused !== "boolean" || !Number.isInteger(s.roadmapRevision)) throw new Error("Invalid state.json");
  if (s.repoChecks !== undefined && (!Array.isArray(s.repoChecks) || s.repoChecks.some(c => !c || !["focused-tests", "broader-tests", "typecheck", "lint", "build", "integration"].includes(c.kind) || typeof c.command !== "string" || !c.command.trim() || typeof c.source !== "string" || !c.source.trim()))) throw new Error("Invalid persisted repo checks");
  if (s.ownedSnapshots !== undefined && (typeof s.ownedSnapshots !== "object" || s.ownedSnapshots === null ||
      Array.isArray(s.ownedSnapshots) || Object.entries(s.ownedSnapshots).some(([filename, hash]) =>
        !filename || typeof hash !== "string" || (!["absent", "directory", "unknown"].includes(hash) && !/^[a-f0-9]{64}$/.test(hash))))) throw new Error("Invalid persisted owned snapshots");
  if (s.milestones.length) s.milestones = normalizePlan(s.milestones, false, s.repoChecks);
  validateNativeState(s);
  s.knowledge ??= []; s.processedInbox ??= []; s.dispatches ??= 0; s.planningFailures ??= 0;
  return s;
}
export async function saveState(root: string, state: ShipState): Promise<void> { state.updatedAt = new Date().toISOString(); await atomicJson(statePath(root), state); }
export async function loadConfig(root: string): Promise<ShipConfig> {
  const c = await readJson<ShipConfig>(configPath(root));
  if (c.schemaVersion !== 1 || !c.limits) throw new Error("Invalid config.json");
  for (const n of [c.limits.maxTaskAttempts, c.limits.maxDispatches, c.verificationTimeoutMs ?? 300_000]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Timeouts and limits must be positive integers");
  }
  if (c.judgment !== undefined) {
    const j = c.judgment;
    if (!j || typeof j !== "object" || typeof j.enabled !== "boolean" ||
        (j.confidenceThreshold !== undefined && (typeof j.confidenceThreshold !== "number" || !Number.isFinite(j.confidenceThreshold) || j.confidenceThreshold <= 0 || j.confidenceThreshold > 1)) ||
        (j.timeoutMs !== undefined && (!Number.isSafeInteger(j.timeoutMs) || j.timeoutMs < 1000 || j.timeoutMs > 120_000))) throw new Error("Invalid judgment configuration");
  }
  strings(c.protectedChecks ?? [], "protectedChecks");
  return c;
}
export async function appendEvent(root: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(path.join(shipDir(root), "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
}
async function writeInbox(root: string, message: RoadmapEdit | { type: "pause" | "resume" } | { type: "capture"; note: string }): Promise<void> {
  if (!await exists(statePath(root))) throw new Error("Run ship init first");
  const id = `${Date.now()}-${randomUUID()}`;
  await atomicJson(path.join(shipDir(root), "inbox", `${id}.json`), { ...message, id, at: new Date().toISOString() });
}
export async function queueMessage(root: string, type: "pause" | "resume" | "capture", note?: string): Promise<void> {
  if (type === "capture" && (!note?.trim() || note.length > 20_000)) throw new Error("Capture must be 1–20,000 characters");
  await writeInbox(root, type === "capture" ? { type, note: note! } : { type });
}
export async function queueRoadmapEdit(root: string, edit: RoadmapEdit): Promise<void> {
  const state = await loadState(root);
  if (!state.milestones.length) throw new Error("Roadmap has not been loaded");
  if (!Number.isSafeInteger(edit.revision) || edit.revision < 0) throw new Error("Invalid roadmap revision");
  if (edit.revision !== state.roadmapRevision) throw new Error(`Stale roadmap revision: requested ${edit.revision}, current ${state.roadmapRevision}`);
  await writeInbox(root, edit);
}
export async function consumeInbox(root: string, state: ShipState): Promise<void> {
  state.processedInbox ??= []; state.knowledge ??= [];
  const dir = path.join(shipDir(root), "inbox"); await mkdir(dir, { recursive: true });
  for (const file of (await readdir(dir)).filter(x => x.endsWith(".json")).sort()) {
    if (state.processedInbox.includes(file)) continue;
    const msg = await readJson<InboxMessage>(path.join(dir, file));
    if (msg.type === "pause") state.paused = true;
    else if (msg.type === "resume") { state.paused = false; if (state.phase === "blocked") { state.phase = "idle"; delete state.blockedReason; } }
    else if (msg.type === "capture" && typeof msg.note === "string" && msg.note.trim()) state.knowledge.push({ id: `K${String(state.knowledge.length + 1).padStart(4, "0")}`, kind: "capture", text: msg.note, source: "user", evidence: `inbox/${file}`, at: msg.at });
    else if (msg.type === "add" || msg.type === "change") {
      if (state.activeAttempt || state.nativeBatch || state.nativePlanning || state.pendingJudgment) continue;
      try {
        const allowed = ["id", "type", "at", "goal", "revision", "taskType", "uncertainty", "profile", "dependencies", "affectedFiles", "affectedDomains", "verificationRequirements", ...(msg.type === "add" ? ["slice", "title", "acceptance", "check"] : ["task"])];
        if (Object.keys(msg).some(key => !allowed.includes(key))) throw new Error("Roadmap edit contains forbidden fields");
        applyRoadmapEdit(state, msg);
        refresh(state);
      }
      catch (error) {
        state.phase = "blocked";
        state.blockedReason = `Rejected inbox/${file}: ${error instanceof Error ? error.message : String(error)}`;
        state.processedInbox.push(file);
        break;
      }
    } else throw new Error(`Invalid inbox message: ${file}`);
    state.processedInbox.push(file);
  }
  // State and applied/rejected IDs are committed together: replay cannot duplicate a mutation.
  await saveState(root, state);
  await writeRoadmapView(root, state);
}
export async function writeRoadmapView(root: string, state: ShipState): Promise<void> {
  const lines = ["# Roadmap (generated)", "", `Revision: ${state.roadmapRevision}`, ""];
  for (const m of state.milestones) {
    lines.push(`## ${m.id}: ${m.title} [${m.status}]`, "", m.outcome, "");
    for (const s of m.slices) { lines.push(`### ${s.id}: ${s.title} [${s.status}]`, ""); for (const t of s.tasks) lines.push(`- [${t.status === "passed" ? "x" : " "}] ${t.id} — ${t.title} (${t.status})`, `  ${t.goal}`); }
  }
  await writeFile(path.join(shipDir(root), "ROADMAP.md"), lines.join("\n") + "\n");
  const graph = state.milestones.length ? new DependencyGraph(state.milestones) : undefined;
  const executionPlan = {
    revision: state.roadmapRevision,
    levels: graph?.levels.map(level => level.map(node => node.key)) ?? [],
    tasks: tasks(state).map(({ key, t }) => ({
      key, title: t.title, objective: t.objective, goal: t.goal, status: t.status,
      taskType: t.taskType, complexity: t.complexity, risk: t.risk, uncertainty: t.uncertainty,
      prerequisites: graph?.dependencies.get(key) ?? [], dependencyLevel: t.dependencyLevel,
      ownership: { files: t.affectedFiles, domains: t.affectedDomains },
      parallelEligible: t.parallelEligible, executionRoute: t.executionRoute,
      classificationSignals: t.classificationSignals, classificationRationale: t.classificationRationale,
      execution: t.execution, verificationRequirements: t.verificationRequirements, verificationCommands: t.verificationCommands,
      verificationPlan: t.verificationPlan, acceptance: t.acceptance,
    })),
  };
  await atomicJson(path.join(shipDir(root), "EXECUTION_PLAN.json"), executionPlan);
  const planned = ["# Execution plan (generated)", "", `Roadmap revision: ${state.roadmapRevision}`, ""];
  for (const item of executionPlan.tasks) {
    planned.push(`## ${item.key}: ${item.title} [${item.status}]`, "",
      `Objective: ${item.objective}`, `Goal: ${item.goal}`, `Type: ${item.taskType}; complexity: ${item.complexity}; risk: ${item.risk}; uncertainty: ${item.uncertainty}`,
      `Dependency level: ${item.dependencyLevel}; prerequisites: ${item.prerequisites.join(", ") || "none"}`,
      `Ownership: files ${item.ownership.files.join(", ") || "unspecified"}; domains ${item.ownership.domains.join(", ") || "unspecified"}`,
      `Parallel eligible: ${item.parallelEligible}; execution route: ${item.executionRoute}`,
      `Role: ${item.execution.role} (${item.execution.mode}); reason: ${item.execution.reason}`,
      `Specialists: execution ${item.execution.specialist ?? "none"}; verification ${item.execution.verificationSpecialist ?? "none"}`,
      `Classification signals: ${item.classificationSignals.join(", ") || "none"}; rationale: ${item.classificationRationale.join("; ")}`,
      `Acceptance: ${item.acceptance.join("; ")}`,
      `Verification requirements: ${item.verificationRequirements.join("; ")}`,
      `Verification commands: ${item.verificationCommands.join("; ")}`,
      `Verification policy: ${item.verificationPlan.requirements.map(r => `${r.kind}: ${r.reason}${r.command ? ` (${r.command})` : ""}`).join("; ")}`, "");
  }
  await writeFile(path.join(shipDir(root), "EXECUTION_PLAN.md"), planned.join("\n") + "\n");
  await writeFile(path.join(shipDir(root), "KNOWLEDGE.md"), "# Knowledge (generated; agent entries are proposals, not user authorization)\n\n" + (state.knowledge ?? []).map(k => `## ${k.id} [${k.kind}; ${k.source}]\n${k.text}\n\nEvidence: ${k.evidence}\n`).join("\n"));
}
