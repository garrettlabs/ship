import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../src/git.ts";
import { captureHandoffGit } from "../src/handoff-git.ts";

test("handoff snapshot detects staged changes even when working bytes stay the same", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-handoff-git-"));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "ship@example.test"]);
    await git(root, ["config", "user.name", "Ship Test"]);
    await writeFile(path.join(root, "one.txt"), "base\n");
    await git(root, ["add", "one.txt"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(path.join(root, "one.txt"), "working\n");
    const unstaged = await captureHandoffGit(root);
    assert.equal(unstaged.branch, "main");
    assert.ok(unstaged.dirty["one.txt"]);
    await git(root, ["add", "one.txt"]);
    const staged = await captureHandoffGit(root);
    assert.notEqual(staged.dirty["one.txt"], unstaged.dirty["one.txt"]);
    await writeFile(path.join(root, "two.txt"), "new\n");
    const untracked = await captureHandoffGit(root);
    assert.ok(untracked.dirty["two.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
