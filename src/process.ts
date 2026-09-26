import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { unlink, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, exists, readJson, shipDir } from "./store.ts";

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid === 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function treeRunning(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (process.platform === "win32") return alive(pid);
  if (!alive(-pid)) return false;
  // Orphaned zombies can retain a group ID but cannot write or spawn work.
  const { promise, resolve } = Promise.withResolvers<boolean>();
  execFile("ps", ["-eo", "pgid=,stat="], { timeout: 3000 }, (error, stdout) => {
    if (error) return resolve(true);
    resolve(stdout.split("\n").some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state?.startsWith("Z");
    }));
  });
  return promise;
}
async function killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform !== "win32") {
    try { process.kill(-pid, signal); } catch {}
    return;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolve());
  await promise;
}
export async function assertNoProcess(root: string): Promise<void> {
  const file = path.join(shipDir(root), "process.json");
  if (!await exists(file)) return;
  const record = await readJson<{ pid: number; host: string }>(file);
  if (record.host !== hostname() || await treeRunning(record.pid)) throw new Error(`Worker group ${record.pid} may still be alive. Refusing overlapping work; inspect it before recovery.`);
  await unlink(file);
}
export async function startProcess(command: string, args: string[], cwd: string, root?: string) {
  if (root) await assertNoProcess(root);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./process-host.mjs", import.meta.url))], {
    cwd, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: process.env,
  }) as ChildProcessWithoutNullStreams;
  child.stdin.on("error", () => {});
  let exited = false;
  const completion = Promise.withResolvers<number | null>();
  const closed = completion.promise;
  child.once("error", () => { exited = true; completion.resolve(null); });
  child.once("close", code => { exited = true; completion.resolve(code); });
  if (!child.pid) { await closed; throw new Error(`Cannot spawn process supervisor for ${command}`); }
  const pid = child.pid;
  const token = randomUUID();
  const marker = root && path.join(shipDir(root), "process.json");
  try {
    if (marker) await atomicJson(marker, { pid, token, host: hostname(), command, at: new Date().toISOString() });
  } catch (error) { await killTree(pid, "SIGKILL"); await closed; throw error; }
  let sent = false;
  return {
    child, closed,
    // Install output/error handlers before opening the execution gate.
    start() { if (!sent) { sent = true; child.send({ type: "start", command, args }, () => {}); } },
    async stop(): Promise<void> {
      child.stdin.end();
      if (!exited) await Promise.race([closed, delay(300)]);
      if (!exited) { await killTree(pid, "SIGTERM"); await Promise.race([closed, delay(300)]); }
      // Also reap ordinary descendants if their parent exited early.
      if (await treeRunning(pid)) await killTree(pid, "SIGKILL");
      if (!exited) await Promise.race([closed, delay(1500)]);
      for (let i = 0; i < 20 && await treeRunning(pid); i++) await delay(25);
      if (!exited || await treeRunning(pid)) throw new Error(`Cannot establish termination of worker group ${pid}; process record retained`);
      if (marker && await exists(marker)) {
        const record = await readJson<{ token: string }>(marker);
        if (record.token === token) await unlink(marker);
      }
    },
  };
}
export async function runCheck(cwd: string, command: string, root: string, timeoutMs: number, signal?: AbortSignal, logFile?: string) {
  const proc = await startProcess("sh", ["-c", command], cwd, root);
  let output = ""; let timedOut = false;
  // Persist a bounded artifact while continuing to drain both pipes.
  let log: Awaited<ReturnType<typeof open>> | undefined;
  try { log = logFile ? await open(logFile, "w", 0o600) : undefined; } catch (error) { await proc.stop(); throw error; }
  let bytes = 0; let writing = Promise.resolve(); let logError: unknown;
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16_000);
    if (log && bytes < 4_000_000) { bytes += chunk.length; writing = writing.then(async () => { await log!.write(chunk); }).catch(error => { logError = error; }); }
  };
  proc.child.stdout.on("data", collect); proc.child.stderr.on("data", collect);
  const interruption = Promise.withResolvers<null>();
  const cancel = () => interruption.resolve(null);
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel(); else proc.start();
  let code: number | null = null;
  try { code = await Promise.race([proc.closed, interruption.promise]); }
  finally {
    clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    try { await proc.stop(); } finally { await writing; await log?.close(); }
  }
  if (logError) throw logError;
  return { ok: code === 0 && !timedOut && !signal?.aborted, code, output, timedOut, aborted: !!signal?.aborted };
}
