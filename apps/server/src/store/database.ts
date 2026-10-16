import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { busy, openConnection } from "./connection.js";
import { execute, loadOperations, type OperationTable } from "./executor.js";
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from "./migrations.js";
import type { StoreArgs, StoreOperationName, StoreResult } from "./sql/registry.js";
import {
  reviveStoreError,
  StoreError,
  StoreUnavailableError,
  type StoreErrorCategory,
} from "./store-errors.js";

export { StoreError, type StoreErrorCategory };

// Observes the execution interval of every store call (D6 probe). Times come from
// performance.timeOrigin + performance.now() so that they correlate with client timestamps.
export type TransactionObserver = (startMs: number, endMs: number) => void;

export type StoreOptions = {
  databasePath: string;
  // The instance lock file; defaults to `cove.lock` beside the database.
  lockPath?: string;
  backupDirectory: string;
  now?: () => number;
  migrations?: readonly Migration[];
  // File URLs of modules whose `operations` are added to the built-in ones (tests).
  operationModules?: readonly string[];
};

// The server's database (D5, D6). Callers run complete business operations by name
// (store/sql/registry.ts); each call is one transaction, so a business operation is never split
// across calls and never spans an await.
//
// The instance lock (`cove.lock`, held before the database is touched): the newer-schema refusal
// must leave a newer build's files byte-for-byte unchanged, so the committed version is read from
// the files before SQLite opens them (schema-version.ts; opening could checkpoint a newer build's
// WAL on close). Without a lock, a newer server could commit into the WAL between that read and
// the open, and the refusal's close would checkpoint it. The database's own lock cannot be taken
// without SQLite reading (and later possibly checkpointing) the WAL, so every server first takes
// an exclusive lock on a separate SQLite file: an open BEGIN EXCLUSIVE transaction, held until
// close and never committed, so the lock file is never written after creation. Holding it, no
// other server of this data directory is running or can start, and the files cannot change
// between the version check and the open. The operating system releases it when a crashed server
// exits.
//
// Never open a second connection to either file from the same process: POSIX advisory locks
// belong to the process, and closing any other connection to the file would drop this one's lock.
export class Store {
  private observer: TransactionObserver | undefined;
  private closed = false;
  private constructor(
    private readonly lock: Database.Database,
    private readonly db: Database.Database,
    private readonly operations: OperationTable,
    readonly path: string,
    readonly schemaVersion: number,
    readonly backupPath: string | null,
  ) {}

  static async open(options: StoreOptions): Promise<Store> {
    const lock = lockInstance(options.lockPath ?? join(dirname(options.databasePath), "cove.lock"));
    try {
      const operations = await loadOperations(options.operationModules);
      const opened = await openConnection({
        databasePath: options.databasePath,
        backupDirectory: options.backupDirectory,
        migrations: options.migrations ?? MIGRATIONS,
        now: (options.now ?? Date.now)(),
      });
      return new Store(
        lock,
        opened.db,
        operations,
        options.databasePath,
        opened.schemaVersion,
        opened.backupPath,
      );
    } catch (error) {
      lock.close();
      if (error instanceof StoreError) throw error;
      throw new StoreError("unavailable", "The Cove database cannot be opened");
    }
  }

  observe(observer: TransactionObserver | undefined): void {
    this.observer = observer;
  }

  // Runs one business operation as one transaction.
  call<N extends StoreOperationName>(name: N, args: StoreArgs<N>): Promise<StoreResult<N>>;
  call(name: string, args?: unknown): Promise<unknown>;
  call(name: string, args?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new StoreUnavailableError("closed", "not-sent"));
    const result = execute(this.db, this.operations, name, args);
    this.observer?.(result.timing[0], result.timing[1]);
    return result.ok
      ? Promise.resolve(result.value)
      : Promise.reject(reviveStoreError(result.error));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    // Released last: the database is closed (and checkpointed) before another server can start.
    this.lock.close();
  }
}

// Takes the instance lock or fails with in-use (see the class comment).
function lockInstance(path: string): Database.Database {
  let lock: Database.Database | undefined;
  try {
    lock = new Database(path, { timeout: 0 });
    // No rollback journal file: an exclusive transaction otherwise creates `cove.lock-journal`.
    lock.pragma("journal_mode = MEMORY");
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock?.close();
    throw busy(error)
      ? new StoreError("in-use", "The Cove data directory is in use by another server")
      : new StoreError("unavailable", "The Cove data directory lock cannot be taken");
  }
}

export { SCHEMA_VERSION };
