import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePlan } from "../src/model.ts";
import { discoverRepoChecks, missingVerification, routeVerification } from "../src/verification.ts";
import { plan } from "./helpers.ts";

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
test("package scripts use the declared manager ahead of lockfiles and never guess missing scripts", async t => {
  for (const [name, packageManager, lockfile, expected] of [
    ["pnpm field", "pnpm@9.12.0", "package-lock.json", "pnpm"],
    ["yarn field", "yarn@4.5.0", "pnpm-lock.yaml", "yarn"],
    ["bun field", "bun@1.2.0", "yarn.lock", "bun"],
    ["npm field", "npm@10.9.0", "bun.lockb", "npm"],
    ["pnpm lock", undefined, "pnpm-lock.yaml", "pnpm"],
    ["yarn lock", undefined, "yarn.lock", "yarn"],
    ["bun lock", undefined, "bun.lock", "bun"],
    ["bun binary lock", undefined, "bun.lockb", "bun"],
    ["npm lock", undefined, "package-lock.json", "npm"],
    ["npm shrinkwrap", undefined, "npm-shrinkwrap.json", "npm"],
  ] as const) {
    await t.test(name, async t => {
      const root = await mkdtemp(path.join(os.tmpdir(), "ship-check-manager-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        ...(packageManager ? { packageManager } : {}),
        scripts: { test: "node --test", build: "node build.js", lint: " " },
      }));
      await writeFile(path.join(root, lockfile), "");
      assert.deepEqual((await discoverRepoChecks(root)).map(check => [check.kind, check.command]), [
        ["broader-tests", `${expected} run test`],
        ["build", `${expected} run build`],
      ]);
    });
  }
});

test("conflicting manager locks do not invent a package script runner", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-check-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  await writeFile(path.join(root, "pnpm-lock.yaml"), "");
  await writeFile(path.join(root, "yarn.lock"), "");
  assert.deepEqual(await discoverRepoChecks(root), []);
});

test("conventional ecosystem checks require their build configuration", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-check-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = 'example'\n");
  assert.deepEqual(await discoverRepoChecks(root), []);
  await writeFile(path.join(root, "pom.xml"), "<project />");
  await writeFile(path.join(root, "mvnw.cmd"), "");
  await writeFile(path.join(root, "mvnw"), "");
  await writeFile(path.join(root, "build.gradle.kts"), "plugins { java }");
  await writeFile(path.join(root, "gradlew.bat"), "");
  await writeFile(path.join(root, "gradlew"), "");
  const mvn = process.platform === "win32" ? "./mvnw.cmd" : "./mvnw";
  const gradle = process.platform === "win32" ? "./gradlew.bat" : "./gradlew";
  assert.deepEqual((await discoverRepoChecks(root)).map(check => [check.kind, check.command, check.source]), [
    ["broader-tests", `${mvn} test`, "pom.xml"],
    ["build", `${mvn} package`, "pom.xml"],
    ["broader-tests", `${gradle} test`, "build.gradle.kts"],
    ["build", `${gradle} build`, "build.gradle.kts"],
  ]);
});

test("Gradle base plugin does not invent a test task; declared tasks, Java plugins and CI do", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-check-gradle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = path.join(root, "build.gradle.kts");
  const checks = async () => (await discoverRepoChecks(root)).map(({ kind, command }) => [kind, command]);
  await writeFile(build, "plugins { base }\n// tasks.register(\"test\")\n");
  assert.deepEqual(await checks(), [["build", "gradle build"]]);
  await writeFile(build, "plugins { base }\ntasks.register(\"test\") { doLast { println(\"ok\") } }\n");
  assert.deepEqual(await checks(), [["broader-tests", "gradle test"], ["build", "gradle build"]]);
  await writeFile(build, "plugins { id(\"java\") }\n");
  assert.deepEqual(await checks(), [["broader-tests", "gradle test"], ["build", "gradle build"]]);
  await writeFile(build, "plugins { base }\n");
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "jobs:\n  test:\n    steps:\n      - run: ./gradlew test\n");
  assert.deepEqual(await checks(), [["broader-tests", "gradle test"], ["build", "gradle build"]]);
});

test("Cargo, Go and declared Make targets expose bounded checks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-check-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "Cargo.toml"), "[package]\nname = 'example'\n");
  await writeFile(path.join(root, "go.mod"), "module example.com/project\n");
  await writeFile(path.join(root, "Makefile"), "test-unit:\n\t@true\nbuild:\n\t@true\n");
  assert.deepEqual((await discoverRepoChecks(root)).map(check => [check.kind, check.command]), [
    ["focused-tests", "make test-unit"], ["build", "make build"],
    ["broader-tests", "cargo test"], ["typecheck", "cargo check"], ["lint", "cargo clippy"], ["build", "cargo build"],
    ["broader-tests", "go test ./..."], ["lint", "go vet ./..."], ["build", "go build ./..."],
  ]);
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
