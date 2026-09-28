import test from "node:test";
import assert from "node:assert/strict";
import { classifyAutonomousApproval, canContinueAutonomously } from "../src/autonomy.ts";
import { parsePlan } from "../src/model.ts";
import type { Milestone, ShipState } from "../src/types.ts";

function plan(goal = "Implement the display toggle", files = ["src/display.ts"]): Milestone[] {
  return parsePlan(JSON.stringify({ milestones: [{ id: "M01", title: "Display toggle", outcome: "Display toggle works", slices: [{ id: "S01", title: "Implement toggle", tasks: [{
    id: "T01", title: "Implement display toggle", goal, acceptance: ["Toggle changes the displayed value"],
    verificationCommands: ["npm test -- display"], affectedFiles: files, affectedDomains: ["display"],
    taskType: "implementation", uncertainty: "LOW", profile: { complexity: 3, uncertainty: 2, risk: 2, traits: [], rationale: ["Bounded local display change"] },
  }] }] }] }));
}

function state(milestones: Milestone[] = plan()): ShipState {
  return { schemaVersion: 2, projectName: "Display", phase: "idle", roadmapRevision: 1, milestones,
    autonomy: "yolo", autonomySessionId: "session-a", paused: false, lastProgressAt: "2026-01-01", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    discovery: { id: "discovery", sessionId: "session-a", status: "approved", goalSet: true } };
}

function revised(old = plan(), goal = "Implement the display toggle with keyboard support"): Milestone[] {
  const next = structuredClone(old);
  next[0].slices[0].tasks[0].goal = goal;
  return next;
}

test("planner-authored shell text cannot cross YOLO approval, but an exact previously approved command can", () => {
  const initial = state([]);
  const proposed = plan();
  proposed[0].slices[0].tasks[0].verificationCommands = ["node -e \"require('fs').writeFileSync('marker','executed')\""];
  assert.match(classifyAutonomousApproval(initial, proposed).reasons.join("; "), /planner-authored verification commands/);
  const existing = plan();
  const revision = revised(existing);
  revision[0].slices[0].tasks[0].verificationPlan.requirements.push({ kind: "independent-review", reason: "Required independent review" });
  assert.deepEqual(classifyAutonomousApproval(state(existing), revision), { safe: true, reasons: [] });
  revision[0].slices[0].tasks[0].verificationCommands.push("echo unexpected > marker");
  assert.match(classifyAutonomousApproval(state(existing), revision).reasons.join("; "), /planner-authored verification commands/);
  const newTask = revised(existing);
  newTask[0].slices[0].tasks.push({ ...structuredClone(existing[0].slices[0].tasks[0]), id: "T02", affectedFiles: ["src/other.ts"] });
  assert.match(classifyAutonomousApproval(state(existing), newTask).reasons.join("; "), /planner-authored verification commands/);
  assert.equal(existing[0].slices[0].tasks[0].goal, "Implement the display toggle");
});

test("YOLO may approve commandless planner work verified by an existing repository check", () => {
  const raw = { milestones: [{ id: "M01", title: "Display toggle", outcome: "Display toggle works", slices: [{
    id: "S01", title: "Implement toggle", tasks: [{ id: "T01", title: "Implement display toggle",
      goal: "Implement the display toggle", acceptance: ["Toggle changes the displayed value"],
      verificationCommands: [], affectedFiles: ["src/display.ts"], affectedDomains: ["display"],
      taskType: "implementation", uncertainty: "LOW",
      profile: { complexity: 3, uncertainty: 2, risk: 2, traits: [], rationale: ["Bounded local display change"] },
    }],
  }] }] };
  const proposal = parsePlan(JSON.stringify(raw), [{ kind: "focused-tests", command: "node --test", source: "approved repository policy" }]);
  assert.deepEqual(classifyAutonomousApproval(state([]), proposal), { safe: true, reasons: [] });
});

test("consequential scope, product choices, ownership and missing acceptance require approval", () => {
  const old = plan();
  const cases: Array<[string, (next: Milestone[]) => void, RegExp]> = [
    ["destructive migration", next => { next[0].slices[0].tasks[0].goal = "Drop table and migrate records"; }, /consequential/i],
    ["deployment", next => { next[0].slices[0].tasks[0].goal = "Deploy to production"; }, /consequential/i],
    ["secrets", next => { next[0].slices[0].tasks[0].goal = "Rotate API keys"; }, /consequential/i],
    ["publishing", next => { next[0].slices[0].tasks[0].goal = "Publish the package"; }, /consequential/i],
    ["functionality deletion", next => { next[0].slices[0].tasks[0].goal = "Remove the display toggle"; }, /consequential/i],
    ["budget", next => { next[0].slices[0].tasks[0].goal = "Increase the dispatch budget"; }, /consequential/i],
    ["product choice", next => { next[0].slices[0].tasks[0].goal = "Choose between compact or expanded layout"; }, /product decision/i],
    ["unknown risk", next => { next[0].slices[0].tasks[0].risk = "UNKNOWN"; }, /unknown risk/i],
    ["unknown ownership", next => { next[0].slices[0].tasks[0].affectedFiles = []; }, /unknown file ownership/i],
    ["ambiguous path", next => { next[0].slices[0].tasks[0].affectedFiles = ["src/../display.ts"]; }, /unknown file ownership/i],
    ["missing acceptance", next => { next[0].slices[0].tasks[0].acceptance = []; }, /missing acceptance/i],
    ["missing protected check", next => { next[0].slices[0].tasks[0].verificationPlan.requirements = []; }, /protected verification|missing acceptance/i],
    ["human acceptance", next => { next[0].slices[0].tasks[0].acceptance.push("Human approval of UI required"); }, /human acceptance/i],
    ["remove planned work", next => { next[0].slices[0].tasks = []; }, /removes planned functionality/i],
  ];
  for (const [label, mutate, reason] of cases) {
    const next = revised(old);
    mutate(next);
    const decision = classifyAutonomousApproval(state(old), next);
    assert.equal(decision.safe, false, label);
    assert.match(decision.reasons.join("; "), reason, label);
  }
  const expanded = revised(old);
  expanded.push({ ...structuredClone(expanded[0]), id: "M02" });
  assert.match(classifyAutonomousApproval(state(old), expanded).reasons.join(" "), /expands the approved goal/);
  const overlap = revised(old);
  overlap[0].slices[0].tasks.push({ ...structuredClone(overlap[0].slices[0].tasks[0]), id: "T02", affectedFiles: ["src/display.ts"] });
  assert.match(classifyAutonomousApproval(state(old), overlap).reasons.join(" "), /Overlapping file ownership/);
  const outline = [{ id: "M02", title: "Different product", outcome: "New goal" }];
  assert.match(classifyAutonomousApproval(state(old), revised(old), outline).reasons.join(" "), /Future outline changes unapproved scope/);
});

test("explicit proposals and preserved protected requirements cannot be auto-approved", () => {
  const old = plan(), next = revised(old);
  const required = { kind: "security-review" as const, reason: "Protected security review" };
  old[0].slices[0].tasks[0].verificationPlan.requirements.push(required);
  assert.match(classifyAutonomousApproval(state(old), next).reasons.join(" "), /protected verification/);
  const explicit = state(old);
  explicit.pendingProposal = { id: "proposal", request: "Change toggle", sessionId: "session-a", targetRevision: 1,
    milestones: next, impactedSummary: ["toggle"], approvalBoundary: "explicit", status: "pending", createdAt: "2026-01-01" };
  assert.match(classifyAutonomousApproval(explicit, next).reasons.join(" "), /explicit user approval/);
});

test("continuation refuses human gates, pause, supervised mode and foreign active assignments", () => {
  const current = state();
  assert.deepEqual(canContinueAutonomously(current, "session-a"), { safe: true });
  current.nativeBatch = { id: "batch", sessionId: "session-b", revision: 1, stage: "executing", assignments: [] };
  assert.match(canContinueAutonomously(current, "session-a").reason ?? "", /another session/);
  delete current.nativeBatch;
  current.milestones[0].slices[0].tasks[0].status = "verifying";
  current.milestones[0].slices[0].tasks[0].acceptance.push("Human approval of appearance");
  assert.match(canContinueAutonomously(current, "session-a").reason ?? "", /Human evaluation/);
  current.paused = true;
  assert.match(canContinueAutonomously(current, "session-a").reason ?? "", /paused/);
  current.autonomy = "supervised";
  assert.match(canContinueAutonomously(current, "session-a").reason ?? "", /yolo/);
});
