import test from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCheck, assertNoProcess } from "../src/process.ts";
import { acquireLock, recoverLock } from "../src/lock.ts";
import { exists, shipDir } from "../src/store.ts";
import { fixture } from "./helpers.ts";

test("verification timeout terminates the owned command group", async t => {
  const root = await fixture(t);
  const result = await runCheck(root, "sleep 30", root, 100);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  await assertNoProcess(root);
  assert.equal(await exists(path.join(shipDir(root), "process.json")), false);
});

test("packaged OMP launches verification with Node and reports the command's failure", async t => {
  const root = await fixture(t);
  const original = process.execPath;
  const originalNodeBinary = process.env.NODE_BINARY;
  try {
    process.execPath = path.join(root, "omp.exe");
    delete process.env.NODE_BINARY;
    const result = await runCheck(root, "printf 'node-host-started\\n'; exit 7", root, 10_000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 7);
    assert.equal(result.timedOut, false);
    assert.match(result.output, /node-host-started/);
  } finally {
    process.execPath = original;
    if (originalNodeBinary === undefined) delete process.env.NODE_BINARY; else process.env.NODE_BINARY = originalNodeBinary;
  }
  await assertNoProcess(root);
});

test("packaged OMP without Node fails before creating a verification record", async t => {
  const root = await fixture(t);
  const original = process.execPath;
  const key = Object.keys(process.env).find(name => name.toLowerCase() === "path") ?? "PATH";
  const originalPath = process.env[key];
  const originalNodeBinary = process.env.NODE_BINARY;
  try {
    process.execPath = path.join(root, "omp.exe");
    process.env[key] = "";
    delete process.env.NODE_BINARY;
    await assert.rejects(runCheck(root, "exit 0", root, 1000), /Node\.js executable not found/);
  } finally {
    process.execPath = original;
    if (originalPath === undefined) delete process.env[key]; else process.env[key] = originalPath;
    if (originalNodeBinary === undefined) delete process.env.NODE_BINARY; else process.env.NODE_BINARY = originalNodeBinary;
  }
  assert.equal(await exists(path.join(shipDir(root), "process.json")), false);
});

test("project-wide lock rejects overlapping native mutations and refuses live-owner recovery", async t => {
  const root = await fixture(t), release = await acquireLock(root);
  try {
    await assert.rejects(acquireLock(root), /project lock exists/);
    await assert.rejects(recoverLock(root), /still be alive/);
  } finally { await release(); }
  const next = await acquireLock(root); await next();
});

test("explicit recovery reclaims a dead owner but not an ambiguous verification process", async t => {
  const root = await fixture(t);
  await acquireLock(root);
  const ownerPath = path.join(shipDir(root), "lock", "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  await writeFile(ownerPath, JSON.stringify({ ...owner, pid: 2147483000 }));
  const marker = path.join(shipDir(root), "process.json");
  await writeFile(marker, JSON.stringify({ host: hostname(), pid: 2147483000 }));
  if (process.platform === "win32") {
    await assert.rejects(recoverLock(root), /may still be alive/);
    assert.equal(await exists(ownerPath), true);
  } else {
    await recoverLock(root);
    assert.equal(await exists(ownerPath), false);
  }
});

test("verification log-open failure stops before running the shell command", async t => {
  const root = await fixture(t);
  await assert.rejects(runCheck(root, "touch should-not-exist", root, 1000, undefined, path.join(root, "missing/log.txt")), /ENOENT/);
  await assertNoProcess(root);
  assert.equal(await exists(path.join(root, "should-not-exist")), false);
});
