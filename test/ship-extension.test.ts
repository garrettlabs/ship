import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import ship, { createShipExtension } from "../extensions/ship.ts";
import { fixture, plan } from "./helpers.ts";
import { parsePlan } from "../src/model.ts";
import { atomicJson, configPath, loadConfig, loadState, saveState } from "../src/store.ts";
import { Controller } from "../src/controller.ts";

function harness(extension = ship) {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  type ToolRunner = (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
  let report: ToolRunner | undefined, submit: ToolRunner | undefined;
  let spawnHook: ((event: { spawnKey?: string; agent: string; invocationKind: "task" }, ctx: ExtensionContext) => Promise<{ model?: string; block?: boolean; reason?: string } | undefined>) | undefined;
  const messages: string[] = [];
  const schema = { object: () => ({}), string: () => ({}), enum: () => ({}) };
  extension({
    zod: schema,
    on(event: string, callback: typeof spawnHook) { assert.equal(event, "before_subagent_spawn"); spawnHook = callback; },
    registerCommand(name: string, options: { handler: typeof handler }) { assert.equal(name, "ship"); handler = options.handler; },
    registerTool(tool: { name: string; execute: ToolRunner }) {
      if (tool.name === "ship_outcome") report = tool.execute;
      else if (tool.name === "ship_plan") submit = tool.execute;
      else assert.fail(`Unexpected extension tool: ${tool.name}`);
    },
    sendUserMessage(message: string) { messages.push(message); },
  } as unknown as ExtensionAPI);
  assert.ok(handler); assert.ok(report); assert.ok(submit); assert.ok(spawnHook);
  return { handle: handler, report: report, submit: submit, spawnHook: spawnHook, messages };
}
function command(extension = ship) { return harness(extension).handle; }

function context(cwd: string) {
  const notices: { message: string; type?: string }[] = [];
  const prompts: string[] = [];
  let selected: string | undefined;
  let confirmed = true;
  let hasUI = true;
  const ctx = {
    cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "test-session" }, models: { resolve: () => ({}) },
    get hasUI() { return hasUI; },
    ui: {
      notify(message: string, type?: string) { notices.push({ message, type }); },
      async select(_title: string, options: string[]) { assert.ok(options.includes(selected ?? options[0])); return selected ?? options[0]; },
      async input(title: string) { return prompts.shift(); },
      async confirm() { return confirmed; },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notices, prompts, select(id: string) { selected = id; }, confirm(value: boolean) { confirmed = value; }, ui(value: boolean) { hasUI = value; } };
}

async function inbox(root: string): Promise<{ type: string; [key: string]: unknown }[]> {
  const dir = path.join(root, ".ship", "inbox");
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(files.filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(dir, file), "utf8"))));
}

test("/ship help and status report actual project state from a nested directory", async t => {
  const root = await fixture(t);
  const nested = path.join(root, "nested"); await mkdir(nested);
  const state = await loadState(root);
  state.phase = "blocked"; state.blockedReason = "verification failed"; state.paused = true; state.roadmapRevision = 4;
  await saveState(root, state);
  const ui = context(nested), handle = command();
  await handle("", ui.ctx);
  assert.match(ui.notices[0].message, /\/ship add/);
  await handle("status", ui.ctx);
  assert.match(ui.notices[1].message, /blocked \(paused\); roadmap r4/);
  assert.match(ui.notices[1].message, /verification failed/);
  assert.equal(ui.notices[1].type, "warning");
});

test("/ship status remains usable for a valid roadmap larger than the CLI output limit", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  const slice = raw.milestones[0].slices[0];
  const first = slice.tasks[0];
  slice.tasks = Array.from({ length: 200 }, (_, i) => ({
    ...first, id: `T${String(i + 1).padStart(2, "0")}`,
    goal: "Build a game mechanic ".repeat(100),
  }));
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1;
  await saveState(root, state);
  const ui = context(root);
  await command()("status", ui.ctx);
  assert.match(ui.notices.at(-1)?.message ?? "", /roadmap r1, 200 tasks/);
  assert.equal(ui.notices.at(-1)?.type, "info");
});

test("/ship pause and resume queue real safe-boundary controls without changing state immediately", async t => {
  const root = await fixture(t), ui = context(root), handle = command();
  await handle("pause", ui.ctx); await handle("resume", ui.ctx);
  assert.deepEqual((await inbox(root)).map(message => message.type).sort(), ["pause", "resume"]);
  assert.equal((await loadState(root)).paused, false);
  assert.ok(ui.notices.every(notice => /queued.*safe boundary/.test(notice.message)));
});

test("/ship add and change queue selected concrete IDs, revision and field values, not applied edits", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 3; await saveState(root, state);
  const ui = context(root), handle = command();
  ui.select("M001/S01"); ui.prompts.push("New task", "Create file", "File exists", "test -f file", "documentation", "LOW", "T01", "src/new.ts", "docs", "File is readable");
  await handle("add", ui.ctx);
  ui.select("M001/S01/T01"); ui.prompts.push("Changed goal", "", "", "", "", "", "");
  await handle("change", ui.ctx);
  const queued = await inbox(root);
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map(({ type, revision }) => [type, revision]).sort(), [["add", 3], ["change", 3]]);
  assert.ok(queued.some(message => message.type === "add" && message.slice === "M001/S01" && message.title === "New task" && message.goal === "Create file" && message.acceptance === "File exists" && message.check === "test -f file" && message.taskType === "documentation" && message.uncertainty === "LOW" && JSON.stringify(message.dependencies) === '["T01"]' && JSON.stringify(message.affectedFiles) === '["src/new.ts"]' && JSON.stringify(message.verificationRequirements) === '["File is readable"]'));
  assert.ok(queued.some(message => message.type === "change" && message.task === "M001/S01/T01" && message.goal === "Changed goal"));
  assert.equal((await loadState(root)).roadmapRevision, 3);
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].goal, "create file1.txt");
  assert.ok(ui.notices.every(notice => /queued.*not applied yet/.test(notice.message)));
});

test("/ship run dispatches OMP-native assignments without a controller CLI", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root);
  ui.confirm(false); await api.handle("run", ui.ctx); assert.equal(api.messages.length, 0);
  ui.confirm(true); ui.ui(false); await api.handle("run", ui.ctx); assert.equal(api.messages.length, 0);
  ui.ui(true); await api.handle("run", ui.ctx);
  assert.equal(api.messages.length, 1);
  assert.match(api.messages[0], /OMP task tool with agent|main session/);
  const active = await loadState(root);
  assert.equal(active.nativeBatch?.sessionId, "test-session");
  assert.equal(active.nativeBatch?.assignments.length, 1);
  assert.equal(active.milestones[0].slices[0].tasks[0].status, "running");
});

test("/ship cancelled edits and CLI failures do not claim a queued change", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 2; await saveState(root, state);
  const ui = context(root), handle = command();
  ui.confirm(false); ui.prompts.push("Improved goal", "", "", "", "", "", ""); await handle("change", ui.ctx);
  assert.deepEqual(await inbox(root), []);
  ui.confirm(true);
  ui.prompts.push("Another goal", "", "", "", "", "", "");
  const originalConfirm = ui.ctx.ui.confirm;
  ui.ctx.ui.confirm = async () => { const updated = await loadState(root); updated.roadmapRevision = 3; await saveState(root, updated); return true; };
  await handle("change", ui.ctx);
  ui.ctx.ui.confirm = originalConfirm;
  assert.deepEqual(await inbox(root), []);
  assert.match(ui.notices.at(-1)?.message ?? "", /failed:.*Stale roadmap revision/);
  assert.equal(ui.notices.at(-1)?.type, "error");
});

test("native outcomes verify real files before releasing dependent tasks", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks.push({
    id: "T02", title: "Dependent file", goal: "create file2.txt", dependencies: ["T01"],
    acceptance: ["file2.txt contains two"], verificationCommands: ["grep -q '^two$' file2.txt"],
  });
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  let batch = (await loadState(root)).nativeBatch!;
  assert.deepEqual(batch.assignments.map(a => a.key), ["M001/S01/T01"]);
  const outcome = (status: "passed" | "failed" | "partial", summary: string) =>
    api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status, summary }, undefined, undefined, ui.ctx);
  await outcome("passed", "Worker says file exists, but it does not");
  let current = await loadState(root);
  assert.equal(current.milestones[0].slices[0].tasks[0].status, "running");
  assert.equal(current.milestones[0].slices[0].tasks[1].status, "pending");
  assert.match(current.milestones[0].slices[0].tasks[0].lastError ?? "", /Verification/);
  batch = current.nativeBatch!;
  assert.equal(batch.assignments[0].key, "M001/S01/T01");
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await outcome("passed", "Created file1.txt with hello");
  current = await loadState(root);
  assert.equal(current.milestones[0].slices[0].tasks[0].status, "passed");
  assert.deepEqual(current.nativeBatch?.assignments.map(a => a.key), ["M001/S01/T02"]);
  batch = current.nativeBatch!;
  await writeFile(path.join(root, "file2.txt"), "two\n");
  await outcome("passed", "Created file2.txt with two");
  current = await loadState(root);
  assert.equal(current.phase, "complete");
  assert.equal(current.milestones[0].slices[0].tasks[1].status, "passed");
  const evidence = JSON.parse(await readFile(path.join(root, ".ship", "attempts", `native-${batch.assignments[0].id}.verification.json`), "utf8"));
  assert.equal(evidence.passed, true);
  assert.equal(evidence.checks[0].ok, true);
});

test("native safe parallel batch waits for both reports and preserves failures", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks = [1, 2].map(i => ({
    id: `T0${i}`, title: `Document file${i}`, goal: `document file${i}.txt`, taskType: "documentation",
    uncertainty: "LOW", affectedFiles: [`file${i}.txt`, `note${i}.txt`], affectedDomains: [`doc${i}`],
    acceptance: [`file${i}.txt contains hello`], verificationCommands: [`grep -q '^hello$' file${i}.txt`],
  }));
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  assert.equal(batch.assignments.length, 2);
  assert.match(api.messages[0], /ONE OMP task tool batch/);
  const result = (index: number, status: "passed" | "failed" | "partial", summary: string) =>
    api.report("call", { batchId: batch.id, assignmentId: batch.assignments[index].id, status, summary }, undefined, undefined, ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await result(0, "passed", "Documented file1.txt");
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].status, "running");
  const duplicate = await result(0, "passed", "Duplicate");
  assert.equal(duplicate.isError, true);
  await result(1, "partial", "Only a draft of file2 exists");
  const current = await loadState(root);
  assert.equal(current.milestones[0].slices[0].tasks[0].status, "passed");
  assert.equal(current.milestones[0].slices[0].tasks[1].status, "running");
  assert.match(current.milestones[0].slices[0].tasks[1].lastError ?? "", /partial/);
  assert.equal(current.nativeBatch?.assignments.length, 1);
});

test("native OMP session correlation and bounded failures reject stale or foreign outcomes", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  const foreign = { ...ui.ctx, sessionManager: { getSessionId: () => "another-session" } } as unknown as ExtensionContext;
  const payload = { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "failed" as const, summary: "Worker reported failure" };
  assert.equal((await api.report("call", payload, undefined, undefined, foreign)).isError, true);
  await api.report("call", payload, undefined, undefined, ui.ctx);
  let current = await loadState(root);
  assert.equal(current.nativeBatch?.assignments[0].key, batch.assignments[0].key);
  assert.notEqual(current.nativeBatch?.id, batch.id);
  assert.equal((await api.report("call", payload, undefined, undefined, ui.ctx)).isError, true);
  const next = current.nativeBatch!;
  await api.report("call", { ...payload, batchId: next.id, assignmentId: next.assignments[0].id }, undefined, undefined, ui.ctx);
  current = await loadState(root);
  assert.equal(current.phase, "blocked");
  assert.equal(current.nativeBatch, undefined);
  assert.match(current.blockedReason ?? "", /repair budget/);
});

test("native verification requires an independent reviewer after successful commands", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks[0].taskType = "implementation";
  raw.milestones[0].slices[0].tasks[0].uncertainty = "HIGH";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  const execution = (await loadState(root)).nativeBatch!;
  const route = await api.spawnHook({ spawnKey: `0-Ship${execution.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, ui.ctx);
  assert.equal(route?.model, "@slow");
  await api.report("call", { batchId: execution.id, assignmentId: execution.assignments[0].id, status: "passed", summary: "Created correct file" }, undefined, undefined, ui.ctx);
  let current = await loadState(root), review = current.nativeBatch!;
  assert.equal(review.stage, "reviewing");
  assert.equal(current.milestones[0].slices[0].tasks[0].status, "verifying");
  assert.match(api.messages.at(-1) ?? "", /agent: "reviewer"/);
  await api.report("call", { batchId: review.id, assignmentId: review.assignments[0].id, status: "failed", summary: "Independent reviewer found a concrete defect" }, undefined, undefined, ui.ctx);
  current = await loadState(root);
  assert.notEqual(current.milestones[0].slices[0].tasks[0].status, "passed");
  assert.match(current.milestones[0].slices[0].tasks[0].lastError ?? "", /Independent reviewer found/);
  review = current.nativeBatch!;
  assert.equal(review.stage, "executing");
  assert.equal((await api.spawnHook({ spawnKey: `0-Ship${review.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, ui.ctx))?.model, "@slow");
  await api.report("call", { batchId: review.id, assignmentId: review.assignments[0].id, status: "passed", summary: "Repaired reviewer finding" }, undefined, undefined, ui.ctx);
  current = await loadState(root); review = current.nativeBatch!;
  assert.equal(review.stage, "reviewing");
  assert.equal(current.milestones[0].slices[0].tasks[0].status, "verifying");
  await api.report("call", { batchId: review.id, assignmentId: review.assignments[0].id, status: "passed", summary: "Independent reviewer inspected changes and accepted repair" }, undefined, undefined, ui.ctx);
  current = await loadState(root);
  assert.equal(current.phase, "complete");
  assert.equal(current.milestones[0].slices[0].tasks[0].status, "passed");
});

test("queued roadmap changes wait for active native batch to settle", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks.push({
    id: "T02", title: "Second file", goal: "create second file", acceptance: ["second file exists"],
    verificationCommands: ["test -f second.txt"],
  });
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  let current = await loadState(root), batch = current.nativeBatch!;
  ui.select("M001/S01/T02"); ui.prompts.push("updated second goal", "", "", "", "", "", "");
  await api.handle("change", ui.ctx);
  await api.handle("run", ui.ctx);
  current = await loadState(root);
  assert.equal(current.roadmapRevision, 1);
  assert.equal(current.milestones[0].slices[0].tasks[1].goal, "create second file");
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Created file" }, undefined, undefined, ui.ctx);
  current = await loadState(root); batch = current.nativeBatch!;
  assert.equal(current.roadmapRevision, 2);
  assert.equal(current.milestones[0].slices[0].tasks[1].goal, "updated second goal");
  assert.equal(batch.assignments[0].key, "M001/S01/T02");
});

test("fresh native project plans through OMP before assigning work", async t => {
  const root = await fixture(t), api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const planning = (await loadState(root)).nativePlanning!;
  assert.ok(planning.id);
  assert.match(api.messages[0], /ship_plan/);
  assert.equal((await api.submit("call", { planningId: "wrong", plan: plan() }, undefined, undefined, ui.ctx)).isError, true);
  await api.submit("call", { planningId: planning.id, plan: plan() }, undefined, undefined, ui.ctx);
  const state = await loadState(root);
  assert.equal(state.nativePlanning, undefined);
  assert.equal(state.roadmapRevision, 1);
  assert.equal(state.nativeBatch?.assignments[0].key, "M001/S01/T01");
});

test("fully reported interrupted batch settles on restart without rerunning the worker", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  const interrupted = await loadState(root), batch = interrupted.nativeBatch!;
  batch.assignments[0].status = "passed"; batch.assignments[0].summary = "Actual file created";
  delete batch.settling;
  await saveState(root, interrupted);
  await api.handle("run", ui.ctx);
  const recovered = await loadState(root);
  assert.equal(recovered.phase, "complete");
  assert.equal(recovered.milestones[0].slices[0].tasks[0].attempts, 1);
  assert.equal(recovered.nativeBatch, undefined);
});

test("standalone controller and incompatible worktree cannot overlap an OMP-native batch", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const controller = new Controller(root, { async run() { throw new Error("Worker must not start"); } });
  await assert.rejects(controller.step(), /OMP-native batch/);
  const current = await loadState(root);
  assert.equal(current.phase, "executing");
  assert.equal(current.nativeBatch?.assignments[0].status, "pending");
  delete current.nativeBatch;
  current.milestones[0].slices[0].tasks[0].status = "pending";
  current.workspace = { path: path.join(root, ".ship", "worktree"), branch: "ship/standalone", baseHead: "baseline" };
  await saveState(root, current);
  await api.handle("run", ui.ctx);
  assert.match(ui.notices.at(-1)?.message ?? "", /Standalone worktree state cannot be reused/);
});

test("unsupported configured OMP role cannot silently accept a task outcome", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks[0].taskType = "planning-design";
  raw.milestones[0].slices[0].tasks[0].uncertainty = "LOW";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  assert.match(api.messages[0], /agent: "task".*configured @plan/);
  const unconfigured = { ...ui.ctx, models: { resolve: () => undefined } } as unknown as ExtensionContext;
  const route = await api.spawnHook({ spawnKey: `0-Ship${batch.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, unconfigured);
  assert.equal(route?.block, true);
  const rejected = await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Claimed success" }, undefined, undefined, ui.ctx);
  assert.equal(rejected.isError, true);
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].status, "running");
});

test("required reviewer remains schedulable after dispatch budget increases", async t => {
  const root = await fixture(t), state = await loadState(root), config = await loadConfig(root);
  config.limits.maxDispatches = 1; await atomicJson(configPath(root), config);
  const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].uncertainty = "HIGH";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  let batch = (await loadState(root)).nativeBatch!;
  await api.spawnHook({ spawnKey: `0-Ship${batch.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Created file" }, undefined, undefined, ui.ctx);
  let current = await loadState(root);
  assert.equal(current.phase, "blocked");
  assert.equal(current.nativeBatch?.awaitingBudget, true);
  config.limits.maxDispatches = 2; await atomicJson(configPath(root), config);
  await api.handle("resume", ui.ctx); await api.handle("run", ui.ctx);
  current = await loadState(root); batch = current.nativeBatch!;
  assert.equal(batch.stage, "reviewing");
  assert.equal(batch.awaitingBudget, undefined);
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Independent review accepted changes" }, undefined, undefined, ui.ctx);
  assert.equal((await loadState(root)).phase, "complete");
});

test("concurrent OMP processes atomically claim at most one native batch", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const launch = (session: string) => new Promise<number>((resolve, reject) => {
    execFile(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e",
      "import {startNativeRun} from './src/native-execution.ts'; await startNativeRun(process.argv[1], process.argv[2]);",
      root, session], { cwd: path.resolve("."), timeout: 20_000 },
    error => { if (error && !("code" in error)) reject(error); else resolve(error ? 1 : 0); });
  });
  const statuses = await Promise.all([launch("omp-one"), launch("omp-two")]);
  assert.ok(statuses.includes(0));
  const current = await loadState(root);
  assert.equal(current.dispatches, 1);
  assert.equal(current.milestones[0].slices[0].tasks[0].attempts, 1);
  assert.ok(["omp-one", "omp-two"].includes(current.nativeBatch?.sessionId ?? ""));
});

test("slow review work preserves the reviewer specialist at OMP spawn", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks[0].taskType = "review";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  assert.match(api.messages[0], /agent: "reviewer"/);
  const key = `0-Ship${batch.assignments[0].id.replaceAll("-", "").slice(0, 26)}`;
  assert.equal((await api.spawnHook({ spawnKey: key, agent: "task", invocationKind: "task" }, ui.ctx))?.block, true);
  assert.equal((await api.spawnHook({ spawnKey: key, agent: "reviewer", invocationKind: "task" }, ui.ctx))?.model, "@slow");
});
