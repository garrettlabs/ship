import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize } from "../src/cli.ts";
import { git } from "../src/git.ts";
import { atomicJson, configPath, loadConfig } from "../src/store.ts";
import type { Worker, WorkerOptions, WorkerResult } from "../src/types.ts";
export async function fixture(t: { after: (f: () => Promise<void>) => void }, review = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Ship Tests"]); await git(root, ["config", "user.email", "tests@local"]);
  await writeFile(path.join(root, "brief.md"), "Build two local files without external services.");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "baseline"]);
  await initialize(root, "brief.md");
  const config = await loadConfig(root); config.review = review; config.limits.maxTaskAttempts = 2;
  config.verificationTimeoutMs = 1000;
  await atomicJson(configPath(root), config);
  return root;
}
export const plan = (count = 1) => JSON.stringify({ milestones: Array.from({ length: count }, (_, i) => ({ id: `M00${i + 1}`, title: `Milestone ${i + 1}`, outcome: `file ${i + 1} exists`, slices: [{ id: "S01", title: "Deliver file", tasks: [{ id: "T01", title: `Create file${i + 1}`, goal: `create file${i + 1}.txt`, acceptance: [`file${i + 1}.txt contains hello`], verificationCommands: [`grep -q '^hello$' file${i + 1}.txt`] }] }] })) });
export const report = (summary = "Created file", observations: string[] = []): WorkerResult => ({ ok: true, text: JSON.stringify({ summary, observations }) });
export type Response = WorkerResult | ((prompt: string, cwd: string, options?: WorkerOptions) => Promise<WorkerResult>);
export class ScriptWorker implements Worker {
  calls: string[] = []; responses: Response[];
  constructor(responses: Response[]) { this.responses = responses; }
  async run(prompt: string, cwd: string, options?: WorkerOptions): Promise<WorkerResult> {
    this.calls.push(prompt); const response = this.responses.shift();
    if (!response) throw new Error("Unexpected worker invocation");
    return typeof response === "function" ? response(prompt, cwd, options) : response;
  }
}
export const write = (file = "file1.txt", content = "hello\n"): Response => async (_prompt, cwd) => { await writeFile(path.join(cwd, file), content); return report(); };
