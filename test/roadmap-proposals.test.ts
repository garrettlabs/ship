import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture, plan } from "./helpers.ts";
import { parsePlan } from "../src/model.ts";
import { approveRoadmapProposal, rejectRoadmapProposal, stageRoadmapOperations, stageRoadmapProposal } from "../src/roadmap-proposals.ts";
import { consumeInbox, loadConfig, loadState, queueMessage, queueRoadmapEdit, saveState, statePath } from "../src/store.ts";

const draft = (id: string) => ({ id, title: `Deliver ${id}`, goal: `write ${id}.txt`, acceptance: [`${id}.txt is correct`], verificationCommands: [`test -f ${id}.txt`] });

test("proposal staging has no dispatch, approval is revisioned and rejection retains history", async t => {
  const root = await fixture(t); const initial = await loadState(root);
  const staged = stageRoadmapProposal(initial, { request: "Deliver local file", milestones: parsePlan(plan()), impactedSummary: ["Initial active scope"] });
  assert.equal(initial.milestones.length, 0);
  assert.equal(staged.pendingProposal?.targetRevision, initial.roadmapRevision);
  assert.equal(staged.pendingProposal?.approvalBoundary, "explicit");
  const rejected = rejectRoadmapProposal(staged, "Need a narrower scope");
  assert.equal(rejected.proposalHistory?.[0].reason, "Need a narrower scope");
  assert.equal(rejected.milestones.length, 0);
  const approved = approveRoadmapProposal(stageRoadmapProposal(rejected, { request: "Deliver local file", milestones: parsePlan(plan()), impactedSummary: ["Reviewed scope"] }));
  assert.equal(approved.milestones[0].slices[0].tasks[0].status, "pending");
  assert.equal(approved.roadmapRevision, initial.roadmapRevision + 1);
  assert.equal(approved.proposalHistory?.length, 2);
  assert.equal((await loadConfig(root)).limits.maxParallelTasks, 2);
});

test("operations keep passed evidence immutable, require unfinished prerequisites and preserve objective vs approach", async t => {
  const root = await fixture(t); const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 4;
  const completed = state.milestones[0].slices[0].tasks[0];
  completed.status = "passed"; completed.attempts = 1; completed.evidenceRefs = ["events.jsonl#verified-1"];
  const staged = stageRoadmapOperations(state, { request: "Add integration work", impactedSummary: ["One additional local task"], operations: [
    { type: "add-task", slice: "M001/S01", task: { ...draft("T02"), dependencies: ["T01"] } },
    { type: "revise-task", task: "M001/S01/T02", objective: "deliver the checked artifact", goal: "write it using a local file" },
  ] });
  const approved = approveRoadmapProposal(staged);
  assert.deepEqual(approved.milestones[0].slices[0].tasks[0].evidenceRefs, completed.evidenceRefs);
  assert.equal(approved.milestones[0].slices[0].tasks[1].objective, "deliver the checked artifact");
  assert.equal(approved.milestones[0].slices[0].tasks[1].goal, "write it using a local file");
  assert.throws(() => stageRoadmapOperations(approved, { request: "Alter history", impactedSummary: [], operations: [{ type: "set-status", target: "M001/S01/T01", status: "cancelled" }] }), /started/);
  const candidate = structuredClone(approved.milestones);
  candidate[0].slices[0].tasks[1].dependencies = [];
  candidate[0].slices[0].tasks[0].status = "pending";
  assert.throws(() => stageRoadmapProposal(approved, { request: "Erase proof", impactedSummary: [], milestones: candidate }), /passed evidence/);
});

test("split retains tombstone and dependent unfinished prerequisite; active attempts defer approval", async t => {
  const root = await fixture(t); const state = await loadState(root); state.milestones = parsePlan(plan());
  const split = stageRoadmapOperations(state, { request: "Split bounded work", impactedSummary: [], operations: [
    { type: "split-task", task: "M001/S01/T01", replacements: [draft("T02"), { ...draft("T03"), dependencies: ["T02"] }] },
  ] });
  assert.equal(split.pendingProposal?.milestones[0].slices[0].tasks[0].status, "superseded");
  const active = { ...split, activeAttempt: { id: "busy", key: "M001/S01/T01", baseHead: "head", stage: "executing" as const, commands: [], revision: 0 } };
  assert.throws(() => approveRoadmapProposal(active), /active work/);
  const approved = approveRoadmapProposal(split);
  assert.equal(approved.milestones[0].slices[0].tasks.length, 3);
  assert.throws(() => stageRoadmapOperations(approved, { request: "Drop prerequisite", impactedSummary: [], operations: [
    { type: "revise-task", task: "M001/S01/T03", dependencies: [] },
  ] }), /unfinished prerequisite/);
});

test("split rewires dependents only to all real successor prerequisites", async t => {
  const root = await fixture(t); const state = await loadState(root); state.milestones = parsePlan(plan());
  const dependent = stageRoadmapOperations(state, { request: "Add consumer", impactedSummary: [], operations: [
    { type: "add-task", slice: "M001/S01", task: { ...draft("T04"), dependencies: ["T01"] } },
  ] });
  const current = approveRoadmapProposal(dependent);
  const proposed = stageRoadmapOperations(current, { request: "Split and rewire", impactedSummary: [], operations: [
    { type: "split-task", task: "M001/S01/T01", replacements: [draft("T02"), draft("T03")] },
    { type: "revise-task", task: "M001/S01/T04", dependencies: ["T02", "T03"] },
  ] });
  const accepted = approveRoadmapProposal(proposed);
  assert.deepEqual(accepted.milestones[0].slices[0].tasks[0].supersededBy, ["M001/S01/T02", "M001/S01/T03"]);
  assert.deepEqual(accepted.milestones[0].slices[0].tasks[1].dependencies, ["T02", "T03"]);
  assert.throws(() => stageRoadmapOperations(current, { request: "Unsafe split", impactedSummary: [], operations: [
    { type: "split-task", task: "M001/S01/T01", replacements: [draft("T02"), draft("T03")] },
    { type: "revise-task", task: "M001/S01/T04", dependencies: ["T02"] },
  ] }), /unfinished prerequisite/);
});

test("revision planning intent survives reload without dispatch and autonomy defaults supervised", async t => {
  const root = await fixture(t); const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 3; state.phase = "planning";
  state.nativePlanning = { id: "plan-3", sessionId: "session-1", attempts: 0, request: "Improve existing file", intent: "change", targetRevision: 3 };
  await saveState(root, state);
  const recovered = await loadState(root);
  assert.equal(recovered.nativePlanning?.request, "Improve existing file");
  assert.equal(recovered.nativePlanning?.targetRevision, 3);
  assert.equal(recovered.autonomy, "supervised");
  assert.equal(recovered.dispatches, 0);
  recovered.nativePlanning!.targetRevision = 2;
  await saveState(root, recovered);
  await assert.rejects(loadState(root), /Invalid persisted native state: planning assignment/);
});

test("inbox accepts independent same-base edits, records conflicts and captures ideas durably", async t => {
  const root = await fixture(t); const state = await loadState(root); state.milestones = parsePlan(plan());
  state.milestones[0].slices[0].tasks.push({ ...state.milestones[0].slices[0].tasks[0], id: "T02", status: "pending" });
  await saveState(root, state);
  const base = state.roadmapRevision;
  await queueRoadmapEdit(root, { type: "change", task: "M001/S01/T01", goal: "first goal", revision: base });
  await queueRoadmapEdit(root, { type: "change", task: "M001/S01/T02", goal: "second goal", revision: base });
  await queueRoadmapEdit(root, { type: "change", task: "M001/S01/T01", goal: "conflicting goal", revision: base });
  await queueMessage(root, "capture", "A possible future idea, not approved work");
  await consumeInbox(root, state);
  assert.equal(state.roadmapRevision, base + 2);
  assert.equal(state.rejectedEdits?.length, 1);
  assert.match(state.rejectedEdits![0].reason, /Conflicting/);
  assert.equal(state.phase, "idle");
  assert.equal(state.knowledge?.[0].kind, "capture");
  assert.equal(state.milestones[0].slices[0].tasks[0].goal, "first goal");
  assert.equal(state.milestones[0].slices[0].tasks[1].goal, "second goal");
  await consumeInbox(root, await loadState(root));
  assert.equal((await loadState(root)).knowledge?.length, 1);
  assert.equal(JSON.parse(await readFile(statePath(root), "utf8")).schemaVersion, 2);
  assert.match(await readFile(path.join(root, ".ship", "KNOWLEDGE.md"), "utf8"), /not approved work/);
});
