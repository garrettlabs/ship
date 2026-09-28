import { acquireLock } from "./lock.ts";
import { buildHandoffCheckpoint, validateHandoffTransfer } from "./handoff.ts";
import { captureHandoffGit } from "./handoff-git.ts";
import { appendEvent, loadState, queueMessage, saveState } from "./store.ts";

/** Active workers receive a queued pause; idle work can checkpoint immediately. */
export async function pauseNativeHandoff(root: string, sessionId: string): Promise<string> {
  const unlock = await acquireLock(root);
  try {
    const state = await loadState(root);
    if (state.nativeBatch || state.nativePlanning || state.pendingJudgment || state.activeAttempt ||
        state.discovery?.status === "researching" || state.milestones.some(m => m.slices.some(s => s.tasks.some(t => ["running", "verifying"].includes(t.status))))) {
      await queueMessage(root, "pause");
      return "SHIP pause queued for the next safe boundary; active OMP workers must finish first.";
    }
    state.paused = true;
    try {
      state.handoff = buildHandoffCheckpoint(state, root, await captureHandoffGit(root));
    } catch (error) {
      delete state.handoff;
      await saveState(root, state);
      await appendEvent(root, { type: "native_paused_without_handoff", reason: String(error), sessionId });
      return `SHIP paused; no transferable checkpoint: ${String(error)}. Resume in the owning session or establish a committed Git HEAD.`;
    }
    await saveState(root, state);
    await appendEvent(root, { type: "native_handoff_checkpoint", sessionId, revision: state.roadmapRevision });
    return `SHIP paused at a clean handoff boundary. ${state.handoff.nextAction}. Use /ship resume in another session only if checkout and roadmap still match.`;
  } finally { await unlock(); }
}

/** A paused clean checkpoint transfers without recovering failed tasks or consuming attempts. */
export async function resumeNativeHandoff(root: string, sessionId: string): Promise<string> {
  const unlock = await acquireLock(root);
  try {
    const state = await loadState(root);
    if (!state.handoff) {
      await queueMessage(root, "resume");
      return "SHIP resume queued for the next safe boundary; no transferable checkpoint exists.";
    }
    if (!state.paused) throw new Error("Checkpoint is not paused; do not transfer active work");
    const result = validateHandoffTransfer(state, state.handoff, root, await captureHandoffGit(root));
    if (!result.ok) throw new Error(`Safe handoff refused: ${result.reason}; inspect Git and roadmap before resuming. Do not recover live workers.`);
    delete state.handoff;
    state.paused = false;
    await saveState(root, state);
    await appendEvent(root, { type: "native_handoff_resumed", sessionId, revision: state.roadmapRevision });
    return "SHIP handoff validated; no attempts consumed. Use /ship run to advance approved work in this session.";
  } finally { await unlock(); }
}
