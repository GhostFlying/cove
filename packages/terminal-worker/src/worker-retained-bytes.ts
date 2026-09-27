export type RetainedCategory = "worker" | "engine" | "native-input" | "native-output";

export interface RetainedLease {
  release(): void;
}

// The control carve-out is inside workerBytes and is never consumed by ordinary work.
export class WorkerRetainedBytes {
  readonly #limit: number;
  readonly #control: number;
  readonly #current: Record<RetainedCategory, number> = {
    worker: 0,
    engine: 0,
    "native-input": 0,
    "native-output": 0,
  };
  #used = 0;
  #peak = 0;

  constructor(limit: number, reservedControlBytes: number) {
    this.#limit = limit;
    this.#control = Math.min(limit, reservedControlBytes);
  }

  reserve(category: RetainedCategory, bytes: number): RetainedLease | undefined {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > this.#limit - this.#control - this.#used
    )
      return undefined;
    this.#current[category] += bytes;
    this.#used += bytes;
    this.#peak = Math.max(this.#peak, this.#used);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#current[category] -= bytes;
        this.#used -= bytes;
      },
    };
  }

  availableOrdinaryBytes(): number {
    return this.#limit - this.#control - this.#used;
  }

  snapshot(): {
    readonly accountedBytes: number;
    readonly peakAccountedBytes: number;
    readonly reservedControlBytes: number;
    readonly workerBytes: number;
    readonly engineBytes: number;
    readonly nativeInputBytes: number;
    readonly nativeOutputBytes: number;
  } {
    return {
      accountedBytes: this.#control + this.#used,
      peakAccountedBytes: this.#control + this.#peak,
      reservedControlBytes: this.#control,
      workerBytes: this.#current.worker,
      engineBytes: this.#current.engine,
      nativeInputBytes: this.#current["native-input"],
      nativeOutputBytes: this.#current["native-output"],
    };
  }
}
