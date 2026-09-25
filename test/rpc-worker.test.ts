import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmpRpcWorker } from "../src/rpc-worker.ts";
import type { ShipConfig } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("OMP adapter waits through prompt_result until session_settled", async () => {
  const config: ShipConfig = {
    schemaVersion: 1,
    worker: {
      command: process.execPath,
      args: [path.join(here, "fixtures", "fake-omp.mjs")],
      startupTimeoutMs: 1000,
      inactivityTimeoutMs: 1000,
      hardTimeoutMs: 3000
    },
    limits: { maxTaskAttempts: 2, maxDispatches: 10 }
  };
  const started = Date.now();
  const result = await new OmpRpcWorker(config).run("do it", process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.text, "implemented");
  assert.ok(Date.now() - started >= 20, "worker should not return at immediate prompt_result when session is unsettled");
});
