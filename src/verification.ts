import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoCheck, Task, VerificationKind, VerificationPlan } from "./types.ts";

type Scope = Pick<Task, "taskType" | "complexity" | "risk" | "affectedDomains" | "affectedFiles" | "dependencies" | "verificationCommands">;

/** Discovery reads declared project checks; it never executes a script or guesses installed tools. */
export async function discoverRepoChecks(root: string): Promise<RepoCheck[]> {
  const checks: RepoCheck[] = [];
  const add = (kind: RepoCheck["kind"], command: string, source: string) => {
    if (!checks.some(check => check.kind === kind && check.command === command)) checks.push({ kind, command, source });
  };
  const file = async (name: string) => readFile(path.join(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const pkg = await file("package.json");
  if (pkg) {
    const metadata: unknown = JSON.parse(pkg);
    const scripts: unknown = metadata && typeof metadata === "object" && "scripts" in metadata ? metadata.scripts : undefined;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      const defined = scripts as Record<string, unknown>;
      const script = (kind: RepoCheck["kind"], ...names: string[]) => {
        const name = names.find(name => { const value = defined[name]; return typeof value === "string" && Boolean(value.trim()); });
        if (name) add(kind, `npm run ${name}`, `package.json scripts.${name}`);
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
  const makefile = await file("Makefile") ?? await file("makefile");
  if (makefile) {
    const targets = new Set([...makefile.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map(match => match[1]));
    for (const [kind, names] of [
      ["focused-tests", ["test-unit", "test-focused"]], ["broader-tests", ["test", "check"]],
      ["typecheck", ["typecheck", "type-check"]], ["lint", ["lint"]], ["build", ["build"]],
      ["integration", ["test-integration", "integration", "test-e2e"]],
    ] as const) {
      const target = names.find(name => targets.has(name));
      if (target) add(kind, `make ${target}`, `Makefile target ${target}`);
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
  const integration = task.taskType === "integration" || task.affectedDomains.length > 1 || task.dependencies.length > 1;
  const broad = task.complexity === "COMPLEX" || integration;
  const codeChange = !["documentation", "reconnaissance", "planning-design", "research", "review", "security-review"].includes(task.taskType);
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
