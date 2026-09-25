#!/usr/bin/env -S node --no-warnings --experimental-strip-types
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Controller } from "./controller.ts";
import { OmpRpcWorker } from "./rpc-worker.ts";
import { appendEvent, atomicJson, configPath, exists, loadConfig, loadState, saveState, shipDir, statePath, writeRoadmapView } from "./store.ts";
import { ensureGitRepo, ensureShipExcluded } from "./git.ts";
import type { ShipConfig, ShipState } from "./types.ts";

const args = process.argv.slice(2);
const command = args[0];
const root = process.cwd();

function usage() {
  console.log(`Ship Autopilot MVP\n\nCommands:\n  ship init --brief <file>\n  ship run [--once] [--max-runtime 8h]\n  ship status [--json]\n  ship pause\n  ship capture "<note>"\n  ship doctor`);
}

function flag(name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; }
function parseDuration(value = "8h"): number { const m = /^(\d+)(ms|s|m|h)$/.exec(value); if(!m) throw new Error(`Invalid duration: ${value}`); const n=Number(m[1]); return n*({ms:1,s:1000,m:60000,h:3600000} as any)[m[2]]; }

async function init() {
  const briefFile = flag("--brief"); if (!briefFile) throw new Error("init requires --brief <file>");
  if (await exists(statePath(root))) throw new Error(".ship already exists; refusing to overwrite state");
  const brief = await readFile(path.resolve(root, briefFile), "utf8");
  await ensureGitRepo(root); await ensureShipExcluded(root); await mkdir(shipDir(root), { recursive: true });
  await writeFile(path.join(shipDir(root), "PROJECT.md"), brief, "utf8");
  await writeFile(path.join(shipDir(root), "KNOWLEDGE.md"), "# Knowledge\n\n## Constraints\n\n## Decisions\n\n## Assumptions\n\n## Lessons\n", "utf8");
  const config: ShipConfig = { schemaVersion:1, worker:{ command:"omp", args:["--mode","rpc","--no-session","--no-ui"], startupTimeoutMs:15000, inactivityTimeoutMs:10*60_000, hardTimeoutMs:60*60_000 }, limits:{ maxTaskAttempts:3, maxDispatches:100 } };
  const now = new Date().toISOString();
  const state: ShipState = { schemaVersion:1, projectName:path.basename(root), phase:"idle", roadmapRevision:0, milestones:[], paused:false, lastProgressAt:now, createdAt:now, updatedAt:now };
  await atomicJson(configPath(root), config); await saveState(root, state); await writeRoadmapView(root, state); await appendEvent(root, {type:"initialized"});
  console.log("Initialized .ship/. Run `ship doctor`, then `ship run`. ");
}

async function run() {
  const config = await loadConfig(root); const worker = new OmpRpcWorker(config); const controller = new Controller(root, worker);
  const once = args.includes("--once"); const deadline = Date.now() + parseDuration(flag("--max-runtime") ?? "8h");
  let dispatches = 0;
  while (Date.now() < deadline && dispatches < config.limits.maxDispatches) {
    const r = await controller.step(); dispatches++; console.log(`[ship] ${r} (${dispatches} dispatches)`);
    if (once || r === "complete" || r === "blocked") break;
  }
}

async function status() {
  const state = await loadState(root);
  if (args.includes("--json")) return console.log(JSON.stringify(state, null, 2));
  console.log(`${state.projectName}: ${state.phase}${state.paused ? " (paused)" : ""}`);
  console.log(`roadmap revision ${state.roadmapRevision}; last progress ${state.lastProgressAt}`);
  if (state.current) console.log(`current: ${state.current.milestoneId}/${state.current.sliceId}/${state.current.taskId ?? "-"}`);
  if (state.blockedReason) console.log(`blocked: ${state.blockedReason}`);
  for (const m of state.milestones) console.log(`- ${m.id} ${m.title}: ${m.status}`);
}

async function pause() { const s=await loadState(root); s.paused=true; await saveState(root,s); await appendEvent(root,{type:"pause_requested"}); console.log("Pause requested."); }
async function capture() { const note=args.slice(1).join(" ").trim(); if(!note) throw new Error("capture requires a note"); const dir=path.join(shipDir(root),"inbox"); await mkdir(dir,{recursive:true}); const file=path.join(dir,`${Date.now()}-${process.pid}.json`); await atomicJson(file,{type:"capture",note,at:new Date().toISOString()}); console.log("Capture queued."); }
async function doctor() {
  const checks: [string, boolean, string][] = [];
  checks.push([".ship state", await exists(statePath(root)), statePath(root)]);
  const git = spawnSync("git", ["rev-parse","--is-inside-work-tree"], {cwd:root,encoding:"utf8"}); checks.push(["git repository", git.status===0, git.stderr.trim()]);
  const omp = spawnSync("omp", ["--version"], {cwd:root,encoding:"utf8"}); checks.push(["OMP executable", omp.status===0, omp.status===0 ? omp.stdout.trim() : "not found"]);
  for (const [name,ok,detail] of checks) console.log(`${ok?"✓":"✗"} ${name}${detail?`: ${detail}`:""}`);
  if (checks.some(x=>!x[1])) process.exitCode=1;
}

try {
  if (!command || command === "--help" || command === "-h") usage();
  else if (command === "init") await init();
  else if (command === "run") await run();
  else if (command === "status") await status();
  else if (command === "pause") await pause();
  else if (command === "capture") await capture();
  else if (command === "doctor") await doctor();
  else throw new Error(`Unknown command: ${command}`);
} catch (e:any) { console.error(`ship: ${e.message}`); process.exitCode=1; }
