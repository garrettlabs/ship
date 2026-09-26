import { mkdir, readFile, rename, open, access, appendFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxMessage, RoadmapEdit, ShipConfig, ShipState } from "./types.ts";
import { applyRoadmapEdit, normalizePlan, refresh, strings } from "./model.ts";
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
export async function loadState(root: string): Promise<ShipState> {
  const s = await readJson<ShipState>(statePath(root));
  if (s.schemaVersion !== 1 || !Array.isArray(s.milestones) || typeof s.paused !== "boolean" || !Number.isInteger(s.roadmapRevision)) throw new Error("Invalid state.json");
  if (s.milestones.length) s.milestones = normalizePlan(s.milestones);
  s.knowledge ??= []; s.processedInbox ??= []; s.reviewedSlices ??= []; s.reviewAttempts ??= {}; s.dispatches ??= 0; s.planningFailures ??= 0;
  return s;
}
export async function saveState(root: string, state: ShipState): Promise<void> { state.updatedAt = new Date().toISOString(); await atomicJson(statePath(root), state); }
export async function loadConfig(root: string): Promise<ShipConfig> {
  const c = await readJson<ShipConfig>(configPath(root));
  if (c.schemaVersion !== 1 || !c.worker?.command || !c.limits) throw new Error("Invalid config.json");
  strings(c.worker.args, "worker.args");
  for (const n of [c.worker.startupTimeoutMs, c.worker.inactivityTimeoutMs, c.worker.hardTimeoutMs, c.limits.maxTaskAttempts, c.limits.maxDispatches, c.verificationTimeoutMs ?? 300_000]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Timeouts and limits must be positive integers");
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
      if (state.activeAttempt) continue;
      try {
        const allowed = msg.type === "add" ? ["id", "type", "at", "slice", "title", "goal", "acceptance", "check", "revision"] : ["id", "type", "at", "task", "goal", "revision"];
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
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(shipDir(root), "ROADMAP.md"), lines.join("\n") + "\n");
  await writeFile(path.join(shipDir(root), "KNOWLEDGE.md"), "# Knowledge (generated; agent entries are proposals, not user authorization)\n\n" + (state.knowledge ?? []).map(k => `## ${k.id} [${k.kind}; ${k.source}]\n${k.text}\n\nEvidence: ${k.evidence}\n`).join("\n"));
}
