import test from "node:test";
import assert from "node:assert/strict";
import { applyReview, parsePlan } from "../src/model.ts";
import { renderDashboard, safe } from "../src/tui.ts";
import { parseDuration } from "../src/cli.ts";
import { fixture, plan } from "./helpers.ts";
import { loadState } from "../src/store.ts";

test("roadmap rejects duplicate task IDs", () => { const raw = JSON.parse(plan()); raw.milestones[0].slices[0].tasks.push(raw.milestones[0].slices[0].tasks[0]); assert.throws(() => parsePlan(JSON.stringify(raw)), /Duplicate/); });
test("review rejects stale revisions, changed checks, and completed targets atomically", async t => {
  const root = await fixture(t), s = await loadState(root); s.milestones = parsePlan(plan()); s.roadmapRevision = 1;
  const base = { revision: 1, rationale: "improve", lessons: [], changes: [{ task: "M001/S01/T01", goal: "better implementation", reason: "evidence" }] };
  const original = JSON.stringify(s);
  assert.throws(() => applyReview(s, JSON.stringify({ ...base, revision: 0 }), "test"), /Stale/);
  assert.throws(() => applyReview(s, JSON.stringify({ ...base, changes: [{ ...base.changes[0], verificationCommands: [] }] }), "test"), /cannot change/);
  assert.equal(JSON.stringify(s), original);
  s.milestones[0].slices[0].tasks[0].status = "passed";
  assert.throws(() => applyReview(s, JSON.stringify(base), "test"), /unstarted/);
});
test("dashboard renders roadmap, knowledge, and activity at common terminal sizes", async t => {
  const root = await fixture(t), s = await loadState(root); s.milestones = parsePlan(plan(2));
  for (const [width, height] of [[60, 18], [120, 35]]) for (const view of ["roadmap", "knowledge", "activity"]) {
    const screen = renderDashboard(s, ["12:00 task_started"], width, height, view);
    assert.equal(screen.split("\n").length, height);
    assert.ok(screen.split("\n").every(line => line.length <= width)); assert.match(screen, /SHIP/);
  }
});
test("terminal escape sequences from user/agent content are stripped", () => { assert.equal(safe("hello\x1b[2J\x1b]52;c;c2VjcmV0\x07world"), "helloworld"); });
test("duration parser rejects zero, missing units, and overflow", () => { assert.equal(parseDuration("8h"), 28_800_000); for (const bad of ["0h", "eight", "-1m", "999999999h"]) assert.throws(() => parseDuration(bad)); });
