import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PortSchema, SshTargetSchema } from "@cove/protocol/auth";
import { DeviceIdSchema, DeviceTokenSchema } from "@cove/protocol/bootstrap";
import { OpaqueIdSchema } from "@cove/protocol/identity";

// The client's record of the servers it is paired with (m2 D5): one file per server,
// `<home>/client/servers/<serverId>.json`, mode 0600 in 0700 directories, replaced atomically. It
// holds the alias the operator addresses the server by, the device ID and token this client was
// given at pairing (the only place the token is kept on disk), and the entries this client has
// verified reach that server, with the default one (D11: never switched automatically).
//
// Entries (D11). Each names how this client reaches the server's loopback business port:
// - loopback `{ port }`: the server is on this host (recorded when pairing over loopback);
// - ssh `{ target, port }`: `ssh -L` to `target`, forwarding to 127.0.0.1:`port` on its host
//   (ssh-tunnel.ts). The target is the one the invitation advertised.
// An entry is verified on every use, not once at pairing: the channel's own peer check (ssh's
// host key against the user's known_hosts) and then the serverId (entries.ts verifiedIdentity),
// both before the token is released. T4 adds the tsnet kind with its node identity.

export const ENTRY_KINDS = ["loopback", "ssh", "tsnet"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export type LoopbackEntry = { readonly port: number };
export type SshEntry = { readonly target: string; readonly port: number };
export type ServerEntries = { readonly loopback?: LoopbackEntry; readonly ssh?: SshEntry };

// Whether `entry` is a valid entry of `kind`, with exactly its members.
function validEntry(kind: string, entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const fields = entry as Record<string, unknown>;
  const keys = Object.keys(fields).sort().join();
  if (!PortSchema.safeParse(fields.port).success) return false;
  if (kind === "loopback") return keys === "port";
  if (kind === "ssh")
    return keys === "port,target" && SshTargetSchema.safeParse(fields.target).success;
  return false;
}

export type ServerRecord = {
  readonly version: 1;
  readonly alias: string;
  readonly serverId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly defaultEntry: EntryKind;
  readonly entries: ServerEntries;
  readonly pairedAtMs: number;
};

// An alias is chosen by the operator and given as `--server ALIAS` or COVE_SERVER.
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isEntryKind(value: unknown): value is EntryKind {
  return (ENTRY_KINDS as readonly unknown[]).includes(value);
}

// The record when `value` is a valid one, else null. Members other than the known ones make it
// invalid: a record is only ever written by this module.
export function parseServerRecord(value: unknown): ServerRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join();
  if (keys !== "alias,defaultEntry,deviceId,entries,pairedAtMs,serverId,token,version") return null;
  const entries = record.entries as Record<string, unknown> | null;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
  for (const [kind, entry] of Object.entries(entries)) if (!validEntry(kind, entry)) return null;
  const token = DeviceTokenSchema.safeParse(record.token);
  if (
    record.version !== 1 ||
    typeof record.alias !== "string" ||
    !ALIAS_PATTERN.test(record.alias) ||
    !OpaqueIdSchema.safeParse(record.serverId).success ||
    !DeviceIdSchema.safeParse(record.deviceId).success ||
    !token.success ||
    !token.data.startsWith(`cove_d1_${record.deviceId as string}.`) ||
    !isEntryKind(record.defaultEntry) ||
    entries[record.defaultEntry] === undefined ||
    !Number.isSafeInteger(record.pairedAtMs) ||
    (record.pairedAtMs as number) < 0
  )
    return null;
  return record as ServerRecord;
}

function clientDirectory(home: string): string {
  return join(home, "client");
}

function serversDirectory(home: string): string {
  return join(clientDirectory(home), "servers");
}

function recordPath(home: string, serverId: string): string {
  if (!OpaqueIdSchema.safeParse(serverId).success) throw new Error("Invalid serverId");
  return join(serversDirectory(home), `${serverId}.json`);
}

// Creates `path` as an owner-only directory, or narrows an existing one this user owns to 0700.
// A symlink or another user's directory is refused rather than used.
async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(`${path} is not a directory owned by this user`);
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Every record, sorted by alias. An unreadable or invalid file is an error naming it: a
// credential file is never silently ignored or replaced.
export async function listServers(home: string): Promise<ServerRecord[]> {
  let names: string[];
  try {
    names = await readdir(serversDirectory(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ServerRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(serversDirectory(home), name);
    let record: ServerRecord | null = null;
    try {
      record = parseServerRecord(JSON.parse(await readFile(path, "utf8")));
    } catch {
      record = null;
    }
    if (!record || `${record.serverId}.json` !== name)
      throw new Error(`the client credential file ${path} is invalid`);
    records.push(record);
  }
  return records.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function findServer(home: string, alias: string): Promise<ServerRecord | null> {
  return (await listServers(home)).find((record) => record.alias === alias) ?? null;
}

// Writes a record atomically: a complete, synced 0600 file is renamed over the old one, and the
// directory is synced, so a crash leaves the old record or the new one, never a partial token.
export async function saveServer(home: string, record: ServerRecord): Promise<void> {
  if (!parseServerRecord(record)) throw new Error("Refusing to save an invalid server record");
  await ownerOnlyDirectory(home);
  await ownerOnlyDirectory(clientDirectory(home));
  await ownerOnlyDirectory(serversDirectory(home));
  const path = recordPath(home, record.serverId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(serversDirectory(home));
}

// The record of `serverId` as it is on disk now, or null when there is none.
export async function readServer(home: string, serverId: string): Promise<ServerRecord | null> {
  const path = recordPath(home, serverId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let record: ServerRecord | null;
  try {
    record = parseServerRecord(JSON.parse(text));
  } catch {
    record = null;
  }
  if (!record || record.serverId !== serverId)
    throw new Error(`the client credential file ${path} is invalid`);
  return record;
}

// How long a command waits for another cove command to release a server's record, and how often
// it looks. A rotation holds the lock across its requests, which the client bounds.
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 50;
// SQLite's result code for a lock that another connection holds.
const SQLITE_BUSY = 5;

function busy(error: unknown): boolean {
  return (error as { errcode?: unknown } | null)?.errcode === SQLITE_BUSY;
}

// Runs `action` holding the record lock of `serverId`. Every command that changes a record
// (rotate, remote entry default, remote remove) reads the latest record under the lock and writes
// it before releasing it, so concurrent commands are serialized and none writes over another's
// change (a token saved by one rotation, a default entry chosen by another command). Commands
// that only read the record take no lock.
//
// The lock is an OS lock that lives exactly as long as the process holding it: an exclusive
// SQLite transaction, which is a POSIX advisory lock the kernel arbitrates, on the empty database
// `<serverId>.lock.sqlite` beside the record. The kernel drops the lock when its holder exits,
// however it exits, so a crashed command's lock needs no takeover and there is no stale-holder
// guess (a PID check could not tell a reused PID from the holder). No command ever deletes or
// renames the file: had one removed it while another held its lock, a third command could lock a
// new file at the same path alongside the holder. Release is the holder rolling back its own
// transaction and closing its own connection, which cannot touch another command's lock. The file
// therefore stays after `remote remove`; it holds nothing. Waiting is bounded by LOCK_WAIT_MS and
// polls without blocking the event loop.
export async function withServerLock<T>(
  home: string,
  serverId: string,
  action: () => Promise<T>,
): Promise<T> {
  await ownerOnlyDirectory(home);
  await ownerOnlyDirectory(clientDirectory(home));
  await ownerOnlyDirectory(serversDirectory(home));
  const path = recordPath(home, serverId).replace(/\.json$/, ".lock.sqlite");
  // Created 0600 before SQLite opens it, which would otherwise create it with the umask's mode.
  await (await open(path, "a", 0o600)).close();
  const database = new DatabaseSync(path, { timeout: 0 });
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        database.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if (!busy(error)) throw error;
      }
      if (Date.now() > deadline)
        throw new Error(
          `another cove command holds the credential record of server ${serverId} (${path}); ` +
            "nothing was changed",
        );
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
    try {
      return await action();
    } finally {
      database.exec("ROLLBACK");
    }
  } finally {
    database.close();
  }
}

export async function removeServer(home: string, record: ServerRecord): Promise<void> {
  await unlink(recordPath(home, record.serverId));
  await syncDirectory(serversDirectory(home));
}

// What a listing shows of a record: everything but the token.
export function describeServer(record: ServerRecord): Record<string, unknown> {
  const { token: _token, version: _version, ...shown } = record;
  return shown;
}
