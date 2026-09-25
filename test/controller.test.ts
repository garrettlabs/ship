import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Controller } from "../src/controller.ts";
import { atomicJson, configPath, exists, loadConfig, loadState, queueMessage, shipDir } from "../src/store.ts";
import { git } from "../src/git.ts";
import { acquireLock } from "../src/lock.ts";
import { fixture, plan, report, ScriptWorker, write } from "./helpers.ts";

test("two milestones finish with verified commits in an isolated worktree", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "user-draft.txt"), "keep me");
  const worker = new ScriptWorker([{ ok: true, text: plan(2) }, write(), write("file2.txt")]);
  assert.equal(await new Controller(root, worker).run(), "complete");
  const s = await loadState(root);
  assert.equal(s.phase, "complete"); assert.equal(s.dispatches, 3);
  assert.equal(await git(s.workspace!.path, ["rev-list", "--count", "HEAD"]), "3");
  assert.equal(await git(root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal(await exists(path.join(root, "file1.txt")), false);
  assert.equal(await readFile(path.join(root, "user-draft.txt"), "utf8"), "keep me");
  assert.equal(await git(s.workspace!.path, ["ls-files", ".ship"]), "");
});

test("failed acceptance evidence reaches a successful repair prompt", async t => {
  const root = await fixture(t);
  const worker = new ScriptWorker([{ ok: true, text: plan() }, write("file1.txt", "wrong\n"), async (prompt, cwd) => {
    assert.match(prompt, /Verification failed/); assert.match(prompt, /grep/);
    await writeFile(path.join(cwd, "file1.txt"), "hello\n"); return report("repaired");
  }]);
  assert.equal(await new Controller(root, worker).run(), "complete");
  const s = await loadState(root); assert.equal(s.milestones[0].slices[0].tasks[0].attempts, 2);
  const evidence = JSON.parse(await readFile(path.join(shipDir(root), "attempts/M001-S01-T01-a2.verification.json"), "utf8"));
  assert.equal(evidence.passed, true); assert.equal(evidence.checks[0].code, 0);
});

test("repair budget survives controller restart", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, report(), report()]);
  const c = new Controller(root, worker); await c.step(); await c.step();
  assert.equal(await new Controller(root, worker).run(), "blocked");
  await queueMessage(root, "resume");
  assert.equal(await new Controller(root, worker).run(), "blocked");
  assert.equal(worker.calls.length, 3);
});

for (const boundary of ["after_execute", "after_verify", "after_commit"] as const) {
  test(`restart at ${boundary} does not repeat accepted work or duplicate commits`, async t => {
    const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, write()]);
    const c = new Controller(root, worker, { fault(at) { if (at === boundary) throw new Error("simulated interruption"); } });
    await c.step(); await assert.rejects(c.step(), /simulated interruption/);
    assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].status, "verifying");
    assert.equal(await new Controller(root, worker).run(), "complete");
    const s = await loadState(root);
    assert.equal(worker.calls.length, 2);
    assert.equal(await git(s.workspace!.path, ["rev-list", "--count", "HEAD"]), "2");
  });
}

test("interrupted execution keeps partial work and repairs with a fresh attempt", async t => {
  const root = await fixture(t);
  const worker = new ScriptWorker([{ ok: true, text: plan() }, async (_p, cwd) => { await writeFile(path.join(cwd, "partial.txt"), "preserved"); throw new Error("worker host died"); }, async (prompt, cwd) => {
    assert.match(prompt, /interrupted/); assert.equal(await readFile(path.join(cwd, "partial.txt"), "utf8"), "preserved");
    await writeFile(path.join(cwd, "file1.txt"), "hello\n"); return report();
  }]);
  const c = new Controller(root, worker); await c.step(); await assert.rejects(c.step(), /host died/);
  assert.equal(await new Controller(root, worker).run(), "complete");
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].attempts, 2);
});

test("pause and capture during execution cannot overwrite authoritative state", async t => {
  const root = await fixture(t);
  const worker = new ScriptWorker([{ ok: true, text: plan(2) }, async (_p, cwd) => {
    await queueMessage(root, "pause"); await queueMessage(root, "capture", "Reuse the first implementation.");
    await writeFile(path.join(cwd, "file1.txt"), "hello\n"); return report();
  }, write("file2.txt")]);
  const c = new Controller(root, worker); await c.step(); assert.equal(await c.step(), "task");
  assert.equal(await c.step(), "paused"); assert.equal(await c.step(), "paused");
  const s = await loadState(root); assert.equal(s.knowledge!.length, 1); assert.equal(s.milestones[0].slices[0].tasks[0].status, "passed");
  await queueMessage(root, "resume"); assert.equal(await c.run(), "complete");
  assert.equal((await loadState(root)).knowledge!.length, 1);
});

test("second controller cannot acquire an existing lock", async t => {
  const root = await fixture(t); const release = await acquireLock(root);
  try { await assert.rejects(new Controller(root, new ScriptWorker([])).step(), /lock exists/); await queueMessage(root, "pause"); }
  finally { await release(); }
});

test("slice review consumes a capture and changes only an unstarted task approach", async t => {
  const root = await fixture(t, true);
  const noChange = { ok: true, text: JSON.stringify({ revision: 2, rationale: "approved outcomes complete", lessons: [], changes: [] }) };
  const worker = new ScriptWorker([{ ok: true, text: plan(2) }, write(), async prompt => {
    assert.match(prompt, /reuse the implementation/);
    return { ok: true, text: JSON.stringify({ revision: 1, rationale: "reuse confirmed implementation", lessons: [{ kind: "lesson", text: "The first file is available for reuse", evidence: "M001/S01/T01 result" }], changes: [{ task: "M002/S01/T01", goal: "reuse the implementation to create file2.txt", reason: "user capture" }] }) };
  }, async (prompt, cwd) => { assert.match(prompt, /reuse the implementation/); await writeFile(path.join(cwd, "file2.txt"), "hello\n"); return report(); }, noChange]);
  const c = new Controller(root, worker); await c.step(); await c.step(); await queueMessage(root, "capture", "reuse the implementation");
  assert.equal(await c.run(), "complete");
  const s = await loadState(root); assert.equal(s.roadmapRevision, 2); assert.equal(s.reviewedSlices!.length, 2);
  assert.deepEqual(s.milestones[1].slices[0].tasks[0].verificationCommands, ["grep -q '^hello$' file2.txt"]);
});

test("--once includes initial planning and one accepted task, not planning alone", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan(2) }, write()]);
  assert.equal(await new Controller(root, worker).run(true), "task");
  assert.equal(worker.calls.length, 2);
});

test("verification that changes source cannot produce an accepted commit", async t => {
  const root = await fixture(t); const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].verificationCommands = ["printf tampered > brief.md"];
  const c = new Controller(root, new ScriptWorker([{ ok: true, text: JSON.stringify(raw) }, write()]));
  assert.equal(await c.run(), "blocked"); const s = await loadState(root);
  assert.match(s.blockedReason!, /Verification changed/); assert.equal(await git(s.workspace!.path, ["rev-list", "--count", "HEAD"]), "1");
});

test("unexpected worktree edits are not swept into task commits", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }]));
  await c.step(); const s = await loadState(root); await writeFile(path.join(s.workspace!.path, "unrelated.txt"), "private work");
  assert.equal(await c.step(), "blocked");
});

test("empty acceptance commands cannot pass by omission", async t => {
  const root = await fixture(t), raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks[0].verificationCommands = [];
  const worker = new ScriptWorker([{ ok: true, text: JSON.stringify(raw) }, { ok: true, text: JSON.stringify(raw) }]);
  assert.equal(await new Controller(root, worker).run(), "blocked"); assert.equal(worker.calls.length, 2);
});

test("a persistent dispatch ceiling stops before launching another worker", async t => {
  const root = await fixture(t); const cfg = await loadConfig(root); cfg.limits.maxDispatches = 1; await atomicJson(configPath(root), cfg);
  const worker = new ScriptWorker([{ ok: true, text: plan() }]);
  assert.equal(await new Controller(root, worker).run(), "blocked"); assert.equal(worker.calls.length, 1);
});

test("corrupted verification evidence blocks commit recovery", async t => {
  const root = await fixture(t), worker = new ScriptWorker([{ ok: true, text: plan() }, write()]);
  const c = new Controller(root, worker, { fault(at) { if (at === "after_verify") throw new Error("interrupted"); } });
  await c.step(); await assert.rejects(c.step(), /interrupted/);
  const file = path.join(shipDir(root), "attempts/M001-S01-T01-a1.verification.json");
  const evidence = JSON.parse(await readFile(file, "utf8")); evidence.tree = "wrong"; await atomicJson(file, evidence);
  assert.equal(await new Controller(root, worker).step(), "blocked");
});
