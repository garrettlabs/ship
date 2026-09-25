// Explicit opt-in: one real execution dispatch, never part of npm test.
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize, main } from "../src/cli.ts";
import { git } from "../src/git.ts";
import { atomicJson, configPath, loadConfig, loadState, saveState } from "../src/store.ts";
import { parsePlan } from "../src/model.ts";
if (process.env.SHIP_LIVE_OMP !== "1") {
  console.error("Not run. SHIP_LIVE_OMP=1 explicitly authorizes a real OMP/provider call."); process.exitCode = 2;
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-live-smoke-"));
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Ship Smoke"]); await git(root, ["config", "user.email", "smoke@local"]);
  await writeFile(path.join(root, "brief.md"), "Write smoke.txt containing ship-smoke-ok. No dependencies or services.");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "smoke baseline"]);
  await initialize(root, "brief.md");
  const cfg = await loadConfig(root); cfg.limits.maxDispatches = 1; cfg.review = false; await atomicJson(configPath(root), cfg);
  const state = await loadState(root); state.roadmapRevision = 1;
  state.milestones = parsePlan(JSON.stringify({ milestones: [{ id: "M001", title: "Smoke", outcome: "Verified local file", slices: [{ id: "S01", title: "File", tasks: [{ id: "T01", title: "Create smoke.txt", goal: "Write smoke.txt containing ship-smoke-ok", acceptance: ["Expected text exists"], verificationCommands: ["grep -qx 'ship-smoke-ok' smoke.txt"] }] }] }] }));
  await saveState(root, state);
  console.log(`Live OMP smoke project: ${root}`); await main(["run", "--once", "--max-runtime", "5m"], root); await main(["status"], root);
}
