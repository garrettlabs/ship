// Gated verification process-group leader. SHIP records ownership BEFORE
// starting the check; Windows assigns this idle host to a kill-on-close job.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
let started = false;
process.on("disconnect", () => {
  if (process.platform === "win32") process.exit(1); // helper closes the job on stdin EOF
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
});

function cmdWord(word) {
  // cmd.exe does not offer an argv API for .cmd scripts. Refuse syntax rather
  // than interpolating shell metacharacters or environment expansions.
  if (!word || /["%!^&|<>()\r\n]/.test(word)) throw new Error("Unsafe Windows batch argument");
  return `"${word}"`;
}
function resolveWindowsCommand(command) {
  if (path.extname(command)) return command;
  const directories = path.dirname(command) === "." ? [process.cwd(), ...(process.env.PATH || "").split(path.delimiter)] : [""];
  const extensions = [".exe", ".com", ".cmd", ".bat"];
  for (const directory of directories) {
    for (const ext of extensions) {
      const candidate = path.resolve(directory, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}
function workerCommand(command, args) {
  if (process.platform !== "win32") return [command, args, false];
  command = resolveWindowsCommand(command);
  if (/\.cmd$/i.test(command) || /\.bat$/i.test(command)) {
    return [process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", `"${[command, ...args].map(cmdWord).join(" ")}"`], true];
  }
  return [command, args, false];
}
function ownJob(token) {
  return new Promise((resolve, reject) => {
    const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./process-job.ps1", import.meta.url)), "own", token, String(process.pid)], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let stage = 0, buffer = "", settled = false;
    const fail = error => { if (!settled) { settled = true; helper.stdin.end(); reject(error); } };
    const timer = setTimeout(() => fail(new Error("Windows job assignment timed out")), 10000);
    helper.stdin.on("error", () => {});
    helper.stdout.on("data", chunk => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (stage === 0 && line === "OPENED") { stage = 1; helper.stdin.write("ACK\n"); }
        else if (stage === 1 && line === "READY") { stage = 2; settled = true; clearTimeout(timer); helper.once("close", () => process.exit(1)); resolve(helper); }
        else fail(new Error(`Windows job helper returned ${line}`));
      }
    });
    helper.on("error", fail);
    helper.on("close", code => fail(new Error(`Windows job helper exited before assignment (${code})`)));
  });
}
process.on("message", async message => {
  if (started || message?.type !== "start") return;
  started = true;
  try {
    if (process.platform === "win32") await ownJob(message.token);
    const [command, args, windowsVerbatimArguments] = workerCommand(message.command, message.args);
    const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true, windowsVerbatimArguments });
    child.stdin.on("error", () => {});
    process.stdin.pipe(child.stdin);
    child.on("error", error => { console.error(error.message); process.exit(127); });
    child.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  } catch (error) { console.error(error.message); process.exit(127); }
});
