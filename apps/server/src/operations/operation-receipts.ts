import {
  classifyReceiptAdmission,
  OperationReceiptKeySchema,
  type OperationReceiptKey,
  type OperationRecord,
  type StoredReceipt,
  type WriteRpcMethod,
} from "@cove/protocol/rpc";
import { domainError } from "@cove/protocol/errors";
import type { ByteReservation } from "../terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../terminal/runtime-composition.js";
import {
  checkedReceiptRecord,
  intentDigest,
  RECEIPT_RETENTION_MS,
  type DatabaseWriteResult,
  type DatabaseWriteRequest,
  type PurgeArgs,
  type PurgeBatch,
  type ReceiptLimits,
  type ReceiptTombstone,
} from "./receipt-records.js";

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

// Durable storage of committed receipts (apps/server/src/store/operations.ts). Every method is
// asynchronous (the database runs in the store worker) and each write is atomic. `replace` is a
// compare-and-set on the stored revision, so two writers can never both advance the same record,
// whatever else runs between a read and the write. A rejected promise is a store failure
// (store/store-errors.ts), never an answer: an unreadable receipt must not look absent.
export interface DurableReceiptBackend {
  // The receipt, or the tombstone its purge left (m2 D13), or null for a key never used.
  get(key: OperationReceiptKey): Promise<StoredReceipt | ReceiptTombstone | null>;
  // Inserts a new receipt; false when the key already exists.
  insert(receipt: StoredReceipt): Promise<boolean>;
  // Replaces the record when the stored revision still equals expectedRevision.
  replace(
    key: OperationReceiptKey,
    expectedRevision: number,
    record: OperationRecord,
  ): Promise<boolean>;
  // Receipts left accepted, running or recovering, oldest first.
  unfinished(): Promise<StoredReceipt[]>;
  // One receipt-checked database write: receipt recheck, the named change and the receipt in a
  // single transaction (store/sql/receipts.ts, receipts.write).
  write(request: DatabaseWriteRequest, limits: ReceiptLimits): Promise<DatabaseWriteResult>;
  // Receipt retention (m2 D13), when the backend has it: one bounded batch per call, and the
  // run-N high-water mark a pass reads first (store/sql/receipts.ts receipts.purge). A backend
  // without them keeps every receipt.
  purge?(batch: PurgeArgs): Promise<PurgeBatch>;
  highestRun?(): Promise<number>;
}

// How OperationReceipts runs receipt retention. Production uses the defaults; tests pass a clock
// and timers. `now` is the wall clock (ms) that receipts are stamped with (store/operations.ts).
export type ReceiptRetentionOptions = {
  now?: () => number;
  retentionMs?: number;
  // Between the end of one pass and the start of the next.
  intervalMs?: number;
  // Receipts per batch, each batch one transaction.
  batchSize?: number;
  timers?: {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
};

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_BATCH = 256;

// The production timers: unref'd, so a scheduled pass never keeps the process alive.
const UNREF_TIMERS = {
  set(callback: () => void, ms: number): unknown {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function isTombstone(found: StoredReceipt | ReceiptTombstone | null): found is ReceiptTombstone {
  return found !== null && "expired" in found;
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
// `expired`: the receipt of the same request was purged after the retention period (m2 D13); the
// caller answers OPERATION_HISTORY_EXPIRED and executes nothing.
export type ReceiptLookup =
  | { kind: "existing"; record: OperationRecord }
  | { kind: "reserve" | "busy" | "conflict" | "invalid" | "expired" };
export interface ReceiptPreparation {
  // Commits the accepted record. False: refused (invalid, or the key exists), nothing written.
  // Rejects with the store's error when the store failed; an uncertain failure
  // (uncertainStoreOutcome) means the receipt may have been committed.
  commit(record: OperationRecord): Promise<boolean>;
  // Releases the reservation (also after a commit, where it does nothing).
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
//
// Every method is asynchronous. Between a read and a later write of the same method other calls
// may run, so each write is guarded on its own: a reservation is re-checked synchronously right
// before it is made (one in-flight reservation per key), and every replacement is a
// compare-and-set on the revision that was read.
//
// Store failures: lookup reports an unreadable receipt as `invalid` (nothing is executed, the
// caller refuses the request); get, update, recover and commit reject with the store's error, so a
// caller can tell an uncertain outcome from a refusal.
export class OperationReceipts {
  private readonly entries = new Map<string, Entry>();
  private readonly scratch: ByteReservation;
  private disposed = false;
  private readonly retention: Required<ReceiptRetentionOptions>;
  private retentionTimer: { handle: unknown } | null = null;
  private retentionPass: Promise<number> | null = null;
  constructor(
    readonly composition: RuntimeComposition,
    private readonly encodeUtf8: (text: string) => Uint8Array,
    private readonly durable?: DurableReceiptBackend,
    retention: ReceiptRetentionOptions = {},
  ) {
    this.retention = {
      now: retention.now ?? (() => Date.now()),
      retentionMs: retention.retentionMs ?? RECEIPT_RETENTION_MS,
      intervalMs: retention.intervalMs ?? RETENTION_INTERVAL_MS,
      batchSize: retention.batchSize ?? RETENTION_BATCH,
      timers: retention.timers ?? UNREF_TIMERS,
    };
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

  // The committed receipt of a key, wherever it is kept, or the tombstone its purge left. A backend
  // failure rejects: an unreadable receipt must never look absent, or a resend would execute the
  // operation again; for the same reason a tombstone is never taken for an absent receipt.
  private async committed(
    key: OperationReceiptKey,
  ): Promise<StoredReceipt | ReceiptTombstone | null> {
    if (this.durable) return this.durable.get(key);
    const entry = this.entries.get(this.id(key));
    return entry?.record
      ? { key: entry.key, canonicalIntent: entry.canonicalIntent, record: entry.record }
      : null;
  }

  async lookup(key: OperationReceiptKey, canonicalIntent: string): Promise<ReceiptLookup> {
    if (
      !this.valid(key) ||
      this.encodeUtf8(canonicalIntent).byteLength > this.budgets.canonicalIntentBytes
    )
      return { kind: "invalid" };
    const pending = this.pending(key, canonicalIntent);
    if (pending) return { kind: pending };
    let found: StoredReceipt | ReceiptTombstone | null;
    try {
      found = await this.committed(key);
    } catch {
      return { kind: "invalid" };
    }
    // A purged receipt (m2 D13): the ID is used for good. The same request is expired, another one
    // reusing the ID conflicts; neither is executed.
    if (isTombstone(found))
      return {
        kind: found.intentDigest === intentDigest(canonicalIntent) ? "expired" : "conflict",
      };
    const existing = found;
    // A reservation for the key may have been made while the store answered.
    const reserved = this.pending(key, canonicalIntent);
    if (reserved && !existing) return { kind: reserved };
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

  // An in-flight reservation of the key: busy for the same intent, conflict for another.
  private pending(key: OperationReceiptKey, canonicalIntent: string): "busy" | "conflict" | null {
    const entry = this.entries.get(this.id(key));
    if (!entry || entry.record) return null;
    return entry.canonicalIntent === canonicalIntent ? "busy" : "conflict";
  }

  async prepare(
    key: OperationReceiptKey,
    canonicalIntent: string,
  ): Promise<ReceiptPreparation | null> {
    if ((await this.lookup(key, canonicalIntent)).kind !== "reserve") return null;
    // Re-checked after the lookup's await: another call may have reserved the key or the last
    // free slot meanwhile.
    if (
      this.disposed ||
      this.entries.has(this.id(key)) ||
      this.entries.size >= this.budgets.operationReceipts
    )
      return null;
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
      commit: async (record) => {
        if (this.disposed || this.entries.get(id) !== entry || entry.record !== null) return false;
        const valid = this.validate(entry.key, record);
        if (!valid || valid.revision !== 0 || valid.state !== "accepted") return false;
        if (!this.durable) {
          entry.record = structuredClone(valid);
          return true;
        }
        // A store failure rejects; the reservation stays until the caller cancels it.
        const inserted = await this.durable.insert({
          key: entry.key,
          canonicalIntent: entry.canonicalIntent,
          record: valid,
        });
        if (!inserted || this.entries.get(id) !== entry) return false;
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
    return checkedReceiptRecord(key, record, this.limits, this.encodeUtf8);
  }

  private get limits(): ReceiptLimits {
    return {
      serverId: this.composition.serverId,
      operationRecordBytes: this.budgets.operationRecordBytes,
    };
  }

  // The committed receipt when `next` is its successor: next revision, same method and run.
  private async successor(
    key: OperationReceiptKey,
    next: OperationRecord,
  ): Promise<StoredReceipt | null> {
    if (!this.valid(key)) return null;
    const found = await this.committed(key);
    if (isTombstone(found)) return null;
    const current = found;
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

  // A compare-and-set on the revision `current` was read at.
  private async replace(current: StoredReceipt, next: OperationRecord): Promise<boolean> {
    const checked = this.validate(current.key, next);
    if (!checked || this.disposed) return false;
    if (!this.durable) {
      const entry = this.entries.get(this.id(current.key));
      if (!entry?.record || entry.record.revision !== current.record.revision) return false;
      entry.record = structuredClone(checked);
      return true;
    }
    return this.durable.replace(current.key, current.record.revision, checked);
  }

  // Ordinary progress of a live operation. Terminal states never change here, so a late executor
  // or verification result cannot replace succeeded, failed, cancelled or requires_attention.
  // False when refused; rejects on a store failure.
  async update(key: OperationReceiptKey, next: OperationRecord): Promise<boolean> {
    const current = await this.successor(key, next);
    if (!current || TERMINAL_STATES.has(current.record.state)) return false;
    return this.replace(current, next);
  }

  // The only way out of requires_attention (relay-protocol §11.5): an explicit operation.continue
  // moves the same operation to running or recovering, after which ordinary updates bring it to
  // its normal terminal state; operation.abandon ends it as cancelled. The caller names the
  // revision it inspected, so a recovery decided on a stale view is refused. succeeded, failed
  // and cancelled never change.
  async recover(
    key: OperationReceiptKey,
    expectedRevision: number,
    next: OperationRecord,
  ): Promise<boolean> {
    const current = await this.successor(key, next);
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
  // verifier's outcome is committed afterwards. Every step is a compare-and-set on the revision
  // just read. Startup is the only caller and runs before any request is served, so nothing else
  // changes these receipts in between; a refused step is therefore corruption and fails startup.
  async recoverInterrupted(verifiers: ReceiptVerifiers = {}): Promise<OperationRecord[]> {
    const durable = this.durable;
    if (!durable || this.disposed) return [];
    const verified: OperationRecord[] = [];
    for (const receipt of await durable.unfinished()) {
      const key = receipt.key;
      const found = await this.committed(key);
      const current = isTombstone(found) ? undefined : found?.record;
      if (!current || TERMINAL_STATES.has(current.state)) continue;
      let record = current;
      if (current.state !== "recovering") {
        record = { ...current, revision: current.revision + 1, state: "recovering" };
        if (!(await this.update(key, record))) throw new Error("Receipt verification refused");
      }
      let proven: OperationRecord | null = null;
      try {
        proven = (await verifiers[record.method]?.(structuredClone(record))) ?? null;
      } catch {
        proven = null;
      }
      if (this.disposed) break;
      let outcome: OperationRecord;
      if (proven && (await this.update(key, proven))) outcome = proven;
      else {
        outcome = {
          ...record,
          revision: record.revision + 1,
          state: "requires_attention",
          error: domainError("RESULT_UNKNOWN", "unknown"),
        };
        if (!(await this.update(key, outcome))) throw new Error("Receipt verification refused");
      }
      verified.push(outcome);
    }
    // Retention starts once startup verification is done (nothing is left accepted, running or
    // recovering by an earlier instance) and runs in the background from then on.
    this.startRetention();
    return verified;
  }

  // Receipt retention (m2 D13, #97; relay-protocol §11.3). The first pass is scheduled at once,
  // then one pass every intervalMs after the previous one ended; passes never overlap. Each pass
  // reads the run-N high-water mark, then purges due receipts in batches of batchSize, one store
  // call (one transaction in the store worker) per batch, until a batch is not full. Other store
  // calls queue between batches, so a long backlog delays a request by at most about one batch.
  //
  // Failures end the pass and leave the rest for the next one: a refused or failed batch rolled
  // back, and one whose answer was lost either committed whole or not at all, so repeating it
  // later is safe (what it purged is no longer due, its tombstones stay). dispose() clears the
  // timer, and a running pass stops before its next batch; the production timer is unref'd, so a
  // scheduled pass never keeps the process alive.
  private startRetention(): void {
    if (this.disposed || this.retentionTimer || !this.durable?.purge) return;
    this.scheduleRetention(0);
  }

  private scheduleRetention(ms: number): void {
    if (this.disposed) return;
    const timer: { handle: unknown } = { handle: undefined };
    timer.handle = this.retention.timers.set(() => {
      if (this.retentionTimer !== timer) return;
      void this.purgeExpired()
        .catch(() => 0)
        .then(() => {
          if (this.retentionTimer === timer) this.scheduleRetention(this.retention.intervalMs);
        });
    }, ms);
    this.retentionTimer = timer;
  }

  // One retention pass; resolves to the number of receipts purged. A pass already running is
  // joined rather than started twice. Rejects with the store's error when a store call fails.
  purgeExpired(): Promise<number> {
    this.retentionPass ??= this.runRetentionPass().finally(() => {
      this.retentionPass = null;
    });
    return this.retentionPass;
  }

  private async runRetentionPass(): Promise<number> {
    const durable = this.durable;
    if (!durable?.purge || this.disposed) return 0;
    // Read before any batch: every receipt that may hold the current mark names a run numbered at
    // least this (store/sql/receipts.ts purge). Without it, no receipt naming a run-N is purged.
    const highestRun = durable.highestRun ? await durable.highestRun() : 0;
    let purged = 0;
    while (!this.disposed) {
      const batch = await durable.purge({
        now: Math.trunc(this.retention.now()),
        retentionMs: this.retention.retentionMs,
        limit: this.retention.batchSize,
        highestRun,
      });
      purged += batch.purged;
      if (!batch.more) break;
    }
    return purged;
  }

  // One receipt-checked database write (operations/database-operations.ts). Without a durable
  // backend there is no database to write to. Rejects on a store failure.
  async write(request: DatabaseWriteRequest): Promise<DatabaseWriteResult> {
    if (!this.durable || !this.valid(request.key))
      return { error: domainError("CAPABILITY_UNAVAILABLE") };
    return this.durable.write(request, this.limits);
  }

  // Rejects on a store failure: an unreadable receipt is not an absent one. A purged receipt is
  // null here (nothing can act on it); read() tells it from one that never existed.
  async get(key: OperationReceiptKey): Promise<OperationRecord | null> {
    const found = await this.read(key);
    return found === "expired" ? null : found;
  }

  // The record of a key, "expired" when its receipt was purged after the retention period
  // (operation.get answers OPERATION_HISTORY_EXPIRED), or null when the key was never used.
  // Rejects on a store failure.
  async read(key: OperationReceiptKey): Promise<OperationRecord | "expired" | null> {
    if (!this.valid(key)) return null;
    const found = await this.committed(key);
    if (isTombstone(found)) return "expired";
    return found ? structuredClone(found.record) : null;
  }
  // Receipts held in memory: every receipt without a backend, in-flight reservations with one.
  get count(): number {
    return this.entries.size;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retentionTimer) this.retention.timers.clear(this.retentionTimer.handle);
    this.retentionTimer = null;
    for (const entry of this.entries.values()) entry.lease.release();
    this.entries.clear();
    this.scratch.release();
  }
}
