import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { gitDirtySnapshot, readProjectProfile, refreshProjectProfile } from "../src/project-profile.ts";

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-project-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("discovers declared conventions, workspace layout, CI, migrations and executable checks without touching source", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "packages", "server", "prisma"), { recursive: true });
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "Rules for agents");
  await writeFile(path.join(root, "CLAUDE.md"), "Other rules");
  await writeFile(path.join(root, "README.md"), "Existing readme");
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { test: "vitest", typecheck: "tsc --noEmit", lint: "eslint .", build: "tsc" }, dependencies: { next: "*" } }));
  await writeFile(path.join(root, "packages", "server", "package.json"), JSON.stringify({ dependencies: { "@prisma/client": "*" } }));
  await writeFile(path.join(root, "packages", "server", "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" }");
  await writeFile(path.join(root, ".github", "workflows", "test.yml"), "name: CI\n");
  const profile = await readProjectProfile(root);
  assert.deepEqual(profile.facts.commands, { test: "pnpm run test", typecheck: "pnpm run typecheck", lint: "pnpm run lint", build: "pnpm run build" });
  assert.deepEqual(profile.facts.instructions, ["AGENTS.md", "CLAUDE.md", "README.md"]);
  assert.ok(profile.facts.ecosystems.includes("workspace"));
  assert.ok(profile.facts.ecosystems.includes("Next.js"));
  assert.ok(profile.facts.layout.includes("packages/server"));
  assert.deepEqual(profile.facts.ci, [".github/workflows/test.yml"]);
  assert.ok(profile.facts.migrations.includes("Prisma"));
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Existing readme");
  assert.deepEqual(await readProjectProfile(root), profile);
});

test("ignores files beside workspace packages on the first profile read", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "packages", "server"), { recursive: true });
  await writeFile(path.join(root, "packages", "README.md"), "Workspace overview");
  await writeFile(path.join(root, "packages", "server", "package.json"), JSON.stringify({ dependencies: { express: "*" } }));
  const profile = await readProjectProfile(root);
  assert.ok(profile.facts.layout.includes("packages/server"));
  assert.ok(!profile.facts.layout.includes("packages/README.md"));
  assert.ok(profile.facts.ecosystems.includes("Express"));
  assert.ok(profile.sourceFingerprints["packages/server/package.json"]);
});

test("refreshes changed provenance, deleted instructions and malformed cache without inventing checks", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await writeFile(path.join(root, "AGENTS.md"), "No assumptions");
  const initial = await readProjectProfile(root);
  assert.deepEqual(initial.facts.commands, { test: "npm run test" });
  assert.ok(initial.unknowns.includes("Build command not discovered"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
  await rm(path.join(root, "AGENTS.md"));
  await writeFile(path.join(root, "CLAUDE.md"), "Keep local conventions");
  const refreshed = await readProjectProfile(root);
  assert.deepEqual(refreshed.facts.commands, { build: "npm run build" });
  assert.deepEqual(refreshed.facts.instructions, ["CLAUDE.md"]);
  assert.notEqual(initial.sourceFingerprints["package.json"], refreshed.sourceFingerprints["package.json"]);
  assert.equal(refreshed.sourceFingerprints["AGENTS.md"], undefined);
  await writeFile(path.join(root, ".ship", "project-profile.json"), "{invalid");
  assert.deepEqual(await readProjectProfile(root), refreshed);
  await writeFile(path.join(root, ".ship", "project-profile.json"), JSON.stringify({ schemaVersion: 1, sourceFingerprints: refreshed.sourceFingerprints, facts: {} }));
  assert.deepEqual(await refreshProjectProfile(root), refreshed);
});

test("does not guess script runner on ambiguous lockfiles", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  await writeFile(path.join(root, "yarn.lock"), "");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  const ambiguous = await readProjectProfile(root);
  assert.equal(ambiguous.facts.commands.test, undefined);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0", scripts: { test: "vitest" } }));
  const declared = await readProjectProfile(root);
  assert.equal(declared.facts.commands.test, "yarn run test");
});

test("refreshes test-config, workflow, scoped instruction and source-layout provenance", async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, "apps", "client"), { recursive: true });
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, "vitest.config.ts"), "export default { test: {} }");
  const first = await readProjectProfile(root);
  await writeFile(path.join(root, "vitest.config.ts"), "export default { test: { watch: false } }");
  await writeFile(path.join(root, "apps", "client", "AGENTS.md"), "Client-specific instructions");
  await mkdir(path.join(root, "src", "billing"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "ci.yaml"), "name: CI");
  const updated = await readProjectProfile(root);
  assert.notEqual(updated.sourceFingerprints["vitest.config.ts"], first.sourceFingerprints["vitest.config.ts"]);
  assert.deepEqual(updated.facts.instructions, ["apps/client/AGENTS.md"]);
  assert.ok(updated.facts.layout.includes("src/billing"));
  assert.deepEqual(updated.facts.ci, [".github/workflows/ci.yaml"]);
  assert.deepEqual(updated.facts.commands, {});
});

test("reports transient Git changes including rename origins, nested untracked files and bounded overflow", async t => {
  const root = await fixture(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(path.join(root, "original.txt"), "tracked");
  execFileSync("git", ["add", "original.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "initial"], { cwd: root });
  execFileSync("git", ["mv", "original.txt", "renamed.txt"], { cwd: root });
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "new.txt"), "user work");
  const current = await gitDirtySnapshot(root);
  assert.equal(current.branch, "main");
  assert.equal(current.dirty, true);
  assert.deepEqual(current.paths.sort(), ["nested/new.txt", "original.txt", "renamed.txt"]);
  assert.equal(current.truncated, undefined);
  for (let index = 0; index < 260; index++) await writeFile(path.join(root, "nested", `file-${index}.txt`), "x");
  const overflow = await gitDirtySnapshot(root);
  assert.equal(overflow.truncated, true);
  assert.equal(overflow.dirty, true);
  assert.equal(overflow.paths.length, 256);
  assert.equal(await readFile(path.join(root, "nested", "new.txt"), "utf8"), "user work");
});

test("non-Git directories explicitly report unknown Git state", async t => {
  const root = await fixture(t);
  assert.deepEqual(await gitDirtySnapshot(root), { branch: null, paths: [], dirty: false, unknown: true });
});

test("workspace overflow invalidates cache and declares uninspected scoped instructions unknown", async t => {
  const root = await fixture(t);
  for (let index = 0; index < 24; index++) await mkdir(path.join(root, "apps", `app-${String(index).padStart(2, "0")}`), { recursive: true });
  const initial = await readProjectProfile(root);
  await mkdir(path.join(root, "apps", "z-last"), { recursive: true });
  await writeFile(path.join(root, "apps", "z-last", "AGENTS.md"), "Specific instructions");
  const changed = await readProjectProfile(root);
  assert.notEqual(changed.sourceFingerprints["@layout"], initial.sourceFingerprints["@layout"]);
  assert.ok(changed.unknowns.some(value => /workspace directories not inspected.*instructions.*unknown/.test(value)));
  assert.equal(changed.facts.instructions.includes("apps/z-last/AGENTS.md"), false);
  await mkdir(path.join(root, "apps", "zz-last"), { recursive: true });
  assert.notEqual((await readProjectProfile(root)).sourceFingerprints["@layout"], changed.sourceFingerprints["@layout"]);
});
