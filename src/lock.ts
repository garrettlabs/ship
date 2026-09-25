import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { atomicJson, exists, readJson, shipDir } from "./store.ts";
import { alive, assertNoProcess } from "./process.ts";

export async function acquireLock(root: string): Promise<() => Promise<void>> {
  const dir = path.join(shipDir(root), "lock");
  if (await exists(path.join(shipDir(root), "recovery"))) throw new Error("Recovery in progress");
  const token = randomUUID();
  try { await mkdir(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Controller lock exists. Attach with ship tui; after a crash use ship recover, then ship run.");
    throw e;
  }
  if (await exists(path.join(shipDir(root), "recovery"))) { await rm(dir, { recursive: true }); throw new Error("Recovery in progress"); }
  await atomicJson(path.join(dir, "owner.json"), { pid: process.pid, host: hostname(), token });
  return async () => {
    const owner = await readJson<{ token: string }>(path.join(dir, "owner.json"));
    if (owner.token === token) await rm(dir, { recursive: true });
  };
}
export async function recoverLock(root: string): Promise<void> {
  // Explicit recovery never kills arbitrary/reused PIDs. Recovery requests are
  // serialized; normal startup cannot succeed while the old lock is present.
  const gate = path.join(shipDir(root), "recovery");
  await mkdir(gate);
  try {
    const dir = path.join(shipDir(root), "lock");
    const owner = await readJson<{ pid: number; host: string }>(path.join(dir, "owner.json"));
    if (owner.host !== hostname() || alive(owner.pid)) throw new Error("Lock owner may still be alive; refusing recovery");
    await assertNoProcess(root);
    await rm(dir, { recursive: true });
  } finally { await rm(gate, { recursive: true }); }
}
