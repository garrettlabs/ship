#!/usr/bin/env -S node --experimental-strip-types
import { mkdir, readFile, writeFile, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Supervisor } from "./supervisor.ts";
import { OmpRpcWorker } from "./rpc-worker.ts";
import { atomicJson, configPath, exists, loadConfig, loadState, queueMessage, queueRoadmapEdit, saveState, shipDir, statePath, writeRoadmapView } from "./store.ts";
import { ensureGitRepo, ensureShipExcluded, git } from "./git.ts";
import { recoverLock } from "./lock.ts";
import { tui } from "./tui.ts";
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
  console.log(`Ship 0.2 — file-backed autonomous controller\n\nship                         open the TUI\nship init --brief <file>      initialize without model calls\nship run [--once] [--detach] [--max-runtime 8h]\nship tui                     attach; q detaches without stopping the run\nship status [--json]\nship pause | resume          queue control at a safe boundary\nship capture "<note>"\nship add --slice M001/S01 --title TITLE --goal GOAL --acceptance TEXT --check COMMAND --revision N [planning hints]\nship change --task M001/S01/T01 --goal GOAL --revision N [planning hints]\nPlanning hints: --type TYPE --uncertainty LOW|MEDIUM|HIGH|UNKNOWN --depends TASK[,TASK] --files PATH[,PATH] --domains NAME[,NAME] --verify TEXT (use - to clear dependency/ownership lists)\nship recover                 unlock a confirmed-dead controller\nship doctor                  no paid model calls`);
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
    if (args.includes("--json") && args.includes("--compact")) {
      console.log(JSON.stringify({
        projectName: s.projectName, phase: s.phase, paused: s.paused, roadmapRevision: s.roadmapRevision,
        dispatches: s.dispatches, current: s.current, blockedReason: s.blockedReason,
        milestones: s.milestones.map(m => ({ id: m.id, slices: m.slices.map(slice => ({
          id: slice.id, tasks: slice.tasks.map(task => ({ id: task.id, status: task.status, attempts: task.attempts })),
        })) })),
      }));
    } else console.log(args.includes("--json") ? JSON.stringify(s, null, 2) : `${s.projectName}: ${s.phase}${s.paused ? " (paused)" : ""}\nRoadmap r${s.roadmapRevision}; ${s.dispatches ?? 0} dispatches\nWorktree: ${s.workspace?.path ?? "not started"}\n${s.blockedReason ?? ""}`);
  } else if (command === "pause" || command === "resume" || command === "capture") {
    await queueMessage(root, command, command === "capture" ? args.slice(1).join(" ") : undefined); console.log(`${command} queued.`);
  } else if (command === "add" || command === "change") {
    const common = ["--type", "--uncertainty", "--depends", "--files", "--domains", "--verify"];
    const required = command === "add" ? ["--slice", "--title", "--goal", "--acceptance", "--check", "--revision"] : ["--task", "--goal", "--revision"];
    const flags = [...required, ...common];
    const options = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i], content = args[i + 1];
      if (!flags.includes(flag) || options.has(flag) || content === undefined || !content.trim()) throw new Error(`Invalid ${command} option: ${flag ?? "(missing)"}`);
      options.set(flag, content);
    }
    for (const flag of required) if (!options.has(flag)) throw new Error(`${command} requires ${flag}`);
    const revisionText = options.get("--revision")!;
    if (!/^(0|[1-9]\d*)$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) throw new Error("Invalid roadmap revision");
    const revision = Number(revisionText);
    const list = (flag: string) => options.has(flag) ? options.get(flag) === "-" ? [] : options.get(flag)!.split(",").map(x => x.trim()) : undefined;
    const hints = {
      ...(options.has("--type") ? { taskType: options.get("--type")! } : {}),
      ...(options.has("--uncertainty") ? { uncertainty: options.get("--uncertainty")! } : {}),
      ...(options.has("--depends") ? { dependencies: list("--depends")! } : {}),
      ...(options.has("--files") ? { affectedFiles: list("--files")! } : {}),
      ...(options.has("--domains") ? { affectedDomains: list("--domains")! } : {}),
      ...(options.has("--verify") ? { verificationRequirements: [options.get("--verify")!] } : {}),
    };
    if (command === "add") await queueRoadmapEdit(root, { type: "add", slice: options.get("--slice")!, title: options.get("--title")!, goal: options.get("--goal")!, acceptance: options.get("--acceptance")!, check: options.get("--check")!, revision, ...hints } as Parameters<typeof queueRoadmapEdit>[1]);
    else await queueRoadmapEdit(root, { type: "change", task: options.get("--task")!, goal: options.get("--goal")!, revision, ...hints } as Parameters<typeof queueRoadmapEdit>[1]);
    console.log(`${command} queued for roadmap revision ${revision}; run the controller to apply it.`);
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
    const supervisor = new Supervisor(root, new OmpRpcWorker(config), { signal: abort.signal, maxRuntimeMs: duration });
    try {
      let last = "";
      const result = await supervisor.run(args.includes("--once"), step => { if (step !== "paused" || step !== last) console.log(`[ship] ${step}`); last = step; });
      if (result === "blocked") process.exitCode = 2;
    } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  } else if (command === "doctor") {
    const checks: [string, boolean, string][] = [];
    try { await loadState(root); checks.push(["State schema", true, ""]); } catch (e) { checks.push(["State schema", false, String(e)]); }
    try { await git(root, ["rev-parse", "HEAD"]); await git(root, ["var", "GIT_AUTHOR_IDENT"]); checks.push(["Git baseline and author", true, ""]); } catch (e) { checks.push(["Git baseline and author", false, String(e)]); }
    try { const c = await loadConfig(root); const version = spawnSync(c.worker.command, ["--version"], { encoding: "utf8", timeout: 5000 }); checks.push(["Worker executable", version.status === 0, version.stdout?.trim() || version.error?.message || version.stderr?.trim()]); } catch (e) { checks.push(["Worker configuration", false, String(e)]); }
    const shell = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    checks.push(["Verification shell", shell.status === 0, shell.status === 0 ? "" : shell.error?.message || shell.stderr?.trim() || "Install a POSIX sh; Git for Windows includes one"]);
    for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    console.log("No live model call was made. Executable availability is not an OMP compatibility or authentication test.");
    if (checks.some(x => !x[1])) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => "")) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.cwd()).catch(error => { console.error(`ship: ${error.message}`); process.exitCode = 1; });
}
