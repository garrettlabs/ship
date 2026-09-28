import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acceptanceFingerprint, artifactFingerprint } from "../src/evidence.ts";
import { approveNativeHumanEvidence, confirmNativeSpecialist, reportNativeOutcome, routeNativeSpawn } from "../src/native-execution.ts";
import { parsePlan, tasks } from "../src/model.ts";
import { atomicJson, configPath, loadConfig, loadState, saveState } from "../src/store.ts";
import { fixture, plan } from "./helpers.ts";

async function setup(t: Parameters<typeof fixture>[0], type: "implementation" | "research", acceptance: string[]) {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  const entry = tasks(state)[0], task = entry.t;
  task.taskType = type; task.acceptance = acceptance; task.uncertainty = "LOW";
  task.profile = { ...task.profile, complexity: 2, risk: 1, uncertainty: 1 };
  task.verificationCommands = type === "implementation" ? ["node -e \"process.exit(0)\""] : [];
  task.status = "running"; task.attempts = 1;
  state.phase = "executing";
  state.nativeBatch = { id: "batch", sessionId: "main", revision: 1, stage: "executing", assignments: [{ id: "assignment", key: entry.key, status: "pending" }] };
  await saveState(root, state);
  const config = await loadConfig(root);
  config.limits.maxTaskAttempts = 1;
  await atomicJson(configPath(root), config);
  return { root, key: entry.key, task: tasks(await loadState(root))[0].t };
}
const outcome = { batchId: "batch", assignmentId: "assignment", status: "passed" as const, summary: "Completed actual work" };
async function confirmWorker(root: string) {
  const state = await loadState(root), task = tasks(state)[0].t;
  if (task.execution.specialist) await confirmNativeSpecialist(root, "main", "assignment", task.execution.specialist, { status: "valid" });
  if (task.execution.mode === "delegate" && ["plan", "slow"].includes(task.execution.role))
    await routeNativeSpawn(root, "main", "Shipassignment", task.execution.specialist ?? "task", () => true);
}

test("native code refuses agent command claims without mandatory command and runs protected checks", async t => {
  const { root, key } = await setup(t, "implementation", ["Code works"]);
  const config = await loadConfig(root);
  config.protectedChecks = ["node -e \"require('fs').writeFileSync('protected-proof.txt','ran')\""];
  await atomicJson(configPath(root), config);
  const state = await loadState(root);
  tasks(state)[0].t.verificationCommands = [];
  await saveState(root, state);
  await confirmWorker(root);
  const response = await reportNativeOutcome(root, "main", { ...outcome, evidence: { commands: [{ command: "node -e \"process.exit(0)\"", ok: true }] } });
  const after = await loadState(root);
  assert.equal(tasks(after).find(item => item.key === key)!.t.status, "failed", response);
  assert.equal(await readFile(path.join(root, "protected-proof.txt"), "utf8"), "ran");
});

test("native protected check failure blocks a passing agent report and passing task command", async t => {
  const { root, key } = await setup(t, "implementation", ["Code works"]);
  const config = await loadConfig(root);
  config.protectedChecks = ["node -e \"process.exit(7)\""];
  await atomicJson(configPath(root), config);
  await confirmWorker(root);
  await reportNativeOutcome(root, "main", outcome);
  const task = tasks(await loadState(root)).find(item => item.key === key)!.t;
  assert.equal(task.status, "failed");
  assert.match(task.lastError ?? "", /Verification failed/);
  assert.ok(task.evidenceRefs?.some(ref => ref.endsWith(".verification.json")));
});

test("native research requires supported artifact, binds current acceptance, and awaits explicit same-session human approval", async t => {
  const acceptance = ["Answer with human evaluation"];
  const { root, key, task } = await setup(t, "research", acceptance);
  const answer = "Observed finding: the system supports this workflow.";
  await writeFile(path.join(root, "findings.txt"), `${answer}\n`);
  const evidence = { research: { path: "findings.txt", fingerprint: await artifactFingerprint(root, "findings.txt"),
    acceptanceFingerprint: acceptanceFingerprint(task, task.acceptanceRevision ?? 0), answer,
    findings: [{ criterion: acceptance[0], finding: answer, support: "Observed workspace behavior" }] } };
  await confirmWorker(root);
  await assert.rejects(reportNativeOutcome(root, "main", { ...outcome, evidence: { ...evidence, humanApproval: { approved: true } } as never }), /Invalid bounded SHIP evidence/);
  const response = await reportNativeOutcome(root, "main", { ...outcome, evidence });
  assert.match(response, /awaiting main-session human approval/);
  assert.equal(tasks(await loadState(root))[0].t.status, "verifying");
  await assert.rejects(approveNativeHumanEvidence(root, "foreign", key), /another main session/);
  const stale = await loadState(root);
  tasks(stale)[0].t.acceptanceRevision = 1;
  await saveState(root, stale);
  await assert.rejects(approveNativeHumanEvidence(root, "main", key), /stale or incomplete evidence/);
  tasks(stale)[0].t.acceptanceRevision = 0;
  await saveState(root, stale);
  await approveNativeHumanEvidence(root, "main", key);
  const approved = await loadState(root);
  assert.equal(tasks(approved)[0].t.status, "passed");
  assert.equal(approved.humanApprovals?.[key].sessionId, "main");
});

test("native required review cannot pass on an agent report alone", async t => {
  const { root, key } = await setup(t, "implementation", ["Code works"]);
  const state = await loadState(root);
  const task = tasks(state)[0].t;
  task.profile.complexity = 8;
  await saveState(root, state);
  await confirmWorker(root);
  const response = await reportNativeOutcome(root, "main", outcome);
  const pending = await loadState(root);
  assert.equal(pending.nativeBatch?.stage, "reviewing", response);
  const review = pending.nativeBatch!;
  await assert.rejects(reportNativeOutcome(root, "main", { batchId: review.id, assignmentId: review.assignments[0].id,
    status: "passed", summary: "Looks good", evidence: { reviews: [{ kind: "independent-review", ok: true }] } }), /not confirmed/);
  await confirmNativeSpecialist(root, "main", review.assignments[0].id, "reviewer", { overall_correctness: "correct" });
  await reportNativeOutcome(root, "main", { batchId: review.id, assignmentId: review.assignments[0].id, status: "passed", summary: "Independent review confirms behavior" });
  assert.equal(tasks(await loadState(root)).find(item => item.key === key)!.t.status, "passed");
});
