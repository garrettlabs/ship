import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const [marker, mode] = process.argv.slice(2);
const child = spawn(process.execPath, [fileURLToPath(new URL("./heartbeat.mjs", import.meta.url)), marker], { detached: true, stdio: "ignore" });
child.unref();
for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
if (!existsSync(marker)) process.exit(1);
if (mode === "stay") setInterval(() => {}, 1000);
