import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { runCheck, assertNoProcess } from "../src/process.ts";
import { acquireLock, recoverLock } from "../src/lock.ts";
import { exists, shipDir } from "../src/store.ts";
import { fixture } from "./helpers.ts";

test("verification timeout kills the owned command group", async t => {
  const root = await fixture(t);
  const result = await runCheck(root, "sleep 30", root, 100);
  assert.equal(result.ok, false); assert.equal(result.timedOut, true);
  await assertNoProcess(root);
});
test("recovery refuses a live lock owner", async t => {
  const root = await fixture(t); const release = await acquireLock(root);
  try { await assert.rejects(recoverLock(root), /still be alive/); } finally { await release(); }
});
test("controller SIGKILL disconnects its gated worker and permits explicit recovery", async t => {
  const root = await fixture(t);
  const parent = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", fileURLToPath(new URL("./fixtures/crashing-controller.ts", import.meta.url)), root], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => parent.on("close", () => resolve()));
  parent.stdout.resume(); parent.stderr.resume();
  t.after(async () => { parent.kill("SIGKILL"); await closed; });
  const marker = path.join(root, "heartbeat.txt");
  for (let i = 0; i < 100 && !await exists(marker); i++) await delay(25);
  assert.equal(await exists(marker), true);
  parent.kill("SIGKILL"); await closed; await delay(150);
  const before = await readFile(marker, "utf8"); await delay(150);
  assert.equal(await readFile(marker, "utf8"), before, "orphan must stop writing");
  await recoverLock(root);
  assert.equal(await exists(path.join(shipDir(root), "process.json")), false);
  const release = await acquireLock(root); await release();
});

test("log-open failure terminates the gated process before it starts work", async t => {
  const root = await fixture(t);
  await assert.rejects(runCheck(root, "touch should-not-exist", root, 1000, undefined, path.join(root, "missing/log.txt")), /ENOENT/);
  await assertNoProcess(root); assert.equal(await exists(path.join(root, "should-not-exist")), false);
});
