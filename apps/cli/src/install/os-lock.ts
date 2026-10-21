import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// Process-lifetime OS locks on SQLite files, for the install lock (layout.ts) and for probing the
// server's instance lock (server-state.ts).
//
// The lock is an exclusive SQLite transaction on an empty database file: a POSIX advisory lock the
// kernel arbitrates and drops when its holder exits, however it exits. A crashed holder therefore
// needs no takeover and there is no stale-holder guess (a PID check cannot tell a reused PID from
// the holder, and two commands that both decided a holder was dead could both take over). No
// command deletes or renames a lock file: had one removed it while another held its lock, a third
// command could lock a new file at the same path beside the holder. Release is the holder rolling
// back its own transaction and closing its own connection.
//
// The same approach as the client credential record lock (T2, PR #161) and the server's instance
// lock (apps/server/src/store/database.ts lockInstance), whose file this module also probes. POSIX
// locks belong to a process: a process must never open a second connection to a file it holds the
// lock of, since closing that connection would drop the lock. A CLI command takes the install lock
// once and probes the server's lock, a different file that the CLI never holds.

// SQLite's primary result code for a lock that another connection holds.
const SQLITE_BUSY = 5;

function busy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 0xff) === SQLITE_BUSY;
}

// Takes the exclusive lock of `path` without waiting; null when another process holds it. The
// file is created owner-only when missing.
export async function tryExclusiveLock(path: string): Promise<DatabaseSync | null> {
  // Created 0600 before SQLite opens it, which would otherwise create it with the umask's mode.
  await (await open(path, "a", 0o600)).close();
  return exclusive(path);
}

function exclusive(path: string): DatabaseSync | null {
  const database = new DatabaseSync(path, { timeout: 0 });
  try {
    // No rollback journal file: an exclusive transaction otherwise creates `<path>-journal`, which
    // a holder killed mid-transaction would leave behind. The pragma itself can meet the lock.
    database.exec("PRAGMA journal_mode = MEMORY");
    database.exec("BEGIN EXCLUSIVE");
    return database;
  } catch (error) {
    database.close();
    if (busy(error)) return null;
    throw error;
  }
}

export function releaseLock(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

// Whether some process holds the exclusive lock of `path` right now. A missing file is not held
// (and is not created: probing must not make a lock file where no holder ever made one).
export function lockHeld(path: string): boolean {
  if (!existsSync(path)) return false;
  const database = exclusive(path);
  if (!database) return true;
  releaseLock(database);
  return false;
}
