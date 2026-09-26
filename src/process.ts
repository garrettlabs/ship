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
const jobHelper = fileURLToPath(new URL("./process-job.ps1", import.meta.url));
async function treeRunning(pid: number, token?: string): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (process.platform === "win32") {
    if (!token || alive(pid)) return true;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", jobHelper, "probe", token],
      { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve(!!error || stdout.trim() !== "ABSENT"));
    return promise;
  }
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
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch {}
}
export async function assertNoProcess(root: string): Promise<void> {
  const file = path.join(shipDir(root), "process.json");
  if (!await exists(file)) return;
  const record = await readJson<{ pid: number; host: string; token?: string }>(file);
  if (record.host !== hostname() || await treeRunning(record.pid, record.token)) throw new Error(`Verification group ${record.pid} may still be alive. Refusing overlapping checks; inspect it before recovery.`);
  await unlink(file);
}
async function startCheckProcess(command: string, cwd: string, root: string) {
  await assertNoProcess(root);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./process-host.mjs", import.meta.url))], {
    cwd, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: process.env,
  }) as ChildProcessWithoutNullStreams;
  child.stdin.on("error", () => {});
  let exited = false;
  const completion = Promise.withResolvers<number | null>();
  const closed = completion.promise;
  child.once("error", () => { exited = true; completion.resolve(null); });
  child.once("close", code => { exited = true; completion.resolve(code); });
  if (!child.pid) { await closed; throw new Error(`Cannot spawn verification supervisor for ${command}`); }
  const pid = child.pid;
  const token = randomUUID();
  const marker = path.join(shipDir(root), "process.json");
  try {
    await atomicJson(marker, { pid, token, host: hostname(), command, at: new Date().toISOString() });
  } catch (error) { if (process.platform === "win32") child.kill("SIGKILL"); else killGroup(pid, "SIGKILL"); await closed; throw error; }
  let sent = false;
  return {
    child, closed,
    // Install output/error handlers before opening the execution gate.
    start() { if (!sent) { sent = true; child.send({ type: "start", command: "sh", args: ["-c", command], token }, () => {}); } },
    async stop(): Promise<void> {
      child.stdin.end();
      if (!exited) await Promise.race([closed, delay(300)]);
      if (!exited) {
        if (process.platform === "win32") child.kill("SIGKILL");
        else killGroup(pid, "SIGTERM");
        await Promise.race([closed, delay(300)]);
      }
      if (process.platform !== "win32" && await treeRunning(pid)) killGroup(pid, "SIGKILL");
      if (!exited) await Promise.race([closed, delay(1500)]);
      for (let i = 0; i < 40 && await treeRunning(pid, token); i++) await delay(50);
      if (!exited || await treeRunning(pid, token)) throw new Error(`Cannot establish termination of verification group ${pid}; process record retained`);
      if (await exists(marker)) {
        const record = await readJson<{ token: string }>(marker);
        if (record.token === token) await unlink(marker);
      }
    },
  };
}
export async function runCheck(cwd: string, command: string, root: string, timeoutMs: number, signal?: AbortSignal, logFile?: string) {
  const proc = await startCheckProcess(command, cwd, root);
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
