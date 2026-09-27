import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize } from "../src/project.ts";
import { git } from "../src/git.ts";
import { atomicJson, configPath, loadConfig } from "../src/store.ts";
export async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Ship Tests"]); await git(root, ["config", "user.email", "tests@local"]);
  await writeFile(path.join(root, "brief.md"), "Build two local files without external services.");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "baseline"]);
  await initialize(root, "brief.md");
  const config = await loadConfig(root); config.limits.maxTaskAttempts = 2;
  config.verificationTimeoutMs = 1000;
  await atomicJson(configPath(root), config);
  return root;
}
export const plan = (count = 1) => JSON.stringify({ milestones: Array.from({ length: count }, (_, i) => ({ id: `M00${i + 1}`, title: `Milestone ${i + 1}`, outcome: `file ${i + 1} exists`, slices: [{ id: "S01", title: "Deliver file", tasks: [{ id: "T01", title: `Create file${i + 1}`, goal: `create file${i + 1}.txt`, acceptance: [`file${i + 1}.txt contains hello`], verificationCommands: [`grep -q '^hello$' file${i + 1}.txt`], taskType: "implementation", uncertainty: "UNKNOWN", profile: { complexity: 5, uncertainty: 8, risk: 5, traits: [], rationale: ["Bounded file task with uncertain repository scope"] } }] }] })) });
