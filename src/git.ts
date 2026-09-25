import { execFile } from "node:child_process";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ShipState } from "./types.ts";
import { exists, saveState, shipDir } from "./store.ts";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args[0]}: ${stderr || error.message}`)); else resolve(stdout.trim());
  }));
}
export async function head(cwd: string): Promise<string> { return git(cwd, ["rev-parse", "HEAD"]); }
export async function ensureGitRepo(cwd: string): Promise<void> { try { await git(cwd, ["rev-parse", "--git-dir"]); } catch { await git(cwd, ["init", "-b", "main"]); } }
export async function ensureShipExcluded(cwd: string): Promise<void> {
  const exclude = path.resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "info/exclude"]));
  await mkdir(path.dirname(exclude), { recursive: true });
  let text = ""; try { text = await readFile(exclude, "utf8"); } catch {}
  if (!text.split(/\r?\n/).includes(".ship/")) await appendFile(exclude, `\n.ship/\n`);
}
export async function clean(cwd: string): Promise<boolean> { return (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])) === ""; }
export async function ensureWorkspace(root: string, state: ShipState): Promise<string> {
  if (state.workspace) {
    const cwd = state.workspace.path;
    if (!await exists(cwd) || await git(cwd, ["branch", "--show-current"]) !== state.workspace.branch) throw new Error("Recorded worktree is missing or changed; inspect .ship/state.json");
    return cwd;
  }
  if (state.milestones.some(m => m.slices.some(s => s.tasks.some(t => t.attempts > 0)))) throw new Error("Legacy in-place run detected. Finish/archive it before starting an isolated run; no automatic migration of partial work.");
  const baseHead = await head(root).catch(() => { throw new Error("Make an initial source commit before ship run"); });
  await git(root, ["var", "GIT_AUTHOR_IDENT"]);
  await git(root, ["var", "GIT_COMMITTER_IDENT"]);
  const cwd = path.join(shipDir(root), "worktree");
  const branch = `ship/run-${randomUUID().slice(0, 8)}`;
  // Persist intent before git worktree add. Recovery never guesses at an orphan.
  state.workspace = { path: cwd, branch, baseHead }; await saveState(root, state);
  await git(root, ["worktree", "add", "-b", branch, cwd, baseHead]);
  return cwd;
}
export async function candidateTree(cwd: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  return git(cwd, ["write-tree"]);
}
export async function commitCandidate(cwd: string, tree: string, base: string, marker: string): Promise<string> {
  if (await head(cwd) !== base || await candidateTree(cwd) !== tree) throw new Error("Candidate changed after verification");
  // commit-tree has no hooks which can mutate verified files. update-ref is CAS.
  const commit = await git(cwd, ["commit-tree", tree, "-p", base, "-m", `ship: ${marker}`]);
  await git(cwd, ["update-ref", "HEAD", commit, base]);
  return commit;
}
export async function matchesCommit(cwd: string, commit: string, tree: string, base: string, marker: string): Promise<boolean> {
  return await git(cwd, ["show", "-s", "--format=%T%n%P%n%B", commit]) === `${tree}\n${base}\nship: ${marker}`;
}
