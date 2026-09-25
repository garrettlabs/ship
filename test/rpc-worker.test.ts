import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { OmpRpcWorker } from "../src/rpc-worker.ts";
import type { ShipConfig } from "../src/types.ts";
function config(mode: string): ShipConfig { return { schemaVersion: 1, worker: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url)), mode], startupTimeoutMs: 1500, inactivityTimeoutMs: 1500, hardTimeoutMs: 2000 }, limits: { maxTaskAttempts: 2, maxDispatches: 10 } }; }
test("RPC waits for settlement, fetches only the final answer, then closes the worker", async () => {
  const start = Date.now(); const result = await new OmpRpcWorker(config("normal")).run("do it", process.cwd());
  assert.equal(result.ok, true); assert.equal(result.text, "final answer only"); assert.ok(Date.now() - start >= 50);
});
for (const [mode, error] of [["error", /authentication/], ["local", /locally/], ["malformed", /Malformed/], ["bad-version", /protocol/], ["oversize", /limit/]] as const) {
  test(`RPC rejects ${mode}`, async () => { const r = await new OmpRpcWorker(config(mode)).run("do it", process.cwd()); assert.equal(r.ok, false); assert.match(r.error!, error); });
}
test("a prompt acknowledgement without completion times out", async () => {
  const c = config("ack-only"); c.worker.hardTimeoutMs = 250;
  const r = await new OmpRpcWorker(c).run("do it", process.cwd()); assert.equal(r.ok, false); assert.match(r.error!, /timeout/);
});
test("AbortSignal cancels an active worker", async () => {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 100);
  try { const r = await new OmpRpcWorker(config("ack-only")).run("do it", process.cwd(), { signal: abort.signal }); assert.equal(r.ok, false); assert.match(r.error!, /Cancelled/); } finally { clearTimeout(timer); }
});
