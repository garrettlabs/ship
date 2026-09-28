import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RepoCheck, Task, VerificationKind, VerificationPlan } from "./types.ts";

type Scope = Pick<Task, "taskType" | "complexity" | "risk" | "affectedDomains" | "affectedFiles" | "dependencies" | "verificationCommands">;

/** Discovery reads declared project checks; it never executes a script or guesses installed tools. */
export async function discoverRepoChecks(root: string): Promise<RepoCheck[]> {
  const checks: RepoCheck[] = [];
  const add = (kind: RepoCheck["kind"], command: string, source: string, definition?: string, runner?: string, effective?: string) => {
    if (!checks.some(check => check.kind === kind && check.command === command)) {
      checks.push({ kind, command, source, ...(definition === undefined ? {} : {
        definition, runner, fingerprint: createHash("sha256").update(`${runner}\0${effective ?? definition}`).digest("hex"),
      }) });
    }
  };
  const file = async (name: string) => readFile(path.join(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const exists = async (name: string) => access(path.join(root, name)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const pkg = await file("package.json");
  if (pkg) {
    const metadata: unknown = JSON.parse(pkg);
    const manager = metadata && typeof metadata === "object" && "packageManager" in metadata && typeof metadata.packageManager === "string"
      ? /^(npm|pnpm|yarn|bun)@\S+$/.exec(metadata.packageManager)?.[1]
      : undefined;
    const lockManagers = manager ? [] : (await Promise.all([
      ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"], ["bun", "bun.lock"],
      ["bun", "bun.lockb"], ["npm", "package-lock.json"], ["npm", "npm-shrinkwrap.json"],
    ].map(async ([name, lock]) => await exists(lock) ? name : undefined))).filter((name): name is string => name !== undefined);
    const uniqueManagers = new Set(lockManagers);
    const scriptRunner = manager ?? (uniqueManagers.size > 1 ? undefined : lockManagers[0] ?? "npm");
    const scripts: unknown = metadata && typeof metadata === "object" && "scripts" in metadata ? metadata.scripts : undefined;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      const defined = scripts as Record<string, unknown>;
      const packageManager = metadata && typeof metadata === "object" && "packageManager" in metadata ? metadata.packageManager : undefined;
      const script = (kind: RepoCheck["kind"], ...names: string[]) => {
        const name = names.find(name => { const value = defined[name]; return typeof value === "string" && Boolean(value.trim()); });
        if (name && scriptRunner) add(kind, `${scriptRunner} run ${name}`, `package.json scripts.${name}`,
          JSON.stringify({ selectedScript: name, body: defined[name], scripts: defined, packageManager }, null, 2),
          scriptRunner, JSON.stringify([defined, packageManager]));
      };
      script("focused-tests", "test:unit", "test:focused");
      script("broader-tests", "test", "test:all");
      script("typecheck", "typecheck", "type-check", "check:types", "check-types");
      if (!checks.some(c => c.kind === "typecheck") && typeof defined.check === "string" && /\b(?:tsc|vue-tsc|svelte-check|mypy|pyright)\b/.test(defined.check)) script("typecheck", "check");
      script("lint", "lint", "lint:check");
      script("build", "build");
      script("integration", "test:integration", "integration", "test:e2e", "e2e");
    }
  }
  const makefileName = await file("Makefile") !== undefined ? "Makefile" : "makefile";
  const makefile = await file(makefileName);
  if (makefile && !/^\s*(?:-?include|sinclude)\s+/m.test(makefile)) {
    const declarations = [...makefile.matchAll(/^([a-zA-Z][\w-]*):(?!=)[^\r\n]*(?:\r?\n|$)/gm)];
    const targets = new Map<string, string>();
    for (let index = 0; index < declarations.length; index++) {
      const start = declarations[index].index;
      const end = declarations[index + 1]?.index ?? makefile.length;
      const lines = makefile.slice(start, end).split(/\r?\n/);
      const recipe = [lines[0], ...lines.slice(1).filter(line => line.startsWith("\t"))].join("\n");
      targets.set(declarations[index][1], recipe);
    }
    for (const [kind, names] of [
      ["focused-tests", ["test-unit", "test-focused"]], ["broader-tests", ["test", "check"]],
      ["typecheck", ["typecheck", "type-check"]], ["lint", ["lint"]], ["build", ["build"]],
      ["integration", ["test-integration", "integration", "test-e2e"]],
    ] as const) {
      const target = names.find(name => targets.has(name));
      if (target) add(kind, `make ${target}`, `${makefileName} target ${target}`,
        `Selected target ${target}:\n${targets.get(target)}\n\nEffective ${makefileName} (including local dependencies):\n${makefile}`,
        "make", makefile);
    }
  }
  if (await file("Cargo.toml")) {
    add("broader-tests", "cargo test", "Cargo.toml"); add("typecheck", "cargo check", "Cargo.toml");
    add("lint", "cargo clippy", "Cargo.toml"); add("build", "cargo build", "Cargo.toml");
  }
  if (await file("go.mod")) {
    add("broader-tests", "go test ./...", "go.mod"); add("lint", "go vet ./...", "go.mod");
    add("build", "go build ./...", "go.mod");
  }
  if (await exists("pom.xml")) {
    const mvn = await exists(process.platform === "win32" ? "mvnw.cmd" : "mvnw")
      ? process.platform === "win32" ? "./mvnw.cmd" : "./mvnw"
      : "mvn";
    add("broader-tests", `${mvn} test`, "pom.xml");
    add("build", `${mvn} package`, "pom.xml");
  }
  const gradleFile = await exists("build.gradle") ? "build.gradle"
    : await exists("build.gradle.kts") ? "build.gradle.kts" : undefined;
  if (gradleFile) {
    const gradle = await exists(process.platform === "win32" ? "gradlew.bat" : "gradlew")
      ? process.platform === "win32" ? "./gradlew.bat" : "./gradlew"
      : "gradle";
    const build = (await file(gradleFile))!.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
    const javaPlugin = /\b(?:id\s*(?:\(\s*)?["']java(?:-library)?["']|apply\s*(?:\(\s*plugin\s*=\s*|plugin\s*:\s*)["']java(?:-library)?["']|\bjava\b(?=\s*(?:\}|$)))/m.test(build);
    const declaredTest = /\b(?:tasks\s*\.\s*(?:register|create)\s*(?:<[^>]+>)?\s*\(\s*["']test["']|task\s*(?:\(\s*["']test["']|\s+test\b))/.test(build);
    const workflows = await readdir(path.join(root, ".github", "workflows")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const ciTest = (await Promise.all(workflows.filter(name => /\.ya?ml$/.test(name)).sort().slice(0, 24)
      .map(name => file(path.join(".github", "workflows", name))))).some(content =>
      content && /^\s*(?:-\s*)?(?:run:\s*)?(?:\.\/gradlew(?:\.bat)?|gradle)\s+test(?:\s|$)/m.test(content));
    if (javaPlugin || declaredTest || ciTest) add("broader-tests", `${gradle} test`, gradleFile);
    add("build", `${gradle} build`, gradleFile);
  }
  const pyproject = await file("pyproject.toml");
  if (pyproject) {
    if (/^\[tool\.pytest(?:\.|\])/m.test(pyproject)) add("broader-tests", "python -m pytest", "pyproject.toml [tool.pytest]");
    if (/^\[tool\.mypy(?:\.|\])/m.test(pyproject)) add("typecheck", "python -m mypy .", "pyproject.toml [tool.mypy]");
    if (/^\[tool\.ruff(?:\.|\])/m.test(pyproject)) add("lint", "python -m ruff check .", "pyproject.toml [tool.ruff]");
  }
  return checks;
}

export function routeVerification(task: Scope, checks: readonly RepoCheck[] = []): VerificationPlan {
  const requirements: VerificationPlan["requirements"] = [];
  const require = (kind: VerificationKind, reason: string, command?: string) => requirements.push({ kind, reason, ...(command ? { command } : {}) });
  for (const command of task.verificationCommands) require("focused-tests", "Task-specific acceptance check", command);
  const lightweight = task.complexity === "TRIVIAL" && task.risk === "LOW";
  const codeChange = !["documentation", "reconnaissance", "planning-design", "research", "review", "security-review"].includes(task.taskType);
  const integration = codeChange && (task.taskType === "integration" || task.affectedDomains.length > 1 || task.dependencies.length > 1);
  const broad = task.complexity === "COMPLEX" || integration;
  for (const check of checks) {
    if (lightweight && check.kind !== "focused-tests") continue;
    if (check.kind === "focused-tests" && !codeChange) continue;
    if (check.kind === "broader-tests" && !broad) continue;
    if (["typecheck", "lint", "build"].includes(check.kind) && !codeChange) continue;
    if (check.kind === "integration" && !integration) continue;
    require(check.kind, `${check.source}; ${integration ? "cross-component integration" : broad ? "complex change" : "affected code surface"}`, check.command);
  }
  if (integration && !requirements.some(r => r.kind === "integration")) require("integration", "Cross-component integration needs explicit validation evidence");
  if (task.risk === "HIGH") require("security-review", "High-risk security or data-safety signals require security-focused review");
  else if (task.complexity === "COMPLEX") require("independent-review", "Complex work requires an independent reviewer");
  return { requirements };
}

/** A review has no executable command: until a separate evidence producer exists it cannot pass. */
export function missingVerification(plan: VerificationPlan, results: readonly { command: string; ok: boolean }[]): string[] {
  return plan.requirements.filter(requirement => !requirement.command || !results.some(result => result.command === requirement.command && result.ok))
    .map(requirement => `${requirement.kind}: ${requirement.reason}`);
}
