import { Controller, type Step } from "./controller.ts";
import type { Worker } from "./types.ts";

export interface SupervisorOptions {
  signal?: AbortSignal;
  maxRuntimeMs?: number;
}

/** Owns a bounded controller invocation without owning CLI signals or output. */
export class Supervisor {
  private readonly abort = new AbortController();
  private readonly controller: Controller;
  private readonly options: SupervisorOptions;

  constructor(root: string, worker: Worker, options: SupervisorOptions = {}) {
    this.options = options;
    this.controller = new Controller(root, worker, { signal: this.abort.signal });
  }

  private async invoke<T>(action: () => Promise<T>): Promise<T> {
    const cancel = () => this.abort.abort();
    if (this.options.signal?.aborted) cancel();
    else this.options.signal?.addEventListener("abort", cancel);
    const deadline = this.options.maxRuntimeMs === undefined ? undefined : setTimeout(cancel, this.options.maxRuntimeMs);
    try { return await action(); }
    finally {
      clearTimeout(deadline);
      this.options.signal?.removeEventListener("abort", cancel);
    }
  }

  step(): Promise<Step> { return this.invoke(() => this.controller.step()); }
  run(once = false, onStep: (step: Step) => void = () => {}): Promise<Step> {
    return this.invoke(() => this.controller.run(once, onStep));
  }
}
