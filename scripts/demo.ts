import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, main, startDetached } from "../src/cli.ts";
import { git } from "../src/git.ts";
import { atomicJson, configPath, loadConfig, loadState, queueMessage } from "../src/store.ts";
import { setTimeout as delay } from "node:timers/promises";
import { tui } from "../src/tui.ts";
const root = await mkdtemp(path.join(os.tmpdir(), "ship-demo-"));
await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Ship Demo"]); await git(root, ["config", "user.email", "demo@local"]);
await writeFile(path.join(root, "brief.md"), "Create a text greeting and document it. No external services.");
await git(root, ["add", "."]); await git(root, ["commit", "-m", "demo baseline"]);
await initialize(root, "brief.md");
const config = await loadConfig(root);
config.worker.command = process.execPath;
config.worker.args = [fileURLToPath(new URL("../examples/demo-worker.mjs", import.meta.url))];
await atomicJson(configPath(root), config);
await queueMessage(root, "capture", "Reuse the verified greeting when writing documentation.");
const add = process.argv.includes("--add");
if (add) await queueMessage(root, "add", "Add a changelog milestone documenting the delivered greeting.");
console.log(`Offline demo project: ${root}\nNo OMP installation, credentials, or model calls are involved.`);
if (process.argv.includes("--tui")) { await startDetached(root, ["--max-runtime", "2m"]); await tui(root, () => startDetached(root, ["--max-runtime", "2m"])); }
else {
  let finished = false;
  const run = main(["run", "--max-runtime", "2m"], root).finally(() => { finished = true; });
  // This explicit, fake-worker demonstration simulates user approval. Normal
  // ship add never approves a proposal automatically.
  if (add) {
    const deadline = Date.now() + 20_000;
    while (!finished && Date.now() < deadline) {
      const request = (await loadState(root)).workRequests?.find(r => r.status === "proposed");
      if (request) {
        await main(["proposals", request.id], root);
        console.log("Offline demo: simulating the user's explicit approval of the displayed proposal.");
        await main(["approve", request.id], root); break;
      }
      await delay(50);
    }
  }
  await run; await main(["status"], root);
  const state = await loadState(root);
  if (state.phase !== "complete" || (add && state.workRequests?.[0]?.status !== "applied")) throw new Error("Offline demo did not complete");
}
