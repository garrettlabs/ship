import { mkdir, readFile, rename, open, access, appendFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxMessage, ShipConfig, ShipState } from "./types.ts";
import { consumeWorkMessage, validateWorkRequests } from "./work.ts";
import { strings, validatePlan } from "./model.ts";
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
    const dir = await open(path.dirname(file), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(tmp).catch(() => {}); }
}
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
export async function loadState(root: string): Promise<ShipState> {
  const s = await readJson<ShipState>(statePath(root));
  if (s.schemaVersion !== 1 || !Array.isArray(s.milestones) || typeof s.paused !== "boolean" || !Number.isInteger(s.roadmapRevision)) throw new Error("Invalid state.json");
  if (s.milestones.length) {
    validatePlan(s.milestones);
    for (const m of s.milestones) for (const slice of m.slices) for (const t of slice.tasks) {
      if (!["pending", "running", "verifying", "passed", "failed", "blocked"].includes(t.status) || !Number.isInteger(t.attempts) || t.attempts < 0) throw new Error("Invalid task state");
    }
  }
  s.knowledge ??= []; s.processedInbox ??= []; s.reviewedSlices ??= []; s.reviewAttempts ??= {}; s.dispatches ??= 0; s.planningFailures ??= 0;
  s.workRequests ??= []; validateWorkRequests(s.workRequests);
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
export async function queueMessage(root: string, type: "pause" | "resume" | "capture" | "add", note?: string): Promise<void> {
  if (!await exists(statePath(root))) throw new Error("Run ship init first");
  if ((type === "capture" || type === "add") && (!note?.trim() || note.length > 20_000)) throw new Error("Note must be 1–20,000 characters");
  const id = `${Date.now()}-${randomUUID()}`;
  await atomicJson(path.join(shipDir(root), "inbox", `${id}.json`), { id, type, note, at: new Date().toISOString() });
}
// CLI/TUI never write the canonical roadmap. Approval binds to the proposal the
// user inspected, not whichever proposal happens to exist when it is consumed.
export async function queueWorkDecision(root: string, type: "approve" | "reject", requestId: string, expectedProposalId?: string): Promise<void> {
  const s = await loadState(root), r = s.workRequests!.find(x => x.id === requestId);
  if (!r) throw new Error(`Unknown work request: ${requestId}`);
  if (r.status === "applied" || r.status === "rejected") throw new Error(`Request ${requestId} is already ${r.status}`);
  if (type === "approve" && (r.status !== "proposed" || !r.proposal || (expectedProposalId !== undefined && expectedProposalId !== r.proposal.id))) throw new Error("No matching pending proposal; run ship proposals before approval");
  const id = `${Date.now()}-${randomUUID()}`;
  await atomicJson(path.join(shipDir(root), "inbox", `${id}.json`), { id, type, requestId, proposalId: r.proposal?.id, at: new Date().toISOString() });
}
export async function consumeInbox(root: string, state: ShipState): Promise<boolean> {
  let changed = false;
  state.processedInbox ??= []; state.knowledge ??= [];
  const dir = path.join(shipDir(root), "inbox"); await mkdir(dir, { recursive: true });
  for (const file of (await readdir(dir)).filter(x => x.endsWith(".json")).sort()) {
    if (state.processedInbox.includes(file)) continue;
    const msg = await readJson<InboxMessage>(path.join(dir, file));
    if (msg.type === "pause") state.paused = true;
    else if (msg.type === "resume") { state.paused = false; if (state.phase === "blocked") { state.phase = "idle"; delete state.blockedReason; } }
    else if (msg.type === "capture" && typeof msg.note === "string" && msg.note.trim()) state.knowledge.push({ id: `K${String(state.knowledge.length + 1).padStart(4, "0")}`, kind: "capture", text: msg.note, source: "user", evidence: `inbox/${file}`, at: msg.at });
    else if (["add", "approve", "reject"].includes(msg.type)) {
      if (!consumeWorkMessage(state, msg, file)) continue;
    } else throw new Error(`Invalid inbox message: ${file}`);
    state.processedInbox.push(file); changed = true;
  }
  // State and applied IDs are committed together: a replay cannot duplicate an
  // addition/capture. Idle polling must not fsync an unchanged snapshot.
  if (changed) await saveState(root, state);
  return changed;
}
export async function writeRoadmapView(root: string, state: ShipState): Promise<void> {
  const lines = ["# Roadmap (generated)", "", `Revision: ${state.roadmapRevision}`, ""];
  for (const m of state.milestones) {
    lines.push(`## ${m.id}: ${m.title} [${m.status}]`, "", m.outcome, "");
    for (const s of m.slices) { lines.push(`### ${s.id}: ${s.title} [${s.status}]`, ""); for (const t of s.tasks) lines.push(`- [${t.status === "passed" ? "x" : " "}] ${t.id} — ${t.title} (${t.status})`, `  ${t.goal}`); }
  }
  if (state.workRequests?.length) {
    lines.push("", "## User work requests", "");
    for (const r of state.workRequests) lines.push(`- ${r.id} [${r.status}] ${r.text}${r.appliedRevision ? ` (applied in r${r.appliedRevision})` : ""}`);
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(shipDir(root), "ROADMAP.md"), lines.join("\n") + "\n");
  await writeFile(path.join(shipDir(root), "KNOWLEDGE.md"), "# Knowledge (generated; agent entries are proposals, not user authorization)\n\n" + (state.knowledge ?? []).map(k => `## ${k.id} [${k.kind}; ${k.source}]\n${k.text}\n\nEvidence: ${k.evidence}\n`).join("\n"));
}
