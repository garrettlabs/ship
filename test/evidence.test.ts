import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acceptanceFingerprint, artifactFingerprint, evaluateTaskEvidence, outputRequirements } from "../src/evidence.ts";
import type { MainSessionHumanApproval, TaskEvidence } from "../src/evidence.ts";
import type { Task } from "../src/types.ts";

const task = (taskType: Task["taskType"], acceptance = ["State a supported conclusion"]): Task => ({
  id: "T01", objective: "Investigate the design", goal: "Produce a supported answer", acceptance, taskType,
  verificationRequirements: [], verificationCommands: [], verificationPlan: { requirements: [] },
  affectedFiles: [], affectedDomains: [],
} as unknown as Task);

const workspace = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const input = (root: string, current: Task, evidence?: TaskEvidence) => ({ root, task: current, revision: 7, mainSessionId: "main-1", evidence });

test("research requires a supported answer covering acceptance, not merely a file", async t => {
  const root = await workspace(t);
  const current = task("research", ["Compare both alternatives", "Recommend one with rationale"]);
  const answer = "Alternative A is preferable because it avoids a mandatory external dependency.";
  const findings = [
    { criterion: current.acceptance[0], finding: "A is local while B requires a service.", support: "Repository configuration and design notes" },
    { criterion: current.acceptance[1], finding: "Choose A for offline operation.", support: "Deployment constraints in the project brief" },
  ];
  await writeFile(path.join(root, "report.txt"), `${answer}\n${findings.map(f => f.finding).join("\n")}\n`);
  const research = { path: "report.txt", fingerprint: await artifactFingerprint(root, "report.txt"), acceptanceFingerprint: acceptanceFingerprint(current, 7), answer, findings };
  assert.deepEqual(outputRequirements(current), ["research-artifact"]);
  assert.equal((await evaluateTaskEvidence(input(root, current, { research }))).ok, true);
  assert.match((await evaluateTaskEvidence(input(root, current, { research: { ...research, answer: "" } }))).missing.join(" "), /answer/);
  assert.match((await evaluateTaskEvidence(input(root, current, { research: { ...research, findings: findings.slice(0, 1) } }))).missing.join(" "), /criterion/);
  assert.match((await evaluateTaskEvidence(input(root, current, { research: { ...research, answer: "Unrelated answer" } }))).missing.join(" "), /content/);
});

test("artifact and material task revisions invalidate evidence, unrelated roadmap edits do not", async t => {
  const root = await workspace(t);
  const current = task("planning-design");
  const answer = "The migration should use a staged cutover with a bounded rollback window.";
  await writeFile(path.join(root, "design.txt"), `${answer}\nImplement the staged cutover.\n`);
  const research = { path: "design.txt", fingerprint: await artifactFingerprint(root, "design.txt"), acceptanceFingerprint: acceptanceFingerprint(current, 7), answer,
    findings: [{ criterion: current.acceptance[0], finding: "Implement the staged cutover.", support: "Existing release constraints" }] };
  assert.equal((await evaluateTaskEvidence(input(root, current, { research }))).ok, true);
  const roadmap = { revision: 10, task: current };
  roadmap.revision++;
  assert.equal((await evaluateTaskEvidence(input(root, roadmap.task, { research }))).ok, true);
  await writeFile(path.join(root, "design.txt"), `${answer}\nChanged design content.\n`);
  assert.match((await evaluateTaskEvidence(input(root, current, { research }))).missing.join(" "), /fingerprint/);
  await writeFile(path.join(root, "design.txt"), `${answer}\nImplement the staged cutover.\n`);
  assert.equal((await evaluateTaskEvidence({ ...input(root, current, { research }), revision: 8 })).ok, false);
  assert.equal((await evaluateTaskEvidence(input(root, current, { research }))).ok, true);
  current.verificationRequirements = ["Confirm the rollout safety plan"];
  assert.equal((await evaluateTaskEvidence(input(root, current, { research }))).ok, false);
  current.verificationRequirements = [];
  current.acceptance = ["Provide a different conclusion"];
  assert.equal((await evaluateTaskEvidence(input(root, current, { research }))).ok, false);
});

test("artifact fingerprint refuses traversal and symlinks escaping the workspace", async t => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await assert.rejects(artifactFingerprint(root, path.join("..", path.basename(outside), "secret.txt")), /within the workspace/);
  try {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Symlink creation unavailable; traversal assertion still exercised"); return; }
    throw error;
  }
  await assert.rejects(artifactFingerprint(root, "escape.txt"), /within the workspace/);
});

test("human evaluation requires a separate current main-session UI approval, not agent evidence", async t => {
  const root = await workspace(t);
  const current = task("review", ["Human evaluation confirms the visual layout"]);
  const approved: MainSessionHumanApproval = { source: "main-session-ui", sessionId: "main-1", taskId: current.id,
    revision: 7, acceptanceFingerprint: acceptanceFingerprint(current, 7), approved: true };
  assert.deepEqual(outputRequirements(current), ["human-evaluation"]);
  assert.equal((await evaluateTaskEvidence(input(root, current, { humanApproval: approved } as TaskEvidence))).ok, false);
  assert.equal((await evaluateTaskEvidence({ ...input(root, current), humanApproval: approved })).ok, true);
  assert.equal((await evaluateTaskEvidence({ ...input(root, current), humanApproval: { ...approved, sessionId: "agent-session" } })).ok, false);
  assert.equal((await evaluateTaskEvidence({ ...input(root, current), humanApproval: { ...approved, revision: 6 } })).ok, false);
  current.acceptance = ["Human evaluation confirms the revised visual layout"];
  assert.equal((await evaluateTaskEvidence({ ...input(root, current), humanApproval: approved })).ok, false);
});

test("human approval cannot bypass code checks or mandatory security review", async t => {
  const root = await workspace(t);
  const current = task("implementation", ["Human acceptance verifies authentication behavior"]);
  current.risk = "HIGH";
  current.verificationPlan = { requirements: [
    { kind: "focused-tests", command: "npm test", reason: "Required code check" },
    { kind: "security-review", reason: "Security-critical authentication" },
  ] };
  const humanApproval: MainSessionHumanApproval = { source: "main-session-ui", sessionId: "main-1", taskId: current.id,
    revision: 7, acceptanceFingerprint: acceptanceFingerprint(current, 7), approved: true };
  const acceptanceFingerprintForChecks = acceptanceFingerprint(current, 7);
  assert.deepEqual(outputRequirements(current), ["executable-code", "human-evaluation"]);
  assert.match((await evaluateTaskEvidence({ ...input(root, current), humanApproval })).missing.join(" "), /focused-tests/);
  assert.match((await evaluateTaskEvidence({ ...input(root, current, { acceptanceFingerprint: acceptanceFingerprintForChecks, commands: [{ command: "npm test", ok: true }] }), humanApproval })).missing.join(" "), /security-review/);
  assert.equal((await evaluateTaskEvidence({ ...input(root, current, { acceptanceFingerprint: acceptanceFingerprintForChecks, commands: [{ command: "npm test", ok: false }], reviews: [{ kind: "security-review", ok: true }] }), humanApproval })).ok, false);
  const passedEvidence: TaskEvidence = { acceptanceFingerprint: acceptanceFingerprintForChecks, commands: [{ command: "npm test", ok: true }], reviews: [{ kind: "security-review", ok: true }] };
  assert.equal((await evaluateTaskEvidence({ ...input(root, current, passedEvidence), humanApproval })).ok, true);
  assert.equal((await evaluateTaskEvidence({ ...input(root, current, passedEvidence), revision: 8, humanApproval: { ...humanApproval, revision: 8, acceptanceFingerprint: acceptanceFingerprint(current, 8) } })).ok, false);
});
