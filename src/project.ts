import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureGitRepo, ensureShipExcluded } from "./git.ts";
import { atomicJson, configPath, exists, loadState, saveState, shipDir, writeRoadmapView } from "./store.ts";
import { readProjectProfile, type ProjectProfile } from "./project-profile.ts";
import type { ShipConfig, ShipState } from "./types.ts";

/** Ignore repository bookkeeping and generated artifacts; inspect at most a small number of entries. */
const ignored: Record<string, true> = {
  ".git": true, ".ship": true, ".omp": true, node_modules: true, ".gitignore": true, ".gitattributes": true,
  ".gitmodules": true, ".DS_Store": true, "Thumbs.db": true, ".vscode": true, ".idea": true,
  dist: true, build: true, coverage: true, ".next": true, vendor: true, "brief.md": true,
};
const projectFiles = /^(?:README(?:\.[\w-]+)?|Dockerfile|Makefile|Justfile|CMakeLists\.txt|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements(?:-[\w-]+)?\.txt|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|tsconfig(?:\.[\w-]+)?\.json|vite\.config\.[cm]?[jt]s|.*\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|swift|kt|cs|html|css|vue|svelte|ipynb))$/i;
export async function hasExistingProject(root: string): Promise<boolean> {
  const pending = [root];
  let scanned = 0;
  while (pending.length && scanned < 256) {
    const dir = pending.shift()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (++scanned > 256) return true; // Unbounded trees are not empty projects.
      if (ignored[entry.name] || entry.name.startsWith(".ship.")) continue;
      if ((entry.isFile() || entry.isSymbolicLink()) && projectFiles.test(entry.name)) return true;
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
    }
  }
  return false;
}

function discoveryPrompt(root: string, id: string, profile: ProjectProfile): string {
  return `SHIP OMP-native discovery ${id} for ${root}. In the MAIN OMP session use the task tool with agent "scout", name "ShipDiscovery", to perform READ-ONLY reconnaissance. Do not modify files, plan, propose a roadmap, infer a goal, or dispatch implementation. Read repository instructions first. Inspect only relevant bounded evidence. Observed profile: ${JSON.stringify({ facts: profile.facts, unknowns: profile.unknowns }).slice(0, 12000)}. Return a concise evidence-based Markdown summary of existing purpose, layout, commands, conventions, and unknowns (max 6000 characters). In the MAIN session call ship_discovery with discoveryId ${id} and the agent's summary. SHIP will ask the user to approve before writing .ship/DISCOVERY.md.`;
}

/** Initialize discovery without a goal, planner, or repository writes outside .ship and git exclusion. */
export async function initializeDiscovery(root: string, sessionId: string): Promise<string> {
  if (await exists(shipDir(root))) throw new Error(".ship already exists; refusing to overwrite it");
  const id = randomUUID();
  await createProject(root, undefined, { id, sessionId, status: "researching" });
  const profile = await readProjectProfile(root);
  return discoveryPrompt(root, id, profile);
}

/** An explicit later user request, not reconnaissance, establishes the planning goal. */
export async function setDiscoveryGoal(root: string, request: string): Promise<void> {
  const goal = request.trim();
  if (!goal) throw new Error("A change request is required to start planning");
  const state = await loadState(root);
  if (!state.discovery || state.discovery.status !== "approved" || state.discovery.goalSet ||
      state.milestones.length || state.nativePlanning || state.nativeBatch || state.pendingJudgment)
    throw new Error("Approved discovery-only state is required to set a first goal");
  const file = path.join(shipDir(root), "PROJECT.md");
  try {
    await writeFile(file, goal + "\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(file, "utf8") !== goal + "\n")
      throw new Error("PROJECT.md already contains a different goal; refusing to replace it");
  }
  state.discovery.goalSet = true;
  await saveState(root, state);
}

/** A cancelled discovery can be explicitly restarted; old submissions become stale. */
export async function restartDiscovery(root: string, sessionId: string): Promise<string> {
  const state = await loadState(root);
  if (!state.discovery || state.discovery.goalSet || state.discovery.status !== "cancelled")
    throw new Error("Only cancelled discovery can be restarted");
  state.discovery = { id: randomUUID(), sessionId, status: "researching" };
  await saveState(root, state);
  const profile = await readProjectProfile(root);
  return discoveryPrompt(root, state.discovery.id, profile);
}
/** Reassign orphaned read-only research only after the caller confirms the former session is dead. */
export async function recoverDiscovery(root: string, sessionId: string): Promise<string> {
  const state = await loadState(root);
  if (state.discovery?.status !== "researching" || state.discovery.goalSet || state.milestones.length ||
      state.nativePlanning || state.nativeBatch || state.pendingJudgment)
    throw new Error("Only pending discovery research can be recovered");
  const profile = await readProjectProfile(root);
  state.discovery = { id: randomUUID(), sessionId, status: "researching" };
  await saveState(root, state);
  return discoveryPrompt(root, state.discovery.id, profile);
}
/** Initialize a SHIP project in OMP's current checkout; never replace existing state. */
export async function initialize(root: string, briefFile: string): Promise<void> {
  if (await exists(shipDir(root))) throw new Error(".ship already exists; refusing to overwrite it");
  const brief = await readFile(path.resolve(root, briefFile), "utf8");
  if (!brief.trim()) throw new Error("Brief is empty");
  await createProject(root, brief);
}

async function createProject(root: string, brief?: string, discovery?: ShipState["discovery"]): Promise<void> {
  if (await exists(shipDir(root))) throw new Error(".ship already exists; refusing to overwrite it");
  await ensureGitRepo(root);
  await ensureShipExcluded(root);
  // Exclusive creation prevents two sessions from overwriting one another's project.
  await mkdir(shipDir(root));
  if (brief !== undefined) await writeFile(path.join(shipDir(root), "PROJECT.md"), brief);
  const config: ShipConfig = {
    schemaVersion: 1,
    limits: { maxTaskAttempts: 3, maxDispatches: 100 },
    verificationTimeoutMs: 300000, protectedChecks: [], judgment: { enabled: false, confidenceThreshold: 0.7, timeoutMs: 20_000 },
  };
  const now = new Date().toISOString();
  const state: ShipState = {
    schemaVersion: 1, projectName: path.basename(root), phase: "idle", roadmapRevision: 0,
    milestones: [], paused: false, lastProgressAt: now, createdAt: now, updatedAt: now, ...(discovery ? { discovery } : {}),
  };
  await atomicJson(configPath(root), config);
  await saveState(root, state);
  await writeRoadmapView(root, state);
}

/** Adopt an existing checkout in place. The first request is the planning brief. */
export async function bootstrap(root: string, request: string): Promise<void> {
  if (!request.trim()) throw new Error("A change request is required to start planning");
  await createProject(root, request.trim() + "\n");
}
