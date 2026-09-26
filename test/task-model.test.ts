import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parsePlan, applyRoadmapEdit, applyReview } from "../src/model.ts";
import { atomicJson, loadState, saveState, statePath } from "../src/store.ts";
import { fixture, plan } from "./helpers.ts";

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
  for (const extra of [{ status: "passed" }, { attempts: 99 }, { risk: "LOW" }]) {
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
  for (const key of ["objective", "dependencies", "affectedDomains", "affectedFiles", "taskType", "uncertainty", "verificationRequirements", "complexity", "risk", "classificationSignals", "classificationRationale", "parallelEligible", "executionRoute"]) delete old[key];
  await atomicJson(statePath(root), legacy);
  const before = await readFile(statePath(root), "utf8");
  const migrated = await loadState(root);
  assert.equal(await readFile(statePath(root), "utf8"), before);
  assert.equal(migrated.roadmapRevision, 7); assert.deepEqual(migrated.activeAttempt, legacy.activeAttempt);
  assert.equal(migrated.milestones[0].slices[0].tasks[0].status, "verifying");
  assert.equal(migrated.milestones[0].slices[0].tasks[0].attempts, 3);
  assert.equal(migrated.milestones[0].slices[0].tasks[0].objective, old.goal);
  await saveState(root, migrated);
  const reloaded = await loadState(root);
  assert.deepEqual(reloaded.activeAttempt, legacy.activeAttempt);
  assert.deepEqual(reloaded.milestones[0].slices[0].tasks[0], migrated.milestones[0].slices[0].tasks[0]);
  const corrupted = structuredClone(reloaded); corrupted.milestones[0].slices[0].tasks[0].risk = "LOW";
  await atomicJson(statePath(root), corrupted);
  await assert.rejects(loadState(root), /Invalid persisted risk/);
});

test("goal-only edits retain stable objectives, acceptance, checks, and refreshed classification", async t => {
  const root = await fixture(t); const state = await loadState(root);
  state.milestones = parsePlan(plan()); state.roadmapRevision = 1;
  const initial = state.milestones[0].slices[0].tasks[0];
  applyRoadmapEdit(state, { type: "change", task: "M001/S01/T01", goal: "change authentication permissions", revision: 1 });
  const updated = state.milestones[0].slices[0].tasks[0];
  assert.equal(updated.objective, initial.objective);
  assert.deepEqual(updated.acceptance, initial.acceptance);
  assert.deepEqual(updated.verificationCommands, initial.verificationCommands);
  assert.equal(updated.risk, "HIGH");
  applyReview(state, JSON.stringify({ revision: 2, rationale: "implementation revision", lessons: [], changes: [{ task: "M001/S01/T01", goal: "implement using local file", reason: "evidence" }] }), "test");
  assert.equal(updated.objective, initial.objective); assert.equal(updated.risk, "UNKNOWN");
  applyRoadmapEdit(state, { type: "add", slice: "M001/S01", title: "Second result", goal: "produce second result", acceptance: "second result works", check: "test -f second", revision: 3 });
  assert.equal(state.milestones[0].slices[0].tasks[1].objective, "produce second result");
});
