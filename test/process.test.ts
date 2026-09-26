import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { once } from "node:events";
import { hostname } from "node:os";
import { runCheck, assertNoProcess, startProcess } from "../src/process.ts";
import { acquireLock, recoverLock } from "../src/lock.ts";
import { exists, shipDir } from "../src/store.ts";
import { fixture } from "./helpers.ts";

test("verification timeout kills the owned command group", async t => {
  const root = await fixture(t);
  const command = "sleep 30";
  const result = await runCheck(root, command, root, 100);
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
  for (let i = 0; i < 200 && !await exists(marker); i++) await delay(25);
  assert.equal(await exists(marker), true);
  parent.kill("SIGKILL"); await closed; await delay(300);
  const before = await readFile(marker, "utf8"); await delay(200);
  assert.equal(await readFile(marker, "utf8"), before, "detached descendant must stop writing");
  await recoverLock(root);
  assert.equal(await exists(path.join(shipDir(root), "process.json")), false);
  const release = await acquireLock(root); await release();
});

test("log-open failure terminates the gated process before it starts work", async t => {
  const root = await fixture(t);
  await assert.rejects(runCheck(root, process.platform === "win32" ? "echo x > should-not-exist" : "touch should-not-exist", root, 1000, undefined, path.join(root, "missing/log.txt")), /ENOENT/);
  await assertNoProcess(root); assert.equal(await exists(path.join(root, "should-not-exist")), false);
});

test("worker exit kills a detached descendant before clearing the record", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  const marker = path.join(root, "heartbeat.txt");
  const proc = await startProcess(process.execPath, [fileURLToPath(new URL("./fixtures/descendant-worker.mjs", import.meta.url)), marker], root, root);
  proc.child.stdout.resume(); proc.child.stderr.resume(); proc.start();
  assert.equal(await proc.closed, 0);
  await proc.stop();
  assert.equal(await exists(path.join(shipDir(root), "process.json")), false);
  const before = await readFile(marker, "utf8"); await delay(200);
  assert.equal(await readFile(marker, "utf8"), before);
});

test("Windows batch shim preserves literal arguments", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  const shim = path.join(root, "npm.cmd"), output = path.join(root, "arguments.json");
  const node = process.execPath;
  await writeFile(shim, `@echo off\r\n\"${node}\" -e \"require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))\" %*\r\n`);
  const previousPath = process.env.PATH;
  process.env.PATH = root + path.delimiter + previousPath;
  try {
    for (const command of [shim, shim.slice(0, -4), "npm"]) {
      const proc = await startProcess(command, [output, "two words", "literal=ok"], root, root);
      let outputText = "";
      proc.child.stdout.on("data", chunk => { outputText += chunk; });
      proc.child.stderr.on("data", chunk => { outputText += chunk; });
      proc.start();
      assert.equal(await proc.closed, 0, outputText);
      await proc.stop();
      assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["two words", "literal=ok"]);
    }
  } finally { process.env.PATH = previousPath; }
});

test("Windows recovery checks the job even when the recorded PID is gone", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  const proc = await startProcess(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], root, root);
  proc.child.stderr.resume();
  const ready = once(proc.child.stdout, "data");
  proc.start();
  try {
    await ready;
    const marker = path.join(shipDir(root), "process.json");
    const record = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...record, pid: 2147483000 }));
    await assert.rejects(assertNoProcess(root), /may still be alive/);
    assert.equal(await exists(marker), true);
  } finally { await proc.stop(); }
});

test("Windows recovery retains unverifiable legacy records", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t);
  await writeFile(path.join(shipDir(root), "process.json"), JSON.stringify({ host: hostname(), pid: 2147483000 }));
  await assert.rejects(assertNoProcess(root), /may still be alive/);
  assert.equal(await exists(path.join(shipDir(root), "process.json")), true);
});
