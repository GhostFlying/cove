import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Migration } from "./migrations.js";
import { committedSchemaVersion } from "./schema-version.js";
import { StoreError } from "./store-errors.js";

export function busy(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

export type ConnectionOptions = {
  databasePath: string;
  backupDirectory: string;
  migrations: readonly Migration[];
  // Time source of the backup file name.
  now: number;
};

export type OpenedConnection = {
  db: Database.Database;
  schemaVersion: number;
  backupPath: string | null;
};

// Opens the server's only connection to its database (D5). The caller already holds the instance
// lock (database.ts), so the files cannot change between the version check and the open.
//
// The connection runs in EXCLUSIVE locking mode and keeps the database lock from its first write
// until close, a second line of the single-instance guarantee (D7): another opener fails
// immediately (busy_timeout 0).
//
// A newer build's database is refused before SQLite opens it: opening could checkpoint a WAL that
// build left behind (see schema-version.ts). The check after opening is a second line of defence.
// Refusals never write; migrations run in one transaction after a VACUUM INTO backup, so the
// database is never left half-migrated.
export async function openConnection(options: ConnectionOptions): Promise<OpenedConnection> {
  const target = options.migrations.length;
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
          `cove-schema-${version}-${options.now}-${randomUUID().slice(0, 8)}.db`,
        );
        db.prepare("VACUUM INTO ?").run(backupPath);
      }
      try {
        db.transaction(() => {
          for (const migration of options.migrations.slice(version)) db.exec(migration.sql);
          db.pragma(`user_version = ${target}`);
        }).immediate();
      } catch {
        throw new StoreError("migration", "The Cove database migration failed; nothing changed");
      }
    }
    return { db, schemaVersion: target, backupPath };
  } catch (error) {
    db.close();
    if (error instanceof StoreError) throw error;
    throw new StoreError("unavailable", "The Cove database cannot be opened");
  }
}
