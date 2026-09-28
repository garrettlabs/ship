import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, plan } from "./helpers.ts";
import { parsePlan } from "../src/model.ts";
import { approveNativeProposal, recoverNativeRun, reportNativeOutcome, startNativeRun, submitNativePlan } from "../src/native-execution.ts";
import { stageRoadmapProposal } from "../src/roadmap-proposals.ts";
import { discoverRepoChecks } from "../src/verification.ts";
import { loadState, saveState } from "../src/store.ts";

async function roadmap(t: Parameters<typeof fixture>[0], count = 3) {
  const root = await fixture(t);
  const state = await loadState(root);
  const raw = JSON.parse(plan(count));
  for (const [index, milestone] of raw.milestones.entries()) for (const slice of milestone.slices) for (const task of slice.tasks) {
    task.goal = `Produce file${index + 1}.txt`;
    task.verificationCommands = [`node -e "require('fs').readFileSync('file${index + 1}.txt','utf8').includes('hello')||process.exit(1)"`];
    task.affectedFiles = [`file${index + 1}.txt`];
    task.uncertainty = "LOW";
    task.profile = { complexity: 2, uncertainty: 1, risk: 1, traits: [], rationale: ["Independent local file"] };
  }
  state.milestones = parsePlan(JSON.stringify(raw)); state.roadmapRevision = 1;
  await saveState(root, state);
  return root;
}

async function finish(root: string) {
  const batch = (await loadState(root)).nativeBatch!;
  let response = "";
  for (const assignment of batch.assignments) {
    const index = Number(assignment.key.slice(2, 4));
    await writeFile(path.join(root, `file${index}.txt`), "hello\n");
    response = await reportNativeOutcome(root, "target-session", { batchId: batch.id, assignmentId: assignment.id,
      status: "passed", summary: "Wrote and verified selected output" });
  }
  return response;
}

test("legacy state selects next milestone once, persists it, verifies, and never auto-dispatches the next", async t => {
  const root = await roadmap(t);
  assert.equal((await loadState(root, { readOnly: true })).runTarget, undefined);
  await startNativeRun(root, "target-session");
  assert.deepEqual((await loadState(root)).runTarget?.keys, ["M001/S01/T01"]);
  const response = await finish(root);
  assert.match(response, /target complete/);
  let state = await loadState(root);
  assert.equal(state.phase, "complete");
  assert.equal(state.nativeBatch, undefined);
  assert.equal(state.milestones[1].slices[0].tasks[0].attempts, 0);
  await startNativeRun(root, "target-session");
  state = await loadState(root);
  assert.deepEqual(state.nativeBatch?.assignments.map(item => item.key), ["M002/S01/T01"]);
  assert.deepEqual(state.runTarget?.keys, ["M001/S01/T01", "M002/S01/T01"]);
});

test("explicit task does not dispatch an external prerequisite or unrelated ready milestone", async t => {
  const root = await roadmap(t);
  const state = await loadState(root);
  state.milestones[0].slices[0].tasks[0].dependencies = ["M002/S01/T01"];
  await saveState(root, state);
  const response = await startNativeRun(root, "target-session", undefined, { scope: "task", id: "M001/S01/T01" });
  assert.match(response, /unresolved prerequisites/);
  const stopped = await loadState(root);
  assert.equal(stopped.phase, "blocked");
  assert.equal(stopped.nativeBatch, undefined);
  assert.equal(stopped.milestones[1].slices[0].tasks[0].attempts, 0);
  assert.equal(stopped.runTarget?.id, "M001/S01/T01");
  assert.match(await recoverNativeRun(root, "target-session"), /unresolved prerequisites/);
  const resumed = await loadState(root);
  assert.equal(resumed.runTarget?.id, "M001/S01/T01");
  assert.equal(resumed.milestones[1].slices[0].tasks[0].attempts, 0);
});

test("future milestone prefix stops before later scope and rejects target changes inside running batch", async t => {
  const root = await roadmap(t);
  await startNativeRun(root, "target-session", undefined, { scope: "milestone", id: "M002" });
  await assert.rejects(startNativeRun(root, "target-session", undefined, { scope: "all" }), /Cannot change run target/);
  const result = await finish(root);
  assert.match(result, /target complete/);
  const state = await loadState(root);
  assert.deepEqual(state.runTarget?.keys, ["M001/S01/T01", "M002/S01/T01"]);
  assert.equal(state.milestones[2].slices[0].tasks[0].attempts, 0);
});

test("failed selected work repairs without dispatching later ready work", async t => {
  const root = await roadmap(t);
  await startNativeRun(root, "target-session", undefined, { scope: "task", id: "M001/S01/T01" });
  const batch = (await loadState(root)).nativeBatch!;
  const response = await reportNativeOutcome(root, "target-session", { batchId: batch.id,
    assignmentId: batch.assignments[0].id, status: "failed", summary: "Repair required" });
  assert.match(response, /M001\/S01\/T01/);
  const repaired = await loadState(root);
  assert.deepEqual(repaired.nativeBatch?.assignments.map(item => item.key), ["M001/S01/T01"]);
  assert.equal(repaired.milestones[1].slices[0].tasks[0].attempts, 0);
  assert.match(await finish(root), /target complete/);
});

test("approval-only resolves pending target, and changed roadmap revision blocks instead of widening", async t => {
  const root = await roadmap(t, 2);
  const state = await loadState(root);
  const staged = stageRoadmapProposal(state, { request: "Approve selected work", sessionId: "target-session",
    milestones: structuredClone(state.milestones), impactedSummary: ["No changed tasks"] });
  await saveState(root, staged);
  const result = await approveNativeProposal(root, "target-session", false, undefined,
    JSON.stringify(staged.pendingProposal), { scope: "slice", id: "M002/S01" });
  assert.match(result, /no assignments dispatched/);
  const approved = await loadState(root);
  assert.deepEqual(approved.runTarget?.keys, ["M002/S01/T01"]);
  assert.equal(approved.nativeBatch, undefined);
  approved.roadmapRevision++;
  await saveState(root, approved);
  assert.match(await startNativeRun(root, "target-session"), /revision changed/);
  assert.equal((await loadState(root)).nativeBatch, undefined);
});

test("approved unrelated revisions retain scope; in-scope additions extend only the selected milestone", async t => {
  const root = await roadmap(t);
  let state = await loadState(root);
  state.runTarget = { scope: "milestone", id: "M001", revision: state.roadmapRevision, keys: ["M001/S01/T01"] };
  await saveState(root, state);
  const unrelated = structuredClone(state.milestones);
  unrelated[2].slices[0].tasks.push({ ...unrelated[2].slices[0].tasks[0], id: "T02", attempts: 0 });
  let staged = stageRoadmapProposal(state, { request: "Extend later milestone", sessionId: "target-session",
    milestones: unrelated, impactedSummary: ["Later work"] });
  await saveState(root, staged);
  await approveNativeProposal(root, "target-session", false, undefined, JSON.stringify(staged.pendingProposal));
  state = await loadState(root);
  assert.deepEqual(state.runTarget?.keys, ["M001/S01/T01"]);
  assert.equal(state.runTarget?.revision, state.roadmapRevision);

  const within = structuredClone(state.milestones);
  within[0].slices[0].tasks.push({ ...within[0].slices[0].tasks[0], id: "T02", attempts: 0,
    affectedFiles: ["file1-extra.txt"] });
  staged = stageRoadmapProposal(state, { request: "Repair first milestone", sessionId: "target-session",
    milestones: within, impactedSummary: ["Additional selected work"] });
  await saveState(root, staged);
  await approveNativeProposal(root, "target-session", false, undefined, JSON.stringify(staged.pendingProposal));
  state = await loadState(root);
  assert.deepEqual(state.runTarget?.keys, ["M001/S01/T01", "M001/S01/T02"]);
  assert.equal(state.runTarget?.revision, state.roadmapRevision);
  await startNativeRun(root, "target-session");
  assert.ok((await loadState(root)).nativeBatch?.assignments.every(entry => entry.key.startsWith("M001/")));
});

test("approved removal of the selected endpoint blocks rather than selecting another milestone", async t => {
  const root = await roadmap(t);
  const state = await loadState(root);
  state.runTarget = { scope: "milestone", id: "M001", revision: state.roadmapRevision, keys: ["M001/S01/T01"] };
  const staged = stageRoadmapProposal(state, { request: "Remove first milestone", sessionId: "target-session",
    milestones: state.milestones.slice(1), impactedSummary: ["Selected milestone removed"] });
  await saveState(root, staged);
  await approveNativeProposal(root, "target-session", false, undefined, JSON.stringify(staged.pendingProposal));
  assert.match(await startNativeRun(root, "target-session"), /revision changed/);
  assert.equal((await loadState(root)).nativeBatch, undefined);
});

test("first YOLO plan retains unresolved milestone intent and never assigns its second milestone", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { "test:unit": "node -e \"require('fs').readFileSync('file1.txt','utf8').includes('hello')||process.exit(1)\"" } }));
  const state = await loadState(root);
  state.autonomy = "yolo"; state.autonomySessionId = "target-session";
  await saveState(root, state);
  await startNativeRun(root, "target-session");
  assert.deepEqual((await loadState(root)).runTarget?.keys, []);
  const planning = (await loadState(root)).nativePlanning!;
  const raw = JSON.parse(plan(2));
  for (const [index, milestone] of raw.milestones.entries()) for (const slice of milestone.slices) for (const task of slice.tasks) {
    task.verificationCommands = [];
    task.uncertainty = "LOW";
    task.profile = { complexity: 2, uncertainty: 1, risk: 1, traits: [], rationale: ["Independent local file"] };
    task.affectedFiles = [`file${index + 1}.txt`];
    task.affectedDomains = [`output-${index + 1}`];
  }
  await submitNativePlan(root, "target-session", planning.id, JSON.stringify(raw));
  const approved = await loadState(root);
  assert.equal(approved.pendingProposal, undefined);
  assert.deepEqual(approved.runTarget?.keys, ["M001/S01/T01"]);
  assert.deepEqual(approved.nativeBatch?.assignments.map(entry => entry.key), ["M001/S01/T01"]);
  assert.equal(approved.milestones[1].slices[0].tasks[0].attempts, 0);
});

test("last bounded task still runs global integration checks before project completion", async t => {
  const root = await roadmap(t, 1);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    "test:integration": "node -e \"require('fs').readFileSync('integration.txt','utf8').includes('ready')||process.exit(1)\"",
  } }));
  const state = await loadState(root);
  state.repoChecks = await discoverRepoChecks(root);
  await saveState(root, state);
  await startNativeRun(root, "target-session");
  assert.match(await finish(root), /Integration check.*failed/);
  const stopped = await loadState(root);
  assert.equal(stopped.phase, "blocked");
  assert.equal(stopped.milestones[0].slices[0].tasks[0].status, "passed");
});
