// The failures of the store, as seen by its callers on the main thread. Each kind says what is
// known about the call's effect, which is what callers need to answer a client truthfully:
//
// - StoreError: opening the store failed (category). Nothing was written: refusals happen before
//   any write, and a migration runs in one transaction.
// - StoreOperationError: the operation ran and threw; its transaction rolled back, so it changed
//   nothing. `code` is SQLite's error code (for example SQLITE_CONSTRAINT_UNIQUE) when SQLite
//   raised it, otherwise null.
// - StoreUnavailableError: the store could not answer. `outcome` is
//   - "not-sent": the call never reached the database (queue full, store closing, closed or
//     failed); it did not execute;
//   - "unknown": the call was handed to the database and no answer came back (the store failed
//     while it was in flight); it may have committed.
// Callers must surface "unknown" as an unknown result and never repeat the call on their own.

export type StoreErrorCategory = "in-use" | "newer-schema" | "unavailable" | "migration";

export class StoreError extends Error {
  constructor(
    readonly category: StoreErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export class StoreOperationError extends Error {
  constructor(
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StoreOperationError";
  }
}

export type StoreUnavailableReason = "busy" | "closed" | "failed";

export class StoreUnavailableError extends Error {
  constructor(
    readonly reason: StoreUnavailableReason,
    readonly outcome: "not-sent" | "unknown",
  ) {
    super(
      outcome === "unknown"
        ? "The Cove store failed before answering; the result is unknown"
        : reason === "busy"
          ? "The Cove store queue is full"
          : "The Cove store is not available",
    );
    this.name = "StoreUnavailableError";
  }
}

// Whether the store may have committed the call's effect without the caller learning of it.
export function uncertainStoreOutcome(error: unknown): boolean {
  return error instanceof StoreUnavailableError && error.outcome === "unknown";
}

// The structured-clone-safe form of an error thrown where the database runs. Only the kind, the
// fixed message and the SQLite code cross; stacks and arbitrary properties do not.
export type SerializedStoreError =
  | { kind: "store"; category: StoreErrorCategory; message: string }
  | { kind: "operation"; code: string | null; message: string };

const CATEGORIES: ReadonlySet<string> = new Set([
  "in-use",
  "newer-schema",
  "unavailable",
  "migration",
]);

export function serializeStoreError(error: unknown): SerializedStoreError {
  if (error instanceof StoreError)
    return { kind: "store", category: error.category, message: error.message };
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "The store operation failed";
  return {
    kind: "operation",
    code: typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? code : null,
    message: message.slice(0, 512),
  };
}

export function reviveStoreError(error: SerializedStoreError): Error {
  if (error.kind === "store" && CATEGORIES.has(error.category))
    return new StoreError(error.category, error.message);
  if (error.kind === "operation") return new StoreOperationError(error.code, error.message);
  return new StoreOperationError(null, "The store operation failed");
}
