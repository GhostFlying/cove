import {
  classifyReceiptAdmission,
  validateOperationRecord,
  OperationReceiptKeySchema,
  type OperationReceiptKey,
  type OperationRecord,
  type StoredReceipt,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import { domainError } from "@cove/protocol/errors";
import type { ByteReservation } from "../terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../terminal/runtime-composition.js";

const TERMINAL_STATES: ReadonlySet<OperationRecord["state"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "requires_attention",
]);

const RECOVERY_STATES: ReadonlySet<OperationRecord["state"]> = new Set([
  "running",
  "recovering",
  "cancelled",
]);

// Durable storage of committed receipts (M1 T1: apps/server/src/store/operations.ts). Every
// method is synchronous and each write is atomic. `replace` is a compare-and-set on the stored
// revision, so two writers can never both advance the same record.
export interface DurableReceiptBackend {
  get(key: OperationReceiptKey): StoredReceipt | null;
  // Inserts a new receipt; false when the key already exists or the write failed.
  insert(receipt: StoredReceipt): boolean;
  // Replaces the record when the stored revision still equals expectedRevision.
  replace(key: OperationReceiptKey, expectedRevision: number, record: OperationRecord): boolean;
  // Receipts left accepted, running or recovering, oldest first.
  unfinished(): StoredReceipt[];
  // Runs fn atomically with the backend's writes (a database transaction).
  atomic<T>(fn: () => T): T;
}

// Proves the outcome of an operation an earlier instance left unfinished. It receives the record
// already moved to `recovering` and returns its proven successor (next revision), or null when the
// outcome cannot be proven, which leaves the operation requires_attention. It may inspect external
// state (Git, processes) asynchronously; startup waits for it before serving.
export type ReceiptVerifier = (
  record: OperationRecord,
) => OperationRecord | null | Promise<OperationRecord | null>;
export type ReceiptVerifiers = Partial<Record<WriteRpcMethod, ReceiptVerifier>>;

type Entry = {
  key: OperationReceiptKey;
  canonicalIntent: string;
  record: OperationRecord | null;
  lease: ByteReservation;
};
export type ReceiptLookup =
  | { kind: "existing"; record: OperationRecord }
  | { kind: "reserve" | "busy" | "conflict" | "invalid" };
export interface ReceiptPreparation {
  commit(record: OperationRecord): boolean;
  cancel(): void;
}

// Operation receipts keyed by the durable identity (serverId, principalId, operationId). The relay
// instance is not part of the key: a record may reference a run of an earlier instance of the same
// server, and a same-intent resend must still find it.
//
// Without a backend, receipts live in memory for as long as this process (unit tests and the
// in-memory composition). With a DurableReceiptBackend, committed receipts live in the database
// and survive restarts; memory then holds only reservations that are not committed yet, and the
// receipt limit bounds those in-flight reservations rather than the durable history.
export class OperationReceipts {
  private readonly entries = new Map<string, Entry>();
  private readonly scratch: ByteReservation;
  private disposed = false;
  constructor(
    readonly composition: RuntimeComposition,
    private readonly encodeUtf8: (text: string) => Uint8Array,
    private readonly durable?: DurableReceiptBackend,
  ) {
    const scratch = this.bytes.reserve(
      6 * this.budgets.operationRecordBytes + 6 * this.budgets.canonicalIntentBytes,
    );
    if (!scratch) throw new Error("Receipt scratch capacity unavailable");
    this.scratch = scratch;
  }

  private get budgets() {
    return this.composition.budgets;
  }
  private get bytes() {
    return this.composition.bytes;
  }

  private id(key: OperationReceiptKey): string {
    return JSON.stringify([key.serverId, key.principalId, key.operationId]);
  }

  private valid(key: OperationReceiptKey): boolean {
    return (
      !this.disposed &&
      OperationReceiptKeySchema.safeParse(key).success &&
      key.serverId === this.composition.serverId
    );
  }

  // The committed receipt of a key, wherever it is kept. A backend failure throws: an unreadable
  // receipt must never look absent, or a resend would execute the operation again.
  private committed(key: OperationReceiptKey): StoredReceipt | null {
    if (this.durable) return this.durable.get(key);
    const entry = this.entries.get(this.id(key));
    return entry?.record
      ? { key: entry.key, canonicalIntent: entry.canonicalIntent, record: entry.record }
      : null;
  }

  lookup(key: OperationReceiptKey, canonicalIntent: string): ReceiptLookup {
    if (
      !this.valid(key) ||
      this.encodeUtf8(canonicalIntent).byteLength > this.budgets.canonicalIntentBytes
    )
      return { kind: "invalid" };
    const entry = this.entries.get(this.id(key));
    if (entry && !entry.record)
      return { kind: entry.canonicalIntent === canonicalIntent ? "busy" : "conflict" };
    let existing: StoredReceipt | null;
    try {
      existing = this.committed(key);
    } catch {
      return { kind: "invalid" };
    }
    const kind = classifyReceiptAdmission({
      key,
      canonicalIntent,
      ...(existing ? { existing } : {}),
      receiptCount: this.entries.size,
      receiptLimit: this.budgets.operationReceipts,
      encodeUtf8: this.encodeUtf8,
    });
    return kind === "existing" ? { kind, record: structuredClone(existing!.record) } : { kind };
  }

  prepare(key: OperationReceiptKey, canonicalIntent: string): ReceiptPreparation | null {
    if (this.lookup(key, canonicalIntent).kind !== "reserve") return null;
    const lease = this.bytes.reserve(
      6 * this.encodeUtf8(canonicalIntent).byteLength +
        6 * this.budgets.operationRecordBytes +
        1024,
    );
    if (!lease) return null;
    const entry: Entry = {
      key: { serverId: key.serverId, principalId: key.principalId, operationId: key.operationId },
      canonicalIntent,
      record: null,
      lease,
    };
    const id = this.id(key);
    this.entries.set(id, entry);
    return {
      commit: (record) => {
        if (this.disposed || this.entries.get(id) !== entry || entry.record !== null) return false;
        const valid = this.validate(entry.key, record);
        if (!valid || valid.revision !== 0 || valid.state !== "accepted") return false;
        if (!this.durable) {
          entry.record = structuredClone(valid);
          return true;
        }
        let inserted = false;
        try {
          inserted = this.durable.insert({
            key: entry.key,
            canonicalIntent: entry.canonicalIntent,
            record: valid,
          });
        } catch {
          inserted = false;
        }
        if (!inserted) return false;
        // The database owns the receipt now; the reservation is no longer in flight.
        this.entries.delete(id);
        lease.release();
        return true;
      },
      cancel: () => {
        if (this.entries.get(id) !== entry || entry.record !== null) return;
        this.entries.delete(id);
        lease.release();
      },
    };
  }

  // Whether a new run may be bound to the current instance is the caller's execution
  // precondition; the store only requires that a referenced run belongs to this server.
  private validate(key: OperationReceiptKey, record: OperationRecord): OperationRecord | null {
    const checked = validateOperationRecord(record, this.encodeUtf8);
    if (
      !checked ||
      this.encodeUtf8(JSON.stringify(checked)).byteLength > this.budgets.operationRecordBytes ||
      checked.operationId !== key.operationId ||
      (checked.run !== undefined && checked.run.serverId !== this.composition.serverId)
    )
      return null;
    return checked;
  }

  // The committed receipt when `next` is its successor: next revision, same method and run.
  private successor(key: OperationReceiptKey, next: OperationRecord): StoredReceipt | null {
    if (!this.valid(key)) return null;
    let current: StoredReceipt | null;
    try {
      current = this.committed(key);
    } catch {
      return null;
    }
    const record = current?.record;
    if (
      !record ||
      record.revision === Number.MAX_SAFE_INTEGER ||
      next.revision !== record.revision + 1 ||
      next.method !== record.method ||
      next.run?.serverId !== record.run?.serverId ||
      next.run?.relayInstanceId !== record.run?.relayInstanceId ||
      next.run?.runId !== record.run?.runId
    )
      return null;
    return current;
  }

  private replace(current: StoredReceipt, next: OperationRecord): boolean {
    const checked = this.validate(current.key, next);
    if (!checked) return false;
    if (!this.durable) {
      const entry = this.entries.get(this.id(current.key));
      if (!entry?.record) return false;
      entry.record = structuredClone(checked);
      return true;
    }
    try {
      return this.durable.replace(current.key, current.record.revision, checked);
    } catch {
      return false;
    }
  }

  // Ordinary progress of a live operation. Terminal states never change here, so a late executor
  // or verification result cannot replace succeeded, failed, cancelled or requires_attention.
  update(key: OperationReceiptKey, next: OperationRecord): boolean {
    const current = this.successor(key, next);
    if (!current || TERMINAL_STATES.has(current.record.state)) return false;
    return this.replace(current, next);
  }

  // The only way out of requires_attention (relay-protocol §11.5): an explicit operation.continue
  // moves the same operation to running or recovering, after which ordinary updates bring it to
  // its normal terminal state; operation.abandon ends it as cancelled. The caller names the
  // revision it inspected, so a recovery decided on a stale view is refused. succeeded, failed
  // and cancelled never change.
  recover(key: OperationReceiptKey, expectedRevision: number, next: OperationRecord): boolean {
    const current = this.successor(key, next);
    if (
      !current ||
      current.record.state !== "requires_attention" ||
      current.record.revision !== expectedRevision ||
      !RECOVERY_STATES.has(next.state)
    )
      return false;
    return this.replace(current, next);
  }

  // Startup verification (m1 "操作身份跨重启", relay-protocol §11.4). Run once, before this
  // instance accepts any request, so every accepted, running or recovering receipt belongs to an
  // earlier instance and has no executor any more. Each moves to `recovering` and then to the
  // outcome its method's verifier proves; without a verifier or proof it becomes
  // requires_attention. Nothing is executed again: continuing or abandoning is an explicit command
  // with its own operation ID. Returns the receipts that were verified.
  //
  // `verifiers` come from operations/recovery-verifiers.ts; a method without one keeps the generic
  // outcome. The move to `recovering` is committed before the verifier runs, so a crash during
  // verification leaves the receipt `recovering` and the next start verifies it again; the
  // verifier's outcome is committed in a second transaction. Startup is the only caller and runs
  // before any request is served, so nothing else changes these receipts in between.
  async recoverInterrupted(verifiers: ReceiptVerifiers = {}): Promise<OperationRecord[]> {
    const durable = this.durable;
    if (!durable || this.disposed) return [];
    const verified: OperationRecord[] = [];
    for (const receipt of durable.unfinished()) {
      const key = receipt.key;
      const record = durable.atomic(() => {
        const current = this.committed(key)?.record;
        if (!current || TERMINAL_STATES.has(current.state)) return null;
        if (current.state === "recovering") return current;
        const recovering: OperationRecord = {
          ...current,
          revision: current.revision + 1,
          state: "recovering",
        };
        if (!this.update(key, recovering)) throw new Error("Receipt verification refused");
        return recovering;
      });
      if (!record) continue;
      let proven: OperationRecord | null = null;
      try {
        proven = (await verifiers[record.method]?.(structuredClone(record))) ?? null;
      } catch {
        proven = null;
      }
      if (this.disposed) break;
      const outcome = durable.atomic(() => {
        if (proven && this.update(key, proven)) return proven;
        const attention: OperationRecord = {
          ...record,
          revision: record.revision + 1,
          state: "requires_attention",
          error: domainError("RESULT_UNKNOWN", "unknown"),
        };
        if (!this.update(key, attention)) throw new Error("Receipt verification refused");
        return attention;
      });
      verified.push(outcome);
    }
    return verified;
  }

  get(key: OperationReceiptKey): OperationRecord | null {
    if (!this.valid(key)) return null;
    let record: OperationRecord | undefined;
    try {
      record = this.committed(key)?.record;
    } catch {
      return null;
    }
    return record ? structuredClone(record) : null;
  }
  // Receipts held in memory: every receipt without a backend, in-flight reservations with one.
  get count(): number {
    return this.entries.size;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.lease.release();
    this.entries.clear();
    this.scratch.release();
  }
}
