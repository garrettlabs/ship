import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureGitRepo, ensureShipExcluded } from "./git.ts";
import { atomicJson, configPath, exists, saveState, shipDir, writeRoadmapView } from "./store.ts";
import type { ShipConfig, ShipState } from "./types.ts";

/** Initialize a SHIP project in OMP's current checkout; never replace existing state. */
export async function initialize(root: string, briefFile: string): Promise<void> {
  if (await exists(shipDir(root))) throw new Error(".ship already exists; refusing to overwrite it");
  const brief = await readFile(path.resolve(root, briefFile), "utf8");
  if (!brief.trim()) throw new Error("Brief is empty");
  await createProject(root, brief);
}

async function createProject(root: string, brief: string): Promise<void> {
  if (await exists(shipDir(root))) throw new Error(".ship already exists; refusing to overwrite it");
  await ensureGitRepo(root);
  await ensureShipExcluded(root);
  // Exclusive creation prevents two sessions from overwriting one another's project.
  await mkdir(shipDir(root));
  await writeFile(path.join(shipDir(root), "PROJECT.md"), brief);
  const config: ShipConfig = {
    schemaVersion: 1,
    limits: { maxTaskAttempts: 3, maxDispatches: 100 },
    verificationTimeoutMs: 300000, protectedChecks: [], judgment: { enabled: false, confidenceThreshold: 0.7, timeoutMs: 20_000 },
  };
  const now = new Date().toISOString();
  const state: ShipState = {
    schemaVersion: 1, projectName: path.basename(root), phase: "idle", roadmapRevision: 0,
    milestones: [], paused: false, lastProgressAt: now, createdAt: now, updatedAt: now,
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
