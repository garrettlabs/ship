import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { applyOwnershipReconciliation, applyRepoCheckReconciliation, previewOwnershipReconciliation, previewRepoCheckReconciliation } from "../src/reconciliation.ts";
import { discoverRepoChecks } from "../src/verification.ts";
import type { ShipState, Task } from "../src/types.ts";

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function state(): ShipState {
  return { schemaVersion: 2, projectName: "fixture", phase: "idle", roadmapRevision: 0, milestones: [], paused: false,
    lastProgressAt: "", createdAt: "", updatedAt: "" } as ShipState;
}

test("ownership preview approves only reviewed resolved paths and preserves branch and other user work", async t => {
  const root = await fixture(t);
  git(root, "init", "-b", "main");
  await writeFile(path.join(root, "resolved.txt"), "original");
  await writeFile(path.join(root, "unrelated.txt"), "original");
  git(root, "add", ".");
  git(root, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "initial");
  await writeFile(path.join(root, "resolved.txt"), "user edit");
  await writeFile(path.join(root, "unrelated.txt"), "user edit");
  const existing = state();
  existing.preexistingWork = { branch: "main", paths: ["resolved.txt", "unrelated.txt"] };
  git(root, "add", "resolved.txt");
  git(root, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "resolve one");
  await writeFile(path.join(root, "new-user-work.txt"), "not owned");
  const preview = await previewOwnershipReconciliation(root, existing);
  assert.deepEqual(preview.eligiblePaths, ["resolved.txt"]);
  assert.deepEqual(preview.stillDirtyPaths, ["unrelated.txt"]);
  await assert.rejects(applyOwnershipReconciliation(root, existing, preview, ["new-user-work.txt"]), /Select previously dirty/);
  const replacement = await applyOwnershipReconciliation(root, existing, preview, ["resolved.txt"]);
  assert.deepEqual(replacement, { branch: "main", paths: ["unrelated.txt"] });
  assert.deepEqual(existing.preexistingWork?.paths, ["resolved.txt", "unrelated.txt"]);
});

test("ownership apply rejects stale content, newly dirty paths, branch and head changes", async t => {
  const root = await fixture(t);
  git(root, "init", "-b", "main");
  await writeFile(path.join(root, "old.txt"), "committed");
  git(root, "add", ".");
  git(root, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "initial");
  const existing = state();
  existing.preexistingWork = { branch: "main", paths: ["old.txt"] };
  const preview = await previewOwnershipReconciliation(root, existing);
  await writeFile(path.join(root, "new.txt"), "user edit");
  await assert.rejects(applyOwnershipReconciliation(root, existing, preview, ["old.txt"]), /Git state changed/);
  await rm(path.join(root, "new.txt"));
  await writeFile(path.join(root, "old.txt"), "new user edit");
  await assert.rejects(applyOwnershipReconciliation(root, existing, preview, ["old.txt"]), /Git state changed/);
  git(root, "checkout", "-b", "other");
  await assert.rejects(applyOwnershipReconciliation(root, existing, preview, ["old.txt"]), /Git state changed/);
  git(root, "checkout", "main");
  await writeFile(path.join(root, "old.txt"), "committed");
  await writeFile(path.join(root, "next.txt"), "next commit");
  git(root, "add", "next.txt");
  git(root, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "next");
  await assert.rejects(applyOwnershipReconciliation(root, existing, preview, ["old.txt"]), /Git state changed/);
});

test("replaced declared check requires approval, identifies affected evidence and rejects changed discovery", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const existing = state();
  existing.repoChecks = [{ kind: "broader-tests", command: "npm run test:all", source: "package.json scripts.test" }];
  existing.milestones = [{ id: "M1", title: "Milestone", outcome: "", status: "pending", slices: [{ id: "S1", title: "Slice", status: "pending", tasks: [{
    id: "T1", taskType: "implementation", complexity: "COMPLEX", risk: "LOW", affectedDomains: [], affectedFiles: [], dependencies: [], verificationCommands: [],
  } as unknown as Task] }] }];
  const preview = await previewRepoCheckReconciliation(root, existing);
  assert.deepEqual(preview.changes.map(change => ({ type: change.type, before: change.before, after: change.after && {
    kind: change.after.kind, command: change.after.command, source: change.after.source,
  } })), [{ type: "replaced", before: existing.repoChecks[0], after: { kind: "broader-tests", command: "npm run test", source: "package.json scripts.test" } }]);
  assert.deepEqual(preview.affectedTaskKeys, ["M1/S1/T1"]);
  assert.match(preview.evidenceInvalidation, /fresh verification/);
  await assert.rejects(applyRepoCheckReconciliation(root, existing, preview, false), /explicit approval/);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { "test:all": "node --test" } }));
  await assert.rejects(applyRepoCheckReconciliation(root, existing, preview, true), /changed since preview/);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const result = await applyRepoCheckReconciliation(root, existing, preview, true);
  assert.deepEqual(result.repoChecks, preview.discovered);
  assert.equal(existing.repoChecks[0].command, "npm run test:all");
});

test("unchanged declared policy needs no approval or evidence invalidation", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const existing = state();
  existing.repoChecks = await discoverRepoChecks(root);
  const preview = await previewRepoCheckReconciliation(root, existing);
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.affectedTaskKeys, []);
  assert.match(preview.evidenceInvalidation, /remains valid/);
  assert.deepEqual((await applyRepoCheckReconciliation(root, existing, preview, false)).repoChecks, existing.repoChecks);
});

test("a changed package script invalidates previously passed npm shorthand verification", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const existing = state();
  existing.repoChecks = await discoverRepoChecks(root);
  existing.milestones = [{ id: "M001", title: "Milestone", outcome: "", status: "complete", slices: [{
    id: "S01", title: "Slice", status: "complete", tasks: [{
      id: "T01", taskType: "test", complexity: "TRIVIAL", risk: "LOW", affectedDomains: [], affectedFiles: ["parser.test.js"],
      dependencies: [], verificationCommands: ["npm test"], status: "passed",
    } as unknown as Task],
  }] }];
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  const preview = await previewRepoCheckReconciliation(root, existing);
  assert.deepEqual(preview.affectedTaskKeys, ["M001/S01/T01"]);
  assert.equal(preview.changes[0]?.type, "replaced");
});
