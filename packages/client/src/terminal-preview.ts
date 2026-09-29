import { M0_LIMITS } from "@cove/protocol/budgets";
import type { DomainError } from "@cove/protocol/errors";
import { RunRefSchema, SequenceSchema, type RunRef } from "@cove/protocol/identity";
import type { Geometry } from "@cove/protocol/profile";
import type { ExternalTerminalEvent, TerminalResult } from "@cove/protocol/terminal";
import type { ClientError, LocalErrorReason } from "./client.js";
import type { NegotiatedConnection } from "./connection-session.js";
import { TerminalLane, type CommandOutcome } from "./terminal-delivery.js";
import type { Disposable, Scheduler } from "./transport-ports.js";

export type PreviewOutcome =
  | { readonly ok: true; readonly status: "unchanged"; readonly version: number }
  | {
      readonly ok: true;
      readonly status: "transfer";
      readonly version: number;
      readonly atSeq: number;
      readonly geometry: Geometry;
      readonly generatedAtMs: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly error: ClientError | DomainError;
      readonly uncertain: boolean;
    };

type PreviewEvent = Extract<
  ExternalTerminalEvent,
  { type: "preview-start" | "preview-chunk" | "preview-end" }
>;
export type PreviewRoute = "active" | "obsolete" | "unrouteable";

interface Transfer {
  readonly previewId: string;
  readonly version: number;
  readonly atSeq: number;
  readonly geometry: Geometry;
  readonly generatedAtMs: number;
  readonly declaredBytes: number;
  bytes?: Uint8Array;
  ended: boolean;
}

interface PendingPreview {
  readonly key: string;
  readonly requestId: string;
  readonly run: RunRef;
  readonly knownVersion: number | undefined;
  readonly generation: number;
  readonly resolve: (result: PreviewOutcome) => void;
  timer?: Disposable;
  result?: Extract<TerminalResult, { type: "preview-result" }>;
  transfer?: Transfer;
  reservedBytes: number;
  startedSend: boolean;
  settled: boolean;
}

const RETIRED_PREVIEW_LIMIT = 256;
const PREVIEW_DEADLINE_MS = 5_000;

function localError(reason: LocalErrorReason): ClientError {
  return { category: "local", reason };
}

function runKey(run: RunRef): string {
  return JSON.stringify([run.serverId, run.relayInstanceId, run.runId]);
}

// Preview events have no requestId: an unseen old transfer requires a run fence after uncertainty.
export class TerminalPreview {
  private readonly pending = new Map<string, PendingPreview>();
  private readonly retired = new Map<string, Set<string>>();
  private readonly quarantined = new Set<string>();
  private retiredCount = 0;
  private retainedBytes = 0;

  constructor(
    private readonly lane: TerminalLane,
    private readonly scheduler: Scheduler,
    private readonly binding: () => NegotiatedConnection | undefined,
    private readonly generation: () => number,
    private readonly connected: () => boolean,
  ) {}

  get(run: RunRef, knownVersion?: number): Promise<PreviewOutcome> {
    const binding = this.binding();
    if (!this.connected() || !binding)
      return Promise.resolve({ ok: false, error: localError("invalid-state"), uncertain: false });
    let parsed: ReturnType<typeof RunRefSchema.safeParse>;
    try {
      parsed = RunRefSchema.safeParse(run);
    } catch {
      return Promise.resolve({ ok: false, error: localError("invalid-request"), uncertain: false });
    }
    if (
      !parsed.success ||
      parsed.data.serverId !== binding.serverId ||
      parsed.data.relayInstanceId !== binding.relayInstanceId ||
      (knownVersion !== undefined && !SequenceSchema.safeParse(knownVersion).success)
    )
      return Promise.resolve({ ok: false, error: localError("invalid-request"), uncertain: false });
    if (!binding.capabilities.includes("terminal-preview-v1"))
      return Promise.resolve({ ok: false, error: localError("invalid-state"), uncertain: false });

    const key = runKey(parsed.data);
    if (this.quarantined.has(key))
      return Promise.resolve({ ok: false, error: localError("invalid-state"), uncertain: false });
    if (
      this.pending.has(key) ||
      this.pending.size >= binding.effectiveBudgets.maxRuns ||
      this.pending.size >= M0_LIMITS.pendingWorkerCommands ||
      this.pending.size + this.retiredCount + this.quarantined.size >= RETIRED_PREVIEW_LIMIT
    )
      return Promise.resolve({ ok: false, error: localError("capacity"), uncertain: false });

    const requestId = this.lane.nextRequestId(this.generation());
    if (!requestId)
      return Promise.resolve({ ok: false, error: localError("capacity"), uncertain: false });
    let resolve!: (result: PreviewOutcome) => void;
    const promise = new Promise<PreviewOutcome>((settle) => {
      resolve = settle;
    });
    const pending: PendingPreview = {
      key,
      requestId,
      run: Object.freeze(parsed.data),
      knownVersion,
      generation: this.generation(),
      resolve,
      reservedBytes: 0,
      startedSend: false,
      settled: false,
    };
    this.pending.set(key, pending);
    try {
      const timer = this.scheduler.setTimer(PREVIEW_DEADLINE_MS, () => {
        this.finish(pending, {
          ok: false,
          error: localError("timeout"),
          uncertain: pending.startedSend,
        });
      });
      pending.timer = timer;
      if (pending.settled) timer.dispose();
    } catch {
      this.finish(pending, {
        ok: false,
        error: localError("invalid-state"),
        uncertain: false,
      });
      return promise;
    }
    if (pending.settled || this.binding() !== binding || this.generation() !== pending.generation) {
      if (!pending.settled) this.fail(pending, "invalid-state");
      return promise;
    }

    pending.startedSend = true;
    void this.lane.send(
      {
        type: "preview",
        requestId,
        run: pending.run,
        ...(knownVersion === undefined ? {} : { knownVersion }),
      },
      PREVIEW_DEADLINE_MS,
      undefined,
      (outcome) => this.onCommand(pending, outcome),
    );
    return promise;
  }

  receive(event: PreviewEvent, bytes: Uint8Array): PreviewRoute {
    const key = runKey(event.run);
    if (this.retired.get(key)?.has(event.previewId) || this.quarantined.has(key)) return "obsolete";
    const pending = this.pending.get(key);
    if (!pending || pending.settled || pending.generation !== this.generation())
      return "unrouteable";
    this.process(pending, event, bytes);
    return "active";
  }

  private process(pending: PendingPreview, event: PreviewEvent, bytes: Uint8Array): void {
    const transfer = pending.transfer;
    if (event.type === "preview-start") {
      if (transfer || event.vtBytes > this.binding()!.effectiveBudgets.previewBytesPerRun) {
        this.fail(pending, "invalid-response");
        return;
      }
      const budgets = this.binding()!.effectiveBudgets;
      if (
        this.retainedBytes + event.vtBytes > budgets.previewGlobalBytes ||
        !this.lane.reserveIngress(event.vtBytes)
      ) {
        this.fail(pending, "capacity");
        return;
      }
      this.retainedBytes += event.vtBytes;
      pending.reservedBytes = event.vtBytes;
      pending.transfer = {
        previewId: event.previewId,
        version: event.version,
        atSeq: event.atSeq,
        geometry: event.geometry,
        generatedAtMs: event.generatedAtMs,
        declaredBytes: event.vtBytes,
        ended: false,
      };
      return;
    }
    if (!transfer || transfer.previewId !== event.previewId || transfer.version !== event.version) {
      this.fail(pending, "invalid-response");
      return;
    }
    if (event.type === "preview-chunk") {
      if (transfer.bytes || bytes.byteLength !== transfer.declaredBytes) {
        this.fail(pending, "invalid-response");
        return;
      }
      transfer.bytes = new Uint8Array(bytes);
      return;
    }
    if (
      transfer.ended ||
      !transfer.bytes ||
      event.totalBytes !== transfer.declaredBytes ||
      event.atSeq !== transfer.atSeq
    ) {
      this.fail(pending, "invalid-response");
      return;
    }
    transfer.ended = true;
    this.complete(pending);
  }

  close(reason: LocalErrorReason): void {
    for (const pending of [...this.pending.values()])
      this.finish(pending, {
        ok: false,
        error: localError(reason),
        uncertain: pending.startedSend,
      });
    this.retired.clear();
    this.retiredCount = 0;
    this.quarantined.clear();
  }

  private onCommand(pending: PendingPreview, outcome: CommandOutcome): void {
    if (pending.settled) return;
    if (!outcome.ok) {
      const uncertain =
        outcome.uncertain ||
        ("acceptance" in outcome.error && outcome.error.acceptance !== "not-accepted");
      this.finish(pending, { ok: false, error: outcome.error, uncertain });
      return;
    }
    const result = outcome.result;
    if (result.type !== "preview-result") {
      this.fail(pending, "invalid-response");
      return;
    }
    if (result.status === "unchanged") {
      if (pending.knownVersion !== result.version || pending.transfer) {
        this.fail(pending, "invalid-response");
        return;
      }
      this.finish(pending, { ok: true, status: "unchanged", version: result.version });
      return;
    }
    pending.result = result;
    this.complete(pending);
  }

  private complete(pending: PendingPreview): void {
    const transfer = pending.transfer;
    const result = pending.result;
    if (!transfer || !transfer.ended || !result) return;
    if (transfer.version !== result.version || !transfer.bytes) {
      this.fail(pending, "invalid-response");
      return;
    }
    this.finish(pending, {
      ok: true,
      status: "transfer",
      version: transfer.version,
      atSeq: transfer.atSeq,
      geometry: transfer.geometry,
      generatedAtMs: transfer.generatedAtMs,
      bytes: transfer.bytes,
    });
  }

  private fail(pending: PendingPreview, reason: LocalErrorReason): void {
    this.finish(pending, { ok: false, error: localError(reason), uncertain: pending.startedSend });
  }

  private finish(pending: PendingPreview, outcome: PreviewOutcome): void {
    if (pending.settled) return;
    pending.settled = true;
    this.pending.delete(pending.key);
    if (!outcome.ok && (outcome.uncertain || pending.transfer)) {
      // A run quarantine subsumes every older completed preview ID for that run.
      const oldIds = this.retired.get(pending.key);
      if (oldIds) {
        this.retiredCount -= oldIds.size;
        this.retired.delete(pending.key);
      }
      this.quarantined.add(pending.key);
    } else if (pending.transfer) {
      let ids = this.retired.get(pending.key);
      if (!ids) {
        ids = new Set<string>();
        this.retired.set(pending.key, ids);
      }
      if (!ids.has(pending.transfer.previewId)) {
        ids.add(pending.transfer.previewId);
        this.retiredCount++;
      }
    }
    if (pending.reservedBytes) {
      this.retainedBytes -= pending.reservedBytes;
      this.lane.releaseIngress(pending.reservedBytes);
      pending.reservedBytes = 0;
    }
    const timer = pending.timer;
    delete pending.timer;
    this.lane.cancelPreview(pending.requestId);
    try {
      timer?.dispose();
    } catch {
      // Ownership was cleared before an adapter can reenter.
    }
    pending.resolve(outcome);
  }
}
