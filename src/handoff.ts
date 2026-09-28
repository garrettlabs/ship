import { createHash } from "node:crypto";
import path from "node:path";
import type { ShipState } from "./types.ts";

/** A complete Git observation at one instant; dirty includes tracked and untracked paths. */
export interface GitSnapshot {
  branch: string;
  head: string;
  dirty: Record<string, string>;
}

export interface HandoffCheckpoint {
  root: string;
  git: GitSnapshot;
  roadmapRevision: number;
  taskProgress: string;
  phase: ShipState["phase"];
  finished: string[];
  outstanding: string[];
  omittedFinished: number;
  omittedOutstanding: number;
  pendingVerification: string[];
  pendingApproval: string[];
  decisions: string[];
  nextAction: string;
  references: string[];
}

export interface TransferValidation { ok: boolean; reason?: string }

const MAX_TEXT = 240;
const MAX_ITEMS = 40;
const text = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
const settled: Record<string, true> = { passed: true, cancelled: true, superseded: true, deferred: true };

function reasonNotQuiescent(state: ShipState): string | undefined {
  if (state.nativeBatch) return "Native batch is active";
  if (state.nativePlanning) return "Native planning is active";
  if (state.pendingJudgment) return "Semantic judgment is pending";
  if (state.activeAttempt) return "Task attempt is active; recover confirmed-dead attempts first";
  if (state.discovery?.status === "researching") return "Discovery research is active";
  if (state.milestones.some(m => m.slices.some(s => s.tasks.some(t => t.status === "running" || t.status === "verifying"))))
    return "A task is still marked active; recover confirmed-dead work first";
  return undefined;
}

function checkedRoot(root: string): string {
  if (typeof root !== "string" || !root.trim()) throw new Error("A repository root is required");
  return path.resolve(root);
}

function checkedGit(snapshot: GitSnapshot): GitSnapshot {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.branch !== "string" || !snapshot.branch.trim() ||
      !/^[a-f0-9]{40,64}$/.test(snapshot.head) || !snapshot.dirty || typeof snapshot.dirty !== "object" || Array.isArray(snapshot.dirty)) {
    throw new Error("A complete Git snapshot with branch, HEAD and dirty fingerprints is required");
  }
  const dirty = Object.create(null) as Record<string, string>;
  for (const [filename, fingerprint] of Object.entries(snapshot.dirty)) {
    if (!filename || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("Every dirty path must have a content fingerprint");
    }
    dirty[filename] = fingerprint;
  }
  return { branch: snapshot.branch, head: snapshot.head, dirty };
}

function progress(state: ShipState): string {
  const summary = [state.current, state.pendingProposal, state.knowledge, state.workspace, state.lastHead,
    state.milestones.map(m => [m.id, m.title, m.status, m.slices.map(s => [s.id, s.title, s.status,
      s.tasks.map(t => [t.id, t.title, t.status, t.attempts, t.verificationRequirements])])])];
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex");
}

/** Pure summary at a settled boundary. The caller captures Git, then persists the returned value. */
export function buildHandoffCheckpoint(state: ShipState, root: string, snapshot: GitSnapshot): HandoffCheckpoint {
  const active = reasonNotQuiescent(state);
  if (active) throw new Error(active);
  const git = checkedGit(snapshot);
  const finished: string[] = [];
  const outstanding: string[] = [];
  const pendingVerification: string[] = [];
  for (const m of state.milestones) for (const s of m.slices) for (const t of s.tasks) {
    const label = text(`${m.id}/${s.id}/${t.id} [${t.status}]: ${t.title}`);
    (settled[t.status] ? finished : outstanding).push(label);
    if (t.status === "verifying" || (t.status !== "passed" && t.attempts > 0 && t.verificationRequirements.length)) {
      pendingVerification.push(text(`${m.id}/${s.id}/${t.id}: ${t.verificationRequirements.join("; ")}`));
    }
  }
  const approval = state.pendingProposal?.status === "pending" ? [text(`Roadmap proposal ${state.pendingProposal.id}: ${state.pendingProposal.request}`)] : [];
  const decisions = (state.knowledge ?? []).filter(k => k.kind === "decision").slice(-MAX_ITEMS).map(k => text(k.text));
  const references = (state.knowledge ?? []).filter(k => k.evidence).slice(-MAX_ITEMS).map(k => text(`${k.id}: ${k.evidence}`));
  if (state.workspace) references.unshift(text(`Workspace: ${state.workspace.path}; base: ${state.workspace.baseHead}`));
  if (state.lastHead) references.unshift(text(`Last completed HEAD: ${state.lastHead}`));
  const next = outstanding.find(item => state.current?.taskId && item.startsWith(`${state.current.milestoneId}/${state.current.sliceId}/${state.current.taskId} `))
    ?? outstanding[0];
  return {
    root: checkedRoot(root), git, roadmapRevision: state.roadmapRevision, taskProgress: progress(state), phase: state.phase,
    finished: finished.slice(0, MAX_ITEMS), outstanding: outstanding.slice(0, MAX_ITEMS),
    omittedFinished: Math.max(0, finished.length - MAX_ITEMS), omittedOutstanding: Math.max(0, outstanding.length - MAX_ITEMS),
    pendingVerification: pendingVerification.slice(0, MAX_ITEMS), pendingApproval: approval, decisions,
    nextAction: approval.length ? "Obtain approval for the pending roadmap proposal" : next ? text(`Continue ${next}`) : "No outstanding planned tasks",
    references: references.slice(0, MAX_ITEMS),
  };
}

/** Recheck persisted progress and live Git before handing control to another session. */
export function validateHandoffTransfer(state: ShipState, checkpoint: HandoffCheckpoint, root: string, snapshot: GitSnapshot): TransferValidation {
  const active = reasonNotQuiescent(state);
  if (active) return { ok: false, reason: active };
  if (!checkpoint || typeof checkpoint !== "object") return { ok: false, reason: "No checkpoint exists" };
  try {
    const current = checkedGit(snapshot);
    const recorded = checkedGit(checkpoint.git);
    if (checkpoint.root !== checkedRoot(root)) return { ok: false, reason: "Repository root changed" };
    if (checkpoint.roadmapRevision !== state.roadmapRevision || checkpoint.phase !== state.phase || checkpoint.taskProgress !== progress(state))
      return { ok: false, reason: "Roadmap changed since checkpoint" };
    if (recorded.branch !== current.branch || recorded.head !== current.head) return { ok: false, reason: "Git branch or HEAD changed" };
    const before = Object.entries(recorded.dirty).sort(([a], [b]) => a.localeCompare(b));
    const now = Object.entries(current.dirty).sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(before) !== JSON.stringify(now)) return { ok: false, reason: "Git dirty paths or content changed" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Invalid Git snapshot" };
  }
}
