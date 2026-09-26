import { acquireLock } from "../../src/lock.ts";
import { startProcess } from "../../src/process.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = process.argv[2];
await acquireLock(root);
const args = process.platform === "win32"
  ? [fileURLToPath(new URL("./descendant-worker.mjs", import.meta.url)), path.join(root, "heartbeat.txt"), "stay"]
  : ["-e", "const fs=require('fs'); fs.writeFileSync('heartbeat.txt','start');setInterval(()=>fs.appendFileSync('heartbeat.txt','.'),20)"];
const proc = await startProcess(process.execPath, args, root, root);
proc.child.stdout.resume(); proc.child.stderr.resume(); proc.start(); await proc.closed;
