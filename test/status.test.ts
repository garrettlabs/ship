import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, plan } from "./helpers.ts";
import { parsePlan } from "../src/model.ts";
import { loadState } from "../src/store.ts";
import { formatStatus } from "../src/status.ts";

test("status projects graph readiness, queued changes and verified evidence without changing state", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks.push({
    ...raw.milestones[0].slices[0].tasks[0], id: "T02", title: "Dependent release", dependencies: ["T01"],
  });
  state.milestones = parsePlan(JSON.stringify(raw));
  state.roadmapRevision = 1;
  state.milestones[0].slices[0].tasks[0].status = "passed";
  const inbox = path.join(root, ".ship", "inbox");
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, "one.json"), JSON.stringify({ type: "capture", note: "Potential improvement" }));
  await writeFile(path.join(inbox, "two.json"), JSON.stringify({ type: "change", task: "M001/S01/T02", revision: 1 }));
  await appendFile(path.join(root, ".ship", "events.jsonl"), JSON.stringify({ at: "2026-09-27T00:00:00Z", type: "verification", task: "M001/S01/T01", command: "node --test focused", ok: true }) + "\n");
  const before = JSON.stringify(state);
  const text = await formatStatus(root, state);
  assert.match(text, /1 verified\/passed, 1 remaining/);
  assert.match(text, /Next ready: M001\/S01\/T02 Dependent release/);
  assert.match(text, /Queued changes \(1\): change M001\/S01\/T02/);
  assert.match(text, /Captured ideas: 1 \(1 queued\)/);
  assert.match(text, /Last verified: M001\/S01\/T01 node --test focused; evidence \.ship\/events\.jsonl/);
  assert.match(text, /Details: \/ship status M001\/S01\/T01/);
  assert.equal(JSON.stringify(state), before);
  state.milestones[0].slices[0].tasks[0].evidenceRefs = [".ship/attempts/native-proof.verification.json"];
  assert.match(await formatStatus(root, state, "M001/S01/T01"), /Evidence: \.ship\/attempts\/native-proof\.verification\.json/);
  assert.match(await formatStatus(root, state), /evidence \.ship\/attempts\/native-proof\.verification\.json/);
  assert.equal(JSON.parse(await readFile(path.join(inbox, "two.json"), "utf8")).type, "change");
});

test("task detail shows stable prerequisites, acceptance, route, history and blocked ancestor", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks.push({
    ...raw.milestones[0].slices[0].tasks[0], id: "T02", title: "Dependent release", dependencies: ["T01"],
  });
  state.milestones = parsePlan(JSON.stringify(raw));
  state.milestones[0].slices[0].tasks[0].status = "failed";
  state.milestones[0].slices[0].tasks[1].attempts = 1;
  state.milestones[0].slices[0].tasks[1].lastError = "Build failed";
  const summary = await formatStatus(root, state);
  assert.match(summary, /Blocked prerequisites: M001\/S01\/T02 needs failed M001\/S01\/T01/);
  const detail = await formatStatus(root, state, "M001/S01/T02");
  assert.match(detail, /Prerequisites: M001\/S01\/T01 \[failed\]/);
  assert.match(detail, /Acceptance: file1\.txt contains hello/);
  assert.match(detail, /Route: .*; .* \(.*\)/);
  assert.match(detail, /History: 1 attempt\(s\); last error: Build failed/);
  assert.match(detail, /Evidence: not yet verified/);
  assert.match(await formatStatus(root, state, "T02"), /Unknown task T02/);
  state.milestones[0].slices[0].tasks[0].status = "deferred";
  assert.match(await formatStatus(root, state), /Unavailable prerequisites: M001\/S01\/T02 needs M001\/S01\/T01/);
});

test("status bounds a large roadmap and shows proposed changes and rejection reasons", async t => {
  const root = await fixture(t), state = await loadState(root);
  const raw = JSON.parse(plan());
  raw.milestones[0].slices[0].tasks = Array.from({ length: 80 }, (_, i) => ({
    ...raw.milestones[0].slices[0].tasks[0], id: `T${String(i + 1).padStart(2, "0")}`, title: `Task ${i + 1} long title repeated many times`,
  }));
  state.milestones = parsePlan(JSON.stringify(raw));
  state.pendingProposal = { id: "P1", request: "add roadmap feature", targetRevision: 0, milestones: state.milestones, impactedSummary: ["two slices impacted"], approvalBoundary: "routine", status: "pending", createdAt: "2026-09-27T00:00:00Z" };
  state.rejectedEdits = [{ id: "bad-edit", revision: 0, reason: "stale revision", at: "2026-09-27T00:00:00Z" }];
  const summary = await formatStatus(root, state);
  assert.ok(summary.length <= 2100);
  assert.match(summary, /Plan approval: P1/);
  assert.match(summary, /Rejected change bad-edit: stale revision/);
  assert.ok((await formatStatus(root, state, "M001/S01/T01")).length <= 4100);
});

test("status reports saved bounded and whole-roadmap targets without mutating legacy snapshots", async t => {
  const root = await fixture(t), state = await loadState(root);
  state.milestones = parsePlan(plan(2));
  state.roadmapRevision = 1;
  const legacy = JSON.stringify(state);
  assert.match(await formatStatus(root, state), /Run target: not selected; next \/ship run chooses the first incomplete milestone/);
  assert.equal(JSON.stringify(state), legacy);
  state.runTarget = { scope: "milestone", id: "M002", revision: 1, keys: ["M001/S01/T01", "M002/S01/T01"] };
  state.milestones[0]!.slices[0]!.tasks[0]!.status = "passed";
  state.autonomy = "yolo";
  const selected = JSON.stringify(state);
  let summary = await formatStatus(root, state);
  assert.match(summary, /Mode: yolo \(same-session only\)/);
  assert.match(summary, /Run target: through milestone M002; 1\/2 verified\/total/);
  assert.equal(JSON.stringify(state), selected);
  state.milestones[1]!.slices[0]!.tasks[0]!.status = "passed";
  summary = await formatStatus(root, state);
  assert.match(summary, /Run target: through milestone M002; 2\/2 verified\/total \(target complete\)/);
  state.runTarget = { scope: "task", id: "M002/S01/T01", revision: 1, keys: ["M002/S01/T01"] };
  assert.match(await formatStatus(root, state), /Run target: task M002\/S01\/T01; 1\/1 verified\/total \(target complete\)/);
  state.runTarget = { scope: "slice", id: "M001/S01", revision: 1, keys: ["M001/S01/T01"] };
  assert.match(await formatStatus(root, state), /Run target: slice M001\/S01; 1\/1 verified\/total \(target complete\)/);
  state.milestones[1]!.slices[0]!.tasks[0]!.status = "pending";
  summary = await formatStatus(root, state);
  assert.match(summary, /Roadmap: 1 verified\/passed, 1 remaining/);
  assert.match(summary, /Run target: slice M001\/S01; 1\/1 verified\/total \(target complete\)/);
  assert.doesNotMatch(summary, /Next ready: M002\/S01\/T01/);
  state.milestones[1]!.slices[0]!.tasks[0]!.status = "passed";
  state.runTarget = { scope: "all", revision: 1, keys: ["M001/S01/T01", "M002/S01/T01"] };
  state.autonomy = "supervised";
  summary = await formatStatus(root, state);
  assert.match(summary, /Mode: supervised/);
  assert.match(summary, /Run target: whole roadmap; 2\/2 verified\/total \(target complete\)/);
});
