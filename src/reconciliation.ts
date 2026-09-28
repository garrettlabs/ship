import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { git } from "./git.ts";
import { gitDirtySnapshot } from "./project-profile.ts";
import type { RepoCheck, ShipState } from "./types.ts";
import { discoverRepoChecks, routeVerification } from "./verification.ts";

export interface OwnershipPreview {
  branch: string;
  head: string | null;
  fingerprint: string;
  previouslyDirty: string[];
  eligiblePaths: string[];
  stillDirtyPaths: string[];
}

export interface RepoCheckChange {
  type: "added" | "removed" | "replaced";
  before?: RepoCheck;
  after?: RepoCheck;
}

export interface RepoCheckPreview {
  previous: RepoCheck[];
  discovered: RepoCheck[];
  changes: RepoCheckChange[];
  affectedTaskKeys: string[];
  evidenceInvalidation: string;
}

const pathKey = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value.replaceAll("\\", "/");
const checkKey = (check: RepoCheck) => JSON.stringify([check.kind, check.command, check.source, check.definition, check.runner, check.fingerprint]);
const sortedChecks = (checks: readonly RepoCheck[]) => [...checks].sort((a, b) => checkKey(a).localeCompare(checkKey(b)));
const sameChecks = (a: readonly RepoCheck[], b: readonly RepoCheck[]) => JSON.stringify(sortedChecks(a)) === JSON.stringify(sortedChecks(b));

function changesBetween(previous: readonly RepoCheck[], discovered: readonly RepoCheck[]): RepoCheckChange[] {
  const old = sortedChecks(previous).filter(check => !discovered.some(next => checkKey(next) === checkKey(check)));
  const next = sortedChecks(discovered).filter(check => !previous.some(before => checkKey(before) === checkKey(check)));
  const changes: RepoCheckChange[] = [];
  // Prefer an unchanged declaration source, then an unchanged command whose provenance moved.
  for (const match of [(a: RepoCheck, b: RepoCheck) => a.kind === b.kind && a.source === b.source,
    (a: RepoCheck, b: RepoCheck) => a.kind === b.kind && a.command === b.command]) {
    for (let index = 0; index < old.length;) {
      const replacement = next.findIndex(check => match(old[index], check));
      if (replacement < 0) { index++; continue; }
      changes.push({ type: "replaced", before: old.splice(index, 1)[0], after: next.splice(replacement, 1)[0] });
    }
  }
  // A unique remaining kind pair also covers a declaration renamed with its command.
  for (const before of [...old]) {
    const candidates = next.filter(check => check.kind === before.kind);
    if (candidates.length !== 1 || old.filter(check => check.kind === before.kind).length !== 1) continue;
    changes.push({ type: "replaced", before, after: candidates[0] });
    old.splice(old.indexOf(before), 1);
    next.splice(next.indexOf(candidates[0]), 1);
  }
  changes.push(...old.map(before => ({ type: "removed" as const, before })), ...next.map(after => ({ type: "added" as const, after })));
  return changes;
}

/** Compare executable invocations, including npm's shorthand for `npm run test`. */
function invokesCheck(command: string, check: RepoCheck): boolean {
  if (command === check.command) return true;
  const declared = /^(npm|pnpm|yarn|bun) run ([^\s]+)$/.exec(check.command);
  const invoked = /^(npm|pnpm|yarn|bun) (?:(?:run|run-script) )?([^\s;&|]+)/.exec(command);
  return !!declared && !!invoked && declared[1] === invoked[1] && declared[2] === invoked[2];
}
function affectedTasks(state: ShipState, before: readonly RepoCheck[], after: readonly RepoCheck[], changes: readonly RepoCheckChange[]): string[] {
  const affected: string[] = [];
  const changedCommands = changes.flatMap(change => [change.before, change.after].filter((check): check is RepoCheck => !!check));
  for (const milestone of state.milestones) for (const slice of milestone.slices) for (const task of slice.tasks) {
    const scope = { ...task, taskType: task.effectiveTaskType ?? task.taskType };
    const oldPlan = routeVerification(scope, before).requirements;
    const newPlan = routeVerification(scope, after).requirements;
    const relevant = [...oldPlan, ...newPlan].some(requirement => requirement.command && changedCommands.some(check => invokesCheck(requirement.command!, check)));
    if (relevant || JSON.stringify(oldPlan) !== JSON.stringify(newPlan)) affected.push(`${milestone.id}/${slice.id}/${task.id}`);
  }
  return affected;
}

/** Compare persisted policy with declarations without altering state or executing checks. */
export async function previewRepoCheckReconciliation(root: string, state: ShipState): Promise<RepoCheckPreview> {
  const previous = sortedChecks(state.repoChecks ?? []);
  const discovered = sortedChecks(await discoverRepoChecks(root));
  const changes = changesBetween(previous, discovered);
  const affectedTaskKeys = affectedTasks(state, previous, discovered, changes);
  return { previous, discovered, changes, affectedTaskKeys,
    evidenceInvalidation: changes.length
      ? "Changed check commands, effective script bodies, recipes, runners or provenance are not covered by earlier verification evidence; affected passed tasks require fresh verification before relying on the new policy."
      : "Declared verification policy is unchanged; existing evidence remains valid." };
}

/** The executable policy is checked at each launch, not only before worker dispatch. */
export async function assertApprovedRepoCheck(root: string, state: ShipState, command: string): Promise<void> {
  const discovered = await discoverRepoChecks(root);
  if (!sameChecks(state.repoChecks ?? [], discovered))
    throw new Error(`Repository verification policy changed before ${command}; review old/new definitions with /ship reconcile before running checks`);
  // Task-authored commands may spell a discovered check differently (notably `npm test`).
  // Never execute an unapproved repo-script invocation simply because it was absent from the check list.
  for (const match of command.matchAll(/\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)) {
    const [, runner, script] = match;
    if (["run", "exec", "install", "ci", "publish"].includes(script)) continue;
    if (!discovered.some(check => check.source === `package.json scripts.${script}` && check.runner === runner))
      throw new Error(`Repository script ${runner} ${script} has no approved effective definition; inspect /ship reconcile before executing ${command}`);
  }
  for (const match of command.matchAll(/\bmake\s+(?:-[-\w]+\s+)*([a-zA-Z][\w-]*)/g)) {
    if (!discovered.some(check => check.source.endsWith(` target ${match[1]}`) && check.runner === "make"))
      throw new Error(`Makefile target ${match[1]} has no approved effective definition; inspect /ship reconcile before executing ${command}`);
  }
}

/** Caller must explicitly approve a changed policy and apply this result while holding its state lock. */
export async function applyRepoCheckReconciliation(root: string, state: ShipState, preview: RepoCheckPreview, approved: boolean): Promise<Pick<RepoCheckPreview, "discovered" | "affectedTaskKeys" | "evidenceInvalidation"> & { repoChecks: RepoCheck[] }> {
  if (!sameChecks(state.repoChecks ?? [], preview.previous)) throw new Error("Persisted repository checks changed since preview");
  const current = await discoverRepoChecks(root);
  if (!sameChecks(current, preview.discovered)) throw new Error("Declared repository checks changed since preview");
  const changes = changesBetween(state.repoChecks ?? [], current);
  if (JSON.stringify(changes) !== JSON.stringify(preview.changes)) throw new Error("Repository check preview is stale");
  if (changes.length && !approved) throw new Error("Changed repository checks require explicit approval");
  const affectedTaskKeys = affectedTasks(state, state.repoChecks ?? [], current, changes);
  if (JSON.stringify(affectedTaskKeys) !== JSON.stringify(preview.affectedTaskKeys)) throw new Error("Affected tasks changed since preview");
  return { repoChecks: [...current], discovered: [...current], affectedTaskKeys, evidenceInvalidation: preview.evidenceInvalidation };
}

async function fileFingerprint(root: string, filename: string): Promise<string> {
  try {
    const full = path.join(root, filename);
    const stat = await lstat(full);
    if (!stat.isFile()) return stat.isDirectory() ? "directory" : "unknown";
    const hash = createHash("sha256");
    for await (const part of createReadStream(full)) hash.update(part);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

async function ownershipObservation(root: string, previous: readonly string[]) {
  const snapshot = await gitDirtySnapshot(root);
  if (snapshot.unknown || snapshot.truncated || !snapshot.branch) throw new Error("Git branch or dirty paths cannot be inspected safely");
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  const paths = [...new Set([...previous, ...snapshot.paths].map(pathKey))].sort();
  const contents = await Promise.all(paths.map(async filename => [filename, await fileFingerprint(root, filename)]));
  // Index entries catch staged edits even when the working-tree bytes and dirty path set stay the same.
  const index = paths.length ? await git(root, ["ls-files", "--stage", "--", ...paths]) : "";
  const fingerprint = createHash("sha256").update(JSON.stringify({ dirty: snapshot.paths.map(pathKey).sort(), contents, index })).digest("hex");
  return { snapshot, head, fingerprint };
}

/** Only previously guarded paths that are now clean can be offered for user review. */
export async function previewOwnershipReconciliation(root: string, state: ShipState): Promise<OwnershipPreview> {
  const work = state.preexistingWork;
  if (!work || work.unknown || work.truncated || !work.branch) throw new Error("No complete previously-dirty ownership record to reconcile");
  if (state.nativeBatch || state.activeAttempt) throw new Error("Cannot reconcile ownership during active assignments");
  const { snapshot, head, fingerprint } = await ownershipObservation(root, work.paths);
  if (snapshot.branch !== work.branch) throw new Error("Git branch changed since ownership was established");
  const dirty = snapshot.paths.map(pathKey);
  const overlapsDirty = (filename: string) => dirty.some(changed => changed === pathKey(filename) || changed.startsWith(`${pathKey(filename)}/`) || pathKey(filename).startsWith(`${changed}/`));
  return { branch: snapshot.branch, head, fingerprint, previouslyDirty: [...work.paths],
    eligiblePaths: work.paths.filter(filename => !overlapsDirty(filename)),
    stillDirtyPaths: work.paths.filter(overlapsDirty) };
}

/** Returns a replacement guard; the caller persists it under lock only after explicit selection. */
export async function applyOwnershipReconciliation(root: string, state: ShipState, preview: OwnershipPreview, approvedPaths: readonly string[]): Promise<NonNullable<ShipState["preexistingWork"]>> {
  if (!approvedPaths.length || new Set(approvedPaths.map(pathKey)).size !== approvedPaths.length ||
      approvedPaths.some(filename => !preview.eligiblePaths.includes(filename))) throw new Error("Select previously dirty clean paths from the preview for approval");
  if (state.nativeBatch || state.activeAttempt) throw new Error("Cannot reconcile ownership during active assignments");
  const work = state.preexistingWork;
  if (!work || work.unknown || work.truncated || work.branch !== preview.branch ||
      JSON.stringify(work.paths) !== JSON.stringify(preview.previouslyDirty)) throw new Error("Ownership record changed since preview");
  const { snapshot, head, fingerprint } = await ownershipObservation(root, work.paths);
  if (snapshot.branch !== preview.branch || head !== preview.head || fingerprint !== preview.fingerprint) throw new Error("Git state changed since ownership preview");
  const dirty = snapshot.paths.map(pathKey);
  if (approvedPaths.some(filename => dirty.some(changed => changed === pathKey(filename) || changed.startsWith(`${pathKey(filename)}/`) || pathKey(filename).startsWith(`${changed}/`)))) throw new Error("Approved ownership path is dirty again");
  const approved = new Set(approvedPaths.map(pathKey));
  return { ...work, paths: work.paths.filter(filename => !approved.has(pathKey(filename))) };
}
