import { sameRunRef, sameWorkerRef, type RunRef, type WorkerRef } from "@cove/protocol/identity";
import type { PipeEvent, RunStatus } from "@cove/protocol/pipe";
import type { RuntimeResult } from "@cove/protocol/runtime";
import type { ExternalTerminalEvent, TerminalResult } from "@cove/protocol/terminal";
import { PreviewCache, type OwnedPreviewBytes, type PreviewReader } from "./preview-cache.js";
import { TerminalConnectionDelivery, type DeliveryFence } from "./terminal-connection-delivery.js";

type Start = Extract<ExternalTerminalEvent, { type: "preview-start" }>;

// Result ingress seals this collector synchronously, before the parser sees later frames.
export class PreviewCollector {
  private start: Start | undefined;
  private owned: OwnedPreviewBytes | undefined;
  private ended = false;
  private invalid = false;
  private sealed = false;
  constructor(
    readonly cache: PreviewCache,
    readonly run: RunRef,
    readonly worker: WorkerRef,
    readonly requestId: string,
    readonly status: RunStatus,
    private readonly current: () => boolean,
    private readonly claimId: (id: string) => boolean,
  ) {}

  event(event: PipeEvent, payload: Uint8Array): void {
    if (
      this.sealed ||
      !this.current() ||
      !sameRunRef(event.run, this.run) ||
      !event.terminal.type.startsWith("preview-")
    )
      return;
    const terminal = event.terminal;
    if (this.invalid) return;
    if (
      event.subscription ||
      !sameWorkerRef(event.worker, this.worker) ||
      !sameRunRef(terminal.run, this.run)
    ) {
      this.invalid = true;
      return;
    }
    if (terminal.type === "preview-start") {
      if (
        this.start ||
        payload.byteLength ||
        terminal.chunkCount !== 1 ||
        terminal.vtBytes > this.cache.runtime.composition.budgets.previewBytesPerRun ||
        terminal.geometry.cols > this.cache.runtime.composition.budgets.maxCols ||
        terminal.geometry.rows > this.cache.runtime.composition.budgets.maxRows ||
        terminal.geometry.cols !== this.status.geometry.cols ||
        terminal.geometry.rows !== this.status.geometry.rows ||
        terminal.atSeq !== terminal.version ||
        (this.status.parsedSeq !== null && terminal.atSeq < this.status.parsedSeq) ||
        !this.claimId(terminal.previewId)
      ) {
        this.invalid = true;
        return;
      }
      this.start = structuredClone(terminal);
      return;
    }
    const start = this.start;
    if (
      !start ||
      !("previewId" in terminal) ||
      start.previewId !== terminal.previewId ||
      start.version !== terminal.version
    ) {
      this.invalid = true;
      return;
    }
    if (terminal.type === "preview-chunk") {
      if (
        this.owned ||
        this.ended ||
        terminal.ordinal !== 0 ||
        payload.byteLength !== start.vtBytes
      ) {
        this.invalid = true;
        return;
      }
      const account = this.cache.runtime.composition.bytes;
      const scratch = account.reserve(payload.byteLength + 256);
      if (!scratch) {
        this.invalid = true;
        return;
      }
      try {
        const vt = new Uint8Array(payload);
        const backing = account.retainBacking(vt);
        if (!backing) {
          this.invalid = true;
          return;
        }
        this.owned = { vt, backing };
      } finally {
        scratch.release();
      }
    } else if (terminal.type === "preview-end") {
      if (
        !this.owned ||
        this.ended ||
        payload.byteLength ||
        terminal.totalBytes !== start.vtBytes ||
        terminal.atSeq !== start.atSeq
      )
        this.invalid = true;
      else this.ended = true;
    }
  }

  seal(result: RuntimeResult, checkedAtMs: number): boolean {
    if (this.sealed) return false;
    this.sealed = true;
    let accepted = false;
    try {
      if (
        !this.current() ||
        this.invalid ||
        result.type !== "result" ||
        result.outcome !== "accepted" ||
        result.commandType !== "preview-refresh" ||
        result.requestId !== this.requestId ||
        !sameWorkerRef(result.worker, this.worker) ||
        !sameRunRef(result.run, this.run)
      )
        return false;
      const proof = this.cache.runtime.registry.get(this.run);
      if (
        !proof ||
        proof.status.status === "unverifiable" ||
        !sameWorkerRef(proof.worker, this.worker) ||
        proof.status.geometry.cols !== this.status.geometry.cols ||
        proof.status.geometry.rows !== this.status.geometry.rows ||
        (proof.status.status === "exited" && this.status.status !== "exited")
      )
        return false;
      if (!this.start) {
        if (
          result.previewVersion !== this.status.parsedSeq ||
          !this.cache.matches(this.run, this.worker, this.status)
        )
          return false;
        accepted = this.cache.checked(this.run, this.status, checkedAtMs);
        return accepted;
      }
      if (!this.owned || !this.ended || result.previewVersion !== this.start.version) return false;
      if (proof.status.parsedSeq !== null && proof.status.parsedSeq > this.start.atSeq)
        return false;
      accepted = this.cache.commit(
        {
          run: this.run,
          worker: this.worker,
          version: this.start.version,
          atSeq: this.start.atSeq,
          geometry: this.start.geometry,
          generatedAtMs: this.start.generatedAtMs,
          checkedAtMs,
          stale: false,
          status: this.status,
        },
        this.owned,
      );
      if (accepted) this.owned = undefined;
      return accepted;
    } finally {
      this.disposeBytes();
    }
  }

  private disposeBytes(): void {
    this.owned?.backing.release();
    this.owned = undefined;
  }
  dispose(): void {
    this.sealed = true;
    this.disposeBytes();
  }
}

export function publishPreview(
  delivery: TerminalConnectionDelivery,
  reader: PreviewReader,
  requestId: string,
  knownVersion: number | undefined,
  previewId: string,
  fence: DeliveryFence,
): TerminalResult | null {
  const picture = reader.picture;
  const transfer = knownVersion !== picture.version;
  const reply: TerminalResult = {
    type: "preview-result",
    requestId,
    run: picture.run,
    status: transfer ? "transfer" : "unchanged",
    version: picture.version,
    ...(transfer ? { previewId } : {}),
  };
  if (picture.stale || !fence.current()) return null;
  if (reply.status === "transfer") {
    const common = { run: picture.run, previewId, version: picture.version };
    const start: ExternalTerminalEvent = {
      type: "preview-start",
      ...common,
      atSeq: picture.atSeq,
      geometry: picture.geometry,
      generatedAtMs: picture.generatedAtMs,
      vtBytes: picture.vt.byteLength,
      chunkCount: 1,
    };
    const chunk: ExternalTerminalEvent = { type: "preview-chunk", ...common, ordinal: 0 };
    const end: ExternalTerminalEvent = {
      type: "preview-end",
      ...common,
      atSeq: picture.atSeq,
      totalBytes: picture.vt.byteLength,
    };
    for (const [metadata, payload] of [
      [start, new Uint8Array()],
      [chunk, picture.vt],
      [end, new Uint8Array()],
    ] as const)
      if (!delivery.admit(metadata, payload, { control: false, fence })) {
        delivery.cancel(fence);
        return null;
      }
  }
  if (!delivery.admit(reply, new Uint8Array(), { control: true, fence })) {
    delivery.cancel(fence);
    return null;
  }
  return fence.current() ? reply : null;
}
