import { acquireLock } from "./lock.ts";
import { recomputeJudgedTask, refresh, tasks } from "./model.ts";
import { previewOwnershipReconciliation, applyOwnershipReconciliation, previewRepoCheckReconciliation, applyRepoCheckReconciliation, type OwnershipPreview, type RepoCheckPreview } from "./reconciliation.ts";
import { appendEvent, loadState, saveState, writeRoadmapView } from "./store.ts";

export interface ReconciliationPreview { ownership?: OwnershipPreview; checks: RepoCheckPreview }

/** Preview without changing accepted policy, work ownership, or task evidence. */
export async function previewNativeReconciliation(root: string): Promise<ReconciliationPreview> {
  const state = await loadState(root);
  const checks = await previewRepoCheckReconciliation(root, state);
  const ownership = state.preexistingWork?.paths.length && !state.nativeBatch && !state.activeAttempt
    ? await previewOwnershipReconciliation(root, state) : undefined;
  return { ownership, checks };
}

/** Explicit UI-approved reconciliation; every observation is checked again under the state lock. */
export async function applyNativeReconciliation(root: string, sessionId: string, preview: ReconciliationPreview,
  choice: { kind: "ownership"; paths: string[] } | { kind: "checks" }): Promise<string> {
  if (!sessionId?.trim()) throw new Error("Main OMP session is required for reconciliation");
  const unlock = await acquireLock(root);
  try {
    const state = await loadState(root);
    if (state.nativeBatch || state.nativePlanning || state.pendingJudgment || state.activeAttempt || state.workspace)
      throw new Error("Reconciliation requires a settled boundary; do not interrupt active workers");
    if (choice.kind === "ownership") {
      if (!preview.ownership) throw new Error("No previously dirty paths were previewed");
      state.preexistingWork = await applyOwnershipReconciliation(root, state, preview.ownership, choice.paths);
      await saveState(root, state);
      await appendEvent(root, { type: "ownership_reconciled", sessionId, paths: choice.paths });
      return `SHIP ownership reconciled: ${choice.paths.join(", ")}. Recheck /ship status, then /ship resume and /ship run if blocked.`;
    }
    if (!preview.checks.changes.length) return "SHIP declared repository checks are unchanged.";
    const result = await applyRepoCheckReconciliation(root, state, preview.checks, true);
    state.repoChecks = result.repoChecks;
    const affected = new Set(result.affectedTaskKeys);
    const invalidated: string[] = [];
    for (const entry of tasks(state)) {
      if (!affected.has(entry.key)) continue;
      recomputeJudgedTask(entry.t, result.repoChecks);
      if (entry.t.status === "passed") {
        entry.t.status = "failed";
        entry.t.lastError = "Repository verification policy changed; prior evidence is retained but fresh verification is required";
        invalidated.push(entry.key);
      }
    }
    if (state.phase === "complete" && invalidated.length) state.phase = "idle";
    refresh(state);
    await saveState(root, state);
    await writeRoadmapView(root, state);
    await appendEvent(root, { type: "repo_checks_reconciled", sessionId, changes: preview.checks.changes, invalidated });
    return `SHIP repository checks reconciled. ${result.affectedTaskKeys.length} affected tasks; ${invalidated.length} previously passed tasks require fresh verification. Use /ship run to continue.`;
  } finally { await unlock(); }
}
