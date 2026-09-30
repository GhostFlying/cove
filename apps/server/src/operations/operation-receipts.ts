import {
  classifyReceiptAdmission, validateOperationRecord, OperationReceiptKeySchema,
  type OperationReceiptKey, type OperationRecord,
} from "@cove/protocol/rpc";
import type { EffectiveBudgets } from "@cove/protocol/budgets";
import { RuntimeRetainedBytes, type ByteReservation } from "../terminal/runtime-retained-bytes.js";

type Entry = { key: OperationReceiptKey; canonicalIntent: string;
  record: OperationRecord | null; lease: ByteReservation };
export type ReceiptLookup = { kind: "existing"; record: OperationRecord } |
  { kind: "reserve" | "busy" | "conflict" | "invalid" };
export interface ReceiptPreparation {
  commit(record: OperationRecord): boolean;
  cancel(): void;
}

export class OperationReceipts {
  private readonly entries = new Map<string, Entry>();
  private readonly scratch: ByteReservation;
  private disposed = false;
  constructor(readonly serverId: string, readonly relayInstanceId: string,
    private readonly budgets: EffectiveBudgets, private readonly bytes: RuntimeRetainedBytes,
    private readonly encodeUtf8: (text: string) => Uint8Array) {
    if (bytes.limit > budgets.runtimeBytes) throw new Error("Runtime budget mismatch");
    const scratch = bytes.reserve(6 * budgets.operationRecordBytes + 6 * budgets.canonicalIntentBytes);
    if (!scratch) throw new Error("Receipt scratch capacity unavailable");
    this.scratch = scratch;
  }

  private id(key: OperationReceiptKey): string {
    return JSON.stringify([key.serverId, key.relayInstanceId, key.principalId, key.operationId]);
  }

  private valid(key: OperationReceiptKey): boolean {
    return !this.disposed && OperationReceiptKeySchema.safeParse(key).success &&
      key.serverId === this.serverId && key.relayInstanceId === this.relayInstanceId;
  }

  lookup(key: OperationReceiptKey, canonicalIntent: string): ReceiptLookup {
    if (!this.valid(key) || this.encodeUtf8(canonicalIntent).byteLength > this.budgets.canonicalIntentBytes)
      return { kind: "invalid" };
    const entry = this.entries.get(this.id(key));
    if (entry && !entry.record)
      return { kind: entry.canonicalIntent === canonicalIntent ? "busy" : "conflict" };
    const kind = classifyReceiptAdmission({ key, canonicalIntent,
      ...(entry?.record ? { existing: { key: entry.key, canonicalIntent: entry.canonicalIntent,
        record: entry.record } } : {}), receiptCount: this.entries.size,
      receiptLimit: this.budgets.operationReceipts, encodeUtf8: this.encodeUtf8 });
    return kind === "existing" ? { kind, record: structuredClone(entry!.record!) } : { kind };
  }

  prepare(key: OperationReceiptKey, canonicalIntent: string): ReceiptPreparation | null {
    if (this.lookup(key, canonicalIntent).kind !== "reserve") return null;
    const lease = this.bytes.reserve(6 * this.encodeUtf8(canonicalIntent).byteLength +
      6 * this.budgets.operationRecordBytes + 1024);
    if (!lease) return null;
    const entry: Entry = { key: { ...key }, canonicalIntent, record: null, lease };
    const id = this.id(key);
    this.entries.set(id, entry);
    return {
      commit: (record) => {
        if (this.disposed || this.entries.get(id) !== entry || entry.record !== null) return false;
        const valid = this.validate(entry, record);
        if (!valid || valid.revision !== 0 || valid.state !== "accepted") return false;
        entry.record = structuredClone(valid);
        return true;
      },
      cancel: () => {
        if (this.entries.get(id) !== entry || entry.record !== null) return;
        this.entries.delete(id); lease.release();
      },
    };
  }

  private validate(entry: Entry, record: OperationRecord): OperationRecord | null {
    const checked = validateOperationRecord(record, this.encodeUtf8);
    if (!checked || this.encodeUtf8(JSON.stringify(checked)).byteLength > this.budgets.operationRecordBytes ||
        checked.operationId !== entry.key.operationId || checked.run?.serverId !== this.serverId ||
        checked.run.relayInstanceId !== this.relayInstanceId) return null;
    return checked;
  }

  update(key: OperationReceiptKey, next: OperationRecord): boolean {
    if (!this.valid(key)) return false;
    const entry = this.entries.get(this.id(key));
    if (!entry?.record || entry.record.revision === Number.MAX_SAFE_INTEGER ||
        next.revision !== entry.record.revision + 1 || next.method !== entry.record.method ||
        next.run?.serverId !== entry.record.run?.serverId ||
        next.run?.relayInstanceId !== entry.record.run?.relayInstanceId ||
        next.run?.runId !== entry.record.run?.runId) return false;
    if (entry.record.state === "succeeded" || entry.record.state === "failed" ||
        entry.record.state === "requires_attention") return false;
    const checked = this.validate(entry, next);
    if (!checked) return false;
    entry.record = structuredClone(checked);
    return true;
  }

  get(key: OperationReceiptKey): OperationRecord | null {
    if (!this.valid(key)) return null;
    const record = this.entries.get(this.id(key))?.record;
    return record ? structuredClone(record) : null;
  }
  get count(): number { return this.entries.size; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.lease.release();
    this.entries.clear(); this.scratch.release();
  }
}
