import test from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../src/model.ts";
import { reconcileRunTarget, resolveRunTarget, targetContains, targetProgress } from "../src/run-target.ts";
import { atomicJson, loadState, saveState, statePath } from "../src/store.ts";
import { fixture, plan } from "./helpers.ts";

test("default milestone freezes one boundary; explicit future milestone freezes the prefix", async t => {
  const root = await fixture(t);
  const state = await loadState(root);
  state.milestones = parsePlan(plan(3)); state.roadmapRevision = 2;
  const next = resolveRunTarget(state);
  assert.deepEqual(next.keys, ["M001/S01/T01"]);
  assert.equal(targetContains(next, "M002/S01/T01"), false);
  const future = resolveRunTarget(state, { scope: "milestone", id: "M002" });
  assert.deepEqual(future.keys, ["M001/S01/T01", "M002/S01/T01"]);
  assert.equal(targetContains(future, "M003/S01/T01"), false);
  state.milestones[0].slices[0].tasks[0].status = "passed";
  assert.deepEqual(targetProgress(state, future).remaining, ["M002/S01/T01"]);
  assert.deepEqual(resolveRunTarget(state).keys, ["M001/S01/T01", "M002/S01/T01"]); // New selection advances beyond completed work.
  state.milestones[1].slices[0].tasks[0].status = "passed";
  assert.equal(targetProgress(state, future).complete, true);
  assert.deepEqual(resolveRunTarget(state).keys, ["M001/S01/T01", "M002/S01/T01", "M003/S01/T01"]);
});

test("slice/task selectors use approved IDs and enforce external prerequisites without widening", async t => {
  const root = await fixture(t);
  const state = await loadState(root);
  const source = JSON.parse(plan(2));
  source.milestones[0].slices[0].tasks.push({ ...source.milestones[0].slices[0].tasks[0], id: "T02", dependencies: ["T01"] });
  state.milestones = parsePlan(JSON.stringify(source));
  assert.deepEqual(resolveRunTarget(state, { scope: "task" }).keys, ["M001/S01/T01"]);
  assert.deepEqual(resolveRunTarget(state, { scope: "slice" }).keys, ["M001/S01/T01", "M001/S01/T02"]);
  assert.deepEqual(resolveRunTarget(state, { scope: "milestone" }).keys, ["M001/S01/T01", "M001/S01/T02"]);
  assert.deepEqual(resolveRunTarget(state, { scope: "task", id: "M001/S01/T02" }).keys, ["M001/S01/T02"]);
  assert.deepEqual(resolveRunTarget(state, { scope: "slice", id: "M001/S01" }).keys, ["M001/S01/T01", "M001/S01/T02"]);
  assert.deepEqual(resolveRunTarget(state, { scope: "all" }).keys, ["M001/S01/T01", "M001/S01/T02", "M002/S01/T01"]);
  assert.throws(() => resolveRunTarget(state, { scope: "task", id: "T01" }), /ambiguous/);
  assert.throws(() => resolveRunTarget(state, { scope: "task", id: "T99" }), /unknown/);
  const selected = resolveRunTarget(state, { scope: "task", id: "M001/S01/T02" });
  state.milestones[0].slices[0].tasks[0].status = "passed";
  assert.deepEqual(targetProgress(state, selected).remaining, ["M001/S01/T02"]);
});

test("persisted schema-2 targets round-trip, legacy read-only loads do not select, revisions fail closed", async t => {
  const root = await fixture(t);
  const state = await loadState(root);
  state.milestones = parsePlan(plan(2)); state.roadmapRevision = 1;
  await saveState(root, state);
  assert.equal((await loadState(root, { readOnly: true })).runTarget, undefined);
  const selected = resolveRunTarget(state);
  state.runTarget = selected;
  await saveState(root, state);
  assert.deepEqual((await loadState(root)).runTarget, selected);
  state.roadmapRevision++;
  assert.match(targetProgress(state, selected).invalid ?? "", /revision changed/);
  const malformed = { ...state, runTarget: { scope: "task", id: "M001/S01/T01", revision: 1, keys: ["M001/S01/T01", "M001/S01/T01"] } };
  await atomicJson(statePath(root), malformed);
  await assert.rejects(loadState(root), /Invalid persisted native state: run target/);
});

test("new milestone inserted before an explicit endpoint cannot silently widen the frozen prefix", async t => {
  const root = await fixture(t);
  const state = await loadState(root);
  state.milestones = parsePlan(plan(3));
  const target = resolveRunTarget(state, { scope: "milestone", id: "M003" });
  const introduced = structuredClone(state.milestones[2]);
  introduced.id = "M004";
  state.milestones.splice(2, 0, introduced);
  state.roadmapRevision++;
  const preserved = reconcileRunTarget(state, target);
  assert.deepEqual(preserved, target);
  assert.equal(targetContains(preserved, "M004/S01/T01"), false);
  assert.match(targetProgress(state, preserved).invalid ?? "", /revision changed/);
});
