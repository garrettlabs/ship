import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, main, startDetached } from "../src/cli.ts";
import { git } from "../src/git.ts";
import { atomicJson, configPath, loadConfig, queueMessage } from "../src/store.ts";
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
console.log(`Offline demo project: ${root}\nNo OMP installation, credentials, or model calls are involved.`);
if (process.argv.includes("--tui")) { await startDetached(root, ["--max-runtime", "2m"]); await tui(root, () => startDetached(root, ["--max-runtime", "2m"])); }
else { await main(["run", "--max-runtime", "2m"], root); await main(["status"], root); }
