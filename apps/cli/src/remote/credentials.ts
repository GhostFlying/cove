import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { PortSchema } from "@cove/protocol/auth";
import { DeviceIdSchema, DeviceTokenSchema } from "@cove/protocol/bootstrap";
import { OpaqueIdSchema } from "@cove/protocol/identity";

// The client's record of the servers it is paired with (m2 D5): one file per server,
// `<home>/client/servers/<serverId>.json`, mode 0600 in 0700 directories, replaced atomically. It
// holds the alias the operator addresses the server by, the device ID and token this client was
// given at pairing (the only place the token is kept on disk), and the entries this client has
// verified reach that server, with the default one (D11: never switched automatically).
//
// Entries. T1 verifies only the loopback entry: pairing over 127.0.0.1 checks the serverId the
// pairing listener reports before the secret is submitted. T2 (SSH) and T4 (tsnet) add their
// kinds here together with their verification.

export const ENTRY_KINDS = ["loopback", "ssh", "tsnet"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export type LoopbackEntry = { readonly port: number };
export type ServerEntries = { readonly loopback?: LoopbackEntry };

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
  for (const [kind, entry] of Object.entries(entries)) {
    if (kind !== "loopback" || !entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).join() !== "port" || !PortSchema.safeParse(fields.port).success)
      return null;
  }
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
// A lock file still empty this long after it was created belongs to a command that died between
// creating it and writing its PID.
const EMPTY_LOCK_STALE_MS = 5_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Runs `action` holding the record lock of `serverId`: `<serverId>.lock` beside the record,
// created exclusively and holding the PID of the command that holds it. Every command that
// changes a record (rotate, remote entry default, remote remove) reads the latest record under
// the lock and writes it before releasing it, so concurrent commands are serialized and none
// writes over another's change (a token saved by one rotation, a default entry chosen by
// another command). Commands that only read the record take no lock.
//
// A lock whose holder is no longer running (a command that crashed) is taken over: it is renamed
// away first, and restored when the renamed file turns out to be another command's newer lock.
// The PID check cannot tell a reused PID from the holder, which then only delays this command
// until LOCK_WAIT_MS ends with an error naming the lock file.
export async function withServerLock<T>(
  home: string,
  serverId: string,
  action: () => Promise<T>,
): Promise<T> {
  await ownerOnlyDirectory(home);
  await ownerOnlyDirectory(clientDirectory(home));
  await ownerOnlyDirectory(serversDirectory(home));
  const path = recordPath(home, serverId).replace(/\.json$/, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const seen = await readFile(path, "utf8").catch(() => null);
    if (seen !== null) {
      const pid = Number(seen.trim());
      const created = seen === "" ? await lstat(path).catch(() => null) : null;
      const stale =
        seen === ""
          ? created !== null && Date.now() - created.mtimeMs > EMPTY_LOCK_STALE_MS
          : Number.isSafeInteger(pid) && pid > 0 && !alive(pid);
      if (stale) {
        const moved = `${path}.${randomUUID()}.stale`;
        if (
          await rename(path, moved).then(
            () => true,
            () => false,
          )
        ) {
          if ((await readFile(moved, "utf8").catch(() => null)) !== seen)
            await link(moved, path).catch(() => undefined);
          await unlink(moved).catch(() => undefined);
        }
        continue;
      }
    }
    if (Date.now() > deadline)
      throw new Error(
        `another cove command holds the credential record of server ${serverId} (${path}); ` +
          "nothing was changed. Remove the file if no cove command is running",
      );
    await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
  }
  try {
    return await action();
  } finally {
    await unlink(path).catch(() => undefined);
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
