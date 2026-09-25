import { execFile } from "node:child_process";

function exec(cmd: string, args: string[], cwd: string): Promise<{stdout:string; stderr:string}> {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr })); else resolve({ stdout, stderr });
  }));
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try { await exec("git", ["rev-parse", "--is-inside-work-tree"], cwd); return true; } catch { return false; }
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  if (!await isGitRepo(cwd)) await exec("git", ["init", "-b", "main"], cwd);
}

export async function head(cwd: string): Promise<string | null> {
  try { return (await exec("git", ["rev-parse", "HEAD"], cwd)).stdout.trim(); } catch { return null; }
}

export async function statusPorcelain(cwd: string): Promise<string> {
  return (await exec("git", ["status", "--porcelain"], cwd)).stdout.trim();
}

export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await exec("git", ["add", "-A"], cwd);
  const staged = (await exec("git", ["diff", "--cached", "--name-only"], cwd)).stdout.trim();
  if (!staged) return await head(cwd);
  try {
    await exec("git", ["commit", "-m", message], cwd);
  } catch (e: any) {
    const msg = `${e?.stderr ?? ""}${e?.stdout ?? ""}`;
    if (/identity unknown|tell me who you are/i.test(msg)) {
      await exec("git", ["-c", "user.name=Ship Autopilot", "-c", "user.email=ship@local", "commit", "-m", message], cwd);
    } else throw e;
  }
  return await head(cwd);
}

export async function runCommand(cwd: string, command: string): Promise<{ok:boolean; output:string}> {
  return new Promise(resolve => {
    execFile(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}` });
    });
  });
}

export async function ensureShipExcluded(cwd: string): Promise<void> {
  const { mkdir, readFile, appendFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const infoDir = join(cwd, ".git", "info");
  const exclude = join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });
  let current = "";
  try { current = await readFile(exclude, "utf8"); } catch {}
  if (!current.split(/\r?\n/).includes(".ship/")) {
    await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.ship/\n`, "utf8");
  }
}
