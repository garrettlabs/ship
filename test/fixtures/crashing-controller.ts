import { acquireLock } from "../../src/lock.ts";
import { startProcess } from "../../src/process.ts";
const root = process.argv[2];
await acquireLock(root);
const proc = await startProcess(process.execPath, ["-e", "const fs=require('fs'); fs.writeFileSync('heartbeat.txt','start');setInterval(()=>fs.appendFileSync('heartbeat.txt','.'),20)"], root, root);
proc.child.stdout.resume(); proc.child.stderr.resume(); proc.start(); await proc.closed;
