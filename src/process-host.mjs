// A gated process-group leader. The controller records ownership BEFORE sending
// start. Losing its IPC connection kills this group, including ordinary children.
import { spawn, spawnSync } from "node:child_process";
let started = false;
let worker;
process.on("disconnect", () => {
  if (process.platform === "win32" && worker?.pid) {
    spawnSync("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    process.exit(1);
  }
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
});
process.on("message", message => {
  if (started || message?.type !== "start") return;
  started = true;
  const child = worker = spawn(message.command, message.args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  child.on("error", error => { console.error(error.message); process.exit(127); });
  child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
});
