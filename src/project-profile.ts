import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "./store.ts";

export interface ProjectProfile {
  schemaVersion: 1;
  sourceFingerprints: Record<string, string>;
  facts: {
    ecosystems: string[];
    packageManagers: string[];
    commands: Record<string, string>;
    instructions: string[];
    ci: string[];
    layout: string[];
    migrations: string[];
  };
  unknowns: string[];
}

export interface GitDirtySnapshot { branch: string | null; paths: string[]; dirty: boolean; truncated?: boolean; unknown?: boolean; }

const SOURCE_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", "README", "package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", "lerna.json", "nx.json", "turbo.json", "tsconfig.json", "vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts", "vite.config.ts", "vite.config.js", "pytest.ini", "tox.ini", "Makefile", "makefile", "pyproject.toml", "poetry.lock", "uv.lock", "requirements.txt", "Pipfile", "Cargo.toml", "Cargo.lock", "go.mod", "go.work", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew", "Gemfile", "Gemfile.lock", "composer.json", "mix.exs", "Dockerfile", "prisma/schema.prisma", "drizzle.config.ts", "drizzle.config.js", "alembic.ini"] as const;
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", "README"];
const SCOPED_NAMES = ["AGENTS.md", "CLAUDE.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "prisma/schema.prisma"];
const LIMIT = 64 * 1024;
const profilePath = (root: string) => path.join(root, ".ship", "project-profile.json");
const unique = (values: string[]) => [...new Set(values)];

async function names(root: string, relative: string, directoriesOnly = false): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    return entries.filter(entry => !entry.isSymbolicLink() && (!directoriesOnly || entry.isDirectory()) && entry.name !== ".ship" && entry.name !== "node_modules" && entry.name !== ".git")
      .map(entry => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function source(root: string, relative: string): Promise<{ fingerprint: string; text: string } | undefined> {
  const filename = path.join(root, relative);
  try {
    const stat = await lstat(filename);
    if (!stat.isFile()) return undefined;
    const handle = await open(filename, "r");
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, LIMIT));
    let bytesRead = 0;
    try { if (buffer.length) ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0)); } finally { await handle.close(); }
    const content = buffer.subarray(0, bytesRead);
    return { fingerprint: `${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(content).digest("hex")}`, text: content.toString("utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type Snapshot = { fingerprints: Record<string, string>; contents: Record<string, string>; layout: string[]; overflow: string[] };
async function inspect(root: string): Promise<Snapshot> {
  const fingerprints: Record<string, string> = {};
  const contents: Record<string, string> = {};
  const rootNames = await names(root, ".");
  // Only root, conventional source/workspace directories and CI workflow names are listed.
  const directories = ["src", "lib", "app", "apps", "packages", "services", "api", "web", "test", "tests", "spec", "migrations", "db", "database"];
  const layout = rootNames.filter(name => directories.includes(name));
  const rootCandidates = [...SOURCE_NAMES, ...rootNames.filter(name => /\.(?:sln|slnx|csproj)$/.test(name)).slice(0, 16)];
  const paths = [...rootCandidates];
  const overflow: string[] = [];
  const workspaceNames: Record<string, string[]> = {};
  for (const directory of ["apps", "packages", "services"]) {
    const all = await names(root, directory, true);
    workspaceNames[directory] = all;
    if (all.length > 24) overflow.push(`${directory}: ${all.length - 24} workspace directories not inspected; scoped instructions and project checks unknown`);
    const children = all.slice(0, 24);
    layout.push(...children.map(child => `${directory}/${child}`));
    for (const child of children) paths.push(...SCOPED_NAMES.map(name => `${directory}/${child}/${name}`));
  }
  for (const directory of ["src", "lib", "app", "test", "tests", "migrations", "db", "database"]) {
    const children = (await names(root, directory)).slice(0, 32);
    layout.push(...children.map(child => `${directory}/${child}`));
  }
  const workflows = (await names(root, ".github/workflows")).filter(name => /\.ya?ml$/.test(name));
  if (workflows.length > 24) overflow.push(`${workflows.length - 24} CI workflows not inspected; additional checks unknown`);
  paths.push(...workflows.slice(0, 24).map(name => `.github/workflows/${name}`));
  fingerprints["@layout"] = createHash("sha256").update(JSON.stringify({ layout, workspaceNames })).digest("hex");
  fingerprints["@workflows"] = createHash("sha256").update(JSON.stringify(workflows)).digest("hex");
  for (const relative of unique(paths)) {
    const entry = await source(root, relative);
    if (entry) { fingerprints[relative] = entry.fingerprint; contents[relative] = entry.text; }
  }
  return { fingerprints, contents, layout, overflow };
}

function discover(snapshot: Snapshot): ProjectProfile["facts"] {
  const { contents, layout } = snapshot;
  const present = (name: string) => Object.hasOwn(contents, name);
  const ecosystems: string[] = [], packageManagers: string[] = [], migrations: string[] = [];
  const commands: Record<string, string> = {};
  const instructions: string[] = [];
  const scoped = Object.keys(contents).filter(name => /^(?:apps|packages|services)\/[^/]+\//.test(name));
  for (const name of INSTRUCTION_NAMES) if (present(name)) instructions.push(name);
  for (const name of scoped.filter(name => /\/(?:AGENTS|CLAUDE)\.md$/.test(name)).sort()) instructions.push(name);
  const packages = ["package.json", ...scoped.filter(name => name.endsWith("/package.json"))];
  const rootPackage = (() => { try { return JSON.parse(contents["package.json"]) as { packageManager?: unknown }; } catch { return {}; } })();
  const declaredManager = typeof rootPackage.packageManager === "string" ? rootPackage.packageManager.split("@")[0] : undefined;
  const lockManagers = unique([
    ...(present("pnpm-lock.yaml") || present("pnpm-workspace.yaml") ? ["pnpm"] : []),
    ...(present("yarn.lock") ? ["yarn"] : []),
    ...(present("bun.lock") || present("bun.lockb") ? ["bun"] : []),
    ...(present("package-lock.json") ? ["npm"] : []),
  ]);
  const runner = ["pnpm", "yarn", "bun", "npm"].includes(declaredManager ?? "") ? declaredManager : lockManagers.length === 1 ? lockManagers[0] : lockManagers.length ? undefined : "npm";
  for (const filename of packages) {
    if (!present(filename)) continue;
    ecosystems.push("JavaScript/TypeScript");
    try {
      const pkg: unknown = JSON.parse(contents[filename]);
      if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
        const data = pkg as Record<string, unknown>;
        if (typeof data.packageManager === "string") packageManagers.push(data.packageManager.split("@")[0]);
        if (data.workspaces || present("pnpm-workspace.yaml")) ecosystems.push("workspace");
        const dependencies = { ...(data.dependencies && typeof data.dependencies === "object" ? data.dependencies : {}), ...(data.devDependencies && typeof data.devDependencies === "object" ? data.devDependencies : {}) } as Record<string, unknown>;
        for (const [dependency, framework] of [["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["@angular/core", "Angular"], ["svelte", "Svelte"], ["express", "Express"], ["fastify", "Fastify"], ["prisma", "Prisma"], ["@prisma/client", "Prisma"], ["drizzle-orm", "Drizzle"]]) if (dependency in dependencies) ecosystems.push(framework);
        if ("prisma" in dependencies) migrations.push("Prisma");
        if ("drizzle-orm" in dependencies) migrations.push("Drizzle");
        if (filename === "package.json" && data.scripts && typeof data.scripts === "object" && !Array.isArray(data.scripts) && runner) {
          const scripts = data.scripts as Record<string, unknown>;
          for (const [kind, scriptNames] of Object.entries({ test: ["test", "test:unit", "test:focused"], typecheck: ["typecheck", "type-check", "check:types", "check-types"], lint: ["lint", "lint:check"], build: ["build"] })) {
            const script = scriptNames.find(name => typeof scripts[name] === "string" && (scripts[name] as string).trim());
            if (script) commands[kind] = `${runner} run ${script}`;
          }
        }
      }
    } catch { /* Invalid project metadata is not a known fact. */ }
  }
  packageManagers.push(...(declaredManager ? [declaredManager] : lockManagers));
  for (const [config, language, manager] of [["pyproject.toml", "Python", "pip"], ["Cargo.toml", "Rust", "cargo"], ["go.mod", "Go", "go"], ["pom.xml", "Java", "Maven"], ["build.gradle", "Java", "Gradle"], ["build.gradle.kts", "Kotlin", "Gradle"], ["Gemfile", "Ruby", "Bundler"], ["composer.json", "PHP", "Composer"], ["mix.exs", "Elixir", "Mix"]]) if (present(config)) { ecosystems.push(language); packageManagers.push(manager); }
  if (present("uv.lock")) packageManagers.push("uv");
  if (present("poetry.lock")) packageManagers.push("Poetry");
  if (present("pyproject.toml")) {
    const py = contents["pyproject.toml"];
    if (/^\[tool\.pytest(?:\.|\])/m.test(py)) commands.test ??= "python -m pytest";
    if (/^\[tool\.mypy(?:\.|\])/m.test(py)) commands.typecheck ??= "python -m mypy .";
    if (/^\[tool\.ruff(?:\.|\])/m.test(py)) commands.lint ??= "python -m ruff check .";
    if (/^\[tool\.alembic(?:\.|\])/m.test(py)) migrations.push("Alembic");
  }
  if (present("Cargo.toml")) { commands.test ??= "cargo test"; commands.typecheck ??= "cargo check"; commands.build ??= "cargo build"; }
  if (present("go.mod")) { commands.test ??= "go test ./..."; commands.build ??= "go build ./..."; }
  if (present("Makefile") || present("makefile")) {
    const make = contents["Makefile"] ?? contents["makefile"];
    const targets = new Set([...make.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)].map(match => match[1]));
    for (const [kind, options] of Object.entries({ test: ["test", "check"], typecheck: ["typecheck", "type-check"], lint: ["lint"], build: ["build"] })) {
      const target = options.find(name => targets.has(name));
      if (target) commands[kind] ??= `make ${target}`;
    }
  }
  if (present("prisma/schema.prisma") || scoped.some(name => name.endsWith("/prisma/schema.prisma"))) migrations.push("Prisma");
  if (present("drizzle.config.ts") || present("drizzle.config.js")) migrations.push("Drizzle");
  if (present("alembic.ini")) migrations.push("Alembic");
  if (layout.includes("migrations")) migrations.push("migrations/");
  const ci = Object.keys(contents).filter(name => name.startsWith(".github/workflows/"));
  return { ecosystems: unique(ecosystems), packageManagers: unique(packageManagers), commands, instructions, ci, layout, migrations: unique(migrations) };
}

function valid(value: unknown): value is ProjectProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Partial<ProjectProfile>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === "string");
  const record = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(item => typeof item === "string");
  const f = p.facts;
  return p.schemaVersion === 1 && record(p.sourceFingerprints) && !!f && strings(f.ecosystems) && strings(f.packageManagers) && record(f.commands) && strings(f.instructions) && strings(f.ci) && strings(f.layout) && strings(f.migrations) && strings(p.unknowns);
}

/** Recheck only bounded provenance sources; never use a cached fact after its source changed. */
export async function readProjectProfile(root: string): Promise<ProjectProfile> {
  const snapshot = await inspect(root);
  try {
    const cached: unknown = JSON.parse(await readFile(profilePath(root), "utf8"));
    if (valid(cached) && JSON.stringify(cached.sourceFingerprints) === JSON.stringify(snapshot.fingerprints)) return cached;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return persist(root, snapshot);
}

async function persist(root: string, snapshot: Snapshot): Promise<ProjectProfile> {
  const facts = discover(snapshot);
  const unknowns = ["Architectural boundaries require task-specific reconnaissance", ...snapshot.overflow];
  if (!facts.commands.test) unknowns.push("Test command not discovered");
  if (!facts.commands.typecheck) unknowns.push("Typecheck command not discovered");
  if (!facts.commands.lint) unknowns.push("Lint command not discovered");
  if (!facts.commands.build) unknowns.push("Build command not discovered");
  const profile: ProjectProfile = { schemaVersion: 1, sourceFingerprints: snapshot.fingerprints, facts, unknowns };
  await atomicJson(profilePath(root), profile);
  return profile;
}

/** Explicit refresh and malformed-profile recovery; leaves repository sources untouched. */
export async function refreshProjectProfile(root: string): Promise<ProjectProfile> {
  return persist(root, await inspect(root));
}

function runGit(root: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("git", args, { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args[0]}: ${stderr || error.message}`));
    else resolve(stdout);
  });
  return promise;
}

/** Git state is transient: report both sides of renames and untracked files, never persist them. */
export async function gitDirtySnapshot(root: string): Promise<GitDirtySnapshot> {
  const branchResult = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
  let status: string;
  try {
    status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch (error) {
    if (/not a git repository/i.test(String(error))) return { branch: null, paths: [], dirty: false, unknown: true };
    // A huge status output cannot safely be treated as a clean checkout.
    if (/maxBuffer/i.test(String(error))) return { branch: branchResult?.trim() || null, paths: [], dirty: true, truncated: true };
    throw error;
  }
  const entries = status.split("\0");
  const paths: string[] = [];
  let truncated = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const changed = entry.slice(3);
    if (paths.length < 256) paths.push(changed);
    else truncated = true;
    if (/^[RC]/.test(entry) || /^[RC]/.test(entry.slice(1))) {
      const oldPath = entries[++index];
      if (paths.length < 256) paths.push(oldPath);
      else truncated = true;
    }
  }
  return { branch: branchResult?.trim() || null, paths: unique(paths), dirty: status.length > 0, ...(truncated ? { truncated } : {}) };
}
