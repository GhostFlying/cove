import type { ExternalTerminalEvent, BaselineDescriptor } from "@cove/protocol/terminal";
import { validateBaselineDescriptor } from "@cove/protocol/terminal";
import type { ByteReservation } from "./runtime-retained-bytes.js";
import { RuntimeComposition } from "./runtime-composition.js";

export interface DeliveryCreditRecord {
  readonly bytes: number;
  readonly event: { type: ExternalTerminalEvent["type"]; seq: number; ordinal: number };
  sent: boolean;
  readonly lease: ByteReservation;
}

type Baseline = {
  descriptor: BaselineDescriptor;
  chunks: number;
  payloadBytes: number;
  sentOrdinal: number;
  parsedOrdinal: number;
  endQueued: boolean;
  endSent: boolean;
};

// This account proves client parsing; carrier settlement never changes it.
export class TerminalDeliveryCredit {
  private readonly records = new Set<DeliveryCreditRecord>();
  private baseline: Baseline | undefined;
  private retired = false;
  private queuedBytes = 0;
  private debtBytes = 0;
  private lastQueued: number;
  private lastSent: number;
  private lastApplied: number;
  private installed: boolean;

  constructor(
    readonly composition: RuntimeComposition,
    readonly attempt: number,
    readonly mode: "baseline" | "replay",
    readonly atSeq: number,
    appliedSeq?: number,
  ) {
    if (
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      !Number.isSafeInteger(atSeq) ||
      atSeq < 0 ||
      (mode === "replay" && (appliedSeq === undefined || appliedSeq > atSeq)) ||
      (appliedSeq !== undefined && (!Number.isSafeInteger(appliedSeq) || appliedSeq < 0))
    )
      throw new Error("Invalid delivery credit boundary");
    this.installed = mode === "replay";
    this.lastQueued = mode === "replay" ? appliedSeq! : atSeq;
    this.lastSent = this.lastQueued;
    this.lastApplied = mode === "replay" ? appliedSeq! : -1;
  }

  record(
    event: ExternalTerminalEvent,
    bytes: number,
    payloadBytes: number,
  ): DeliveryCreditRecord | null {
    const budgets = this.composition.budgets;
    if (
      this.retired ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > budgets.outboundConnectionBytes - this.queuedBytes - this.debtBytes ||
      this.records.size >= budgets.postNEvents + budgets.baselineChunks + 2
    )
      return null;
    if (event.type === "run-event") {
      if (
        event.event.seq !== this.lastQueued + 1 ||
        (this.mode === "baseline" && !this.baseline?.endQueued)
      )
        return null;
    } else if (event.type === "baseline-start") {
      const descriptor = validateBaselineDescriptor(event.descriptor);
      if (
        this.mode !== "baseline" ||
        this.baseline ||
        !descriptor ||
        descriptor.atSeq !== this.atSeq ||
        descriptor.coverage.normal.historyLines > budgets.historyLines ||
        descriptor.currentGeometry.cols > budgets.maxCols ||
        descriptor.currentGeometry.rows > budgets.maxRows ||
        descriptor.vtBytes > budgets.baselineVtBytes ||
        descriptor.tailBytes > budgets.baselineTailBytes ||
        descriptor.chunkCount > budgets.baselineChunks
      )
        return null;
    } else if (event.type === "baseline-chunk") {
      const baseline = this.baseline;
      if (
        !baseline ||
        baseline.endQueued ||
        event.baselineId !== baseline.descriptor.baselineId ||
        event.ordinal !== baseline.chunks ||
        baseline.chunks >= baseline.descriptor.chunkCount ||
        payloadBytes < 1 ||
        payloadBytes > 65_536 ||
        payloadBytes >
          baseline.descriptor.vtBytes + baseline.descriptor.tailBytes - baseline.payloadBytes
      )
        return null;
    } else if (event.type === "baseline-end") {
      const baseline = this.baseline;
      if (
        !baseline ||
        baseline.endQueued ||
        event.baselineId !== baseline.descriptor.baselineId ||
        event.chunkCount !== baseline.descriptor.chunkCount ||
        event.chunkCount !== baseline.chunks ||
        event.totalBytes !== baseline.payloadBytes ||
        event.totalBytes !== baseline.descriptor.vtBytes + baseline.descriptor.tailBytes ||
        event.atSeq !== this.atSeq
      )
        return null;
    } else return null;
    const lease = this.composition.bytes.reserve(256);
    if (!lease) return null;
    const record: DeliveryCreditRecord = {
      event: {
        type: event.type,
        seq: event.type === "run-event" ? event.event.seq : -1,
        ordinal: event.type === "baseline-chunk" ? event.ordinal : -1,
      },
      bytes,
      sent: false,
      lease,
    };
    this.records.add(record);
    this.queuedBytes += bytes;
    if (event.type === "run-event") this.lastQueued = event.event.seq;
    if (event.type === "baseline-start")
      this.baseline = {
        descriptor: structuredClone(event.descriptor),
        chunks: 0,
        payloadBytes: 0,
        sentOrdinal: -1,
        parsedOrdinal: -1,
        endQueued: false,
        endSent: false,
      };
    if (event.type === "baseline-chunk") {
      this.baseline!.chunks++;
      this.baseline!.payloadBytes += payloadBytes;
    }
    if (event.type === "baseline-end") this.baseline!.endQueued = true;
    return record;
  }

  eligible(record: DeliveryCreditRecord): boolean {
    return (
      !this.retired &&
      this.records.has(record) &&
      !record.sent &&
      record.bytes <= this.composition.budgets.subscriptionCreditBytes - this.debtBytes
    );
  }

  handoff(record: DeliveryCreditRecord): boolean {
    if (!this.eligible(record)) return false;
    record.sent = true;
    this.queuedBytes -= record.bytes;
    this.debtBytes += record.bytes;
    if (record.event.type === "run-event") this.lastSent = record.event.seq;
    if (record.event.type === "baseline-chunk") this.baseline!.sentOrdinal = record.event.ordinal;
    if (record.event.type === "baseline-end") this.baseline!.endSent = true;
    return true;
  }

  progress(baselineId: string, ordinal: number): boolean {
    const baseline = this.baseline;
    if (
      this.retired ||
      !baseline ||
      baselineId !== baseline.descriptor.baselineId ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > baseline.sentOrdinal
    )
      return false;
    if (ordinal <= baseline.parsedOrdinal) return true;
    baseline.parsedOrdinal = ordinal;
    for (const record of [...this.records]) {
      const event = record.event;
      if (
        record.sent &&
        (event.type === "baseline-start" ||
          (event.type === "baseline-chunk" && event.ordinal <= ordinal))
      )
        this.release(record);
    }
    return true;
  }

  ack(appliedSeq: number): boolean {
    if (this.retired || !Number.isSafeInteger(appliedSeq) || appliedSeq < 0) return false;
    if (!this.installed) {
      if (appliedSeq !== this.atSeq || !this.baseline?.endSent) return false;
      this.installed = true;
      this.lastApplied = appliedSeq;
      for (const record of [...this.records])
        if (record.sent && record.event.type !== "run-event") this.release(record);
      return true;
    }
    if (appliedSeq <= this.lastApplied) return true;
    if (
      appliedSeq > this.lastSent ||
      ![...this.records].some(
        (record) =>
          record.sent && record.event.type === "run-event" && record.event.seq === appliedSeq,
      )
    )
      return false;
    this.lastApplied = appliedSeq;
    for (const record of [...this.records])
      if (record.sent && record.event.type === "run-event" && record.event.seq <= appliedSeq)
        this.release(record);
    return true;
  }

  private release(record: DeliveryCreditRecord): void {
    if (!this.records.delete(record)) return;
    if (record.sent) this.debtBytes -= record.bytes;
    else this.queuedBytes -= record.bytes;
    record.lease.release();
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const record of [...this.records]) this.release(record);
    this.baseline = undefined;
  }

  snapshot() {
    return {
      attempt: this.attempt,
      queuedBytes: this.queuedBytes,
      debtBytes: this.debtBytes,
      items: this.records.size,
      installed: this.installed,
      appliedSeq: this.lastApplied,
      sentSeq: this.lastSent,
      retired: this.retired,
    };
  }
}
