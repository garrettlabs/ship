#!/usr/bin/env -S node --experimental-strip-types
import { mkdir, readFile, writeFile, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Controller } from "./controller.ts";
import { OmpRpcWorker } from "./rpc-worker.ts";
import { atomicJson, configPath, exists, loadConfig, loadState, queueMessage, queueWorkDecision, saveState, shipDir, statePath, writeRoadmapView } from "./store.ts";
import { ensureGitRepo, ensureShipExcluded, git } from "./git.ts";
import { recoverLock } from "./lock.ts";
import { describeRequest } from "./work.ts";
import { safe, tui } from "./tui.ts";
import type { ShipConfig, ShipState } from "./types.ts";

export function parseDuration(value: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!m) throw new Error(`Invalid duration: ${value}`);
  const duration = Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[m[2]];
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 2_147_483_647) throw new Error("Duration must be positive and less than 25 days");
  return duration;
}
export async function initialize(root: string, briefFile: string): Promise<void> {
  if (await exists(shipDir(root))) throw new Error(".ship already exists; refusing to overwrite it");
  const brief = await readFile(path.resolve(root, briefFile), "utf8");
  if (!brief.trim()) throw new Error("Brief is empty");
  await ensureGitRepo(root); await ensureShipExcluded(root);
  await mkdir(shipDir(root));
  await writeFile(path.join(shipDir(root), "PROJECT.md"), brief);
  const config: ShipConfig = {
    schemaVersion: 1,
    worker: { command: "omp", args: ["--mode", "rpc", "--no-session", "--no-ui"], startupTimeoutMs: 15000, inactivityTimeoutMs: 600000, hardTimeoutMs: 3600000 },
    limits: { maxTaskAttempts: 3, maxDispatches: 100 }, verificationTimeoutMs: 300000, protectedChecks: [], review: true,
  };
  const now = new Date().toISOString();
  const state: ShipState = { schemaVersion: 1, projectName: path.basename(root), phase: "idle", roadmapRevision: 0, milestones: [], paused: false, lastProgressAt: now, createdAt: now, updatedAt: now };
  await atomicJson(configPath(root), config); await saveState(root, state); await writeRoadmapView(root, state);
}
export async function startDetached(root: string, args: string[] = []): Promise<string> {
  await loadState(root);
  if (await exists(path.join(shipDir(root), "lock"))) throw new Error("A controller lock exists; attach or recover before starting another controller");
  const logDir = path.join(shipDir(root), "logs"); await mkdir(logDir, { recursive: true });
  const log = await open(path.join(logDir, "controller.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", fileURLToPath(import.meta.url), "run", ...args], { cwd: root, detached: true, stdio: ["ignore", log.fd, log.fd] });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref(); return `Controller launched (PID ${child.pid}); startup errors appear in .ship/logs/controller.log`;
  } finally { await log.close(); }
}
function usage() {
  console.log(`Ship 0.3 — file-backed autonomous controller\n\nship                         open the TUI\nship init --brief <file>      initialize without model calls\nship run [--once] [--detach] [--max-runtime 8h]\nship tui                     attach; q detaches without stopping the run\nship status [--json]\nship pause | resume          queue control at a safe boundary\nship capture "<note>"\nship add "<request>"          queue new requested work, not a capture\nship change "<request>"       propose changes to existing work or requirements\nship proposals [W0001] [--json]\nship approve W0001 | reject W0001\nship recover                 unlock a confirmed-dead controller\nship doctor                  no paid model calls`);
}
export async function main(args: string[], root: string): Promise<void> {
  root = await realpath(root);
  const command = args[0];
  const value = (flag: string) => { const index = args.indexOf(flag); if (index < 0) return undefined; const result = args[index + 1]; if (!result || result.startsWith("--")) throw new Error(`Missing value for ${flag}`); return result; };
  if (command === "--help" || command === "-h") return usage();
  if (!command || command === "tui") return tui(root, () => startDetached(root));
  if (command === "init") { const brief = value("--brief"); if (!brief) throw new Error("init requires --brief <file>"); await initialize(root, brief); console.log("Initialized .ship/. Commit the project baseline, then run ship doctor."); }
  else if (command === "status") {
    const s = await loadState(root);
    console.log(args.includes("--json") ? JSON.stringify(s, null, 2) : `${s.projectName}: ${s.phase}${s.paused ? " (paused)" : ""}\nRoadmap r${s.roadmapRevision}; ${s.dispatches ?? 0} dispatches\nWorktree: ${s.workspace?.path ?? "not started"}\n${s.blockedReason ?? ""}\nWork requests: ${(s.workRequests ?? []).filter(r => r.status !== "applied" && r.status !== "rejected").length} unresolved; ship proposals for details`);
  } else if (command === "proposals") {
    const positional = args.slice(1).filter(x => x !== "--json");
    if (positional.length > 1 || positional.some(x => !/^W[0-9]{2,}$/.test(x))) throw new Error("Usage: ship proposals [W0001] [--json]");
    const all = (await loadState(root)).workRequests!, requestId = positional[0];
    const selected = requestId ? all.filter(r => r.id === requestId) : all;
    if (requestId && !selected.length) throw new Error(`Unknown work request: ${requestId}`);
    if (args.includes("--json")) console.log(JSON.stringify(selected, null, 2));
    else {
      console.log(selected.length ? selected.map(r => describeRequest(r).map(safe).join("\n")).join("\n\n") : "No consumed work requests yet. Start ship run to process queued requests.");
      console.log("\nInspect all changes and commands before ship approve W0001. Use ship reject W0001 to discard. Decisions apply at a safe boundary.");
    }
  } else if (command === "approve" || command === "reject") {
    if (args.length !== 2 || !/^W[0-9]{2,}$/.test(args[1])) throw new Error(`Usage: ship ${command} W0001`);
    await queueWorkDecision(root, command, args[1]);
    console.log(`${command} queued for ${args[1]}. Start ship run if the controller has exited.`);
  } else if (command === "pause" || command === "resume" || command === "capture" || command === "add" || command === "change") {
    await queueMessage(root, command, command === "capture" || command === "add" || command === "change" ? args.slice(1).join(" ") : undefined);
    console.log(command === "change" ? "Change request queued. The controller will propose a before/after patch at a safe boundary. Inspect ship proposals and approve or reject it; no work changed yet." : command === "add" ? "Work request queued. The running controller will propose a task, slice, or milestone at a safe boundary. Start ship run if needed; inspect ship proposals before approving." : `${command} queued.`);
  } else if (command === "recover") { await recoverLock(root); console.log("Dead-controller lock cleared. Run ship run to reconcile persisted work."); }
  else if (command === "run") {
    for (let i = 1; i < args.length; i++) {
      if (["--once", "--detach"].includes(args[i])) continue;
      if (args[i] === "--max-runtime") { i++; continue; }
      throw new Error(`Unknown run option: ${args[i]}`);
    }
    const duration = parseDuration(value("--max-runtime") ?? "8h");
    if (args.includes("--detach")) { console.log(await startDetached(root, args.slice(1).filter(x => x !== "--detach"))); return; }
    const config = await loadConfig(root), abort = new AbortController();
    const stop = () => abort.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const deadline = setTimeout(stop, duration);
    try {
      const c = new Controller(root, new OmpRpcWorker(config), { signal: abort.signal });
      let last = "";
      const result = await c.run(args.includes("--once"), step => { if ((step !== "paused" && step !== "waiting") || step !== last) console.log(`[ship] ${step}`); last = step; });
      if (result === "blocked") process.exitCode = 2;
    } finally { clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } else if (command === "doctor") {
    const checks: [string, boolean, string][] = [];
    try { await loadState(root); checks.push(["State schema", true, ""]); } catch (e) { checks.push(["State schema", false, String(e)]); }
    try { await git(root, ["rev-parse", "HEAD"]); await git(root, ["var", "GIT_AUTHOR_IDENT"]); checks.push(["Git baseline and author", true, ""]); } catch (e) { checks.push(["Git baseline and author", false, String(e)]); }
    try { const c = await loadConfig(root); const version = spawnSync(c.worker.command, ["--version"], { encoding: "utf8", timeout: 5000 }); checks.push(["Worker executable", version.status === 0, version.stdout?.trim() || version.error?.message || version.stderr?.trim()]); } catch (e) { checks.push(["Worker configuration", false, String(e)]); }
    checks.push(["POSIX process groups", process.platform !== "win32", "Linux/macOS; use WSL2 on Windows"]);
    for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    console.log("No live model call was made. Executable availability is not an OMP compatibility or authentication test.");
    if (checks.some(x => !x[1])) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => "")) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.cwd()).catch(error => { console.error(`ship: ${error.message}`); process.exitCode = 1; });
}
