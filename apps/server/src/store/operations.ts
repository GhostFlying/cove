import type { OperationReceiptKey, OperationRecord, StoredReceipt } from "@cove/protocol/rpc";
import type { DurableReceiptBackend } from "../operations/operation-receipts.js";
import type {
  DatabaseWriteOutcome,
  DatabaseWriteRequest,
  ReceiptLimits,
} from "../operations/receipt-records.js";
import type { Store } from "./database.js";

// The operations table (migration 001) as the durable backend of OperationReceipts; the SQL is in
// store/sql/receipts.ts. The caller (OperationReceipts) validates every record it inserts or
// replaces; receipts.write validates the records it creates itself.
export class SqliteReceiptBackend implements DurableReceiptBackend {
  constructor(
    private readonly store: Store,
    // The relay instance that accepts new receipts in this process.
    private readonly relayInstanceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: OperationReceiptKey): Promise<StoredReceipt | null> {
    return this.store.call("receipts.get", { key: { ...key } });
  }

  insert(receipt: StoredReceipt): Promise<boolean> {
    return this.store.call("receipts.insert", {
      receipt,
      relayInstanceId: this.relayInstanceId,
      at: this.now(),
    });
  }

  replace(
    key: OperationReceiptKey,
    expectedRevision: number,
    record: OperationRecord,
  ): Promise<boolean> {
    return this.store.call("receipts.replace", {
      key: { ...key },
      expectedRevision,
      record,
      at: this.now(),
    });
  }

  unfinished(): Promise<StoredReceipt[]> {
    return this.store.call("receipts.unfinished", undefined);
  }

  write(request: DatabaseWriteRequest, limits: ReceiptLimits): Promise<DatabaseWriteOutcome> {
    return this.store.call("receipts.write", {
      ...request,
      relayInstanceId: this.relayInstanceId,
      at: this.now(),
      limits,
    });
  }
}
