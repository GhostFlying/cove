import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from "./migrations.js";
import { committedSchemaVersion } from "./schema-version.js";

export type StoreErrorCategory = "in-use" | "newer-schema" | "unavailable" | "migration";

// A startup failure of the store. The category is safe to print; the database is never left
// half-migrated (migrations run in one transaction) and a refused database is not written.
export class StoreError extends Error {
  constructor(
    readonly category: StoreErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

// Observes the synchronous execution of each outermost transaction (D6 probe). Times come from
// performance.timeOrigin + performance.now() so that they correlate with client timestamps.
export type TransactionObserver = (startMs: number, endMs: number) => void;

export type StoreOptions = {
  databasePath: string;
  backupDirectory: string;
  now?: () => number;
  migrations?: readonly Migration[];
};

function busy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

// The server's only connection to its database (D5, D6). The connection runs in EXCLUSIVE locking
// mode and keeps the database lock from its first write until close, so the lock is the
// single-instance guarantee for the data directory (D7): a second server on the same directory
// fails immediately (busy_timeout 0), and the operating system releases the lock when a crashed
// server's process ends.
//
// Never open a second connection to this file from the same process: POSIX advisory locks belong
// to the process, and closing any other connection to the file would drop this one's lock.
//
// All calls are synchronous on the runtime main thread (D6 A). Callers pass one complete business
// operation to transaction(); a transaction never spans an await.
export class Store {
  private observer: TransactionObserver | undefined;
  private depth = 0;
  private closed = false;
  private constructor(
    readonly db: Database.Database,
    readonly path: string,
    readonly schemaVersion: number,
    readonly backupPath: string | null,
  ) {}

  static async open(options: StoreOptions): Promise<Store> {
    const migrations = options.migrations ?? MIGRATIONS;
    const target = migrations.length;
    const now = options.now ?? Date.now;
    // A newer build's database is refused before SQLite opens it: opening could checkpoint a WAL
    // that build left behind (see schema-version.ts). The check after opening stays for a version
    // written in between.
    let committed: number;
    try {
      committed = await committedSchemaVersion(options.databasePath);
    } catch {
      throw new StoreError("unavailable", "The Cove database cannot be opened");
    }
    if (committed > target)
      throw new StoreError(
        "newer-schema",
        `The Cove database schema ${committed} is newer than this build (${target})`,
      );
    let db: Database.Database;
    try {
      db = new Database(options.databasePath, { timeout: 0 });
    } catch (error) {
      throw busy(error)
        ? new StoreError("in-use", "The Cove data directory is in use by another server")
        : new StoreError("unavailable", "The Cove database cannot be opened");
    }
    try {
      // Set before the first read so the connection never uses a shared-memory WAL index and
      // keeps every lock it takes. Changing the locking mode does not touch the file.
      db.pragma("locking_mode = EXCLUSIVE");
      db.pragma("busy_timeout = 0");
      let version: number;
      try {
        version = db.pragma("user_version", { simple: true }) as number;
      } catch (error) {
        if (busy(error))
          throw new StoreError("in-use", "The Cove data directory is in use by another server");
        throw error;
      }
      // Refuse before any write: a newer build's database stays exactly as it was.
      if (version > target)
        throw new StoreError(
          "newer-schema",
          `The Cove database schema ${version} is newer than this build (${target})`,
        );
      let backupPath: string | null = null;
      try {
        if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal")
          throw new StoreError("unavailable", "The Cove database cannot use WAL");
        db.pragma("synchronous = FULL");
        db.pragma("foreign_keys = ON");
        // The first write takes the exclusive lock and keeps it: rewriting the same version is
        // the smallest write. A concurrent server that read the version first fails here.
        db.pragma(`user_version = ${version}`);
      } catch (error) {
        if (busy(error))
          throw new StoreError("in-use", "The Cove data directory is in use by another server");
        throw error;
      }
      if (version < target) {
        if (version > 0) {
          // A copy of the previous schema's data, taken under the lock before migrating.
          await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 });
          backupPath = join(
            options.backupDirectory,
            `cove-schema-${version}-${now()}-${randomUUID().slice(0, 8)}.db`,
          );
          db.prepare("VACUUM INTO ?").run(backupPath);
        }
        try {
          db.transaction(() => {
            for (const migration of migrations.slice(version)) db.exec(migration.sql);
            db.pragma(`user_version = ${target}`);
          }).immediate();
        } catch {
          throw new StoreError("migration", "The Cove database migration failed; nothing changed");
        }
      }
      return new Store(db, options.databasePath, target, backupPath);
    } catch (error) {
      db.close();
      if (error instanceof StoreError) throw error;
      throw new StoreError("unavailable", "The Cove database cannot be opened");
    }
  }

  observe(observer: TransactionObserver | undefined): void {
    this.observer = observer;
  }

  // Runs fn as one transaction; nested calls become savepoints of the outer one. fn must be
  // synchronous: better-sqlite3 commits when it returns and rolls back when it throws.
  transaction<T>(fn: () => T): T {
    if (this.closed) throw new Error("Store closed");
    if (this.depth > 0 || !this.observer) return this.run(fn);
    const start = performance.timeOrigin + performance.now();
    try {
      return this.run(fn);
    } finally {
      this.observer(start, performance.timeOrigin + performance.now());
    }
  }

  private run<T>(fn: () => T): T {
    this.depth++;
    try {
      return this.db.transaction(fn).immediate();
    } finally {
      this.depth--;
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export { SCHEMA_VERSION };
