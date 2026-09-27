import { execFile } from "node:child_process";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args[0]}: ${stderr || error.message}`)); else resolve(stdout.trim());
  }));
}
export async function ensureGitRepo(cwd: string): Promise<void> { try { await git(cwd, ["rev-parse", "--git-dir"]); } catch { await git(cwd, ["init", "-b", "main"]); } }
export async function ensureShipExcluded(cwd: string): Promise<void> {
  const exclude = path.resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "info/exclude"]));
  await mkdir(path.dirname(exclude), { recursive: true });
  let text = ""; try { text = await readFile(exclude, "utf8"); } catch {}
  if (!text.split(/\r?\n/).includes(".ship/")) await appendFile(exclude, `\n.ship/\n`);
}
