import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Controller } from "../src/controller.ts";
import { applyReview, parsePlan, tasks, validatePlan } from "../src/model.ts";
import { applyWorkProposal, parseWorkProposal, invalidateWorkProposals, describeRequest, validateWorkRequests } from "../src/work.ts";
import { atomicJson, configPath, consumeInbox, loadConfig, loadState, queueMessage, queueWorkDecision, saveState, shipDir } from "../src/store.ts";
import { main } from "../src/cli.ts";
import { renderDashboard } from "../src/tui.ts";
import type { Addition, AdditionProposal, NewTask, ShipState, WorkRequest, WorkProposal } from "../src/types.ts";
import { fixture, plan, report, ScriptWorker, write } from "./helpers.ts";
import { git } from "../src/git.ts";

const task = (id = "T02", file = "extra.txt"): NewTask => ({ id, title: `Create ${file}`, goal: `Create ${file} with hello`, acceptance: [`${file} contains hello`], verificationCommands: [`grep -q '^hello$' ${file}`] });
const addTask = (): Addition => ({ type: "ADD_TASK", parent: "M001/S01", after: "T01", task: task() });
const addSlice = (): Addition => ({ type: "ADD_SLICE", parent: "M001", after: "S01", slice: { id: "S02", title: "Extra capability", tasks: [task("T01")] } });
const addMilestone = (id = "M002", after = "M001"): Addition => ({ type: "ADD_MILESTONE", after, milestone: { id, title: "Extra outcome", outcome: "Extra feature delivered", slices: [{ id: "S01", title: "Extra capability", tasks: [task("T01")] }] } });
const proposed = (patch: Addition = addTask(), revision = 1, requestId = "W0001") => ({ ok: true, text: JSON.stringify({ requestId, revision, rationale: "Smallest useful scope for the user's explicit request", patch }) });
function request(): WorkRequest { return { id: "W0001", text: "Create an extra text file", source: "user", inboxId: "test.json", createdAt: new Date().toISOString(), status: "queued", attempts: 0 }; }
async function state(t: Parameters<typeof fixture>[0]): Promise<ShipState> { const s = await loadState(await fixture(t)); s.milestones = parsePlan(plan()); s.roadmapRevision = 1; s.workRequests = [request()]; return s; }
function parse(s: ShipState, patch = addTask()): WorkProposal {
  const result = parseWorkProposal(s, s.workRequests![0], proposed(patch, s.roadmapRevision).text);
  if ("conflict" in result) throw new Error("Unexpected conflict"); return result;
}
function attach(s: ShipState, patch = addTask()): WorkRequest { const r = s.workRequests![0]; r.proposal = parse(s, patch); r.status = "proposed"; return r; }

for (const [name, patch, key] of [["task", addTask(), "M001/S01/T02"], ["slice", addSlice(), "M001/S02/T01"], ["milestone", addMilestone(), "M002/S01/T01"]] as const) {
  test(`approved ${name} is additive, attributed, pending, and revisioned`, async t => {
    const s = await state(t), original = structuredClone(s.milestones[0].slices[0].tasks[0]);
    const r = attach(s, patch); applyWorkProposal(s, r);
    const added = tasks(s).find(x => x.key === key)!.t;
    assert.deepEqual(s.milestones[0].slices[0].tasks[0], original);
    assert.equal(added.status, "pending"); assert.equal(added.attempts, 0);
    assert.equal(added.requestedBy!.source, "user"); assert.equal(added.requestedBy!.requestId, "W0001");
    assert.equal(s.roadmapRevision, 2); assert.equal(r.appliedRevision, 2); assert.equal(r.status, "applied");
    assert.throws(() => applyWorkProposal(s, r), /pending/); assert.equal(tasks(s).length, 2);
  });
}

test("new work is classified at a safe boundary and never runs without approval", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, proposed(), write(), write("extra.txt")]);
  await queueMessage(root, "add", "Create an extra text file");
  const c = new Controller(root, worker); await c.step(); await c.step();
  assert.equal(await c.step(), "waiting"); assert.equal(await c.step(), "waiting");
  let s = await loadState(root); assert.equal(s.workRequests![0].status, "proposed"); assert.equal(tasks(s).length, 1); assert.equal(worker.calls.length, 2);
  assert.match(worker.calls[1], /work intake planner/); assert.match(worker.calls[1], /Create an extra text file/);
  await queueWorkDecision(root, "approve", "W0001");
  assert.equal(await c.run(), "complete"); s = await loadState(root);
  assert.equal(s.workRequests![0].status, "applied"); assert.equal(tasks(s).length, 2); assert.equal(s.roadmapRevision, 2);
  assert.match(worker.calls[3], /APPROVED USER REQUEST/); assert.match(worker.calls[3], /Create an extra text file/);
  assert.equal(await git(s.workspace!.path, ["rev-list", "--count", "HEAD"]), "3");
});

test("intake during execution is queued, then planned only after that task commits", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, async (_p, cwd) => {
    await queueMessage(root, "add", "Create a follow-up milestone");
    assert.equal((await loadState(root)).workRequests!.length, 0);
    await writeFile(path.join(cwd, "file1.txt"), "hello\n"); return report();
  }, proposed(addMilestone())]);
  const c = new Controller(root, worker); await c.step(); assert.equal(await c.step(), "task");
  const before = await loadState(root); assert.equal(before.milestones[0].status, "complete");
  await c.step(); assert.equal((await loadState(root)).workRequests![0].status, "proposed");
  assert.match(worker.calls[2], /"status":"passed"/); assert.equal(before.roadmapRevision, 1);
});

test("rejecting a proposal resumes original work without modifying the roadmap", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, proposed(), write()]);
  const c = new Controller(root, worker); await c.step(); await queueMessage(root, "add", "Extra file"); await c.step();
  await queueWorkDecision(root, "reject", "W0001"); assert.equal(await c.run(), "complete");
  const s = await loadState(root); assert.equal(s.roadmapRevision, 1); assert.equal(tasks(s).length, 1); assert.equal(s.workRequests![0].status, "rejected");
});

test("a completed project can accept a new milestone without rewriting completed history", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, write(), proposed(addMilestone()), write("extra.txt")]));
  assert.equal(await c.run(), "complete"); const completed = (await loadState(root)).milestones[0];
  await queueMessage(root, "add", "Extra outcome after the original project"); await c.step();
  await queueWorkDecision(root, "approve", "W0001"); assert.equal(await c.run(), "complete");
  const s = await loadState(root); assert.deepEqual(s.milestones[0], completed); assert.equal(s.milestones.length, 2);
});

test("add and approval inbox replays apply exactly once across restarts", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, proposed()]));
  await c.step(); await queueMessage(root, "add", "Extra file"); await c.step();
  await queueWorkDecision(root, "approve", "W0001"); await queueWorkDecision(root, "approve", "W0001");
  let s = await loadState(root); await consumeInbox(root, s);
  for (let i = 0; i < 3; i++) { s = await loadState(root); await consumeInbox(root, s); }
  assert.equal(s.workRequests!.length, 1); assert.equal(tasks(s).length, 2); assert.equal(s.roadmapRevision, 2);
});

test("approval waits for interrupted-attempt recovery, then revalidates placement", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, proposed(addMilestone())]));
  await c.step(); await queueMessage(root, "add", "Extra milestone"); await c.step();
  let s = await loadState(root); s.activeAttempt = { id: "interrupted", key: "M001/S01/T01", stage: "verifying", baseHead: s.workspace!.baseHead, commands: ["true"], revision: 1 };
  await saveState(root, s); await queueWorkDecision(root, "approve", "W0001");
  await consumeInbox(root, s); assert.equal(s.workRequests![0].status, "proposed"); assert.equal(s.roadmapRevision, 1);
  s = await loadState(root); delete s.activeAttempt; await saveState(root, s); await consumeInbox(root, s);
  assert.equal(s.workRequests![0].status, "applied"); assert.equal(s.roadmapRevision, 2);
});

test("pause remains in force when an approval is applied", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, proposed()]); const c = new Controller(root, worker);
  await c.step(); await queueMessage(root, "add", "Extra"); await c.step();
  await queueMessage(root, "pause"); await c.step(); await queueWorkDecision(root, "approve", "W0001");
  assert.equal(await c.step(), "paused"); const s = await loadState(root);
  assert.equal(s.workRequests![0].status, "applied"); assert.equal(tasks(s).length, 2); assert.equal(worker.calls.length, 2);
});

test("invalid proposal planning retries persist and do not block original approved work", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, { ok: true, text: "bad JSON" }, { ok: true, text: "still bad" }, write()]);
  const c = new Controller(root, worker); await c.step(); await queueMessage(root, "add", "Extra"); await c.step();
  const resumed = new Controller(root, worker); await resumed.step(); await resumed.step();
  assert.equal((await loadState(root)).workRequests![0].status, "failed");
  assert.equal(await resumed.step(), "task"); assert.equal(await resumed.step(), "waiting");
  assert.equal((await loadState(root)).workRequests![0].attempts, 2); assert.equal(worker.calls.length, 4);
});

test("interrupted work planning consumes its retry budget instead of disappearing", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, async () => { throw new Error("controller interrupted"); }, proposed()]);
  const c = new Controller(root, worker); await c.step(); await queueMessage(root, "add", "Extra");
  await assert.rejects(c.step(), /interrupted/); assert.equal((await loadState(root)).workRequests![0].status, "planning");
  await new Controller(root, worker).step(); const r = (await loadState(root)).workRequests![0];
  assert.equal(r.attempts, 2); assert.equal(r.status, "proposed");
});

test("a conflict is surfaced, cannot be approved, and never becomes product scope", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, { ok: true, text: JSON.stringify({ requestId: "W0001", revision: 1, conflict: "This conflicts with the brief's no-external-services constraint" }) }, write()]);
  const c = new Controller(root, worker); await c.step(); await queueMessage(root, "add", "Cloud service"); await c.step();
  await assert.rejects(queueWorkDecision(root, "approve", "W0001"), /pending proposal/);
  assert.equal(await c.step(), "task"); assert.equal(await c.step(), "waiting");
  assert.equal((await loadState(root)).workRequests![0].status, "conflict");
  await queueWorkDecision(root, "reject", "W0001"); assert.equal(await c.step(), "complete");
});

test("work planning obeys the existing persistent dispatch budget", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }])); await c.step();
  const cfg = await loadConfig(root); cfg.limits.maxDispatches = 1; await atomicJson(configPath(root), cfg);
  await queueMessage(root, "add", "Extra"); assert.equal(await c.step(), "blocked");
  assert.equal((await loadState(root)).workRequests![0].attempts, 0);
});

test("source-writing intake planners are stopped without accepting a proposal", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, async (_p, cwd) => { await writeFile(path.join(cwd, "bad.txt"), "unexpected"); return proposed(); }]));
  await c.step(); await queueMessage(root, "add", "Extra"); assert.equal(await c.step(), "blocked");
  const s = await loadState(root); assert.equal(s.workRequests![0].status, "failed"); assert.equal(tasks(s).length, 1);
  assert.equal(await readFile(path.join(s.workspace!.path, "bad.txt"), "utf8"), "unexpected");
});

test("proposal rejects stale revisions and exact approval mismatches", async t => {
  const s = await state(t), r = attach(s); const original = JSON.stringify(s.milestones);
  s.roadmapRevision++; assert.throws(() => applyWorkProposal(s, r), /Stale/); assert.equal(JSON.stringify(s.milestones), original);
  invalidateWorkProposals(s); assert.equal(r.status, "stale");
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, proposed()]));
  await c.step(); await queueMessage(root, "add", "Extra"); await c.step();
  await assert.rejects(queueWorkDecision(root, "approve", "W0001", "Pwrong"), /matching/);
});

test("a queued approval becomes stale if the roadmap revision changed meanwhile", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, proposed()]));
  await c.step(); await queueMessage(root, "add", "Extra"); await c.step(); await queueWorkDecision(root, "approve", "W0001");
  const s = await loadState(root); s.roadmapRevision++; await saveState(root, s); await consumeInbox(root, s);
  assert.equal(s.workRequests![0].status, "stale"); assert.equal(tasks(s).length, 1); assert.match(s.workRequests![0].error!, /Stale/);
});

test("duplicate IDs, missing parents and anchors, altered history, and arbitrary fields are rejected atomically", async t => {
  const s = await state(t); const original = JSON.stringify(s);
  const invalid: unknown[] = [
    { ...addTask(), task: task("T01") }, { ...addTask(), parent: "M999/S01" }, { ...addTask(), after: "T99" },
    { ...addTask(), task: { ...task(), status: "passed" } }, { ...addTask(), task: { ...task(), verificationCommands: [] } },
    { ...addTask(), type: "REMOVE_TASK" }, { ...addTask(), protectedChecks: [] },
  ];
  for (const patch of invalid) { assert.throws(() => parseWorkProposal(s, s.workRequests![0], proposed(patch as Addition).text)); assert.equal(JSON.stringify(s), original); }
  s.milestones[0].slices[0].tasks[0].attempts = 1;
  assert.throws(() => parse(s, { ...addTask(), after: null }), /started/);
  s.milestones[0].slices[0].tasks[0].status = "passed";
  assert.throws(() => parse(s, addTask()), /Completed slice/); assert.throws(() => parse(s, addSlice()), /Completed milestone/);
  assert.doesNotThrow(() => parse(s, addMilestone()));
});

test("only earlier serial dependencies are valid; missing, forward and cyclic references fail", async t => {
  const s = await state(t), patch = addTask(); if (patch.type !== "ADD_TASK") throw new Error();
  patch.task.dependsOn = ["M001/S01/T01"]; assert.doesNotThrow(() => parse(s, patch));
  for (const dep of ["M999/S01/T01", "M001/S01/T02", "M001/S01/T03"]) { patch.task.dependsOn = [dep]; assert.throws(() => parse(s, patch), /Dependency/); }
  const planWithCycle = parsePlan(plan(2));
  planWithCycle[0].slices[0].tasks[0].dependsOn = ["M002/S01/T01"];
  planWithCycle[1].slices[0].tasks[0].dependsOn = ["M001/S01/T01"];
  assert.throws(() => validatePlan(planWithCycle), /Dependency/);
});

test("new requested task acceptance and origin remain protected from slice reviews", async t => {
  const s = await state(t), r = attach(s); applyWorkProposal(s, r);
  const added = tasks(s)[1].t, origin = structuredClone(added.requestedBy);
  applyReview(s, JSON.stringify({ revision: 2, rationale: "refine approach", lessons: [], changes: [{ task: "M001/S01/T02", goal: "Reuse an existing writer", reason: "verified implementation" }] }), "test");
  assert.deepEqual(added.verificationCommands, task().verificationCommands); assert.deepEqual(added.requestedBy, origin);
  assert.throws(() => applyReview(s, JSON.stringify({ revision: 3, rationale: "change checks", lessons: [], changes: [{ task: "M001/S01/T02", goal: "skip work", reason: "shortcut", verificationCommands: ["true"] }] }), "test"), /cannot change/);
});

test("tampered proposal content fails state validation", async t => {
  const s = await state(t), r = attach(s); validateWorkRequests(s.workRequests);
  r.proposal!.rationale = "changed after approval inspection";
  assert.throws(() => validateWorkRequests(s.workRequests), /fingerprint/);
});

test("CLI queues additions and decisions without starting a model or changing state", async t => {
  const root = await fixture(t), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const before = await readFile(path.join(shipDir(root), "state.json"), "utf8");
  const output = execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", cli, "add", "Extra text file"], { cwd: root, encoding: "utf8" });
  assert.match(output, /queued/); assert.equal(await readFile(path.join(shipDir(root), "state.json"), "utf8"), before);
  const c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, proposed()])); await c.step(); await c.step();
  const json = execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", cli, "proposals", "W0001", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(JSON.parse(json)[0].proposal.patch.type, "ADD_TASK");
  const detail = execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", cli, "proposals", "W0001"], { cwd: root, encoding: "utf8" });
  assert.match(detail, /grep -q/); assert.match(detail, /Source: user/);
  await main(["approve", "W0001"], root); assert.equal((await loadState(root)).workRequests![0].status, "proposed");
  await assert.rejects(main(["add", " "], root), /Note/); await assert.rejects(main(["approve"], root), /Usage/);
  await assert.rejects(main(["proposals", "W9999"], root), /Unknown/);
});

test("TUI proposal view shows full wrapped details and controls at narrow and wide sizes", async t => {
  const s = await state(t), r = attach(s); assert.match(describeRequest(r).join("\n"), /Run \(JSON string\): "grep/);
  for (const [width, height] of [[50, 20], [110, 35]]) {
    const screen = renderDashboard(s, [], width, height, "requests");
    assert.equal(screen.split("\n").length, height); assert.ok(screen.split("\n").every(l => l.length <= width));
    assert.match(screen, /W0001/); assert.match(screen, /proposed/);
  }
});

test("multiple requests are planned serially against the latest approved revision", async t => {
  const root = await fixture(t), second: Addition = { type: "ADD_TASK", parent: "M001/S01", after: "T02", task: task("T03", "third.txt") };
  const worker = new ScriptWorker([{ ok: true, text: plan() }, proposed(), proposed(second, 2, "W0002"), write(), write("extra.txt"), write("third.txt")]);
  const c = new Controller(root, worker); await c.step();
  await queueMessage(root, "add", "Extra file"); await c.step();
  await queueMessage(root, "add", "A third file"); assert.equal(await c.step(), "waiting");
  assert.equal((await loadState(root)).workRequests![1].status, "queued"); assert.equal(worker.calls.length, 2);
  await queueWorkDecision(root, "approve", "W0001"); await c.step();
  const proposal = (await loadState(root)).workRequests![1].proposal!; assert.equal(proposal.revision, 2);
  await queueWorkDecision(root, "approve", "W0002"); assert.equal(await c.run(), "complete");
  const s = await loadState(root); assert.equal(s.roadmapRevision, 3); assert.equal(tasks(s).length, 3);
});

test("rejecting a queued request consumes no planning dispatch", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, write()]); const c = new Controller(root, worker);
  await c.step(); await queueMessage(root, "add", "Never plan this");
  let s = await loadState(root); await consumeInbox(root, s);
  await queueWorkDecision(root, "reject", "W0001"); assert.equal(await c.run(), "complete");
  s = await loadState(root); assert.equal(s.workRequests![0].attempts, 0); assert.equal(worker.calls.length, 2);
});

test("--once returns waiting without an unauthorized execution when approval is needed", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, proposed()]);
  await queueMessage(root, "add", "Extra");
  assert.equal(await new Controller(root, worker).run(true), "waiting");
  assert.equal(worker.calls.length, 2); assert.equal(tasks(await loadState(root))[0].t.attempts, 0);
});

test("proposal command display escapes newlines and terminal controls without concealing them", async t => {
  const s = await state(t), patch = addTask(); if (patch.type !== "ADD_TASK") throw new Error();
  patch.task.verificationCommands = ["printf hello\necho second", "printf '\x1b[2J'"];
  const r = attach(s, patch), rows = describeRequest(r).filter(x => x.includes("Run (JSON string)"));
  assert.ok(rows[0].includes("\\n")); assert.ok(!rows[0].includes("\n"));
  assert.ok(rows[1].includes("\\u001b")); assert.ok(!rows[1].includes("\x1b"));
});

test("waiting for approval polls without rewriting the authoritative snapshot", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, proposed()]));
  await c.step(); await queueMessage(root, "add", "Extra"); await c.step(); await c.step();
  const before = await readFile(path.join(shipDir(root), "state.json"), "utf8");
  assert.equal(await c.step(), "waiting"); assert.equal(await readFile(path.join(shipDir(root), "state.json"), "utf8"), before);
});
