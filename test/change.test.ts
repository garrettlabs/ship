import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Addition, ChangeOperation, NewTask, ShipState, WorkProposal, WorkRequest } from "../src/types.ts";
import { effectiveProject, fingerprint } from "../src/change.ts";
import { applyReview, parsePlan, refresh, tasks, validatePlan } from "../src/model.ts";
import { applyWorkProposal, consumeWorkMessage, describeRequest, invalidateWorkProposals, parseWorkProposal, validateWorkRequests } from "../src/work.ts";
import { consumeInbox, loadState, queueMessage, queueWorkDecision, saveState, shipDir, writeRoadmapView } from "../src/store.ts";
import { Controller } from "../src/controller.ts";
import { main } from "../src/cli.ts";
import { renderDashboard } from "../src/tui.ts";
import { git } from "../src/git.ts";
import { fixture, plan, report, ScriptWorker, write } from "./helpers.ts";

const brief = "Build a cooperative game.\nSupport 48 zombies.\nNo external services.\n";
const newTask = (id = "T03"): NewTask => ({ id, title: `Task ${id}`, goal: "Implement a feature", acceptance: ["Feature works"], verificationCommands: ["npm test"] });
const modify = (target = "M002/S01/T01", goal = "Use simpler motion"): ChangeOperation => ({ type: "MODIFY_TASK", target, updates: { goal }, reason: "User requested simplification" });
const cancel = (target = "M002/S01/T01"): ChangeOperation => ({ type: "CANCEL_TASK", target, reason: "Drop optional work" });
const req = (before = "Support 48 zombies.", after: string | null = "Support 24 zombies."): ChangeOperation => ({ type: "CHANGE_REQUIREMENT", before, after, reason: "Explicit scale change" });
function request(id = "W0001"): WorkRequest { return { id, kind: "change", text: "Simplify the project", source: "user", inboxId: `${id}.json`, createdAt: "2026-09-25T00:00:00Z", status: "queued", attempts: 0 }; }
function state(): ShipState {
  const s: ShipState = { schemaVersion: 2, projectName: "Test", phase: "idle", roadmapRevision: 1, milestones: parsePlan(plan(3)), paused: false, lastProgressAt: "now", createdAt: "now", updatedAt: "now", workRequests: [request()] };
  for (const m of s.milestones) {
    m.slices[0].tasks.push({ ...newTask("T02"), status: "pending", attempts: 0 });
    m.slices.push({ id: "S02", title: "More", status: "pending", tasks: [{ ...newTask("T01"), status: "pending", attempts: 0 }] });
  }
  return s;
}
function response(ops: ChangeOperation[], revision = 1, requestId = "W0001") { return { ok: true, text: JSON.stringify({ requestId, revision, rationale: "Apply the user's requested change", patch: { type: "CHANGE", operations: ops } }) }; }
function attach(s: ShipState, ops: ChangeOperation[], project = brief, r = s.workRequests![0]): WorkProposal {
  const p = parseWorkProposal(s, r, response(ops, s.roadmapRevision, r.id).text, project);
  if ("conflict" in p) throw new Error(p.conflict);
  r.proposal = p; r.status = "proposed"; return p;
}
function apply(s: ShipState, ops: ChangeOperation[], project = brief) { const p = attach(s, ops, project); applyWorkProposal(s, s.workRequests![0], project); return p; }

for (const [name, op] of [
  ["task", modify()],
  ["slice", { type: "MODIFY_SLICE", target: "M002/S01", updates: { title: "Smaller slice" }, reason: "Simplify" }],
  ["milestone", { type: "MODIFY_MILESTONE", target: "M002", updates: { title: "Simpler milestone", outcome: "Useful small release" }, reason: "Simplify" }],
] as [string, ChangeOperation][]) {
  test(`change ${name} is proposed before approval, attributed, and preserves existing IDs/checks`, () => {
    const s = state(), before = structuredClone(s.milestones); const p = attach(s, [op]);
    assert.deepEqual(s.milestones, before); assert.ok(p.preview?.some(x => x.includes("before:")));
    applyWorkProposal(s, s.workRequests![0], brief);
    assert.equal(s.roadmapRevision, 2); assert.equal(s.workRequests![0].appliedRevision, 2);
    assert.deepEqual(tasks(s).map(x => [x.key, x.t.verificationCommands, x.t.attempts]), tasks({ ...s, milestones: before }).map(x => [x.key, x.t.verificationCommands, x.t.attempts]));
    assert.equal(s.workRequests![0].status, "applied"); assert.doesNotThrow(() => validateWorkRequests(s.workRequests));
  });
}
test("pending acceptance changes display exact old/new commands, including controls, before approval", () => {
  const s = state(); attach(s, [{ type: "MODIFY_TASK", target: "M002/S01/T01", updates: { acceptance: ["24 zombies work"], verificationCommands: ["test-command\nprintf '\\n'\u001b[2J"] }, reason: "Lower the target by explicit user request" }]);
  const display = describeRequest(s.workRequests![0]).join("\n");
  assert.match(display, /verificationCommands before:/); assert.match(display, /verificationCommands after:/);
  assert.match(display, /\\n/); assert.match(display, /\\u001b/); assert.match(display, /WARNING/);
  applyWorkProposal(s, s.workRequests![0], brief); assert.deepEqual(s.milestones[1].slices[0].tasks[0].acceptance, ["24 zombies work"]);
});
for (const [type, target, after, expected] of [
  ["MOVE_TASK", "M002/S01/T01", "T02", ["T02", "T01"]],
  ["MOVE_SLICE", "M002/S01", "S02", ["S02", "S01"]],
  ["MOVE_MILESTONE", "M001", "M003", ["M002", "M003", "M001"]],
] as const) {
  test(`${type} reprioritizes siblings without renaming keys`, () => {
    const s = state(); apply(s, [{ type, target, after, reason: "Prioritize useful work" }]);
    const items = type === "MOVE_TASK" ? s.milestones[1].slices[0].tasks : type === "MOVE_SLICE" ? s.milestones[1].slices : s.milestones;
    assert.deepEqual(items.map(x => x.id), expected); assert.equal(tasks(s).length, 9);
  });
}
for (const [type, target, count] of [["CANCEL_TASK", "M002/S01/T01", 1], ["CANCEL_SLICE", "M002/S01", 2], ["CANCEL_MILESTONE", "M002", 3]] as const) {
  test(`${type} leaves auditable tombstones, not passed work`, () => {
    const s = state(), before = tasks(s).map(x => [x.key, x.t.verificationCommands]); apply(s, [{ type, target, reason: "Remove from scope" }]);
    assert.equal(tasks(s).filter(x => x.t.status === "cancelled").length, count); assert.equal(tasks(s).filter(x => x.t.status === "passed").length, 0);
    assert.deepEqual(tasks(s).map(x => [x.key, x.t.verificationCommands]), before);
    for (const t of tasks(s).filter(x => x.t.status === "cancelled")) assert.equal(t.t.cancellation!.origin.requestId, "W0001");
  });
}
test("cancelled IDs cannot be reused or reopened by additions or changes", () => {
  const s = state(); apply(s, [cancel()]);
  s.workRequests = [request("W0002")]; assert.throws(() => attach(s, [modify()]), /never-started/);
  const r = { ...request("W0003"), kind: "add" as const };
  const p: Addition = { type: "ADD_TASK", parent: "M002/S01", after: "T01", task: newTask("T01") };
  assert.throws(() => parseWorkProposal(s, r, JSON.stringify({ requestId: r.id, revision: 2, rationale: "new", patch: p })), /Duplicate/);
});
test("split milestone uses one atomic add/add/cancel patch with fresh IDs", () => {
  const s = state(); const m = (id: string, after: string): ChangeOperation => ({ type: "ADD_MILESTONE", after, milestone: { id, title: id, outcome: "Smaller outcome", slices: [{ id: "S01", title: "Slice", tasks: [newTask("T01")] }] } });
  apply(s, [m("M004", "M002"), m("M005", "M004"), { type: "CANCEL_MILESTONE", target: "M002", reason: "Split into two manageable milestones" }]);
  assert.deepEqual(s.milestones.map(x => x.id), ["M001", "M002", "M004", "M005", "M003"]); assert.equal(s.milestones[1].status, "cancelled"); assert.equal(s.roadmapRevision, 2);
});
test("invalid last operation rolls back earlier edits and requirement amendments", () => {
  const s = state(), before = JSON.stringify(s);
  assert.throws(() => attach(s, [req(), modify(), cancel("M999/S01/T01")]), /Missing/);
  assert.equal(JSON.stringify(s), before);
});
test("dependencies cannot point to cancelled prerequisites unless consumers are updated/cancelled in same patch", () => {
  const s = state(); s.milestones[1].slices[0].tasks[1].dependsOn = ["M002/S01/T01"];
  assert.throws(() => attach(s, [cancel()]), /Dependency/);
  apply(s, [cancel(), { type: "MODIFY_TASK", target: "M002/S01/T02", updates: { dependsOn: [] }, reason: "No longer depends on cancelled optional work" }]);
  assert.doesNotThrow(() => validatePlan(s.milestones));
});
test("reprioritization rejects missing, forward, self and cyclic dependency order", () => {
  const s = state(); s.milestones[1].slices[0].tasks[1].dependsOn = ["M002/S01/T01"];
  assert.throws(() => attach(s, [{ type: "MOVE_TASK", target: "M002/S01/T01", after: "T02", reason: "Earlier" }]), /Dependency/);
  for (const dep of ["M999/S01/T01", "M002/S01/T01", "M003/S01/T01"]) assert.throws(() => attach(s, [{ type: "MODIFY_TASK", target: "M002/S01/T01", updates: { dependsOn: [dep] }, reason: "dependency" }]), /Dependency/);
});
for (const status of ["passed", "failed", "running", "verifying", "blocked"] as const) {
  test(`${status} task and its parents cannot be rewritten or cancelled`, () => {
    const s = state(); s.milestones[1].slices[0].tasks[0].status = status; s.milestones[1].slices[0].tasks[0].attempts = 1; refresh(s);
    for (const op of [modify(), cancel(), { type: "CANCEL_MILESTONE", target: "M002", reason: "hide failure" } as const]) assert.throws(() => attach(s, [op]), /never-started/);
  });
}
test("moving pending work before a started task is rejected; moving later work remains allowed", () => {
  const s = state(); s.milestones[0].slices[0].tasks[0].status = "passed"; s.milestones[0].slices[0].tasks[0].attempts = 1; refresh(s);
  assert.throws(() => attach(s, [{ type: "MOVE_MILESTONE", target: "M003", after: null, reason: "priority" }]), /history/);
  assert.doesNotThrow(() => attach(s, [{ type: "MOVE_MILESTONE", target: "M003", after: "M001", reason: "priority" }]));
});
test("empty, unknown, no-op, cross-parent and runtime-field-injecting proposals are rejected", () => {
  const s = state(), invalid: unknown[][] = [[], [{ type: "RESET_ATTEMPTS", target: "M002" }], [{ ...modify(), updates: { status: "passed" } }], [{ ...modify(), updates: { verificationCommands: [] } }], [{ ...modify(), updates: { id: "T55" } }], [{ ...modify(), updates: {} }], [{ ...modify(), updates: { goal: s.milestones[1].slices[0].tasks[0].goal } }], [{ type: "MOVE_TASK", target: "M002/S01/T01", after: "M003/S01/T01", reason: "other parent" }], [{ type: "MOVE_TASK", target: "M002/S01/T01", after: "T01", reason: "self" }], [{ type: "MOVE_TASK", target: "M002/S01/T01", after: "T99", reason: "missing" }], [{ type: "ADD_TASK", parent: "M002/S01", after: "T02", task: newTask() }]];
  for (const ops of invalid) assert.throws(() => parseWorkProposal(s, s.workRequests![0], response(ops as ChangeOperation[]).text, brief));
});
test("exact requirement amendment is durable user authority with original brief preserved", () => {
  const s = state(); apply(s, [req()]); assert.equal(effectiveProject(brief, s), brief.replace("48", "24"));
  assert.equal(s.requirements![0].origin.source, "user"); assert.equal(s.requirementsBaseHash, fingerprint(brief));
  const r = request("W0002"); s.workRequests!.push(r); attach(s, [req("Support 24 zombies.", "Support 12 zombies.")], brief, r); applyWorkProposal(s, r, brief);
  assert.equal(effectiveProject(brief, s), brief.replace("48", "12")); assert.equal(s.requirements!.length, 2);
});
test("requirement removal and unrelated requirements are explicit and scoped", () => {
  const s = state(); apply(s, [req("Support 48 zombies.", null)]);
  assert.equal(effectiveProject(brief, s), "Build a cooperative game.\n\nNo external services.\n");
  const rendered = describeRequest(s.workRequests![0]).join("\n"); assert.match(rendered, /After: null/); assert.match(rendered, /do not waive/);
});
test("unknown, repeated, empty and unchanged requirement passages are rejected", () => {
  for (const [before, after, raw] of [["missing", "other", brief], ["Support 48 zombies.", "other", brief + brief], [brief, null, brief], ["Support 48 zombies.", "Support 48 zombies.", brief]] as const) {
    const s = state(); assert.throws(() => attach(s, [req(before, after)], raw));
  }
});
test("raw brief drift after amendments fails closed rather than silently rebasing", () => {
  const s = state(); apply(s, [req()]); assert.throws(() => effectiveProject(brief + "Changed", s), /Restore the original baseline/);
});
for (const drift of ["brief", "plan", "requirements", "revision"] as const) {
  test(`approval rejects stale ${drift} even without a task being dispatched`, () => {
    const s = state(); attach(s, [modify()]); let project = brief;
    if (drift === "brief") project += " Changed";
    if (drift === "plan") s.milestones[0].slices[0].tasks[0].goal = "external edit";
    if (drift === "requirements") s.requirementsBaseHash = "f".repeat(64);
    if (drift === "revision") s.roadmapRevision++;
    const before = JSON.stringify(s); assert.throws(() => applyWorkProposal(s, s.workRequests![0], project), /Stale/); assert.equal(JSON.stringify(s), before);
  });
}
test("proposal preview and context are fingerprinted; tampering fails snapshot validation", () => {
  const s = state(); attach(s, [modify()]); s.workRequests![0].proposal!.preview!.push("forged");
  assert.throws(() => validateWorkRequests(s.workRequests), /fingerprint/); assert.throws(() => applyWorkProposal(s, s.workRequests![0], brief), /pending/);
});
test("add cannot smuggle a change patch and change cannot masquerade as an addition", () => {
  const s = state(); s.workRequests![0].kind = "add"; assert.throws(() => attach(s, [modify()]));
  s.workRequests![0].kind = "change";
  assert.throws(() => parseWorkProposal(s, s.workRequests![0], JSON.stringify({ requestId: "W0001", revision: 1, rationale: "new", patch: { type: "ADD_TASK", parent: "M002/S01", after: "T02", task: newTask() } }), brief));
});
test("active attempt defers approval without mutating current work", () => {
  const s = state(); const p = attach(s, [modify()]); s.activeAttempt = { id: "attempt", key: "M001/S01/T01", stage: "verifying", baseHead: "base", commands: ["true"], revision: 1 };
  const before = JSON.stringify(s.milestones);
  assert.equal(consumeWorkMessage(s, { id: "approval", type: "approve", requestId: "W0001", proposalId: p.id, at: "now" }, "approve.json", brief), false);
  assert.equal(JSON.stringify(s.milestones), before); assert.equal(s.roadmapRevision, 1);
});

test("CLI change queues without invoking a model; common proposals display old/new values", async t => {
  const root = await fixture(t); await main(["change", "Simplify the first task"], root);
  assert.equal((await loadState(root)).dispatches, 0); const c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, response([modify("M001/S01/T01")])]));
  await c.step(); await c.step(); const s = await loadState(root);
  assert.equal(s.workRequests![0].kind, "change"); assert.match(describeRequest(s.workRequests![0]).join("\n"), /goal before/);
  await main(["proposals", "W0001"], root);
  await assert.rejects(main(["change", " "], root), /Note/);
});
test("controller waits for approval, then runs the edited task with approved change context", async t => {
  const root = await fixture(t), w = new ScriptWorker([{ ok: true, text: plan() }, response([modify("M001/S01/T01")]), write()]);
  const c = new Controller(root, w); await c.step(); await queueMessage(root, "change", "Simplify first task"); await c.step(); assert.equal(await c.run(true), "waiting");
  await queueWorkDecision(root, "approve", "W0001"); assert.equal(await c.run(), "complete");
  const s = await loadState(root); assert.equal(s.workRequests![0].status, "applied"); assert.match(w.calls[2], /APPROVED CHANGES/); assert.match(w.calls[2], /Use simpler motion/);
});
test("rejecting change leaves original work untouched and execution continues", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, response([modify("M001/S01/T01")]), write()]));
  await c.step(); const before = (await loadState(root)).milestones[0].slices[0].tasks[0].goal;
  await queueMessage(root, "change", "Simplify"); await c.step(); await queueWorkDecision(root, "reject", "W0001"); assert.equal(await c.run(), "complete");
  assert.equal((await loadState(root)).milestones[0].slices[0].tasks[0].goal, before);
});
test("approved cancellation skips execution, produces no fake successful commit, and does not review nonexistent results", async t => {
  const root = await fixture(t, true), w = new ScriptWorker([{ ok: true, text: plan() }, response([{ type: "CANCEL_MILESTONE", target: "M001", reason: "Scope dropped" }])]);
  const c = new Controller(root, w); await c.step(); await queueMessage(root, "change", "Drop the pending milestone"); await c.step(); await queueWorkDecision(root, "approve", "W0001");
  assert.equal(await c.run(), "complete"); const s = await loadState(root); assert.equal(s.milestones[0].status, "cancelled"); assert.equal(w.calls.length, 2); assert.equal(await git(s.workspace!.path, ["rev-list", "--count", "HEAD"]), "1");
});
test("mixed passed/cancelled slice reviews only real passed task results", async t => {
  const root = await fixture(t, true), raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks.push({ ...newTask("T02"), verificationCommands: ["false"] });
  const w = new ScriptWorker([{ ok: true, text: JSON.stringify(raw) }, response([cancel("M001/S01/T02")]), write(), { ok: true, text: JSON.stringify({ revision: 2, rationale: "Review actual delivery", lessons: [], changes: [] }) }]);
  const c = new Controller(root, w); await c.step(); await queueMessage(root, "change", "Drop second task"); await c.step(); await queueWorkDecision(root, "approve", "W0001");
  assert.equal(await c.run(), "complete"); assert.equal(w.calls.length, 4);
});
test("request received during execution is planned after commit, never mid-task", async t => {
  const root = await fixture(t), w = new ScriptWorker([{ ok: true, text: plan(2) }, async (_p, cwd) => { await queueMessage(root, "change", "Simplify the second milestone"); await writeFile(path.join(cwd, "file1.txt"), "hello\n"); return report(); }, response([modify()])]);
  const c = new Controller(root, w); await c.step(); await c.step(); const done = (await loadState(root)).milestones[0]; await c.step();
  assert.equal((await loadState(root)).workRequests![0].status, "proposed"); assert.deepEqual((await loadState(root)).milestones[0], done); assert.match(w.calls[2], /"status":"passed"/);
});
test("duplicate approvals and restarted inbox replay apply changes exactly once while preserving pause", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, response([modify("M001/S01/T01")])]));
  await c.step(); await queueMessage(root, "change", "Simplify"); await c.step(); await queueMessage(root, "pause"); await c.step();
  await queueWorkDecision(root, "approve", "W0001"); await queueWorkDecision(root, "approve", "W0001"); assert.equal(await c.step(), "paused");
  for (let i = 0; i < 3; i++) { const s = await loadState(root); await consumeInbox(root, s); }
  const s = await loadState(root); assert.equal(s.roadmapRevision, 2); assert.equal(s.paused, true); assert.equal(s.milestones[0].slices[0].tasks[0].changedBy!.length, 1); assert.equal(s.schemaVersion, 2);
});
test("requirement amendment feeds effective brief to execution and writes a generated view without changing PROJECT.md", async t => {
  const root = await fixture(t); const raw = await readFile(path.join(shipDir(root), "PROJECT.md"), "utf8");
  const w = new ScriptWorker([{ ok: true, text: plan() }, response([req("without external services", "without remote APIs")]), write()]);
  const c = new Controller(root, w); await c.step(); await queueMessage(root, "change", "Clarify the external service constraint"); await c.step(); await queueWorkDecision(root, "approve", "W0001"); assert.equal(await c.run(), "complete");
  const s = await loadState(root); assert.match(w.calls[2], /BRIEF:\nBuild two local files without remote APIs/); assert.equal(await readFile(path.join(shipDir(root), "PROJECT.md"), "utf8"), raw);
  assert.match(await readFile(path.join(shipDir(root), "PROJECT-EFFECTIVE.md"), "utf8"), /without remote APIs/);
  await writeFile(path.join(shipDir(root), "PROJECT.md"), raw + "drift"); assert.equal(await c.step(), "blocked"); assert.match((await loadState(root)).blockedReason!, /baseline/);
});
test("changing brief after proposal prevents queued approval from applying", async t => {
  const root = await fixture(t), w = new ScriptWorker([{ ok: true, text: plan() }, response([modify("M001/S01/T01")])]);
  const c = new Controller(root, w); await c.step(); await queueMessage(root, "change", "Simplify"); await c.step(); await queueWorkDecision(root, "approve", "W0001");
  await writeFile(path.join(shipDir(root), "PROJECT.md"), "Different brief"); assert.equal(await c.step(), "waiting");
  assert.equal((await loadState(root)).workRequests![0].status, "stale"); assert.equal(w.calls.length, 2);
});
test("change conflict waits for a decision instead of proceeding with unwanted work", async t => {
  const root = await fixture(t), w = new ScriptWorker([{ ok: true, text: plan() }, { ok: true, text: JSON.stringify({ requestId: "W0001", revision: 1, conflict: "Cannot alter failed work" }) }, write()]);
  const c = new Controller(root, w); await c.step(); await queueMessage(root, "change", "Ambiguous change"); await c.step(); assert.equal(await c.step(), "waiting");
  await queueWorkDecision(root, "reject", "W0001"); assert.equal(await c.run(), "complete");
});
test("planner retries for change requests are bounded and persist across controllers", async t => {
  const root = await fixture(t), c = new Controller(root, new ScriptWorker([{ ok: true, text: plan() }, { ok: true, text: "bad JSON" }, { ok: true, text: "bad JSON" }]));
  await c.step(); await queueMessage(root, "change", "Simplify"); await c.step(); await c.step(); await c.step();
  const next = new Controller(root, new ScriptWorker([])); assert.equal(await next.step(), "waiting"); assert.equal((await loadState(root)).workRequests![0].attempts, 2);
});
test("legacy snapshots retain addition fingerprints and upgrade on write; future schema is rejected", async t => {
  const root = await fixture(t), s = await loadState(root); s.schemaVersion = 1; delete s.requirements;
  await writeFile(path.join(shipDir(root), "state.json"), JSON.stringify(s)); assert.equal((await loadState(root)).schemaVersion, 1);
  await saveState(root, await loadState(root)); assert.equal((await loadState(root)).schemaVersion, 2);
  await writeFile(path.join(shipDir(root), "state.json"), JSON.stringify({ ...s, schemaVersion: 99 })); await assert.rejects(loadState(root), /Invalid state/);
});
test("review cannot reopen cancelled work or change its checks", () => {
  const s = state(); apply(s, [cancel()]); assert.throws(() => applyReview(s, JSON.stringify({ revision: 2, rationale: "reopen", lessons: [], changes: [{ task: "M002/S01/T01", goal: "Do it anyway", reason: "why not" }] }), "review"), /unstarted/);
});
test("TUI exposes change input and full before/after review, with cancelled work clearly marked", () => {
  const s = state(); attach(s, [modify()]); let text = renderDashboard(s, [], 100, 45, "requests");
  assert.match(text, /\[e\] change/); assert.match(text, /goal before:/); assert.match(text, /goal after:/);
  applyWorkProposal(s, s.workRequests![0], brief); s.workRequests = [request("W0002")]; apply(s, [cancel()]);
  text = renderDashboard(s, [], 100, 45); assert.match(text, /1 cancelled/); assert.match(text, /\[-\] T01/);
});
