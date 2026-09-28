import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.ts";
import { pauseNativeHandoff, resumeNativeHandoff } from "../src/native-handoff.ts";
import { loadState } from "../src/store.ts";

test("clean paused checkout transfers across sessions without spending task attempts", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "untracked.txt"), "user content");
  const pause = await pauseNativeHandoff(root, "first-session");
  assert.match(pause, /handoff boundary/);
  const checkpoint = (await loadState(root)).handoff;
  assert.ok(checkpoint?.git.dirty["untracked.txt"]);
  const resumed = await resumeNativeHandoff(root, "new-session");
  assert.match(resumed, /no attempts consumed/);
  const state = await loadState(root);
  assert.equal(state.paused, false);
  assert.equal(state.handoff, undefined);
  assert.equal(state.dispatches, 0);
});

test("handoff refuses changed dirty contents and keeps pause intact", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "untracked.txt"), "first");
  await pauseNativeHandoff(root, "first-session");
  await writeFile(path.join(root, "untracked.txt"), "changed");
  await assert.rejects(resumeNativeHandoff(root, "new-session"), /Git dirty paths or content changed/);
  const state = await loadState(root);
  assert.equal(state.paused, true);
  assert.ok(state.handoff);
  assert.equal(state.dispatches, 0);
});
