import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { confirmNativeSpecialist, reportNativeOutcome, routeNativeSpawn } from "../src/native-execution.ts";
import { applyNativeReconciliation, previewNativeReconciliation } from "../src/native-reconciliation.ts";
import { assertApprovedRepoCheck } from "../src/reconciliation.ts";
import { parsePlan, tasks } from "../src/model.ts";
import { atomicJson, configPath, loadConfig, loadState, saveState } from "../src/store.ts";
import { discoverRepoChecks, routeVerification } from "../src/verification.ts";
import { fixture, plan } from "./helpers.ts";

async function setup(t: Parameters<typeof fixture>[0], name: "package.json" | "Makefile") {
  const root = await fixture(t);
  const declaration = name === "package.json"
    ? JSON.stringify({ scripts: { "test:unit": "node -e \"require('fs').writeFileSync('original-ran','yes')\"" } })
    : "test-unit:\n\t@node -e \"require('fs').writeFileSync('original-ran','yes')\"\n";
  await writeFile(path.join(root, name), declaration);
  const config = await loadConfig(root);
  config.verificationTimeoutMs = 10_000;
  await atomicJson(configPath(root), config);
  const checks = await discoverRepoChecks(root);
  const state = await loadState(root);
  state.repoChecks = checks;
  state.milestones = parsePlan(plan(), checks);
  state.roadmapRevision = 1;
  const task = tasks(state)[0].t;
  task.verificationCommands = [];
  task.verificationPlan = routeVerification(task, checks);
  task.profile = { ...task.profile, complexity: 2, risk: 1, uncertainty: 1 };
  task.status = "running";
  task.attempts = 1;
  state.phase = "executing";
  state.nativeBatch = { id: "batch", sessionId: "main", revision: 1, stage: "executing", assignments: [{ id: "assignment", key: "M001/S01/T01", status: "pending" }] };
  await saveState(root, state);
  return { root, check: checks[0], declaration };
}

async function confirmWorker(root: string) {
  const task = tasks(await loadState(root))[0].t;
  if (task.execution.specialist) await confirmNativeSpecialist(root, "main", "assignment", task.execution.specialist, { status: "valid" });
  if (task.execution.mode === "delegate" && ["plan", "slow"].includes(task.execution.role))
    await routeNativeSpawn(root, "main", "Shipassignment", task.execution.specialist ?? "task", () => true);
}

for (const name of ["package.json", "Makefile"] as const) {
  test(`${name} changed effective check cannot run after a worker finishes`, async t => {
    const { root, check } = await setup(t, name);
    assert.ok(check.definition);
    assert.ok(check.fingerprint);
    assert.ok(check.runner);
    await confirmWorker(root);
    const changed = name === "package.json"
      ? JSON.stringify({ scripts: { "test:unit": "node -e \"require('fs').writeFileSync('changed-ran','yes')\"" } })
      : "test-unit:\n\t@node -e \"require('fs').writeFileSync('changed-ran','yes')\"\n";
    await writeFile(path.join(root, name), changed);
    const response = await reportNativeOutcome(root, "main", { batchId: "batch", assignmentId: "assignment", status: "passed", summary: "Work completed" });
    const state = await loadState(root);
    assert.match(response, /reconcile/);
    assert.match(tasks(state)[0].t.lastError ?? "", /stopped before executing/);
    await assert.rejects(access(path.join(root, "original-ran")), { code: "ENOENT" });
    await assert.rejects(access(path.join(root, "changed-ran")), { code: "ENOENT" });
    const preview = await previewNativeReconciliation(root);
    assert.equal(preview.checks.changes.length, 1);
    assert.equal(preview.checks.changes[0].type, "replaced");
    assert.notEqual(preview.checks.changes[0].before?.definition, preview.checks.changes[0].after?.definition);
    assert.equal(preview.checks.changes[0].before?.command, preview.checks.changes[0].after?.command);
    await applyNativeReconciliation(root, "main", preview, { kind: "checks" });
    assert.equal((await loadState(root)).repoChecks?.[0].definition, preview.checks.changes[0].after?.definition);
  });
}

test("unchanged approved package script still executes during verification", async t => {
  const { root } = await setup(t, "package.json");
  await confirmWorker(root);
  await reportNativeOutcome(root, "main", { batchId: "batch", assignmentId: "assignment", status: "passed", summary: "Work completed" });
  assert.equal(await readFile(path.join(root, "original-ran"), "utf8"), "yes");
});

test("Makefile includes are not approved without their transitive content", async t => {
  const { root } = await setup(t, "Makefile");
  await writeFile(path.join(root, "Makefile"), "include override.mk\ntest-unit:\n\t@true\n");
  await writeFile(path.join(root, "override.mk"), "test-unit:\n\t@node -e \"require('fs').writeFileSync('injected-ran','yes')\"\n");
  const preview = await previewNativeReconciliation(root);
  assert.equal(preview.checks.changes[0].type, "removed");
  await assert.rejects(assertApprovedRepoCheck(root, await loadState(root), "make test-unit"), /reconcile/);
  await assert.rejects(access(path.join(root, "injected-ran")), { code: "ENOENT" });
});

test("policy is rechecked between protected checks and a repository script", async t => {
  const { root } = await setup(t, "package.json");
  const state = await loadState(root);
  const task = tasks(state)[0].t;
  // A first check can mutate the declared definition; the next check must not inherit stale approval.
  const changed = JSON.stringify({ scripts: { "test:unit": "node -e \"require('fs').writeFileSync('changed-ran','yes')\"" } });
  task.verificationCommands = [`node -e "require('fs').writeFileSync('package.json',Buffer.from('${Buffer.from(changed).toString("base64")}','base64'))"`];
  task.verificationPlan.requirements.unshift({ kind: "focused-tests", reason: "Mutate policy in the first check", command: task.verificationCommands[0] });
  await saveState(root, state);
  await confirmWorker(root);
  await reportNativeOutcome(root, "main", { batchId: "batch", assignmentId: "assignment", status: "passed", summary: "Work completed" });
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), changed);
  assert.match(tasks(await loadState(root))[0].t.lastError ?? "", /stopped before executing npm run test:unit/);
  await assert.rejects(access(path.join(root, "changed-ran")), { code: "ENOENT" });
});

test("npm lifecycle injection is a policy change even when test body and command stay identical", async t => {
  const { root, check } = await setup(t, "package.json");
  await confirmWorker(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    pretest: "node -e \"require('fs').writeFileSync('injected-ran','yes')\"",
    "test:unit": "node -e \"require('fs').writeFileSync('original-ran','yes')\"",
  } }));
  const response = await reportNativeOutcome(root, "main", { batchId: "batch", assignmentId: "assignment", status: "passed", summary: "Work completed" });
  assert.match(response, /reconcile/);
  await assert.rejects(access(path.join(root, "injected-ran")), { code: "ENOENT" });
  const change = (await previewNativeReconciliation(root)).checks.changes[0];
  assert.notEqual(change.before?.fingerprint, change.after?.fingerprint);
  assert.match(change.after?.definition ?? "", /pretest.*injected-ran/s);
});

test("npm test alias uses the same approved effective definition as npm run test", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('original-ran','yes')\"" } }));
  const checks = await discoverRepoChecks(root);
  const state = await loadState(root);
  state.repoChecks = checks;
  state.milestones = parsePlan(plan(), checks);
  state.roadmapRevision = 1;
  const task = tasks(state)[0].t;
  task.verificationCommands = ["npm test"];
  task.verificationPlan = { requirements: [{ kind: "focused-tests", reason: "Task acceptance check", command: "npm test" }] };
  task.status = "running";
  state.phase = "executing";
  state.nativeBatch = { id: "batch", sessionId: "main", revision: 1, stage: "executing", assignments: [{ id: "assignment", key: "M001/S01/T01", status: "pending" }] };
  await saveState(root, state);
  await confirmWorker(root);
  await assertApprovedRepoCheck(root, await loadState(root), "npm test");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('changed-ran','yes')\"" } }));
  await reportNativeOutcome(root, "main", { batchId: "batch", assignmentId: "assignment", status: "passed", summary: "Work completed" });
  assert.match(tasks(await loadState(root))[0].t.lastError ?? "", /stopped before executing npm test/);
  await assert.rejects(access(path.join(root, "changed-ran")), { code: "ENOENT" });
});
