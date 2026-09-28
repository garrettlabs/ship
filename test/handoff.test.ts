import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffCheckpoint, validateHandoffTransfer, type GitSnapshot } from "../src/handoff.ts";
import type { ShipState, Task } from "../src/types.ts";

const root = "/repo/work";
const head = "a".repeat(40);
const fingerprint = "b".repeat(64);
const git = (): GitSnapshot => ({ branch: "feature", head, dirty: { "src/change.ts": fingerprint } });

function state(): ShipState {
  const task = (id: string, status: Task["status"], attempts: number): Task => ({
    id, title: `Deliver ${id}`, goal: `Deliver ${id}`, objective: `Deliver ${id}`,
    status, attempts, verificationRequirements: ["Run integration scenario"],
  } as Task);
  return {
    schemaVersion: 2, projectName: "demo", phase: "idle", roadmapRevision: 3,
    milestones: [{ id: "M001", title: "Delivery", outcome: "Complete", status: "active", slices: [{
      id: "S01", title: "Implementation", status: "active", tasks: [task("T01", "passed", 1), task("T02", "failed", 1), task("T03", "pending", 0)],
    }] }],
    current: { milestoneId: "M001", sliceId: "S01", taskId: "T02" }, paused: true,
    lastProgressAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    knowledge: [{ id: "K01", kind: "decision", text: "Use an atomic commit", source: "agent", evidence: "docs/design", at: "2026-01-01" }],
    pendingProposal: { id: "P01", request: "Approve altered scope", targetRevision: 3, milestones: [], impactedSummary: [], approvalBoundary: "routine", status: "pending", createdAt: "2026-01-01" },
  };
}

test("settled handoff describes work and checks Git without changing state or attempts", () => {
  const run = state();
  const before = structuredClone(run);
  const snapshot = git();
  const checkpoint = buildHandoffCheckpoint(run, root, snapshot);
  assert.deepEqual(run, before);
  assert.match(checkpoint.finished[0], /T01 \[passed\]/);
  assert.match(checkpoint.outstanding[0], /T02 \[failed\]/);
  assert.match(checkpoint.pendingVerification[0], /Run integration scenario/);
  assert.match(checkpoint.pendingApproval[0], /Approve altered scope/);
  assert.match(checkpoint.decisions[0], /atomic commit/);
  assert.match(checkpoint.references[0], /docs\/design/);
  assert.match(checkpoint.nextAction, /Obtain approval/);
  snapshot.dirty["src/change.ts"] = "c".repeat(64);
  assert.equal(validateHandoffTransfer(run, checkpoint, root, git()).ok, true);
  assert.deepEqual(run, before);
});

test("an active transition refuses checkpoint and transfer without consuming attempts", () => {
  const run = state();
  const checkpoint = buildHandoffCheckpoint(run, root, git());
  const before = structuredClone(run);
  const cases: [string, Partial<ShipState>][] = [
    ["native batch", { nativeBatch: { id: "B", sessionId: "session", revision: 3, stage: "executing", assignments: [] } }],
    ["native planning", { nativePlanning: { id: "P", sessionId: "session", attempts: 1 } }],
    ["judgment", { pendingJudgment: { id: "J", sessionId: "session", revision: 3, key: "M001/S01/T03", requestedAt: 0, eligible: ["task", "slow"], requestHash: "a".repeat(64) } }],
    ["attempt", { activeAttempt: { id: "A", key: "M001/S01/T02", baseHead: head, stage: "executing", commands: [], revision: 3 } }],
    ["discovery", { discovery: { id: "D", sessionId: "session", status: "researching" } }],
  ];
  for (const [label, flags] of cases) {
    const active = { ...run, ...flags };
    assert.throws(() => buildHandoffCheckpoint(active, root, git()), /active|pending/i, label);
    assert.equal(validateHandoffTransfer(active, checkpoint, root, git()).ok, false, label);
  }
  run.milestones[0].slices[0].tasks[1].status = "running";
  assert.equal(validateHandoffTransfer(run, checkpoint, root, git()).ok, false);
  assert.deepEqual({ ...run, milestones: before.milestones }, before);
});

test("transfer refuses stale Git branch, HEAD, dirty paths, fingerprints, and roadmap", () => {
  const run = state();
  const checkpoint = buildHandoffCheckpoint(run, root, git());
  for (const snapshot of [
    { ...git(), branch: "elsewhere" },
    { ...git(), head: "c".repeat(40) },
    { ...git(), dirty: { "src/other.ts": fingerprint } },
    { ...git(), dirty: { "src/change.ts": "c".repeat(64) } },
  ]) assert.equal(validateHandoffTransfer(run, checkpoint, root, snapshot).ok, false);
  assert.equal(validateHandoffTransfer(run, checkpoint, "/different", git()).ok, false);
  run.milestones[0].slices[0].tasks[1].attempts++;
  assert.match(validateHandoffTransfer(run, checkpoint, root, git()).reason ?? "", /Roadmap changed/);
});

test("checkpoint bounds long text and reports omitted tasks", () => {
  const run = state();
  const slice = run.milestones[0].slices[0];
  for (let i = 4; i < 84; i++) slice.tasks.push({ ...slice.tasks[2], id: `T${i}`, title: "long ".repeat(100) });
  const checkpoint = buildHandoffCheckpoint(run, root, git());
  assert.equal(checkpoint.outstanding.length, 40);
  assert.equal(checkpoint.omittedOutstanding, 42);
  assert.ok(checkpoint.outstanding.every(item => item.length <= 240));
});
