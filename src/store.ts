import { mkdir, readFile, rename, writeFile, access, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ShipConfig, ShipState } from "./types.ts";

export const shipDir = (root: string) => path.join(root, ".ship");
export const statePath = (root: string) => path.join(shipDir(root), "state.json");
export const configPath = (root: string) => path.join(shipDir(root), "config.json");

export async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function loadState(root: string): Promise<ShipState> {
  const state = await readJson<ShipState>(statePath(root));
  if (state.schemaVersion !== 1 || !Array.isArray(state.milestones)) throw new Error("Invalid .ship/state.json");
  return state;
}

export async function saveState(root: string, state: ShipState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await atomicJson(statePath(root), state);
}

export async function loadConfig(root: string): Promise<ShipConfig> {
  const config = await readJson<ShipConfig>(configPath(root));
  if (config.schemaVersion !== 1 || !config.worker?.command) throw new Error("Invalid .ship/config.json");
  return config;
}

export async function appendEvent(root: string, event: Record<string, unknown>): Promise<void> {
  const dir = shipDir(root);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
}

export async function writeRoadmapView(root: string, state: ShipState): Promise<void> {
  const lines = ["# Roadmap", "", `Revision: ${state.roadmapRevision}`, ""];
  for (const m of state.milestones) {
    lines.push(`## ${m.id}: ${m.title} [${m.status}]`, "", m.outcome, "");
    for (const s of m.slices) {
      lines.push(`### ${s.id}: ${s.title} [${s.status}]`, "");
      for (const t of s.tasks) lines.push(`- [${t.status === "passed" ? "x" : " "}] ${t.id} — ${t.title} (${t.status})`);
      lines.push("");
    }
  }
  await writeFile(path.join(shipDir(root), "ROADMAP.md"), lines.join("\n") + "\n", "utf8");
}
