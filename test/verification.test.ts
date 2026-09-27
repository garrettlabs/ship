import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Controller } from "../src/controller.ts";
import { git } from "../src/git.ts";
import { parsePlan } from "../src/model.ts";
import { loadState, shipDir } from "../src/store.ts";
import { discoverRepoChecks, missingVerification, routeVerification } from "../src/verification.ts";
import { fixture, plan, ScriptWorker, write } from "./helpers.ts";

const planned = (patch: Record<string, unknown> = {}) => {
  const raw = JSON.parse(plan()); Object.assign(raw.milestones[0].slices[0].tasks[0], patch);
  return parsePlan(JSON.stringify(raw))[0].slices[0].tasks[0];
};

test("discovers declared checks across project configurations without assuming a single stack", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-check-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { "test:unit": "node unit.js", test: "node all.js", typecheck: "tsc --noEmit", lint: "eslint .", build: "vite build", "test:integration": "node integration.js" } }));
  await writeFile(path.join(root, "Makefile"), "test-e2e:\n\t@true\n");
  await writeFile(path.join(root, "pyproject.toml"), "[tool.ruff]\nline-length = 88\n[tool.pytest.ini_options]\n");
  const checks = await discoverRepoChecks(root);
  assert.deepEqual(checks.filter(c => c.source.startsWith("package.json")).map(c => [c.kind, c.command]), [
    ["focused-tests", "npm run test:unit"], ["broader-tests", "npm run test"], ["typecheck", "npm run typecheck"],
    ["lint", "npm run lint"], ["build", "npm run build"], ["integration", "npm run test:integration"],
  ]);
  assert.ok(checks.some(c => c.kind === "integration" && c.command === "make test-e2e"));
  assert.ok(checks.some(c => c.kind === "lint" && c.command === "python -m ruff check ."));
  assert.ok(checks.some(c => c.kind === "broader-tests" && c.command === "python -m pytest"));
});

test("verification distinguishes trivial docs, ordinary code, complex integration and security risk", () => {
  const checks = [
    { kind: "focused-tests", command: "npm run test:unit", source: "scripts.test:unit" },
    { kind: "broader-tests", command: "npm test", source: "scripts.test" },
    { kind: "typecheck", command: "npm run typecheck", source: "scripts.typecheck" },
    { kind: "lint", command: "npm run lint", source: "scripts.lint" },
    { kind: "build", command: "npm run build", source: "scripts.build" },
    { kind: "integration", command: "npm run test:integration", source: "scripts.test:integration" },
  ] as const;
  const docs = planned({ taskType: "documentation", uncertainty: "LOW", affectedFiles: ["README.md"] });
  assert.deepEqual(routeVerification(docs, checks).requirements.map(r => r.kind), ["focused-tests"]);
  const code = planned({ taskType: "implementation", uncertainty: "LOW", affectedFiles: ["src/a.ts"] });
  assert.deepEqual(routeVerification(code, checks).requirements.map(r => r.kind), ["focused-tests", "focused-tests", "typecheck", "lint", "build"]);
  const complex = planned({ taskType: "implementation", uncertainty: "LOW", affectedDomains: ["api", "ui"] });
  assert.deepEqual(routeVerification(complex, checks).requirements.map(r => r.kind), ["focused-tests", "focused-tests", "broader-tests", "typecheck", "lint", "build", "integration", "independent-review"]);
  const sensitive = planned({ taskType: "implementation", uncertainty: "LOW", goal: "change authentication permissions", affectedDomains: ["api", "ui"] });
  assert.equal(sensitive.risk, "HIGH");
  assert.deepEqual(routeVerification(sensitive, checks).requirements.map(r => r.kind).slice(-1), ["security-review"]);
  assert.equal(routeVerification(sensitive, checks).requirements.some(r => r.kind === "independent-review"), false);
  assert.match(routeVerification(sensitive, checks).requirements.at(-1)!.reason, /High-risk/);
  assert.deepEqual(missingVerification(routeVerification(sensitive, checks), []), routeVerification(sensitive, checks).requirements.map(r => `${r.kind}: ${r.reason}`));
  const withoutIntegration = routeVerification(complex, []);
  assert.ok(withoutIntegration.requirements.some(r => r.kind === "integration" && !r.command));
});

test("native checks are frozen, executed and recorded before an ordinary task can pass", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { "test:unit": "node -e \"process.exit(0)\"", typecheck: "node -e \"process.exit(0)\"" } }));
  await git(root, ["add", "package.json"]); await git(root, ["commit", "-m", "add checks"]);
  const raw = JSON.parse(plan()); Object.assign(raw.milestones[0].slices[0].tasks[0], { taskType: "implementation", uncertainty: "LOW", affectedFiles: ["file1.txt"] });
  const c = new Controller(root, new ScriptWorker([{ ok: true, text: JSON.stringify(raw) }, write()]));
  assert.equal(await c.run(), "complete");
  const state = await loadState(root);
  const task = state.milestones[0].slices[0].tasks[0];
  assert.deepEqual(task.verificationPlan.requirements.map(r => r.kind), ["focused-tests", "focused-tests", "typecheck"]);
  const evidence = JSON.parse(await readFile(path.join(shipDir(root), "attempts/M001-S01-T01-a1.verification.json"), "utf8"));
  assert.deepEqual(evidence.checks.map((check: { command: string }) => check.command), task.verificationPlan.requirements.map(r => r.command));
  assert.equal(evidence.passed, true);
});

test("required independent review without review evidence cannot become verified success", async t => {
  const root = await fixture(t);
  const raw = JSON.parse(plan()); Object.assign(raw.milestones[0].slices[0].tasks[0], { taskType: "implementation", uncertainty: "LOW", affectedFiles: ["a", "b", "c", "d"] });
  const c = new Controller(root, new ScriptWorker([{ ok: true, text: JSON.stringify(raw) }, write()]));
  assert.equal(await c.run(), "blocked");
  const state = await loadState(root), task = state.milestones[0].slices[0].tasks[0];
  assert.equal(task.status, "verifying");
  assert.match(state.blockedReason!, /independent-review/);
  const evidence = JSON.parse(await readFile(path.join(shipDir(root), "attempts/M001-S01-T01-a1.verification.json"), "utf8"));
  assert.equal(evidence.passed, false);
  assert.equal(await git(state.workspace!.path, ["rev-list", "--count", "HEAD"]), "1");
});

test("high-risk changes require security review and integration without a check cannot pass", async t => {
  const root = await fixture(t);
  const raw = JSON.parse(plan()); Object.assign(raw.milestones[0].slices[0].tasks[0], {
    taskType: "integration", uncertainty: "LOW", goal: "update authentication across api and ui",
    affectedDomains: ["api", "ui"],
  });
  const c = new Controller(root, new ScriptWorker([{ ok: true, text: JSON.stringify(raw) }, write()]));
  assert.equal(await c.run(), "blocked");
  const state = await loadState(root), task = state.milestones[0].slices[0].tasks[0];
  assert.equal(task.status, "verifying");
  assert.equal(task.verificationPlan.requirements.some(r => r.kind === "independent-review"), false);
  assert.match(state.blockedReason!, /integration:.*security-review:/);
  const evidence = JSON.parse(await readFile(path.join(shipDir(root), "attempts/M001-S01-T01-a1.verification.json"), "utf8"));
  assert.equal(evidence.passed, false);
});
