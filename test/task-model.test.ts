import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePlan, applyRoadmapEdit } from "../src/model.ts";
import { atomicJson, loadState, saveState, statePath } from "../src/store.ts";
import { fixture, plan } from "./helpers.ts";
import { routeTask } from "../src/role-router.ts";

function task(overrides: Record<string, unknown> = {}) {
  const raw = JSON.parse(plan());
  Object.assign(raw.milestones[0].slices[0].tasks[0], { objective: "Deliver a checked result", affectedFiles: ["result.txt"], affectedDomains: ["local"], uncertainty: "LOW", taskType: "documentation", ...overrides });
  return parsePlan(JSON.stringify(raw))[0].slices[0].tasks[0];
}

test("classification distinguishes structural complexity independently of safety risk", () => {
  const trivial = task();
  assert.equal(trivial.complexity, "TRIVIAL"); assert.equal(trivial.risk, "LOW");
  assert.equal(trivial.parallelEligible, true); assert.equal(trivial.executionRoute, "direct");
  const standard = task({ taskType: "implementation" });
  assert.equal(standard.complexity, "STANDARD");
  const complex = task({ affectedDomains: ["data", "ui"], affectedFiles: ["a", "b", "c", "d"] });
  assert.equal(complex.complexity, "COMPLEX"); assert.equal(complex.risk, "LOW");
  assert.deepEqual(complex.classificationRationale.slice(0, 2), ["multiple affected domains", "four or more affected files"]);
  const sensitive = task({ objective: "Update authentication permissions and API secrets via network", taskType: "documentation" });
  assert.equal(sensitive.complexity, "TRIVIAL"); assert.equal(sensitive.risk, "HIGH");
  assert.deepEqual(sensitive.classificationSignals, ["authn/authz", "secrets", "permissions", "network/security"]);
  assert.equal(sensitive.parallelEligible, false);
  const migration = task({ taskType: "migration", objective: "Migrate schema for persisted data and delete old files" });
  assert.equal(migration.complexity, "COMPLEX"); assert.equal(migration.risk, "HIGH");
  assert.deepEqual(migration.classificationSignals, ["migration/schema", "persisted data", "filesystem deletion"]);
  assert.equal(migration.executionRoute, "decompose");
});

test("role router selects scout, direct, delegated, planning and difficult-reasoning work", () => {
  const recon = task({ taskType: "reconnaissance", objective: "Inspect repository layout" });
  assert.deepEqual([recon.execution.mode, recon.execution.role, recon.execution.specialist], ["delegate", "smol", "scout"]);
  const local = task({ taskType: "implementation", title: "Tiny obvious local edit", goal: "Change one line" });
  assert.deepEqual([local.execution.mode, local.execution.role], ["main", "main"]);
  const normal = task({ taskType: "implementation", title: "Implement result", goal: "Implement the requested behavior" });
  assert.deepEqual([normal.execution.mode, normal.execution.role], ["delegate", "task"]);
  const design = task({ taskType: "planning-design", uncertainty: "HIGH", objective: "Design architecture" });
  assert.equal(design.execution.role, "plan");
  const hard = task({ taskType: "implementation", uncertainty: "HIGH", affectedFiles: ["a", "b", "c", "d"] });
  assert.equal(hard.execution.role, "slow");
  assert.match(hard.execution.reason, /uncertainty/);
  assert.ok(normal.execution.reason);
  for (const routed of [recon, local, normal, design, hard]) {
    assert.equal("provider" in routed.execution, false);
    assert.equal("model" in routed.execution, false);
  }
});

test("reviews use specialists while sensitive implementation keeps its writer role", () => {
  const review = task({ taskType: "review", objective: "Review implementation independently" });
  assert.deepEqual([review.execution.role, review.execution.specialist], ["slow", "reviewer"]);
  const securityReview = task({ taskType: "security-review", objective: "Audit authentication" });
  assert.deepEqual([securityReview.execution.role, securityReview.execution.specialist], ["slow", "security-reviewer"]);
  const sensitive = task({ taskType: "implementation", objective: "Implement authentication permissions", goal: "Implement scoped authentication behavior" });
  assert.equal(sensitive.risk, "HIGH");
  assert.equal(sensitive.execution.role, "task");
  assert.equal(sensitive.execution.specialist, undefined);
  assert.equal(sensitive.execution.verificationSpecialist, "security-reviewer");
  assert.match(sensitive.execution.reason, /security-focused verification/);
});

test("prerequisites affect routing without consulting parallel eligibility", () => {
  const baseline = task({ taskType: "implementation", goal: "Implement bounded result" });
  const dependent = routeTask({ ...baseline, dependencies: ["T00", "T02"], complexity: "COMPLEX" });
  assert.equal(dependent.role, "slow");
  assert.match(dependent.reason, /multiple prerequisites/);
  const onePrerequisite = routeTask({ ...baseline, dependencies: ["T00"] });
  assert.equal(onePrerequisite.role, "task");
  assert.match(onePrerequisite.reason, /prerequisite context/);
  const safeEdit = task({ taskType: "implementation", title: "Tiny obvious edit", goal: "Change one line" });
  const withPrerequisite = routeTask({ ...safeEdit, dependencies: ["T00"] });
  assert.equal(withPrerequisite.role, "task");
});

test("explicit migration type and verification-only secret boundaries remain high risk", () => {
  const migration = task({ taskType: "migration", objective: "Update customer records" });
  assert.equal(migration.complexity, "COMPLEX");
  assert.equal(migration.risk, "HIGH");
  assert.deepEqual(migration.classificationSignals, ["migration/schema"]);
  const secrets = task({ verificationRequirements: ["Verify no secrets are exposed"] });
  assert.equal(secrets.complexity, "TRIVIAL");
  assert.equal(secrets.risk, "HIGH");
  assert.equal(secrets.parallelEligible, false);
  assert.deepEqual(secrets.classificationSignals, ["secrets"]);
  const migrating = task({ goal: "Migrating legacy files" });
  assert.equal(migrating.risk, "HIGH");
  assert.deepEqual(migrating.classificationSignals, ["migration/schema"]);
});

test("qualified dependencies resolve across slices", () => {
  const raw = JSON.parse(plan());
  const firstSlice = raw.milestones[0].slices[0];
  raw.milestones[0].slices.push({
    id: "S02", title: "Integrate result",
    tasks: [{ ...firstSlice.tasks[0], dependencies: ["M001/S01/T01"] }],
  });
  const planned = parsePlan(JSON.stringify(raw));
  assert.deepEqual(planned[0].slices[1].tasks[0].dependencies, ["M001/S01/T01"]);
});

test("execution plans preserve every required semantic task type", () => {
  for (const taskType of ["reconnaissance", "planning-design", "implementation", "test", "documentation", "integration", "review", "security-review"] as const) {
    assert.equal(task({ taskType }).taskType, taskType);
  }
});

test("legacy plan metadata is honest about unknown scope and planner cannot override lifecycle", () => {
  const legacy = parsePlan(plan())[0].slices[0].tasks[0];
  assert.equal(legacy.objective, legacy.goal); assert.equal(legacy.uncertainty, "UNKNOWN");
  assert.equal(legacy.risk, "UNKNOWN"); assert.equal(legacy.executionRoute, "investigate");
  assert.deepEqual(legacy.verificationRequirements, legacy.acceptance);
  for (const extra of [{ status: "passed" }, { attempts: 99 }, { risk: "LOW" }, { execution: { mode: "main", role: "main", reason: "override" } }]) {
    const raw = JSON.parse(plan()); Object.assign(raw.milestones[0].slices[0].tasks[0], extra);
    assert.throws(() => parsePlan(JSON.stringify(raw)), /Planner cannot override/);
  }
  for (const extra of [{ uncertainty: "surprise" }, { taskType: "unsupported" }, { dependencies: ["T99"] }]) {
    const raw = JSON.parse(plan()); Object.assign(raw.milestones[0].slices[0].tasks[0], extra);
    assert.throws(() => parsePlan(JSON.stringify(raw)), /Invalid|Missing task dependency/);
  }
});

test("legacy state normalization preserves active attempt and commits only on save", async t => {
  const root = await fixture(t);
  const state = await loadState(root); state.milestones = parsePlan(plan()); state.roadmapRevision = 7;
  const existing = state.milestones[0].slices[0].tasks[0]; existing.status = "verifying"; existing.attempts = 3;
  state.activeAttempt = { id: "attempt-3", key: "M001/S01/T01", baseHead: "base", stage: "verifying", commands: ["frozen check"], revision: 6, tree: "tree" };
  const legacy = structuredClone(state);
  const old = legacy.milestones[0].slices[0].tasks[0] as unknown as Record<string, unknown>;
  for (const key of ["objective", "dependencies", "dependencyLevel", "affectedDomains", "affectedFiles", "taskType", "uncertainty", "verificationRequirements", "verificationPlan", "complexity", "risk", "classificationSignals", "classificationRationale", "parallelEligible", "executionRoute", "execution"]) delete old[key];
  await atomicJson(statePath(root), legacy);
  const before = await readFile(statePath(root), "utf8");
  const migrated = await loadState(root);
  assert.equal(await readFile(statePath(root), "utf8"), before);
  assert.equal(migrated.roadmapRevision, 7); assert.deepEqual(migrated.activeAttempt, legacy.activeAttempt);
  assert.equal(migrated.milestones[0].slices[0].tasks[0].status, "verifying");
  assert.equal(migrated.milestones[0].slices[0].tasks[0].attempts, 3);
  assert.equal(migrated.milestones[0].slices[0].tasks[0].objective, old.goal);
  assert.equal(migrated.milestones[0].slices[0].tasks[0].dependencyLevel, 0);
  assert.equal(migrated.milestones[0].slices[0].tasks[0].execution.role, "task");
  assert.deepEqual(migrated.milestones[0].slices[0].tasks[0].verificationPlan.requirements.map(r => r.command), existing.verificationCommands);
  await saveState(root, migrated);
  const reloaded = await loadState(root);
  assert.deepEqual(reloaded.activeAttempt, legacy.activeAttempt);
  assert.deepEqual(reloaded.milestones[0].slices[0].tasks[0], migrated.milestones[0].slices[0].tasks[0]);
  const tamperedRoute = structuredClone(reloaded); tamperedRoute.milestones[0].slices[0].tasks[0].execution.reason = "manual override";
  await atomicJson(statePath(root), tamperedRoute);
  await assert.rejects(loadState(root), /Invalid persisted execution/);
  const corrupted = structuredClone(reloaded); corrupted.milestones[0].slices[0].tasks[0].risk = "LOW";
  await atomicJson(statePath(root), corrupted);
  await assert.rejects(loadState(root), /Invalid persisted risk/);
  const tamperedVerification = structuredClone(reloaded); tamperedVerification.milestones[0].slices[0].tasks[0].verificationPlan.requirements[0].reason = "manual override";
  await atomicJson(statePath(root), tamperedVerification);
  await assert.rejects(loadState(root), /Invalid persisted verificationPlan/);
  const tamperedLevel = structuredClone(reloaded); tamperedLevel.milestones[0].slices[0].tasks[0].dependencyLevel = 99;
  await atomicJson(statePath(root), tamperedLevel);
  await assert.rejects(loadState(root), /Invalid persisted dependencyLevel/);
});

test("goal edits refresh the objective and classification without weakening acceptance or checks", async t => {
  const root = await fixture(t); const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  const initial = state.milestones[0].slices[0].tasks[0];
  applyRoadmapEdit(state, { type: "change", task: "M001/S01/T01", goal: "change authentication permissions", revision: 1 });
  const updated = state.milestones[0].slices[0].tasks[0];
  assert.equal(updated.objective, "change authentication permissions");
  assert.deepEqual(updated.acceptance, initial.acceptance);
  assert.deepEqual(updated.verificationCommands, initial.verificationCommands);
  assert.equal(updated.risk, "HIGH");
  assert.equal(updated.execution.verificationSpecialist, "security-reviewer");
  applyRoadmapEdit(state, { type: "change", task: "M001/S01/T01", goal: "implement using local file", revision: 2 });
  assert.equal(state.milestones[0].slices[0].tasks[0].objective, "implement using local file");
  assert.equal(state.milestones[0].slices[0].tasks[0].risk, "UNKNOWN");
  assert.equal(state.milestones[0].slices[0].tasks[0].execution.verificationSpecialist, undefined);
  applyRoadmapEdit(state, { type: "add", slice: "M001/S01", title: "Second result", goal: "produce second result", acceptance: "second result works", check: "test -f second", revision: 3 });
  assert.equal(state.milestones[0].slices[0].tasks[1].objective, "produce second result");
});
