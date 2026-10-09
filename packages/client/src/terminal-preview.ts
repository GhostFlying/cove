import { M0_LIMITS } from "@cove/protocol/budgets";
import type { DomainError } from "@cove/protocol/errors";
import { RunRefSchema, SequenceSchema, type RunRef } from "@cove/protocol/identity";
import type { Geometry } from "@cove/protocol/profile";
import type { ExternalTerminalEvent, TerminalError, TerminalResult } from "@cove/protocol/terminal";
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
  replyObserved: boolean;
  settled: boolean;
}

// Runs that can each hold a fence at once: in-flight previews plus quarantined runs.
const PREVIEW_FENCE_LIMIT = 256;
// Recently settled previews whose reply was observed (see TerminalPreview.recent).
const RECENT_PREVIEW_WINDOW = 256;
const PREVIEW_DEADLINE_MS = 5_000;

function localError(reason: LocalErrorReason): ClientError {
  return { category: "local", reason };
}

function runKey(run: RunRef): string {
  return JSON.stringify([run.serverId, run.relayInstanceId, run.runId]);
}

interface SettledPreview {
  readonly key: string;
  readonly previewId: string | undefined;
}

function transferKey(key: string, previewId: string): string {
  return JSON.stringify([key, previewId]);
}

// Preview events have no requestId: an unseen old transfer requires a run fence after uncertainty.
export class TerminalPreview {
  private readonly pending = new Map<string, PendingPreview>();
  private readonly provisional = new Map<string, symbol>();
  // A preview settles cleanly only after its one reply (and, for a transfer, its whole
  // transfer) has arrived, and the server sends each at most once, minting request and
  // preview IDs that are never reused on a connection. Nothing legitimate can follow such a
  // settlement, so this proof is not needed to fence anything: it only lets a duplicate of a
  // recent reply or transfer stay local instead of invalidating the connection. It is
  // therefore a FIFO window, never an admission cap; retaining every settled preview would
  // refuse all previews once a long-lived connection had served the limit. After eviction a
  // duplicate is unrouteable, which is what any reply or transfer never issued already is.
  // Keyed by request ID in settlement order; `recentTransfers` indexes the same entries.
  private readonly recent = new Map<string, SettledPreview>();
  private readonly recentTransfers = new Set<string>();
  // Uncertain runs stay fenced until the connection is replaced: their unseen transfer could
  // otherwise be taken for a later preview's. Each fence is per run, so the limit is reached
  // only by that many distinct runs with an uncertain preview, not by ordinary use.
  private readonly quarantined = new Map<string, string>();
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
      this.provisional.has(key) ||
      this.pending.size + this.provisional.size >= binding.effectiveBudgets.maxRuns ||
      this.pending.size + this.provisional.size >= M0_LIMITS.pendingWorkerCommands ||
      this.pending.size + this.provisional.size + this.quarantined.size >= PREVIEW_FENCE_LIMIT
    )
      return Promise.resolve({ ok: false, error: localError("capacity"), uncertain: false });

    const generation = this.generation();
    const reservation = Symbol();
    this.provisional.set(key, reservation);
    const requestId = this.lane.nextRequestId(generation);
    if (!requestId) {
      if (this.provisional.get(key) === reservation) this.provisional.delete(key);
      return Promise.resolve({ ok: false, error: localError("capacity"), uncertain: false });
    }
    if (
      this.provisional.get(key) !== reservation ||
      !this.connected() ||
      this.binding() !== binding ||
      this.generation() !== generation
    ) {
      if (this.provisional.get(key) === reservation) this.provisional.delete(key);
      return Promise.resolve({ ok: false, error: localError("invalid-state"), uncertain: false });
    }
    let resolve!: (result: PreviewOutcome) => void;
    const promise = new Promise<PreviewOutcome>((settle) => {
      resolve = settle;
    });
    const pending: PendingPreview = {
      key,
      requestId,
      run: Object.freeze(parsed.data),
      knownVersion,
      generation,
      resolve,
      reservedBytes: 0,
      startedSend: false,
      replyObserved: false,
      settled: false,
    };
    this.provisional.delete(key);
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
      () =>
        !pending.settled &&
        this.connected() &&
        this.binding() === binding &&
        this.generation() === pending.generation,
    );
    return promise;
  }

  receive(event: PreviewEvent, bytes: Uint8Array): PreviewRoute {
    const key = runKey(event.run);
    if (this.recentTransfers.has(transferKey(key, event.previewId)) || this.quarantined.has(key))
      return "obsolete";
    const pending = this.pending.get(key);
    if (!pending || pending.settled || pending.generation !== this.generation())
      return "unrouteable";
    this.process(pending, event, bytes);
    return "active";
  }

  receiveUnmatchedReply(
    reply: Extract<TerminalResult, { type: "preview-result" }> | TerminalError,
  ): PreviewRoute {
    const key = runKey(reply.run);
    const pending = this.pending.get(key);
    if (pending?.requestId === reply.requestId && pending.generation === this.generation()) {
      this.fail(pending, "invalid-response");
      return "active";
    }
    if (
      this.recent.get(reply.requestId)?.key === key ||
      this.quarantined.get(key) === reply.requestId
    )
      return "obsolete";
    return "unrouteable";
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
    this.provisional.clear();
    this.recent.clear();
    this.recentTransfers.clear();
    this.quarantined.clear();
  }

  private onCommand(pending: PendingPreview, outcome: CommandOutcome): void {
    if (pending.settled) return;
    if (!outcome.ok) {
      pending.replyObserved = "acceptance" in outcome.error;
      const uncertain =
        outcome.uncertain ||
        ("acceptance" in outcome.error && outcome.error.acceptance !== "not-accepted");
      this.finish(pending, { ok: false, error: outcome.error, uncertain });
      return;
    }
    pending.replyObserved = true;
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
      // The run fence subsumes this run's event IDs; recent request IDs age out as usual.
      this.quarantined.set(pending.key, pending.requestId);
    } else if (pending.replyObserved) {
      this.remember(pending.requestId, pending.key, pending.transfer?.previewId);
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

  private remember(requestId: string, key: string, previewId: string | undefined): void {
    while (this.recent.size >= RECENT_PREVIEW_WINDOW) {
      const oldest = this.recent.entries().next();
      if (oldest.done) break;
      this.recent.delete(oldest.value[0]);
      const evicted = oldest.value[1];
      if (evicted.previewId !== undefined)
        this.recentTransfers.delete(transferKey(evicted.key, evicted.previewId));
    }
    this.recent.set(requestId, { key, previewId });
    if (previewId !== undefined) this.recentTransfers.add(transferKey(key, previewId));
  }

  // The size of the recent window; tests observe that it stays bounded.
  get retiredCount(): number {
    return this.recent.size;
  }
}
