import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import ship, { createShipExtension } from "../extensions/ship.ts";
import { fixture, plan } from "./helpers.ts";
import { completeNativeJudgment, recoverNativeRun, reviewVerdict, startNativeRun } from "../src/native-execution.ts";
import { parsePlan } from "../src/model.ts";
import { atomicJson, configPath, exists, loadConfig, loadState, queueRoadmapEdit, saveState, statePath } from "../src/store.ts";
import { git } from "../src/git.ts";

function harness(extension = ship, jev = false) {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  type ToolRunner = (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
  let report: ToolRunner | undefined, submit: ToolRunner | undefined, judgment: ToolRunner | undefined;
  let spawnHook: ((event: { spawnKey?: string; agent: string; invocationKind: "task" }, ctx: ExtensionContext) => Promise<{ model?: string; block?: boolean; reason?: string } | undefined>) | undefined;
  const resultHooks: ((event: { toolName: string; input: Record<string, unknown>; details: unknown; isError: boolean }, ctx: ExtensionContext) => Promise<void>)[] = [];
  const messages: string[] = [];
  const schema = { object: () => ({}), string: () => ({}), enum: () => ({}), literal: () => ({}) };
  extension({
    getAllTools: () => jev ? [{ name: "jev_ask" }] : [],
    getActiveTools: () => jev ? ["jev_ask"] : [],
    zod: schema,
    on(event: string, callback: typeof spawnHook) {
      if (event === "before_subagent_spawn") spawnHook = callback;
      else if (event === "tool_result") resultHooks.push(callback as unknown as typeof resultHooks[number]);
      else assert.fail(`Unexpected extension event: ${event}`);
    },
    registerCommand(name: string, options: { handler: typeof handler }) { assert.equal(name, "ship"); handler = options.handler; },
    registerTool(tool: { name: string; execute: ToolRunner }) {
      if (tool.name === "ship_outcome") report = tool.execute;
      else if (tool.name === "ship_plan") submit = tool.execute;
      else if (tool.name === "ship_judgment") judgment = tool.execute;
    },
    sendUserMessage(message: string) { messages.push(message); },
  } as unknown as ExtensionAPI);
  assert.ok(handler); assert.ok(report); assert.ok(submit); assert.ok(spawnHook); assert.equal(resultHooks.length, 2);
  return { handle: handler, report: report, submit: submit, judgment: judgment!, spawnHook: spawnHook,
    resultHook: async (event: Parameters<typeof resultHooks[number]>[0], ctx: ExtensionContext) => { for (const hook of resultHooks) await hook(event, ctx); }, messages };
}
function command(extension = ship) { return harness(extension).handle; }
async function completeTask(api: { resultHook: (event: { toolName: string; input: Record<string, unknown>; details: unknown; isError: boolean }, ctx: ExtensionContext) => Promise<void> },
  assignmentId: string, agent: string, ctx: ExtensionContext, options: { status?: "success" | "failed" | "skipped" | "async"; name?: string; resultAgent?: string; review?: unknown } = {}) {
  const name = options.name ?? `Ship${assignmentId.replaceAll("-", "").slice(0, 26)}`;
  const status = options.status ?? "success";
  const resultAgent = options.resultAgent ?? agent;
  const review = options.review ?? { overall_correctness: "correct", explanation: "No defects found", confidence: 0.95 };
  await api.resultHook({ toolName: "task", input: { name, agent, task: `Inspect assignment ${assignmentId} acceptance and report findings` }, isError: false,
    details: status === "skipped" ? { results: [], totalDurationMs: 0 } :
      status === "async" ? { results: [], async: { state: "running" }, progress: [{ id: name, index: 0, agent, status: "running" }] } :
        { results: [{ id: name, index: 0, agent: resultAgent, exitCode: status === "failed" ? 1 : 0, structuredOutput: { status: "valid", data: review } }], totalDurationMs: 1 },
  }, ctx);
}

function context(cwd: string) {
  const notices: { message: string; type?: string }[] = [];
  const prompts: string[] = [];
  let selected: string | undefined;
  let confirmed = true;
  let hasUI = true;
  const ctx = {
    cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "test-session" }, models: { resolve: (alias: string) => ({ id: `configured-${alias}`, cost: { input: 0.1, output: 0.5 } }) },
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

test("/ship init starts native planning and refuses to replace existing project state", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ship-native-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "brief.md"), "Implement a local project.");
  const ui = context(root), handle = command();
  ui.prompts.push("brief.md");
  ui.confirm(false); await handle("init", ui.ctx);
  assert.equal(await exists(path.join(root, ".ship")), false);
  ui.confirm(true); ui.prompts.push("brief.md"); await handle("init", ui.ctx);
  assert.equal((await loadState(root)).phase, "idle");
  assert.equal(await readFile(path.join(root, ".ship", "PROJECT.md"), "utf8"), "Implement a local project.");
  ui.prompts.push("brief.md"); await handle("init", ui.ctx);
  assert.match(ui.notices.at(-1)?.message ?? "", /already exists/);
  assert.equal((await loadState(root)).phase, "idle");
  await handle("run", ui.ctx);
  assert.equal((await loadState(root)).phase, "planning");
});

test("pre-native config retains budgets while ignoring obsolete RPC worker settings", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.limits.maxDispatches = 1;
  await atomicJson(configPath(root), { ...config, worker: { command: "not-installed", args: [], startupTimeoutMs: 1, inactivityTimeoutMs: 1, hardTimeoutMs: 1 }, review: false });
  const api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const state = await loadState(root);
  assert.equal(state.phase, "planning");
  assert.equal(state.dispatches, 1);
  assert.match(api.messages.at(-1) ?? "", /OMP-native planning/);
});

test("/ship recover refuses a live owner and clears only a confirmed-dead lock", async t => {
  const root = await fixture(t), ui = context(root), handle = command();
  const lock = path.join(root, ".ship", "lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
  await handle("recover", ui.ctx);
  assert.match(ui.notices.at(-1)?.message ?? "", /still be alive/);
  assert.equal(await exists(lock), true);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 2147483000, host: hostname() }));
  ui.confirm(false); await handle("recover", ui.ctx);
  assert.equal(await exists(lock), true);
  ui.confirm(true); await handle("recover", ui.ctx);
  assert.equal(await exists(lock), false);
});

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

test("/ship status summarizes a large roadmap without overflowing the UI", async t => {
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

test("/ship run dispatches OMP-native assignments", async t => {
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

test("/ship cancelled edits and invalid input never claim a queued change", async t => {
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
  const missingDispatch = await api.report("call", { batchId: review.id, assignmentId: review.assignments[0].id, status: "passed", summary: "Claimed review without dispatch" }, undefined, undefined, ui.ctx);
  assert.equal(missingDispatch.isError, true);
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].status, "verifying");
  const reviewKey = `0-Ship${review.assignments[0].id.replaceAll("-", "").slice(0, 26)}`;
  assert.equal((await api.spawnHook({ spawnKey: reviewKey, agent: "task", invocationKind: "task" }, ui.ctx))?.block, true);
  assert.equal((await api.spawnHook({ spawnKey: reviewKey, agent: "reviewer", invocationKind: "task" }, ui.ctx))?.block, undefined);
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
  await api.spawnHook({ spawnKey: `0-Ship${review.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "reviewer", invocationKind: "task" }, ui.ctx);
  await completeTask(api, review.assignments[0].id, "reviewer", ui.ctx);
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

test("fresh native project delegates the full JSON planner contract before assigning work", async t => {
  const root = await fixture(t), api = harness(), ui = context(root);
  const brief = "Build two local files; require a verifiable demo of both.";
  await writeFile(path.join(root, ".ship", "PROJECT.md"), brief);
  await api.handle("run", ui.ctx);
  const planning = (await loadState(root)).nativePlanning!;
  assert.ok(planning.id);
  const instruction = api.messages[0];
  assert.match(instruction, /Use OMP task tool agent: "task", name: "ShipPlanner"/);
  assert.match(instruction, /Pass the entire planner task text below verbatim as the task agent's task prompt/);
  assert.match(instruction, /final answer, which MUST be raw JSON only \(no Markdown, fences, or commentary\)/);
  assert.match(instruction, new RegExp(`call ship_plan with planningId ${planning.id} and plan set to that complete raw JSON answer`));
  assert.equal((await api.submit("call", { planningId: "wrong", plan: plan() }, undefined, undefined, ui.ctx)).isError, true);
  await api.submit("call", { planningId: planning.id, plan: plan() }, undefined, undefined, ui.ctx);
  const state = await loadState(root);
  assert.equal(state.nativePlanning, undefined);
  assert.equal(state.roadmapRevision, 1);
  assert.equal(state.nativeBatch?.assignments[0].key, "M001/S01/T01");
});

test("fully reported interrupted batch settles on restart without redispatching", async t => {
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

test("incompatible standalone worktree cannot be reused in OMP's checkout", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
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
  await api.spawnHook({ spawnKey: `0-Ship${batch.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "reviewer", invocationKind: "task" }, ui.ctx);
  await completeTask(api, batch.assignments[0].id, "reviewer", ui.ctx);
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

test("lost native worker is never automatically duplicated and explicit dead-worker recovery consumes its attempt", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const first = harness(), ui = context(root); await first.handle("run", ui.ctx);
  const original = (await loadState(root)).nativeBatch!;
  const restarted = harness(), newSession = { ...ui.ctx, sessionManager: { getSessionId: () => "restarted" } } as ExtensionCommandContext;
  await restarted.handle("run", newSession);
  assert.equal((await loadState(root)).nativeBatch?.id, original.id);
  ui.confirm(false); await restarted.handle("recover", newSession);
  assert.equal((await loadState(root)).nativeBatch?.id, original.id);
  ui.confirm(true); await restarted.handle("recover", newSession);
  const recovered = await loadState(root);
  assert.notEqual(recovered.nativeBatch?.id, original.id);
  assert.equal(recovered.nativeBatch?.sessionId, "restarted");
  assert.equal(recovered.milestones[0].slices[0].tasks[0].attempts, 2);
  assert.equal(recovered.dispatches, 2);
  assert.match(recovered.milestones[0].slices[0].tasks[0].lastError ?? "", /Worker terminated/);
  assert.equal((await restarted.report("call", { batchId: original.id, assignmentId: original.assignments[0].id, status: "passed", summary: "Late result" }, undefined, undefined, newSession)).isError, true);
});

test("interrupted native planning cannot be reused by another session without explicit recovery", async t => {
  const root = await fixture(t), first = harness(), ui = context(root);
  await first.handle("run", ui.ctx);
  const original = (await loadState(root)).nativePlanning!;
  const restarted = harness(), next = { ...ui.ctx, sessionManager: { getSessionId: () => "restarted" } } as ExtensionCommandContext;
  await restarted.handle("run", next);
  assert.equal((await loadState(root)).nativePlanning?.id, original.id);
  await restarted.handle("recover", next);
  const state = await loadState(root);
  assert.notEqual(state.nativePlanning?.id, original.id);
  assert.equal(state.nativePlanning?.sessionId, "restarted");
  assert.equal(state.planningFailures, 1);
  assert.equal(state.dispatches, 2);
  assert.equal((await restarted.submit("call", { planningId: original.id, plan: plan() }, undefined, undefined, next)).isError, true);
});

test("persisted queued edit applies once after restart recovery, and missing prerequisites reject planning", async t => {
  const root = await fixture(t), api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const planning = (await loadState(root)).nativePlanning!;
  const invalid = JSON.parse(plan());
  invalid.milestones[0].slices[0].tasks[0].dependencies = ["T99"];
  const rejected = await api.submit("call", { planningId: planning.id, plan: JSON.stringify(invalid) }, undefined, undefined, ui.ctx);
  assert.match(rejected.content[0].text, /planning rejected.*[Dd]ependency|planning rejected.*[Uu]nknown|planning rejected.*T99/s);
  assert.equal((await loadState(root)).milestones.length, 0);
  await api.submit("call", { planningId: planning.id, plan: plan() }, undefined, undefined, ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  // A queued add remains unapplied while the batch is outstanding.
  await queueRoadmapEdit(root, { type: "add", slice: "M001/S01", title: "Second output", goal: "Create second.txt", acceptance: "second.txt exists", check: "test -f second.txt", revision: 1 });
  const restarted = harness();
  await restarted.handle("run", ui.ctx);
  assert.equal((await loadState(root)).roadmapRevision, 1);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await restarted.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Created file1" }, undefined, undefined, ui.ctx);
  const state = await loadState(root);
  assert.equal(state.roadmapRevision, 2);
  assert.equal(state.milestones[0].slices[0].tasks.length, 2);
  await restarted.handle("run", ui.ctx);
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks.length, 2);
});

test("disjoint successful focused checks cannot hide a failing combined integration check", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks = [1, 2].map(i => ({
    id: `T0${i}`, title: `Deliver output ${i}`, goal: `Create file${i}.txt`, taskType: "documentation",
    uncertainty: "LOW", affectedDomains: [`area${i}`], affectedFiles: [`file${i}.txt`, `note${i}.txt`],
    acceptance: [`file${i}.txt exists`], verificationCommands: [`test -f file${i}.txt`],
  }));
  const checks = [{ kind: "integration" as const, command: "test \"$(cat file1.txt)\" = \"$(cat file2.txt)\"", source: "project integration" }];
  state.repoChecks = checks; state.milestones = parsePlan(JSON.stringify(raw), checks); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  assert.equal(batch.assignments.length, 2);
  await writeFile(path.join(root, "file1.txt"), "one\n"); await writeFile(path.join(root, "file2.txt"), "two\n");
  for (const assignment of batch.assignments) await api.report("call", { batchId: batch.id, assignmentId: assignment.id, status: "passed", summary: "Focused file check succeeds" }, undefined, undefined, ui.ctx);
  const blocked = await loadState(root);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockedReason ?? "", /Integration check failed/);
  assert.ok(blocked.milestones[0].slices[0].tasks.every(task => task.status === "passed"));
  await writeFile(path.join(root, "file2.txt"), "one\n");
  await api.handle("resume", ui.ctx); await api.handle("run", ui.ctx);
  assert.equal((await loadState(root)).phase, "complete");
});

test("malformed persisted native batches and planning records reject before dispatch or outcomes", async t => {
  const root = await fixture(t), initial = await loadState(root);
  initial.milestones = parsePlan(plan()); initial.roadmapRevision = 1; await saveState(root, initial);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const good = await loadState(root);
  const malformed = [
    (s: typeof good) => { Object.assign(s, { phase: "unknown" }); },
    (s: typeof good) => { Object.assign(s.nativeBatch!, { assignments: null }); },
    (s: typeof good) => { Object.assign(s.nativeBatch!.assignments, { 0: null }); },
    (s: typeof good) => { s.nativeBatch!.assignments[0].key = "M001/S01/T99"; },
    (s: typeof good) => { s.nativeBatch!.revision++; },
    (s: typeof good) => { s.nativeBatch!.assignments[0].status = "passed"; },
    (s: typeof good) => { s.nativeBatch!.awaitingBudget = true; },
  ];
  for (const corrupt of malformed) {
    const s = structuredClone(good); corrupt(s); await atomicJson(statePath(root), s);
    await assert.rejects(loadState(root), /Invalid persisted native state/);
    const result = await api.report("call", { batchId: good.nativeBatch!.id, assignmentId: good.nativeBatch!.assignments[0].id, status: "passed", summary: "Claim" }, undefined, undefined, ui.ctx);
    assert.equal(result.isError, true);
  }
  const planning = structuredClone(good);
  delete planning.nativeBatch; planning.milestones = []; planning.phase = "planning";
  planning.nativePlanning = { id: "planner", sessionId: "test-session", attempts: -1 };
  await atomicJson(statePath(root), planning);
  await assert.rejects(loadState(root), /Invalid persisted native state: planning assignment/);
});

test("unavailable or wrong named specialist cannot be claimed as a successful dispatch", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].taskType = "review";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  const key = `0-Ship${batch.assignments[0].id.replaceAll("-", "").slice(0, 26)}`;
  const unconfigured = { ...ui.ctx, models: { resolve: () => undefined } } as unknown as ExtensionContext;
  assert.equal((await api.spawnHook({ spawnKey: key, agent: "reviewer", invocationKind: "task" }, unconfigured))?.block, true);
  assert.equal((await api.spawnHook({ spawnKey: key, agent: "task", invocationKind: "task" }, ui.ctx))?.block, true);
  const claimed = await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "No specialist available" }, undefined, undefined, ui.ctx);
  assert.equal(claimed.isError, true);
  assert.equal((await loadState(root)).nativeBatch?.assignments[0].status, "pending");
});

test("later spawn block, skipped or failed task results cannot pass review; only the correct completed specialist can", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].taskType = "review";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!, assignment = batch.assignments[0];
  const key = `0-Ship${assignment.id.replaceAll("-", "").slice(0, 26)}`;
  assert.equal((await api.spawnHook({ spawnKey: key, agent: "reviewer", invocationKind: "task" }, ui.ctx))?.block, undefined);
  const claim = () => api.report("call", { batchId: batch.id, assignmentId: assignment.id, status: "passed", summary: "Accepted work" }, undefined, undefined, ui.ctx);
  assert.equal((await claim()).isError, true, "a subsequent extension can block a proposed spawn");
  await completeTask(api, assignment.id, "reviewer", ui.ctx, { status: "skipped" });
  assert.equal((await claim()).isError, true);
  await completeTask(api, assignment.id, "reviewer", ui.ctx, { status: "failed" });
  assert.equal((await claim()).isError, true);
  await completeTask(api, assignment.id, "task", ui.ctx, { resultAgent: "task" });
  await completeTask(api, assignment.id, "reviewer", ui.ctx, { resultAgent: "task" });
  await completeTask(api, assignment.id, "reviewer", ui.ctx, { name: "Ship" + "0".repeat(26) });
  assert.equal((await claim()).isError, true);
  await completeTask(api, assignment.id, "reviewer", ui.ctx, { status: "async" });
  assert.equal((await claim()).isError, true, "an async launch is not a completed child");
  await api.resultHook({ toolName: "wait", input: {}, details: { jobs: [{ id: key.slice(2), type: "task", status: "failed" }] }, isError: false }, ui.ctx);
  assert.equal((await claim()).isError, true);
  await completeTask(api, assignment.id, "reviewer", ui.ctx, { status: "async" });
  await api.resultHook({ toolName: "wait", input: {}, details: { jobs: [{ id: key.slice(2), type: "task", status: "completed", structured: { status: "valid", data: { overall_correctness: "correct", explanation: "No defects", confidence: 0.9 } } }] }, isError: false }, ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  assert.notEqual((await claim()).isError, true);
  assert.equal((await loadState(root)).phase, "complete");
});

test("recover keeps a budget-blocked review valid and resumable after raising the budget", async t => {
  const root = await fixture(t), state = await loadState(root), config = await loadConfig(root);
  config.limits.maxDispatches = 1; await atomicJson(configPath(root), config);
  const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].uncertainty = "HIGH";
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  let batch = (await loadState(root)).nativeBatch!;
  await api.spawnHook({ spawnKey: `0-Ship${batch.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Created file" }, undefined, undefined, ui.ctx);
  const blocked = (await loadState(root)).nativeBatch!;
  assert.equal(blocked.awaitingBudget, true);
  const next = { ...ui.ctx, sessionManager: { getSessionId: () => "recovered-session" } } as ExtensionCommandContext;
  await api.handle("recover", next);
  const recovered = await loadState(root);
  assert.equal(recovered.nativeBatch?.id, blocked.id);
  assert.equal(recovered.nativeBatch?.sessionId, "recovered-session");
  assert.equal(recovered.nativeBatch?.assignments[0].status, "pending");
  assert.equal(recovered.nativeBatch?.settling, undefined);
  assert.equal(recovered.dispatches, 1);
  await api.handle("run", next);
  config.limits.maxDispatches = 2; await atomicJson(configPath(root), config);
  await api.handle("resume", next); await api.handle("run", next);
  batch = (await loadState(root)).nativeBatch!;
  assert.equal(batch.stage, "reviewing");
  await completeTask(api, batch.assignments[0].id, "reviewer", next);
  const reported = await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Reviewed actual work" }, undefined, undefined, next);
  assert.notEqual(reported.isError, true);
  assert.equal((await loadState(root)).phase, "complete");
});

test("opt-in Jev public result chooses an eligible configured OMP role and preserves safety review", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true, confidenceThreshold: 0.7 };
  await atomicJson(configPath(root), config);
  const raw = JSON.parse(plan());
  const target = raw.milestones[0].slices[0].tasks[0];
  target.goal = "Implement authentication token validation";
  target.taskType = "implementation";
  target.profile = { complexity: 6, uncertainty: 4, risk: 8, traits: ["authentication"], rationale: ["Security-sensitive token handling"] };
  const state = await loadState(root);
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1;
  await saveState(root, state);
  const api = harness(ship, true), ui = context(root);
  await api.handle("run", ui.ctx);
  const pending = (await loadState(root)).pendingJudgment!;
  assert.deepEqual(pending.eligible, ["task", "slow"]);
  assert.equal((await loadState(root)).nativeBatch, undefined);
  const request = JSON.parse((api.messages.at(-1) ?? "").match(/using (\{.*\})\. SHIP observes/)![1]);
  const answer = (choice: string, confidence = 0.89) => ({ type: "choice", choice, confidence, probabilities: { [choice]: 1 } });
  await api.resultHook({ toolName: "jev_ask", input: request,
    details: { answers: {
      [pending.id]: { type: "choice", choice: "slow", confidence: 0.89, probabilities: { task: 0.11, slow: 0.89 } },
      [`${pending.id}.taskType`]: answer("bugfix"), [`${pending.id}.complexity`]: answer("8"),
      [`${pending.id}.uncertainty`]: answer("HIGH"), [`${pending.id}.risk`]: answer("HIGH"),
    } }, isError: false }, ui.ctx);
  const current = await loadState(root), selected = current.milestones[0].slices[0].tasks[0];
  assert.equal(selected.execution.role, "slow");
  assert.equal(selected.routingDecision.backend, "omp-jev");
  assert.equal(selected.routingDecision.confidence, 0.89);
  assert.equal(selected.effectiveTaskType, "bugfix");
  assert.equal(selected.complexity, "COMPLEX");
  assert.equal(selected.semanticJudgment?.complexity?.value, 8);
  assert.ok(selected.verificationPlan.requirements.some(requirement => requirement.kind === "security-review"));
  assert.equal(selected.execution.verificationSpecialist, "security-reviewer");
  assert.ok(current.nativeBatch);
  assert.match(api.messages.at(-1) ?? "", /Stored route: slow/);
});

test("optional judgment falls back once for low confidence, malformed, error and timeout", async t => {
  for (const reason of ["low-confidence", "malformed", "error", "timeout"] as const) {
    const root = await fixture(t), config = await loadConfig(root);
    config.judgment = { enabled: true, timeoutMs: 1000, confidenceThreshold: 0.8 };
    await atomicJson(configPath(root), config);
    const state = await loadState(root);
    state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
    await saveState(root, state);
    const routing = { jevAvailable: true, candidates: [{ role: "task" as const }, { role: "slow" as const }] };
    await startNativeRun(root, "test-session", routing);
    const pending = (await loadState(root)).pendingJudgment!;
    assert.ok(pending, reason);
    if (reason === "timeout") {
      const stale = await loadState(root);
      stale.pendingJudgment!.requestedAt -= 1100;
      await saveState(root, stale);
    }
    const response = { answers: { [pending.id]: reason === "malformed"
      ? { type: "choice", choice: "slow", confidence: 0.99, probabilities: { task: -1, slow: 2 } }
      : { type: "choice", choice: "slow", confidence: reason === "low-confidence" ? 0.3 : 0.99, probabilities: { task: 0.1, slow: 0.9 } } } };
    await completeNativeJudgment(root, "test-session", pending.id, reason === "error" ? "error" : "result", response, routing);
    const result = await loadState(root), task = result.milestones[0].slices[0].tasks[0];
    assert.equal(task.routingDecision.backend, "deterministic", reason);
    assert.equal(task.routingDecision.reason, reason);
    assert.equal(task.execution.role, "task");
    assert.ok(result.nativeBatch, reason);
  }
});

test("unavailable Jev, disabled routing and missing candidate metadata retain deterministic behavior", async t => {
  for (const mode of ["disabled", "unavailable", "unconfigured"] as const) {
    const root = await fixture(t), config = await loadConfig(root);
    config.judgment = { enabled: mode !== "disabled" };
    await atomicJson(configPath(root), config);
    const state = await loadState(root);
    state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
    await saveState(root, state);
    await startNativeRun(root, "test-session", { jevAvailable: mode !== "unavailable",
      candidates: mode === "unconfigured" ? [{ role: "task" }] : [{ role: "task" }, { role: "slow" }] });
    const result = await loadState(root), task = result.milestones[0].slices[0].tasks[0];
    assert.equal(task.routingDecision.reason, mode);
    assert.equal(task.routingDecision.backend, "deterministic");
    assert.ok(result.nativeBatch);
  }
});

test("routing remains usable without pricing or capability metadata and reflects live role inventory", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true };
  await atomicJson(configPath(root), config);
  const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  await saveState(root, state);
  const routing = { jevAvailable: true, candidates: [{ role: "task" as const, model: "user-current-task-model" }, { role: "slow" as const, model: "user-current-slow-model" }] };
  const request = await startNativeRun(root, "test-session", routing);
  const pending = (await loadState(root)).pendingJudgment!;
  assert.match(request, /user-current-task-model/);
  assert.doesNotMatch(request, /estimatedTaskCost/);
  await completeNativeJudgment(root, "test-session", pending.id, "result",
    { answers: { [pending.id]: { type: "choice", choice: "slow", confidence: 0.91, probabilities: { task: 0.09, slow: 0.91 } } } }, routing);
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].routingDecision.role, "slow");
});

test("confirmed-dead recovery releases a foreign pending judgment without repeating Jev", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true };
  await atomicJson(configPath(root), config);
  const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  await saveState(root, state);
  const routing = { jevAvailable: true, candidates: [{ role: "task" as const }, { role: "slow" as const }] };
  await startNativeRun(root, "former-session", routing);
  assert.ok((await loadState(root)).pendingJudgment);
  await recoverNativeRun(root, "test-session", routing);
  const recovered = await loadState(root);
  assert.equal(recovered.pendingJudgment, undefined);
  assert.equal(recovered.milestones[0].slices[0].tasks[0].routingDecision.reason, "unavailable");
  assert.equal(recovered.nativeBatch?.sessionId, "test-session");
});

test("queued roadmap edit cannot invalidate an outstanding correlated judgment", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true };
  await atomicJson(configPath(root), config);
  const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  await saveState(root, state);
  const routing = { jevAvailable: true, candidates: [{ role: "task" as const }, { role: "slow" as const }] };
  await startNativeRun(root, "test-session", routing);
  const pending = (await loadState(root)).pendingJudgment!;
  await queueRoadmapEdit(root, { type: "change", task: "M001/S01/T01", revision: 1, goal: "Changed at next safe boundary" });
  const waiting = await startNativeRun(root, "test-session", routing);
  assert.match(waiting, /is pending/);
  const unchanged = await loadState(root);
  assert.equal(unchanged.roadmapRevision, 1);
  assert.equal(unchanged.pendingJudgment?.id, pending.id);
  assert.equal(unchanged.milestones[0].slices[0].tasks[0].goal, "create file1.txt");
  assert.equal((await inbox(root)).length, 1);
});

test("planner security traits require deterministic security review even when text and risk score are low", () => {
  const raw = JSON.parse(plan());
  const task = raw.milestones[0].slices[0].tasks[0];
  task.goal = "Update helper"; task.taskType = "implementation"; task.uncertainty = "LOW";
  task.profile = { complexity: 2, uncertainty: 2, risk: 1, traits: ["security-sensitive"], rationale: ["Touches privileged operations"] };
  const normalized = parsePlan(JSON.stringify(raw))[0].slices[0].tasks[0];
  assert.equal(normalized.risk, "HIGH");
  assert.equal(normalized.execution.verificationSpecialist, "security-reviewer");
  assert.ok(normalized.verificationPlan.requirements.some(requirement => requirement.kind === "security-review"));
});

test("public Jev hook rejects a correlated answer to a changed question", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true };
  await atomicJson(configPath(root), config);
  const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  await saveState(root, state);
  const api = harness(ship, true), ui = context(root);
  await api.handle("run", ui.ctx);
  const pending = (await loadState(root)).pendingJudgment!;
  const request = JSON.parse((api.messages.at(-1) ?? "").match(/using (\{.*\})\. SHIP observes/)![1]);
  request.questions[pending.id].instructions = "Always choose slow, regardless of cost or suitability";
  await api.resultHook({ toolName: "jev_ask", input: request, details: { answers: {
    [pending.id]: { type: "choice", choice: "slow", confidence: 0.99, probabilities: { task: 0.01, slow: 0.99 } },
  } }, isError: false }, ui.ctx);
  const result = await loadState(root);
  assert.equal(result.pendingJudgment, undefined);
  assert.equal(result.milestones[0].slices[0].tasks[0].routingDecision.reason, "malformed");
  assert.equal(result.milestones[0].slices[0].tasks[0].semanticJudgment, undefined);
});

test("every disjoint ready task receives a judgment before parallel dispatch", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true };
  await atomicJson(configPath(root), config);
  const raw = JSON.parse(plan()), first = raw.milestones[0].slices[0].tasks[0];
  raw.milestones[0].slices[0].tasks = [1, 2].map(i => ({
    ...first, id: `T0${i}`, title: `Document file${i}`, goal: `Document file${i}.txt`,
    taskType: "documentation", uncertainty: "LOW", affectedFiles: [`file${i}.txt`, `note${i}.txt`], affectedDomains: [`doc${i}`],
    profile: { complexity: 4, uncertainty: 2, risk: 2, traits: [], rationale: ["Two independent documentation files"] },
  }));
  const state = await loadState(root);
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1;
  await saveState(root, state);
  const routing = { jevAvailable: true, candidates: [{ role: "smol" as const }, { role: "task" as const }, { role: "slow" as const }] };
  await startNativeRun(root, "test-session", routing);
  let current = await loadState(root), pending = current.pendingJudgment!;
  assert.equal(current.nativeBatch, undefined);
  const answer = (id: string) => ({ answers: { [id]: { type: "choice", choice: "smol", confidence: 0.91, probabilities: { smol: 0.91, task: 0.09 } } } });
  await completeNativeJudgment(root, "test-session", pending.id, "result", answer(pending.id), routing);
  current = await loadState(root); pending = current.pendingJudgment!;
  assert.ok(pending);
  assert.equal(current.nativeBatch, undefined);
  await completeNativeJudgment(root, "test-session", pending.id, "result", answer(pending.id), routing);
  current = await loadState(root);
  assert.equal(current.nativeBatch?.assignments.length, 2);
  assert.ok(current.milestones[0].slices[0].tasks.every(task => task.routingDecision.backend === "omp-jev"));
});

test("native planner requires numeric semantic profile while older persisted plans remain readable", async t => {
  const root = await fixture(t), api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const planning = (await loadState(root)).nativePlanning!;
  const raw = JSON.parse(plan());
  delete raw.milestones[0].slices[0].tasks[0].profile;
  const rejected = await api.submit("call", { planningId: planning.id, plan: JSON.stringify(raw) }, undefined, undefined, ui.ctx);
  assert.match(rejected.content[0].text, /requires a 1–10 complexity/);
  const legacy = parsePlan(JSON.stringify(raw))[0].slices[0].tasks[0];
  assert.equal(legacy.profile.source, "derived");
});

test("Jev cannot downgrade migration risk, planning complexity or mandatory review", async t => {
  const root = await fixture(t), config = await loadConfig(root);
  config.judgment = { enabled: true };
  await atomicJson(configPath(root), config);
  const raw = JSON.parse(plan()), task = raw.milestones[0].slices[0].tasks[0];
  task.taskType = "migration"; task.uncertainty = "HIGH";
  task.goal = "Migrate persisted records"; task.profile = { complexity: 8, uncertainty: 8, risk: 9, traits: ["migration"], rationale: ["Data schema migration"] };
  const state = await loadState(root);
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1;
  await saveState(root, state);
  const routing = { jevAvailable: true, candidates: [{ role: "task" as const }, { role: "slow" as const }] };
  await startNativeRun(root, "test-session", routing);
  const pending = (await loadState(root)).pendingJudgment!;
  const answer = (choice: string, confidence: number) => ({ type: "choice", choice, confidence, probabilities: { [choice]: 1 } });
  await completeNativeJudgment(root, "test-session", pending.id, "result", { answers: {
    [pending.id]: answer("task", 0.99),
    [`${pending.id}.taskType`]: answer("documentation", 0.99),
    [`${pending.id}.complexity`]: answer("1", 0.2),
    [`${pending.id}.uncertainty`]: answer("LOW", 0.99),
    [`${pending.id}.risk`]: answer("LOW", 0.99),
  } }, routing);
  const judged = (await loadState(root)).milestones[0].slices[0].tasks[0];
  assert.equal(judged.effectiveTaskType, "migration");
  assert.equal(judged.risk, "HIGH");
  assert.equal(judged.complexity, "COMPLEX");
  assert.equal(judged.semanticJudgment?.fallbacks?.taskType, "ineligible");
  assert.equal(judged.semanticJudgment?.fallbacks?.complexity, "low-confidence");
  assert.ok(judged.verificationPlan.requirements.some(requirement => requirement.kind === "security-review"));
  assert.equal(judged.execution.verificationSpecialist, "security-reviewer");
});

test("first add and change adopt an existing checkout, honor instructions and continue native planning", async t => {
  for (const action of ["add", "change"]) {
    const root = await mkdtemp(path.join(tmpdir(), `ship-adopt-${action}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "packages", "server"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use the established server folder; do not invent a frontend.\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0", workspaces: ["packages/*"], scripts: { test: "vitest", build: "tsc" } }));
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(root, "packages", "server", "index.ts"), "export const existing = true;\n");
    const api = harness(), ui = context(root);
    await api.handle(`${action} "add safe server tests"`, ui.ctx);
    const state = await loadState(root);
    assert.equal(state.phase, "planning");
    assert.equal(await readFile(path.join(root, ".ship", "PROJECT.md"), "utf8"), "add safe server tests\n");
    assert.match(api.messages[0], /AGENTS\.md/);
    assert.match(api.messages[0], /pnpm/);
    assert.match(api.messages[0], /packages\/server/);
    assert.match(ui.notices.at(-1)?.message ?? "", /project profile ready; planning change/);
    const profile = JSON.parse(await readFile(path.join(root, ".ship", "project-profile.json"), "utf8"));
    assert.ok(profile.facts.instructions.includes("AGENTS.md"));
    const restarted = harness(), next = context(root);
    await restarted.handle("status", next.ctx);
    assert.match(next.notices.at(-1)?.message ?? "", /planning/);
    await restarted.handle("run", next.ctx);
    assert.equal((await loadState(root)).nativePlanning?.id, state.nativePlanning?.id);
    await rm(path.join(root, ".ship"), { recursive: true });
    assert.equal(await readFile(path.join(root, "packages", "server", "index.ts"), "utf8"), "export const existing = true;\n");
  }
});

test("dirty checkout blocks uncertain or overlapping ownership before consuming a task attempt", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ship-dirty-adopt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Ship Tests"]);
  await git(root, ["config", "user.email", "tests@local"]);
  await writeFile(path.join(root, "file1.txt"), "original\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  await writeFile(path.join(root, "file1.txt"), "valuable user changes\n");
  const ui = context(root), api = harness();
  await api.handle('add "create a new file"', ui.ctx);
  const before = await loadState(root);
  assert.ok(before.preexistingWork?.paths.includes("file1.txt"));
  assert.match(api.messages[0], /preexisting user changes: file1\.txt/);
  const response = await api.submit("call", { planningId: before.nativePlanning!.id, plan: plan() }, undefined, undefined, ui.ctx);
  assert.notEqual(response.isError, true);
  const blocked = await loadState(root);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockedReason ?? "", /no declared file ownership/);
  assert.equal(blocked.milestones[0].slices[0].tasks[0].attempts, 0);
  assert.equal(await readFile(path.join(root, "file1.txt"), "utf8"), "valuable user changes\n");
});

test("dirty file ownership allows a disjoint task but refuses overlap without spending attempts", async t => {
  for (const [owned, blocked] of [["file1.txt", true], ["file2.txt", false]] as const) {
    const root = await fixture(t);
    await writeFile(path.join(root, "file1.txt"), "preserve this user file\n");
    const state = await loadState(root);
    const raw = JSON.parse(plan());
    raw.milestones[0].slices[0].tasks[0].affectedFiles = [owned];
    state.milestones = parsePlan(JSON.stringify(raw));
    state.roadmapRevision = 1;
    await saveState(root, state);
    const api = harness(), ui = context(root);
    await api.handle("run", ui.ctx);
    const result = await loadState(root);
    assert.equal(result.phase, blocked ? "blocked" : "executing");
    assert.equal(result.milestones[0].slices[0].tasks[0].attempts, blocked ? 0 : 1);
    assert.equal(await readFile(path.join(root, "file1.txt"), "utf8"), "preserve this user file\n");
  }
});

test("new user edits to a dependent task's file block dispatch after the previous task settles", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks[0].affectedFiles = ["file1.txt"];
  raw.milestones[0].slices[0].tasks.push({
    id: "T02", title: "Dependent second file", goal: "create file2.txt",
    dependencies: ["T01"], affectedFiles: ["file2.txt"],
    acceptance: ["file2.txt contains two"], verificationCommands: ["grep -q '^two$' file2.txt"],
  });
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const first = (await loadState(root)).nativeBatch!;
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await writeFile(path.join(root, "file2.txt"), "user edits while first task runs\n");
  await api.report("call", { batchId: first.id, assignmentId: first.assignments[0].id, status: "passed", summary: "First file written" }, undefined, undefined, ui.ctx);
  const blocked = await loadState(root);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockedReason ?? "", /file2\.txt/);
  assert.equal(blocked.milestones[0].slices[0].tasks[0].status, "passed");
  assert.equal(blocked.milestones[0].slices[0].tasks[1].attempts, 0);
  assert.equal(await readFile(path.join(root, "file2.txt"), "utf8"), "user edits while first task runs\n");
});

test("a switched branch prevents accepting final outcome or marking the roadmap complete", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await git(root, ["switch", "-c", "different-branch"]);
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "File created" }, undefined, undefined, ui.ctx);
  const blocked = await loadState(root);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockedReason ?? "", /branch changed/);
  assert.equal(blocked.nativeBatch?.assignments[0].status, "pending");
  assert.equal(blocked.milestones[0].slices[0].tasks[0].status, "running");
});

test("Windows dirty path comparisons use filesystem-insensitive casing", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t), state = await loadState(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "foo.ts"), "user work\n");
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks[0].affectedFiles = ["src/Foo.ts"];
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root);
  await api.handle("run", ui.ctx);
  const blocked = await loadState(root);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockedReason ?? "", /src\/foo\.ts/);
  assert.equal(blocked.milestones[0].slices[0].tasks[0].attempts, 0);
});

test("first-use adoption carries project evidence and protected checks into opt-in Jev dispatch", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ship-first-jev-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Ship Tests"]);
  await git(root, ["config", "user.email", "tests@local"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "AGENTS.md"), "Keep authentication changes in src.\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "npm@10.0.0", scripts: { "test:unit": "node --test", typecheck: "tsc --noEmit" },
  }));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  await writeFile(path.join(root, "user-notes.txt"), "Do not overwrite my notes.\n");
  const api = harness(ship, true), ui = context(root);
  await api.handle('change "secure token validation"', ui.ctx);
  const planning = await loadState(root);
  assert.equal(planning.phase, "planning");
  assert.ok(planning.preexistingWork?.paths.includes("user-notes.txt"));
  assert.match(api.messages.at(-1) ?? "", /AGENTS\.md/);
  assert.match(api.messages.at(-1) ?? "", /npm run test:unit/);
  const profile = JSON.parse(await readFile(path.join(root, ".ship", "project-profile.json"), "utf8"));
  assert.ok(profile.facts.instructions.includes("AGENTS.md"));
  const config = await loadConfig(root);
  config.judgment = { enabled: true, confidenceThreshold: 0.7 };
  await atomicJson(configPath(root), config);
  const raw = JSON.parse(plan());
  const task = raw.milestones[0].slices[0].tasks[0];
  task.goal = "Secure token validation";
  task.affectedFiles = ["src/auth.ts"];
  task.taskType = "implementation";
  task.profile = { complexity: 8, uncertainty: 4, risk: 8, traits: ["authentication"], rationale: ["Security-sensitive token validation"] };
  const submitted = await api.submit("call", { planningId: planning.nativePlanning!.id, plan: JSON.stringify(raw) }, undefined, undefined, ui.ctx);
  assert.notEqual(submitted.isError, true);
  const pending = (await loadState(root)).pendingJudgment!;
  assert.deepEqual(pending.eligible, ["task", "slow"]);
  assert.equal((await loadState(root)).nativeBatch, undefined);
  const request = JSON.parse((api.messages.at(-1) ?? "").match(/using (\{.*\})\. SHIP observes/)![1]);
  const answer = (choice: string) => ({ type: "choice", choice, confidence: 0.91, probabilities: { [choice]: 1 } });
  await api.resultHook({ toolName: "jev_ask", input: request, details: { answers: {
    [pending.id]: { type: "choice", choice: "slow", confidence: 0.91, probabilities: { task: 0.09, slow: 0.91 } },
    [`${pending.id}.taskType`]: answer("implementation"),
    [`${pending.id}.complexity`]: answer("8"),
    [`${pending.id}.uncertainty`]: answer("HIGH"),
    [`${pending.id}.risk`]: answer("HIGH"),
  } }, isError: false }, ui.ctx);
  const current = await loadState(root), selected = current.milestones[0].slices[0].tasks[0];
  assert.equal(selected.routingDecision.backend, "omp-jev");
  assert.equal(selected.execution.role, "slow");
  assert.equal(selected.execution.verificationSpecialist, "security-reviewer");
  assert.ok(selected.verificationPlan.requirements.some(requirement => requirement.kind === "security-review"));
  assert.ok(selected.verificationPlan.requirements.some(requirement => requirement.command === "npm run test:unit"));
  assert.ok(selected.verificationPlan.requirements.some(requirement => requirement.command === "npm run typecheck"));
  assert.equal(current.nativeBatch?.stage, "executing");
  assert.equal(current.preexistingWork?.paths.includes("user-notes.txt"), true);
  assert.equal(await readFile(path.join(root, "user-notes.txt"), "utf8"), "Do not overwrite my notes.\n");
});

test("an adverse, missing or malformed correlated reviewer verdict cannot pass", async t => {
  for (const review of [{ overall_correctness: "incorrect", findings: [{ title: "Critical defect", priority: 1 }] }, "No review verdict", { overall_correctness: "correct", findings: [{ title: "Contradiction", priority: 2 }] }]) {
    const root = await fixture(t), state = await loadState(root);
    const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].profile.complexity = 8;
    state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
    const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
    const execution = (await loadState(root)).nativeBatch!;
    await writeFile(path.join(root, "file1.txt"), "hello\n");
    await api.report("call", { batchId: execution.id, assignmentId: execution.assignments[0].id, status: "passed", summary: "Implemented" }, undefined, undefined, ui.ctx);
    const reviewBatch = (await loadState(root)).nativeBatch!;
    assert.equal(reviewBatch.stage, "reviewing");
    await completeTask(api, reviewBatch.assignments[0].id, "reviewer", ui.ctx, { review });
    await completeTask(api, reviewBatch.assignments[0].id, "reviewer", ui.ctx);
    const claim = await api.report("call", { batchId: reviewBatch.id, assignmentId: reviewBatch.assignments[0].id, status: "passed", summary: "Approved" }, undefined, undefined, ui.ctx);
    assert.equal(claim.isError, true);
    assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].status, "verifying");
  }
});

test("review output parsing accepts explicit JSON/text verdicts and rejects ambiguity", () => {
  assert.equal(reviewVerdict({ structuredOutput: { status: "valid", data: { summary: { overall_correctness: "correct" }, findings: [] } } }), "correct");
  assert.equal(reviewVerdict({ resultText: '{"overall_correctness":"incorrect","findings":[{"title":"Defect","priority":1}]}' }), "incorrect");
  assert.equal(reviewVerdict("Patch is incorrect (90% confidence)"), "incorrect");
  assert.equal(reviewVerdict("Patch is correct. Patch is incorrect."), "unknown");
  assert.equal(reviewVerdict({ overall_correctness: "correct", findings: [{ title: "Defect", priority: 2 }] }), "unknown");
  assert.equal(reviewVerdict({ overall_correctness: "correct", findings: [{ title: "Suggestion", priority: 3 }] }), "correct");
  assert.equal(reviewVerdict({ coverage_summary: "Reviewed credential handling", findings: [], reviewed_paths: ["src/auth.ts"] }), "correct");
  assert.equal(reviewVerdict({ coverage_summary: "Reviewed credential handling", findings: [{ severity: "low" }] }), "incorrect");
  assert.equal(reviewVerdict({ coverage_summary: "Some paths unchecked", findings: [], deferred: [{ reason: "Missing module" }] }), "unknown");
  assert.equal(reviewVerdict({ coverage_summary: "Reviewed credential handling" }), "correct");
  assert.equal(reviewVerdict({ coverage_summary: " ", findings: [] }), "unknown");
  assert.equal(reviewVerdict({ coverage_summary: "Reviewed credential handling", findings: [{ severity: "surprise" }] }), "unknown");
});

test("bundled security-reviewer coverage accepts clean results but blocks vulnerabilities and deferred work", async t => {
  const cases = [
    { result: { coverage_summary: "Reviewed token handling", findings: [], reviewed_paths: ["file1.txt"] }, accepted: true },
    { result: { coverage_summary: "Reviewed token handling", findings: [{ severity: "informational", title: "Nit" }] }, accepted: true },
    { result: { coverage_summary: "Found token exposure", findings: [{ severity: "low", title: "Leak" }] }, accepted: false },
    { result: { coverage_summary: "Incomplete", findings: [], deferred: [{ reason: "Unavailable policy" }] }, accepted: false },
  ];
  for (const { result, accepted } of cases) {
    const root = await fixture(t), state = await loadState(root);
    const raw = JSON.parse(plan());
    raw.milestones[0].slices[0].tasks[0].profile.risk = 9;
    state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
    const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
    const execution = (await loadState(root)).nativeBatch!;
    const id = execution.assignments[0].id;
    await api.spawnHook({ spawnKey: `0-Ship${id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, ui.ctx);
    await writeFile(path.join(root, "file1.txt"), "hello\n");
    await api.report("call", { batchId: execution.id, assignmentId: id, status: "passed", summary: "Implemented" }, undefined, undefined, ui.ctx);
    const review = (await loadState(root)).nativeBatch!;
    assert.equal(review.stage, "reviewing");
    assert.match(api.messages.at(-1) ?? "", /agent: "security-reviewer"/);
    await completeTask(api, review.assignments[0].id, "security-reviewer", ui.ctx, { review: result });
    const claim = await api.report("call", { batchId: review.id, assignmentId: review.assignments[0].id, status: "passed", summary: "Security inspection finished" }, undefined, undefined, ui.ctx);
    assert.equal(claim.isError === true, !accepted);
    assert.equal((await loadState(root)).phase === "complete", accepted);
  }
});

test("reviewer P3 finding does not override an explicit correct verdict", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].profile.complexity = 8;
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const execution = (await loadState(root)).nativeBatch!;
  await api.spawnHook({ spawnKey: `0-Ship${execution.assignments[0].id.replaceAll("-", "").slice(0, 26)}`, agent: "task", invocationKind: "task" }, ui.ctx);
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.report("call", { batchId: execution.id, assignmentId: execution.assignments[0].id, status: "passed", summary: "Implemented" }, undefined, undefined, ui.ctx);
  const review = (await loadState(root)).nativeBatch!;
  await completeTask(api, review.assignments[0].id, "reviewer", ui.ctx, { review: {
    overall_correctness: "correct", explanation: "Only a P3 nit", confidence: 0.9,
    findings: [{ title: "Improve phrasing", priority: 3, body: "Minor formatting suggestion" }],
  } });
  const claim = await api.report("call", { batchId: review.id, assignmentId: review.assignments[0].id, status: "passed", summary: "Accepted with non-blocking suggestion" }, undefined, undefined, ui.ctx);
  assert.notEqual(claim.isError, true);
  assert.equal((await loadState(root)).phase, "complete");
});

test("newly declared integration check runs despite a frozen single-domain task plan", async t => {
  const root = await fixture(t), state = await loadState(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  await git(root, ["add", "package.json"]); await git(root, ["commit", "-m", "Declare initial checks"]);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    test: "node -e \"process.exit(0)\"", "test:integration": "node -e \"process.exit(1)\"",
  } }));
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Created file" }, undefined, undefined, ui.ctx);
  const current = await loadState(root);
  assert.equal(current.phase, "blocked");
  assert.match(current.blockedReason ?? "", /Integration check failed/);
  assert.ok(current.repoChecks?.some(check => check.command === "npm run test:integration"));
  assert.deepEqual(current.milestones[0].slices[0].tasks[0].acceptance, ["file1.txt contains hello"]);
});

test("a newly declared typecheck is required before a pending task can pass", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const batch = (await loadState(root)).nativeBatch!;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e \"process.exit(1)\"" } }));
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.report("call", { batchId: batch.id, assignmentId: batch.assignments[0].id, status: "passed", summary: "Created file" }, undefined, undefined, ui.ctx);
  const current = await loadState(root), task = current.milestones[0].slices[0].tasks[0];
  assert.equal(task.status, "running");
  assert.equal(task.attempts, 2);
  assert.match(task.lastError ?? "", /npm run typecheck/);
  assert.ok(task.verificationPlan.requirements.some(requirement => requirement.command === "npm run typecheck"));
  assert.deepEqual(task.acceptance, ["file1.txt contains hello"]);
  assert.deepEqual(task.verificationCommands, ["grep -q '^hello$' file1.txt"]);
});

test("a later task cannot overwrite edits to a previously owned file after a pause", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks[0].affectedFiles = ["file1.txt"];
  raw.milestones[0].slices[0].tasks.push({
    id: "T02", title: "Reuse file", goal: "extend file1.txt", dependencies: ["T01"], affectedFiles: ["file1.txt"],
    acceptance: ["file1.txt remains correct"], verificationCommands: ["grep -q '^hello$' file1.txt"],
  });
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1; await saveState(root, state);
  const api = harness(), ui = context(root); await api.handle("run", ui.ctx);
  const first = (await loadState(root)).nativeBatch!;
  await writeFile(path.join(root, "file1.txt"), "hello\n");
  await api.handle("pause", ui.ctx);
  await api.report("call", { batchId: first.id, assignmentId: first.assignments[0].id, status: "passed", summary: "Created file" }, undefined, undefined, ui.ctx);
  assert.equal((await loadState(root)).paused, true);
  await writeFile(path.join(root, "file1.txt"), "user edit\n");
  await api.handle("resume", ui.ctx); await api.handle("run", ui.ctx);
  const blocked = await loadState(root);
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.blockedReason ?? "", /Previously owned file changed.*file1\.txt/);
  assert.equal(blocked.milestones[0].slices[0].tasks[1].attempts, 0);
  assert.equal(await readFile(path.join(root, "file1.txt"), "utf8"), "user edit\n");
});
