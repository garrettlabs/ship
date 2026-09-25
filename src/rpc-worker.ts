import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ShipConfig, Worker, WorkerResult } from "./types.ts";

export class OmpRpcWorker implements Worker {
  private readonly config: ShipConfig;
  constructor(config: ShipConfig) { this.config = config; }

  async run(prompt: string, cwd: string): Promise<WorkerResult> {
    const args = this.config.worker.args.length ? this.config.worker.args : ["--mode", "rpc", "--no-session", "--no-ui"];
    const child = spawn(this.config.worker.command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env }) as ChildProcessWithoutNullStreams;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000); });

    const result = await this.drive(child, prompt).catch((error: Error) => ({ ok: false, text: "", error: error.message } as WorkerResult));
    if (!child.killed) child.kill("SIGTERM");
    return result.ok ? result : { ...result, error: result.error || stderr || "OMP worker failed" };
  }

  private drive(child: ChildProcessWithoutNullStreams, prompt: string): Promise<WorkerResult> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: child.stdout });
      const requestId = `ship-${Date.now()}-${process.pid}`;
      let ready = false;
      let promptDone = false;
      let settled = false;
      let assistantText = "";
      let inactivity: NodeJS.Timeout;
      let startup: NodeJS.Timeout;
      let hard: NodeJS.Timeout;
      let finished = false;

      const finish = (r: WorkerResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(startup); clearTimeout(inactivity); clearTimeout(hard); rl.close();
        resolve(r);
      };
      const armInactivity = () => {
        clearTimeout(inactivity);
        inactivity = setTimeout(() => finish({ ok: false, text: assistantText, error: "OMP inactivity timeout" }), this.config.worker.inactivityTimeoutMs);
      };
      startup = setTimeout(() => finish({ ok: false, text: "", error: "OMP startup timeout" }), this.config.worker.startupTimeoutMs);
      hard = setTimeout(() => finish({ ok: false, text: assistantText, error: "OMP hard timeout" }), this.config.worker.hardTimeoutMs);

      rl.on("line", line => {
        armInactivity();
        let frame: any;
        try { frame = JSON.parse(line); } catch { return; }
        if (frame.type === "ready" && !ready) {
          ready = true; clearTimeout(startup);
          child.stdin.write(JSON.stringify({ id: requestId, type: "prompt", message: prompt }) + "\n");
        }
        if (frame.type === "message_update" && frame.assistantMessageEvent?.type === "text_delta") assistantText += frame.assistantMessageEvent.delta ?? "";
        if (frame.type === "prompt_result" && frame.id === requestId) {
          if (frame.status !== "completed") return finish({ ok: false, text: assistantText, error: frame.error?.message ?? `OMP prompt ${frame.status}`, retryable: frame.error?.retryable });
          promptDone = true;
          if (frame.sessionSettled === true) return finish({ ok: true, text: assistantText });
        }
        if (frame.type === "session_settled" && promptDone) {
          settled = true;
          return finish({ ok: true, text: assistantText });
        }
      });
      child.on("error", e => finish({ ok: false, text: assistantText, error: e.message }));
      child.on("exit", code => {
        if (!finished) finish({ ok: false, text: assistantText, error: `OMP exited before completion (${code}); promptDone=${promptDone}; settled=${settled}` });
      });
      armInactivity();
    });
  }
}
