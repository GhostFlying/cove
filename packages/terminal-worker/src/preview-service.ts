import type { EnginePreviewResult } from "@cove/terminal-engine";
import type { EffectiveBudgets } from "@cove/protocol/budgets";
import type { RunRef, WorkerRef } from "@cove/protocol/identity";
import type { PipeCommand, PipeEvent, PipeResult } from "@cove/protocol/pipe";
import type { RecoveryDelivery } from "./recovery-subscription.js";
import { recoveryClock, type RecoveryClock } from "./recovery-clock.js";
import type { RetainedLease } from "./worker-retained-bytes.js";

type PreviewCommand = Extract<PipeCommand, { type: "preview-refresh" }>;
type Failure =
  | "BUSY"
  | "RESYNC_REQUIRED"
  | "RECOVERY_UNAVAILABLE"
  | "RECOVERY_EXPIRED"
  | "COUNTER_EXHAUSTED"
  | "RESULT_UNKNOWN";
export type PreviewOutcome = { readonly result: PipeResult } | { readonly failure: Failure };
const empty = new Uint8Array();
const MAX_METADATA_BYTES = 4096;

interface PendingPreview {
  readonly runId: string;
  readonly token: number;
  readonly command: PreviewCommand;
  readonly frames: readonly { event: PipeEvent; payload: Uint8Array }[];
  readonly lease: RetainedLease;
  readonly resolve: (outcome: PreviewOutcome) => void;
  readonly deadlineAt: number;
  readonly version: number;
  next: number;
}

export class PreviewService {
  readonly #worker: WorkerRef;
  readonly #budgets: EffectiveBudgets;
  readonly #reserve: (bytes: number) => RetainedLease | undefined;
  readonly #delivery: RecoveryDelivery;
  readonly #capture: <T>(runId: string, operation: () => Promise<T>) => Promise<T | undefined>;
  readonly #clock: RecoveryClock;
  readonly #active = new Set<string>();
  readonly #pending = new Map<string, PendingPreview>();
  #counter = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #draining = false;

  constructor(
    worker: WorkerRef,
    budgets: EffectiveBudgets,
    reserve: (bytes: number) => RetainedLease | undefined,
    delivery: RecoveryDelivery,
    capture: <T>(runId: string, operation: () => Promise<T>) => Promise<T | undefined>,
    clock: RecoveryClock = recoveryClock,
  ) {
    this.#worker = worker;
    this.#budgets = budgets;
    this.#reserve = reserve;
    this.#delivery = delivery;
    this.#capture = capture;
    this.#clock = clock;
  }

  async refresh(
    command: PreviewCommand,
    run: RunRef,
    capture: () => Promise<EnginePreviewResult>,
  ): Promise<PreviewOutcome> {
    if (this.#closed) return { failure: "RESULT_UNKNOWN" };
    if (this.#active.has(run.runId) || this.#active.size >= this.#budgets.previewRefreshes)
      return { failure: "BUSY" };
    if (this.#counter === Number.MAX_SAFE_INTEGER) return { failure: "COUNTER_EXHAUSTED" };
    const lease = this.#reserve(this.#budgets.previewBytesPerRun + 3 * MAX_METADATA_BYTES);
    if (!lease) return { failure: "BUSY" };
    this.#active.add(run.runId);
    let retained = false;
    let lateLease = false;
    let captureSettled = false;
    let wakeDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.resolve()
        .then(() => this.#capture(run.runId, capture))
        .finally(() => {
          captureSettled = true;
          if (lateLease) {
            lease.release();
            this.#active.delete(run.runId);
          }
        });
      const expired = Symbol("preview-capture-deadline");
      const deadline = new Promise<typeof expired>((resolve) => {
        wakeDeadline = this.#clock.setTimeout(
          () => resolve(expired),
          this.#budgets.recoveryDeadlineMs,
        );
      });
      let result: EnginePreviewResult | undefined | typeof expired;
      try {
        result = await Promise.race([work, deadline]);
      } catch {
        return { failure: "RECOVERY_UNAVAILABLE" };
      }
      if (result === expired) {
        if (!captureSettled) {
          lateLease = true;
          retained = true;
        }
        return { failure: this.#closed ? "RESULT_UNKNOWN" : "RECOVERY_EXPIRED" };
      }
      if (this.#closed) return { failure: "RESULT_UNKNOWN" };
      if (!result || result.status !== "ready") return { failure: "RECOVERY_UNAVAILABLE" };
      const { vt, atSeq, geometry } = result.preview;
      if (command.knownVersion !== undefined && command.knownVersion > atSeq)
        return { failure: "RESYNC_REQUIRED" };
      if (command.knownVersion === atSeq) return { result: this.#accepted(command, atSeq) };
      if (vt.byteLength < 1 || vt.byteLength > this.#budgets.previewBytesPerRun)
        return { failure: "RECOVERY_UNAVAILABLE" };
      const previewId = `p${++this.#counter}`;
      const common = { run, previewId, version: atSeq };
      const start: PipeEvent = {
        type: "terminal-event",
        worker: this.#worker,
        run,
        terminal: {
          type: "preview-start",
          ...common,
          atSeq,
          geometry,
          generatedAtMs: Date.now(),
          vtBytes: vt.byteLength,
          chunkCount: 1,
        },
      };
      const chunk: PipeEvent = {
        type: "terminal-event",
        worker: this.#worker,
        run,
        terminal: { type: "preview-chunk", ...common, ordinal: 0 },
      };
      const end: PipeEvent = {
        type: "terminal-event",
        worker: this.#worker,
        run,
        terminal: { type: "preview-end", ...common, totalBytes: vt.byteLength, atSeq },
      };
      const token = -this.#counter;
      return await new Promise<PreviewOutcome>((resolve) => {
        const pending: PendingPreview = {
          runId: run.runId,
          token,
          command,
          frames: [
            { event: start, payload: empty },
            { event: chunk, payload: vt },
            { event: end, payload: empty },
          ],
          lease,
          resolve,
          deadlineAt: this.#clock.now() + this.#budgets.recoveryDeadlineMs,
          version: atSeq,
          next: 0,
        };
        retained = true;
        this.#pending.set(run.runId, pending);
        this.#armTimer();
        this.capacity();
      });
    } finally {
      if (wakeDeadline) this.#clock.clearTimeout(wakeDeadline);
      if (!retained) {
        lease.release();
        this.#active.delete(run.runId);
      }
    }
  }

  capacity(): void {
    if (this.#closed || this.#draining) return;
    this.#draining = true;
    try {
      for (const pending of this.#pending.values()) {
        while (pending.next < pending.frames.length) {
          const frame = pending.frames[pending.next]!;
          let sent: number | false;
          try {
            sent = this.#delivery.enqueue(frame.event, frame.payload, pending.token);
          } catch {
            this.#finish(pending, { failure: "RESULT_UNKNOWN" });
            break;
          }
          if (this.#pending.get(pending.runId) !== pending) break;
          if (sent === false) break;
          pending.next++;
        }
        if (this.#pending.get(pending.runId) === pending && pending.next === pending.frames.length)
          this.#finish(pending, { result: this.#accepted(pending.command, pending.version) });
      }
    } finally {
      this.#draining = false;
    }
  }

  shutdown(): void {
    this.#closed = true;
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    for (const pending of [...this.#pending.values()])
      this.#finish(pending, { failure: "RESULT_UNKNOWN" });
  }

  #accepted(command: PreviewCommand, version: number): PipeResult {
    return {
      type: "result",
      worker: command.worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      outcome: "accepted",
      previewVersion: version,
    };
  }

  #finish(pending: PendingPreview, outcome: PreviewOutcome): void {
    if (this.#pending.get(pending.runId) !== pending) return;
    this.#pending.delete(pending.runId);
    this.#active.delete(pending.runId);
    if ("failure" in outcome) this.#delivery.cancelUnsent(pending.token);
    pending.lease.release();
    pending.resolve(outcome);
    this.#armTimer();
  }

  #armTimer(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    const next = Math.min(...[...this.#pending.values()].map((pending) => pending.deadlineAt));
    if (!Number.isFinite(next)) return;
    this.#timer = this.#clock.setTimeout(
      () => {
        const now = this.#clock.now();
        for (const pending of [...this.#pending.values()])
          if (now >= pending.deadlineAt) this.#finish(pending, { failure: "RECOVERY_EXPIRED" });
        this.#armTimer();
      },
      Math.max(0, Math.ceil(next - this.#clock.now())),
    );
  }
}
