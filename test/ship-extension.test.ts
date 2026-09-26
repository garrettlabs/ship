import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import ship, { createShipExtension } from "../extensions/ship.ts";
import { fixture, plan } from "./helpers.ts";
import { parsePlan } from "../src/model.ts";
import { loadState, saveState } from "../src/store.ts";

function command(extension = ship) {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  extension({ registerCommand(name: string, options: { handler: typeof handler }) {
    assert.equal(name, "ship");
    handler = options.handler;
  } } as unknown as ExtensionAPI);
  assert.ok(handler);
  return handler;
}

function context(cwd: string) {
  const notices: { message: string; type?: string }[] = [];
  const prompts: string[] = [];
  let selected: string | undefined;
  let confirmed = true;
  let hasUI = true;
  const ctx = {
    cwd,
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

test("/ship pause and resume queue real CLI controls without changing state immediately", async t => {
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
  ui.select("M001/S01"); ui.prompts.push("New task", "Create file", "File exists", "test -f file");
  await handle("add", ui.ctx);
  ui.select("M001/S01/T01"); ui.prompts.push("Changed goal");
  await handle("change", ui.ctx);
  const queued = await inbox(root);
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map(({ type, revision }) => [type, revision]).sort(), [["add", 3], ["change", 3]]);
  assert.ok(queued.some(message => message.type === "add" && message.slice === "M001/S01" && message.title === "New task" && message.goal === "Create file" && message.acceptance === "File exists" && message.check === "test -f file"));
  assert.ok(queued.some(message => message.type === "change" && message.task === "M001/S01/T01" && message.goal === "Changed goal"));
  assert.equal((await loadState(root)).roadmapRevision, 3);
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].goal, "create file1.txt");
  assert.ok(ui.notices.every(notice => /queued.*not applied yet/.test(notice.message)));
});

test("/ship run confirms before detaching; cancellation and missing UI never start a worker", async t => {
  const root = await fixture(t), calls: string[][] = [];
  const handle = command(createShipExtension(async (_cwd, argv) => { calls.push(argv); return { stdout: "Controller launched (PID 12)", stderr: "" }; }));
  const ui = context(root);
  ui.confirm(false); await handle("run", ui.ctx); assert.deepEqual(calls, []);
  ui.confirm(true); ui.ui(false); await handle("run", ui.ctx); assert.deepEqual(calls, []);
  assert.match(ui.notices.at(-1)?.message ?? "", /requires an interactive UI/);
  ui.ui(true); await handle("run", ui.ctx);
  assert.deepEqual(calls, [["run", "--detach"]]);
  assert.match(ui.notices.at(-1)?.message ?? "", /Controller launched/);
});

test("/ship cancelled edits and CLI failures do not claim a queued change", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 2; await saveState(root, state);
  const ui = context(root), handle = command();
  ui.confirm(false); ui.prompts.push("Improved goal"); await handle("change", ui.ctx);
  assert.deepEqual(await inbox(root), []);
  ui.confirm(true);
  ui.prompts.push("Another goal");
  const originalConfirm = ui.ctx.ui.confirm;
  ui.ctx.ui.confirm = async () => { const updated = await loadState(root); updated.roadmapRevision = 3; await saveState(root, updated); return true; };
  await handle("change", ui.ctx);
  ui.ctx.ui.confirm = originalConfirm;
  assert.deepEqual(await inbox(root), []);
  assert.match(ui.notices.at(-1)?.message ?? "", /failed:.*Stale roadmap revision/);
  assert.equal(ui.notices.at(-1)?.type, "error");
});
