import { Rollback, type Connection, type SqlOperation } from "./sql/statements.js";
import { STORE_OPERATIONS } from "./sql/registry.js";
import { serializeStoreError, type SerializedStoreError } from "./store-errors.js";
import type { BusinessJournal, StoreBusinessPublication } from "./business-journal.js";

export type OperationTable = ReadonlyMap<string, SqlOperation<unknown, unknown>>;

// The built-in operations plus those of `modules` (file URLs of ES modules exporting an
// `operations` object; Store.open's `operationModules`, used by tests to inspect the database or
// inject faults). A module may not replace a built-in operation.
export async function loadOperations(modules: readonly string[] = []): Promise<OperationTable> {
  const table = new Map<string, SqlOperation<unknown, unknown>>(
    Object.entries(STORE_OPERATIONS) as [string, SqlOperation<unknown, unknown>][],
  );
  for (const url of modules) {
    const { operations } = (await import(url)) as {
      operations?: Record<string, SqlOperation<unknown, unknown>>;
    };
    for (const [name, operation] of Object.entries(operations ?? {})) {
      if (table.has(name) || typeof operation !== "function")
        throw new Error(`Store operation ${name} cannot be registered`);
      table.set(name, operation);
    }
  }
  return table;
}

// A hook of a test module (exported as `afterCommit`): called after an operation answered without
// error and before its result is posted, with the operation's name and value; it returns the value
// to post. Tests use it to lose a committed call's reply (end the thread, or return a value that
// cannot be cloned). Only `operationModules` supply hooks, and production passes none.
export type AfterCommitHook = (operation: string, value: unknown) => unknown;

export async function loadAfterCommitHooks(
  modules: readonly string[] = [],
): Promise<AfterCommitHook[]> {
  const hooks: AfterCommitHook[] = [];
  for (const url of modules) {
    const { afterCommit } = (await import(url)) as { afterCommit?: unknown };
    if (typeof afterCommit === "function") hooks.push(afterCommit as AfterCommitHook);
  }
  return hooks;
}

export type Execution =
  | { ok: true; value: unknown; timing: [number, number]; business?: StoreBusinessPublication }
  | { ok: false; error: SerializedStoreError; timing: [number, number] };

const now = (): number => performance.timeOrigin + performance.now();

// Runs one named operation as exactly one transaction (BEGIN IMMEDIATE ... COMMIT) and reports
// the interval it occupied the connection. Times are performance.timeOrigin + performance.now(),
// which agree across threads of one process, so the D6 probe can correlate them with timestamps
// taken on the main thread. A Rollback thrown by the operation rolls back and answers its value;
// any other exception rolls back and is reported as an error.
export function execute(
  db: Connection,
  operations: OperationTable,
  name: string,
  args: unknown,
  journal?: BusinessJournal,
): Execution {
  const start = now();
  const operation = operations.get(name);
  if (!operation)
    return {
      ok: false,
      error: { kind: "operation", code: null, message: "Unknown store operation" },
      timing: [start, now()],
    };
  try {
    journal?.clear();
    let business: StoreBusinessPublication | undefined;
    const value = db
      .transaction(() => {
        const answer = operation(db, args);
        business = journal?.collect();
        return answer;
      })
      .immediate();
    return { ok: true, value, timing: [start, now()], ...(business ? { business } : {}) };
  } catch (error) {
    if (error instanceof Rollback) return { ok: true, value: error.value, timing: [start, now()] };
    return { ok: false, error: serializeStoreError(error), timing: [start, now()] };
  }
}
