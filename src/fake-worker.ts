import type { Worker, WorkerResult } from "./types.ts";

export class FakeWorker implements Worker {
  private readonly responses: WorkerResult[];
  constructor(responses: WorkerResult[]) { this.responses = responses; }
  async run(): Promise<WorkerResult> {
    const next = this.responses.shift();
    return next ?? { ok: false, text: "", error: "Fake worker has no queued response" };
  }
}
