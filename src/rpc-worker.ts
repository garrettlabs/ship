import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { startProcess } from "./process.ts";
import type { ShipConfig, Worker, WorkerOptions, WorkerResult } from "./types.ts";

// Deliberately remains on documented RPC v1. Oversized/truncated frames fail
// closed rather than accepting a lossy planner result. No v2 chunk negotiation.
export class OmpRpcWorker implements Worker {
  private config: ShipConfig;
  constructor(config: ShipConfig) { this.config = config; }
  async run(prompt: string, cwd: string, options: WorkerOptions = {}): Promise<WorkerResult> {
    if (options.signal?.aborted) return { ok: false, text: "", error: "Cancelled" };
    const { worker: cfg } = this.config;
    const proc = await startProcess(cfg.command, cfg.args, cwd, options.controlRoot);
    let log: Awaited<ReturnType<typeof open>> | undefined;
    try { log = options.logFile ? await open(options.logFile, "w", 0o600) : undefined; } catch (error) { await proc.stop(); throw error; }
    let written = 0; let writing = Promise.resolve(); let stderr = ""; let logError: unknown;
    const record = (chunk: Buffer) => {
      if (log && written < 8_000_000) { written += chunk.length; writing = writing.then(async () => { await log!.write(chunk); }).catch(error => { logError = error; cancel(); }); }
    };
    proc.child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); record(chunk); });
    const id = randomUUID(), resultId = randomUUID();
    let cancel = () => {};
    const result = await new Promise<WorkerResult>(resolve => {
      let done = false, ready = false, yielded = false, fetching = false;
      let buffer = Buffer.alloc(0);
      let idle: NodeJS.Timeout;
      const finish = (value: WorkerResult) => {
        if (done) return; done = true;
        clearTimeout(startup); clearTimeout(hard); clearTimeout(idle);
        resolve(value);
      };
      const fail = (error: string, retryable = false) => finish({ ok: false, text: "", error, retryable });
      const send = (frame: object) => proc.child.stdin.write(JSON.stringify(frame) + "\n");
      const fetchText = () => { if (!fetching) { fetching = true; send({ id: resultId, type: "get_last_assistant_text" }); } };
      const startup = setTimeout(() => fail("OMP startup timeout", true), cfg.startupTimeoutMs);
      const hard = setTimeout(() => fail("OMP hard timeout", true), cfg.hardTimeoutMs);
      const activity = () => { clearTimeout(idle); idle = setTimeout(() => fail("OMP inactivity timeout", true), cfg.inactivityTimeoutMs); };
      cancel = () => { if (ready) send({ type: "abort" }); fail("Cancelled"); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      proc.child.stdout.on("data", (chunk: Buffer) => {
        record(chunk);
        if (done) return; // still drain stdout through process shutdown
        buffer = Buffer.concat([buffer, chunk]);
        let end: number;
        while ((end = buffer.indexOf(10)) !== -1) {
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (line.length > 1_048_576) return fail("RPC frame exceeds v1 limit");
          if (!line.toString().trim()) continue;
          let f: any;
          try { f = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { return fail("Malformed RPC JSON"); }
          if (!f || typeof f.type !== "string") return fail("Invalid RPC frame");
          activity();
          if (f.type === "ready" && !ready) {
            if (f.protocolVersion !== 1) return fail("Unsupported OMP protocol version");
            ready = true; clearTimeout(startup);
            const frame = { id, type: "prompt", message: prompt };
            if (Buffer.byteLength(JSON.stringify(frame)) > Math.min(f.maxFrameBytes ?? 1_048_576, 1_048_576) - 1) return fail("Prompt exceeds RPC frame limit");
            send(frame);
          } else if (f.type === "response" && (f.id === id || f.id === resultId)) {
            if (!f.success) return fail(String(f.error ?? "RPC command failed"));
            if (f.id === id && f.data?.agentInvoked === false) return fail("Prompt completed locally without invoking the coding agent");
            if (f.id === resultId && fetching) {
              if (typeof f.data?.text !== "string" || !f.data.text.trim()) return fail("OMP returned no final answer");
              return finish({ ok: true, text: f.data.text });
            }
          } else if (f.type === "prompt_result" && f.id === id) {
            if (f.status !== "completed") return fail(f.error?.message ?? `OMP prompt ${f.status}`, f.error?.retryable === true);
            yielded = true;
            if (f.sessionSettled === true) fetchText();
          } else if (f.type === "session_settled" && yielded) fetchText();
          else if (["host_tool_call", "host_uri_request"].includes(f.type)) return fail("Unsupported host request requires intervention");
          else if (f.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(f.method)) return fail("OMP requested interactive input; configure unattended behavior explicitly");
        }
        if (buffer.length > 1_048_576) fail("Unterminated RPC frame exceeds limit");
      });
      proc.closed.then(code => { if (!done) fail(`OMP exited before completion (${code})${stderr ? `: ${stderr}` : ""}`); });
      activity();
      if (options.signal?.aborted) cancel(); else proc.start();
    });
    options.signal?.removeEventListener("abort", cancel);
    try { await proc.stop(); } finally { await writing; await log?.close(); }
    if (logError) throw logError;
    return result;
  }
}
