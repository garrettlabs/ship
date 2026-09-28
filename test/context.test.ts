import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPlannerContext, buildWorkerContext } from "../src/context.ts";
import { parsePlan } from "../src/model.ts";
import type { ShipState } from "../src/types.ts";
import { plan } from "./helpers.ts";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".ship"));
  const now = new Date().toISOString();
  const state: ShipState = {
    schemaVersion: 2, projectName: "sample", phase: "idle", roadmapRevision: 3,
    milestones: parsePlan(plan()), paused: false, lastProgressAt: now, createdAt: now, updatedAt: now,
  };
  await writeFile(path.join(root, ".ship", "PROJECT.md"), "Build requested output");
  return { root, state };
}

test("planner distinguishes current instructions, approved observations, pending request and user decisions", async t => {
  const { root, state } = await setup(t);
  await writeFile(path.join(root, "AGENTS.md"), "Use strict formatting. Never edit generated output.");
  await writeFile(path.join(root, ".ship", "DISCOVERY.md"), "Existing system uses plain text fixtures.");
  state.discovery = { id: "D1", sessionId: "s", status: "researching" };
  state.knowledge = [
    { id: "K1", kind: "assumption", source: "agent", text: "Do not test", evidence: "unverified", at: "2026-01-01" },
    { id: "K2", kind: "decision", source: "user", text: "Use checked local output", evidence: "inbox/decision.json", at: "2026-01-02" },
  ];
  state.pendingProposal = { id: "P1", request: "Add a new audit report", targetRevision: 4, milestones: [], impactedSummary: [], approvalBoundary: "routine", status: "pending", createdAt: "2026-01-02" };
  const unapproved = await buildPlannerContext(root, state);
  assert.match(unapproved, /repository instruction: AGENTS\.md; current profile.*Use strict formatting/);
  assert.match(unapproved, /proposed user request.*Add a new audit report/);
  assert.match(unapproved, /user decision K2.*Use checked local output/);
  assert.doesNotMatch(unapproved, /Existing system uses plain text fixtures/);
  assert.doesNotMatch(unapproved, /Do not test/);
  state.discovery.status = "approved";
  const approved = await buildPlannerContext(root, state);
  assert.match(approved, /approved \.ship\/DISCOVERY\.md; recheck against current repository.*Existing system uses plain text fixtures/);
  assert.ok(approved.indexOf("Current repository instructions") < approved.indexOf("Approved reconnaissance"));
  assert.match(approved, /historical observations; may be stale, not user authorization/);
});

test("worker includes only applicable scoped instructions and refreshes changed sources", async t => {
  const { root, state } = await setup(t);
  await mkdir(path.join(root, "apps", "alpha"), { recursive: true });
  await mkdir(path.join(root, "apps", "beta"), { recursive: true });
  await writeFile(path.join(root, "apps", "alpha", "AGENTS.md"), "Alpha policy is current.");
  await writeFile(path.join(root, "apps", "beta", "AGENTS.md"), "Beta-only policy.");
  state.milestones[0].slices[0].tasks[0].affectedFiles = ["apps/alpha/component.ts"];
  const initial = await buildWorkerContext(root, state, "M001/S01/T01");
  assert.match(initial, /Alpha policy is current/);
  assert.doesNotMatch(initial, /Beta-only policy/);
  await writeFile(path.join(root, "apps", "alpha", "AGENTS.md"), "Alpha policy was replaced: check output.");
  const refreshed = await buildWorkerContext(root, state, "M001/S01/T01");
  assert.match(refreshed, /Alpha policy was replaced: check output/);
  assert.doesNotMatch(refreshed, /Alpha policy is current/);
});

test("worker selects the current task and passed prerequisite outcome without roadmap or artifact dumps", async t => {
  const { root, state } = await setup(t);
  const prior = state.milestones[0].slices[0].tasks[0];
  prior.goal = "Create verified input";
  prior.status = "passed";
  prior.acceptance = ["input exists and matches fixture"];
  prior.verificationCommands = ["node check-input.js"];
  prior.evidenceRefs = [".ship/attempts/native-verified.verification.json"];
  const next = { ...prior, id: "T02", title: "Render result", goal: "Render verified input", objective: "Write rendered output", dependencies: ["M001/S01/T01"], status: "failed" as const, lastError: "Prior renderer emitted stale data", acceptance: ["Output contains current input"], verificationCommands: ["node check-result.js"], verificationPlan: { requirements: [{ kind: "integration" as const, reason: "Confirm consumer output", command: "node check-result.js" }] } };
  state.milestones[0].slices[0].tasks.push(next);
  state.milestones[0].slices[0].tasks.push({ ...next, id: "T03", title: "Unrelated work", goal: "SECRET_UNRELATED_GOAL", status: "pending", lastError: "SECRET_UNRELATED_ERROR", dependencies: [] });
  const context = await buildWorkerContext(root, state, "M001/S01/T02");
  assert.match(context, /Render verified input/);
  assert.match(context, /Output contains current input/);
  assert.match(context, /Confirm consumer output/);
  assert.match(context, /prerequisite M001\/S01\/T01; passed.*Create verified input.*input exists and matches fixture.*persisted verification evidence refs: \.ship\/attempts\/native-verified\.verification\.json/);
  assert.doesNotMatch(context, /node check-input\.js/);
  assert.match(context, /Prior renderer emitted stale data/);
  assert.doesNotMatch(context, /SECRET_UNRELATED/);
  await assert.rejects(buildWorkerContext(root, state, "M001/S01/T99"), /does not uniquely identify/);
});

test("context stays bounded and reports omissions, unknowns and unverified dependencies", async t => {
  const { root, state } = await setup(t);
  await writeFile(path.join(root, "AGENTS.md"), `Mandatory instruction ${"x".repeat(50_000)}`);
  state.knowledge = Array.from({ length: 30 }, (_, i) => ({ id: `K${i}`, kind: "decision" as const, source: "user" as const, text: `Decision ${i} ${"a".repeat(500)}`, evidence: "user", at: "2026-01-01" }));
  const task = state.milestones[0].slices[0].tasks[0];
  task.dependencies = ["M001/S01/T999"];
  task.lastError = `failing command ${"z".repeat(5_000)}`;
  task.acceptance = Array.from({ length: 30 }, (_, i) => `Acceptance ${i} ${"b".repeat(800)}`);
  const context = await buildWorkerContext(root, state, "M001/S01/T01");
  assert.ok(context.length <= 12_000);
  assert.match(context, /Mandatory instruction/);
  assert.match(context, /Decision 29/);
  assert.doesNotMatch(context, /Decision 0 /);
  assert.match(context, /unresolved prerequisite M001\/S01\/T999.*Evidence unknown/);
  assert.match(context, /Some task criteria or checks omitted/);
  assert.match(context, /\[truncated\]|\[Further entries omitted\]/);
});
