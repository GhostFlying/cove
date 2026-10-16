import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  M1_LIMITS,
  MountRecordStateSchema,
  type MountRecord,
  type MountSource,
} from "@cove/protocol/workspace";
import { MANIFEST_NAME } from "./manifest.js";

// The workspace entry directory on disk (docs/milestones/m1.md D2, option C chosen on #92).
//
// `<workspaceRoot>/<slug>-<short id>/` holds exactly two kinds of things: the mount manifest
// (cove-workspace.json) and the managed worktrees at `<entry>/<mount name>` (created by T3b). A
// checkout gets no symlink or directory in the entry; it is reached through its real path, which
// the manifest lists. That is what agents work with: Claude Code is given each checkout's real
// path with --add-dir, Codex is not (there --add-dir makes a directory writable, and checkouts are
// for read-only use, D4), and the launch prompt points at the manifest. Launching agents is not
// part of M1; the rules are recorded here and in m1.md D2.
//
// Ownership. Cove owns an entry only when it is a directory of this user at the recorded path
// whose manifest names the same workspace (kind, version, task and workspace ID). Anything else
// at that path (a directory Cove did not publish, a file, a symlink, a manifest of another
// workspace or one that does not parse) is foreign and reported. Cove's own entry with an older
// manifest is stale and is brought up to date.
//
// Threat model and guarantee. Cove does not defend against a hostile process of the same user,
// which can change any of these paths at any moment; Node offers no openat(2) or renameat2(2), so
// a write cannot be pinned to a directory it checked. What Cove guarantees is that it never adopts
// or writes over a path or a manifest that is not its own in any order of events it can detect:
// - every create (the entry directory, a temporary manifest) runs right after a check that the
//   workspace root still resolves to itself and is the same directory (device and inode), and
//   for a file inside the entry, that the entry is still the directory Cove created or inspected;
// - every create is exclusive: the entry is claimed with a non-recursive mkdir(2) of its final
//   path (EEXIST leaves an occupant as it is, an empty directory included), and a temporary file
//   is opened O_CREAT|O_EXCL|O_NOFOLLOW;
// - a new manifest is published with link(2), which never replaces anything: a manifest that
//   appeared in the claimed entry stays, and the publication reports the entry unavailable (the
//   claimed directory stays too, holding it);
// - an existing manifest is replaced (rename) only after validating that it is still the file
//   inspected (device, inode, change time and exact bytes) in the same entry under the same
//   root, and then, immediately before the rename, that its name still holds that file (device,
//   inode, change time and size, without following a symlink); every read of a manifest checks its
//   handle before and after reading (device, inode, change time and size unchanged, so an
//   in-place rewrite during the read is refused), and an inspection checks after the read that
//   the name still holds the file it read;
// - immediately before the link or the rename, the temporary manifest is checked to be still the
//   file this call created (device and inode, without following a symlink) holding exactly the
//   bytes it wrote, its handle checked before and after that read, and its name then still holding
//   the file with the change time and size validated; a temporary file replaced or rewritten
//   meanwhile is refused and left as it is.
// Content is compared byte for byte, never as decoded text: every malformed UTF-8 sequence decodes
// to U+FFFD, so different bytes could decode to the same text. A manifest that is not valid UTF-8
// is not Cove's (Cove writes only valid UTF-8).
// The residual windows are the moments between each of those last checks and the system call it
// guards: a path component, the manifest or the temporary file swapped exactly then is not seen,
// and the call follows the swap. The checks after a call (the root still resolving to the same
// directory, the entry still being the same directory) detect only a directory substitution that
// is still in place when they run. A substitution of the manifest or the temporary file alone, or
// one undone again before those checks, can therefore complete as `written`. Change times have the
// filesystem clock's precision: a rewrite in place that keeps the length, or a file re-created at
// the same inode number with the same length, within one tick of that clock is not seen by these
// checks, whatever its bytes (see ObservedManifest). A publication has one
// more window: between its mkdir(2) of the entry and the lstat that records the directory created
// (directoryId), a directory swapped in at the entry path is taken as the claim (it is checked to
// be a directory under the same root, but not to be the one mkdir created). A crash between
// claiming the entry and linking its manifest leaves an empty directory (or one holding a
// `.cove-workspace.json.*.tmp` file) without a manifest, which is indistinguishable from someone
// else's and is therefore reported as unavailable until the operator removes it. Cove removes only
// what it created in the current call and has verified as such (its own temporary file, its own
// claimed directory while empty); nothing else is deleted, and a checkout directory is never
// written to.
//
// Paths. Entry paths are recorded below the workspace root's real path, so the path to the entry
// has no symlink in it. A symlink put in place of the root, an ancestor or the entry is reported
// as unavailable, and nothing is published or cleaned up through it. Manifests are opened without
// following a symlink and never block on a FIFO.
//
// Durability. After a publication the entry, the root and every directory above it are flushed
// (syncEntry) before the domain records the entry as written for a revision, so a recorded
// revision survives a host crash. The flush is idempotent and runs again when a later check finds
// the entry current but not yet recorded.
//
// Everything else follows the database: the domain records every change of the workspace before
// it calls this module (domain/workspaces.ts), so the intent is durable before the filesystem
// changes.

export type ManifestMount = {
  name: string;
  // Real path of the binding: the checkout itself, or the managed worktree inside the entry.
  path: string;
  source: MountSource;
  // Checkouts are for read-only use by convention (D4); Cove does not enforce it.
  readOnly: boolean;
  state: MountRecord["state"];
};

export type Manifest = {
  kind: "cove-workspace";
  version: 1;
  taskId: string;
  workspaceId: string;
  workspaceRevision: number;
  note: string;
  mounts: ManifestMount[];
};

export const MANIFEST_NOTE =
  "Mounts of this Cove workspace. A checkout is an existing directory Cove does not own, " +
  "listed by its real path and meant for read-only use (reading, building, running tests); " +
  "Cove does not enforce this. A managed worktree is a directory of this entry.";

export function manifestPath(entryPath: string): string {
  return join(entryPath, MANIFEST_NAME);
}

// The exact bytes Cove writes for a manifest; a current entry holds exactly these.
export function manifestText(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// The largest manifest Cove can write, derived from the protocol limits rather than estimated:
// the most mounts, each with the longest name, the longest path of characters JSON escapes to six
// bytes (`\u0001`; no UTF-16 code unit encodes to more), the longest source and state, and the
// longest IDs and revision. Anything larger is not Cove's.
export const MAX_MANIFEST_BYTES = Buffer.byteLength(
  manifestText({
    kind: "cove-workspace",
    version: 1,
    taskId: "t".repeat(40),
    workspaceId: "w".repeat(40),
    workspaceRevision: Number.MAX_SAFE_INTEGER,
    note: MANIFEST_NOTE,
    mounts: Array.from({ length: M1_LIMITS.mountsPerWorkspace }, () => ({
      name: "n".repeat(64),
      path: "\u0001".repeat(M0_LIMITS.cwdBytes),
      source: "checkout",
      readOnly: false,
      state: longest(MountRecordStateSchema.options),
    })),
  }),
);

function longest<T extends string>(values: readonly T[]): T {
  return values.reduce((a, b) => (b.length > a.length ? b : a));
}

type FileId = { dev: number; ino: number };

// The manifest Cove read from an entry: its file, its status change time in nanoseconds and its
// size in bytes (both taken through the handle before the read, and confirmed unchanged after it)
// and its exact bytes (compared as bytes, see the header). The final check of the name
// (manifestStill) requires the identity, change time and size. A file
// deleted and re-created can get the same inode number (ext4 reuses a freed inode at once), and a
// rewrite in place keeps it, so the change time is part of the identity. Its precision is the
// filesystem clock's: within one tick of it, a rewrite in place that keeps the length, or a file
// re-created at the same inode number with the same length, goes unnoticed whatever its bytes.
// That window is left open (see the threat model in the header); Cove does not read the file again.
type ObservedManifest = FileId & { changed: bigint; size: bigint; bytes: Buffer };

// The bytes Cove writes for `manifest`.
function manifestBytes(manifest: Manifest): Buffer {
  return Buffer.from(manifestText(manifest), "utf8");
}

// Decodes a manifest's bytes as UTF-8, refusing malformed sequences instead of replacing them.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The final lstat of a name (bigint, so the change time has its full precision). Tests replace it
// to present a change within one tick of the filesystem clock, which they cannot produce.
type NameStat = (path: string) => Promise<BigIntStats>;
const statName: NameStat = (path) => lstat(path, { bigint: true });

// What is at an entry path compared with the manifest it should hold.
// - absent: nothing (the workspace root may be absent too);
// - current: Cove's entry with exactly `expected`;
// - stale: Cove's entry with another manifest of the same workspace, the one observed;
// - foreign: something Cove does not own;
// - unavailable: it cannot be told (the path to it changed, or it cannot be read).
export type EntryInspection =
  | { kind: "absent" }
  | { kind: "current"; entry: FileId }
  | { kind: "stale"; entry: FileId; manifest: ObservedManifest }
  | { kind: "foreign" }
  | { kind: "unavailable" };

export type StaleEntry = Extract<EntryInspection, { kind: "stale" }>;

// The outcome of writing an entry: written; occupied (something not Cove's was already at the
// entry path, so nothing was claimed, and it is left as it is); failed (an ordinary error such as
// an unwritable root, with nothing of this attempt left behind, worth another attempt); or
// unavailable (the path to the entry or its manifest changed under the write, something not
// Cove's appeared inside the directory Cove claimed, or what the write left could not be
// verified). Only `occupied` and `failed` guarantee that nothing of the attempt is at the entry
// path, which is what lets the domain give a publication entitlement back.
export type EntryWrite = "written" | "occupied" | "failed" | "unavailable";

// Test hooks, each run right before the check that guards one step: claiming the entry
// directory, creating the temporary manifest, linking a new manifest into place, or renaming a
// replacement over the inspected one (beforeRename runs before the manifest is validated,
// afterValidation between that validation and the final checks of the names).
export type EntryWriteHooks = {
  beforeClaim?: () => Promise<void>;
  beforeCreate?: () => Promise<void>;
  beforePublish?: () => Promise<void>;
  beforeRename?: () => Promise<void>;
  afterValidation?: () => Promise<void>;
  // Runs inside the check of the temporary manifest, after its bytes were read and before its
  // handle is checked again.
  afterTemporaryRead?: () => Promise<void>;
  nameStat?: NameStat;
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function sameId(a: FileId, b: FileId): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// The directory at `path` itself (lstat, so a symlink is not one), or null.
async function directoryId(path: string): Promise<FileId | null> {
  try {
    const found = await lstat(path);
    return found.isDirectory() ? { dev: found.dev, ino: found.ino } : null;
  } catch {
    return null;
  }
}

async function sameDirectory(path: string, id: FileId): Promise<boolean> {
  const found = await directoryId(path);
  return found !== null && sameId(found, id);
}

// The recorded workspace root as it is now: present (it still resolves to itself), absent (it
// does not exist, and the deepest ancestor that does resolves to itself), or changed (a symlink
// in its place or above it, or it cannot be resolved).
type RootState = { kind: "present"; id: FileId } | { kind: "absent" } | { kind: "changed" };

async function rootState(root: string): Promise<RootState> {
  try {
    if ((await realpath(root)) !== root) return { kind: "changed" };
    const id = await directoryId(root);
    return id ? { kind: "present", id } : { kind: "changed" };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { kind: "changed" };
  }
  for (let above = dirname(root); ; above = dirname(above)) {
    try {
      await lstat(above);
    } catch (error) {
      if (errorCode(error) === "ENOENT" && dirname(above) !== above) continue;
      return { kind: "changed" };
    }
    try {
      return (await realpath(above)) === above && (await directoryId(above))
        ? { kind: "absent" }
        : { kind: "changed" };
    } catch {
      return { kind: "changed" };
    }
  }
}

// Whether the root still resolves to itself (no symlink in or above it) and is the directory
// `id`. Every create below runs right after this check.
async function rootIntact(root: string, id: FileId): Promise<boolean> {
  const state = await rootState(root);
  return state.kind === "present" && sameId(state.id, id);
}

// The recorded root, created (0700) when absent; null when it changed or cannot be created.
async function ensureRoot(root: string): Promise<FileId | null> {
  let state = await rootState(root);
  if (state.kind === "absent") {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
    } catch {
      return null;
    }
    state = await rootState(root);
  }
  return state.kind === "present" ? state.id : null;
}

// Creates the configured workspace root if needed (0700) and returns its real path, so that
// entry paths recorded under it contain no symlink; null when it cannot be created or resolved.
// The configured value itself may pass through symlinks; only the resolved path is recorded. The
// root is a setting, not a per-task artifact, so creating it before the task is recorded leaves
// nothing that needs cleaning up; syncEntry flushes it before any entry under it is recorded.
export async function realWorkspaceRoot(root: string): Promise<string | null> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const real = await realpath(root);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// Whether anything (even a dangling symlink) is at `path`; an error other than "not there"
// counts as occupied, so it is never assumed free.
export async function pathOccupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
}

// Reads the manifest of an entry without following a symlink and without blocking on a FIFO, at
// most MAX_MANIFEST_BYTES. "absent" when there is no file of that name, "foreign" when it is not
// a regular file of this user or too large, null when it cannot be read. The file is checked
// through its handle before and after the read: a rewrite in place while it was read (same inode)
// changes its change time or size, and the bytes read may then belong to neither version, so the
// read is refused (null). The change time recorded is the one from before the read, so a rewrite
// after the read fails manifestStill too.
async function readManifest(
  entryPath: string,
  hooks: EntryInspectionHooks = {},
): Promise<ObservedManifest | "absent" | "foreign" | null> {
  let handle;
  try {
    handle = await open(
      manifestPath(entryPath),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "absent";
    // ELOOP: a symlink; ENXIO: a socket or a FIFO without a writer.
    if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR") return "foreign";
    return null;
  }
  try {
    const found = await handle.stat({ bigint: true });
    if (!found.isFile() || found.size > BigInt(MAX_MANIFEST_BYTES) || !ownedByUs(Number(found.uid)))
      return "foreign";
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_MANIFEST_BYTES) return "foreign";
    }
    await hooks.afterBytes?.();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== found.dev ||
      after.ino !== found.ino ||
      after.ctimeNs !== found.ctimeNs ||
      after.size !== found.size ||
      BigInt(length) !== found.size
    )
      return null;
    return {
      dev: Number(found.dev),
      ino: Number(found.ino),
      changed: found.ctimeNs,
      size: found.size,
      bytes: Buffer.from(buffer.subarray(0, length)),
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function ownedByUs(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

// Whether a manifest's bytes belong to the workspace `expected` describes: valid UTF-8 (Cove
// writes nothing else) holding JSON with the same workspace.
function sameWorkspace(bytes: Buffer, expected: Manifest): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const found = parsed as Partial<Manifest>;
  return (
    found.kind === expected.kind &&
    found.version === expected.version &&
    found.taskId === expected.taskId &&
    found.workspaceId === expected.workspaceId
  );
}

// Test hooks of inspectEntry: afterBytes runs after the manifest's bytes were read and before its
// handle is checked again, afterRead after the read and before its name is checked.
export type EntryInspectionHooks = {
  afterBytes?: () => Promise<void>;
  afterRead?: () => Promise<void>;
  nameStat?: NameStat;
};

// What is at `entryPath` compared with `expected` (see EntryInspection). Reads only.
export async function inspectEntry(
  entryPath: string,
  expected: Manifest,
  hooks: EntryInspectionHooks = {},
): Promise<EntryInspection> {
  const root = await rootState(dirname(entryPath));
  if (root.kind === "changed") return { kind: "unavailable" };
  if (root.kind === "absent") return { kind: "absent" };
  let entry;
  try {
    entry = await lstat(entryPath);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "unavailable" };
  }
  if (!entry.isDirectory() || !ownedByUs(entry.uid)) return { kind: "foreign" };
  const id = { dev: entry.dev, ino: entry.ino };
  const found = await readManifest(entryPath, hooks);
  await hooks.afterRead?.();
  // The entry and the root must still be the ones checked above, or what was read may come from
  // somewhere else.
  if (!(await sameDirectory(entryPath, id)) || !(await rootIntact(dirname(entryPath), root.id)))
    return { kind: "unavailable" };
  if (found === null) return { kind: "unavailable" };
  // A directory without Cove's manifest was not published by Cove: the manifest is linked into
  // the claimed directory as the last step of a publication.
  if (found === "absent" || found === "foreign") return { kind: "foreign" };
  // The name must still hold the file that was read: its content came through a handle opened
  // before, and a current verdict lets the domain record the revision as materialized.
  if (!(await manifestStill(entryPath, found, hooks.nameStat))) return { kind: "unavailable" };
  if (found.bytes.equals(manifestBytes(expected))) return { kind: "current", entry: id };
  return sameWorkspace(found.bytes, expected)
    ? { kind: "stale", entry: id, manifest: found }
    : { kind: "foreign" };
}

// Creates a file that must not exist yet (no symlink followed), writes it and flushes it. Returns
// the created file, so a later cleanup removes it only while its name still holds that file; a
// failure after the open removes the file the same way before it rejects.
async function writeNewFile(path: string, content: Buffer): Promise<FileId> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let id: FileId | null = null;
  try {
    const { dev, ino } = await handle.stat();
    id = { dev, ino };
    await handle.writeFile(content);
    await handle.sync();
    return id;
  } catch (error) {
    if (id) await removeOwnFile(path, id);
    throw error;
  } finally {
    await handle.close();
  }
}

// Removes a file this call created, only while its name still holds that very file (device and
// inode), so whatever replaced it is left alone; a failure leaves it.
async function removeOwnFile(path: string, id: FileId): Promise<void> {
  try {
    const found = await lstat(path);
    if (found.isFile() && sameId(found, id)) await unlink(path);
  } catch {
    // Left behind; see the header.
  }
}

// Whether `path` still names the file this call created (`id`, not followed through a symlink)
// and it holds exactly `bytes`: the temporary manifest is checked this way right before it is
// published (see the header). Like a manifest read (readManifest), the handle is checked before
// and after the read (device, inode, change time and size unchanged), so a rewrite in place
// during the check is refused; the name must then still hold the file with the change time that
// was validated, so one rewritten after the check is refused too.
async function ownFileHolds(
  path: string,
  id: FileId,
  bytes: Buffer,
  hooks: EntryWriteHooks = {},
): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  let validated: bigint;
  try {
    const found = await handle.stat({ bigint: true });
    const size = bytes.length;
    if (
      !found.isFile() ||
      Number(found.dev) !== id.dev ||
      Number(found.ino) !== id.ino ||
      found.size !== BigInt(size)
    )
      return false;
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > size) return false;
    }
    if (!buffer.subarray(0, length).equals(bytes)) return false;
    await hooks.afterTemporaryRead?.();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== found.dev ||
      after.ino !== found.ino ||
      after.ctimeNs !== found.ctimeNs ||
      after.size !== found.size
    )
      return false;
    validated = found.ctimeNs;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
  // The name, not only the handle opened through it, must still hold the file as validated: its
  // change time and its size, so that only a same-length rewrite within one clock tick escapes.
  try {
    const named = await (hooks.nameStat ?? statName)(path);
    return (
      named.isFile() &&
      Number(named.dev) === id.dev &&
      Number(named.ino) === id.ino &&
      named.ctimeNs === validated &&
      named.size === BigInt(bytes.length)
    );
  } catch {
    return false;
  }
}

// Whether the manifest name of the entry holds the observed manifest file (device, inode, change
// time and size; lstat, so a symlink is not it).
async function manifestStill(
  entryPath: string,
  observed: ObservedManifest,
  nameStat: NameStat = statName,
): Promise<boolean> {
  try {
    const found = await nameStat(manifestPath(entryPath));
    return (
      found.isFile() &&
      Number(found.dev) === observed.dev &&
      Number(found.ino) === observed.ino &&
      found.ctimeNs === observed.changed &&
      found.size === observed.size
    );
  } catch {
    return false;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function temporaryManifest(entryPath: string): string {
  return join(entryPath, `.${MANIFEST_NAME}.${randomUUID()}.tmp`);
}

// Publishes a new entry with `manifest` at `entryPath`, which must not exist (see the header for
// the order of checks and creates). The caller flushes it with syncEntry before recording it.
export async function publishEntry(
  entryPath: string,
  manifest: Manifest,
  hooks: EntryWriteHooks = {},
): Promise<EntryWrite> {
  const root = dirname(entryPath);
  const rootId = await ensureRoot(root);
  if (!rootId) return (await rootState(root)).kind === "changed" ? "unavailable" : "failed";
  await hooks.beforeClaim?.();
  if (!(await rootIntact(root, rootId))) return "unavailable";
  try {
    // Not recursive: EEXIST for anything already there, an empty directory included.
    await mkdir(entryPath, { mode: 0o700 });
  } catch (error) {
    return errorCode(error) === "EEXIST" ? "occupied" : "failed";
  }
  const entryId = await directoryId(entryPath);
  // The claim must be the directory just created under the same root; otherwise it was made
  // through a swapped path, and it is not cleaned up through that path either.
  if (!entryId || !(await rootIntact(root, rootId))) return "unavailable";
  const intact = async (): Promise<boolean> =>
    (await rootIntact(root, rootId)) && (await sameDirectory(entryPath, entryId));
  // Removes the claim while it is still this call's empty directory; rmdir(2) refuses a
  // non-empty one, so nothing anyone put into it is lost.
  const release = async (): Promise<void> => {
    if (await intact()) await rmdir(entryPath).catch(() => undefined);
  };
  const temporary = temporaryManifest(entryPath);
  await hooks.beforeCreate?.();
  if (!(await intact())) return "unavailable";
  const bytes = manifestBytes(manifest);
  let created: FileId;
  try {
    created = await writeNewFile(temporary, bytes);
  } catch {
    await release();
    return (await pathOccupied(entryPath)) ? "unavailable" : "failed";
  }
  await hooks.beforePublish?.();
  if (!(await intact())) return "unavailable";
  // A temporary file replaced or rewritten since it was written is not published, and whatever
  // is there now stays (see the header).
  if (!(await ownFileHolds(temporary, created, bytes, hooks))) return "unavailable";
  let linked = true;
  try {
    // link(2) never replaces: a manifest that appeared in the claim meanwhile stays.
    await link(temporary, manifestPath(entryPath));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      await removeOwnFile(temporary, created);
      await release();
      return (await pathOccupied(entryPath)) ? "unavailable" : "failed";
    }
    linked = false;
  }
  await removeOwnFile(temporary, created);
  // A manifest appeared in the directory this call claimed: the claim stays (rmdir would refuse
  // it, and it is not Cove's to empty), so this attempt has left something at the entry path.
  if (!linked) return "unavailable";
  try {
    await syncDirectory(entryPath);
  } catch {
    // syncEntry flushes it again before it is recorded.
  }
  // Published where it was checked: the root unchanged and the entry the directory claimed above.
  return (await intact()) ? "written" : "unavailable";
}

// Replaces the manifest of Cove's existing entry, as inspectEntry observed it, with `manifest`.
// Refused when the manifest is no longer exactly the observed file (see the header).
export async function replaceManifest(
  entryPath: string,
  observed: StaleEntry,
  manifest: Manifest,
  hooks: EntryWriteHooks = {},
): Promise<EntryWrite> {
  const root = dirname(entryPath);
  const state = await rootState(root);
  if (state.kind !== "present") return "unavailable";
  const rootId = state.id;
  const intact = async (): Promise<boolean> =>
    (await rootIntact(root, rootId)) && (await sameDirectory(entryPath, observed.entry));
  const temporary = temporaryManifest(entryPath);
  await hooks.beforeCreate?.();
  if (!(await intact())) return "unavailable";
  const bytes = manifestBytes(manifest);
  let created: FileId;
  try {
    created = await writeNewFile(temporary, bytes);
  } catch {
    return (await pathOccupied(temporary)) ? "unavailable" : "failed";
  }
  await hooks.beforeRename?.();
  const current = await readManifest(entryPath);
  if (
    !(await intact()) ||
    current === null ||
    typeof current === "string" ||
    !sameId(current, observed.manifest) ||
    // Against the inspection's observation, byte for byte: the final name check below
    // (manifestStill) compares with this read, so this is where it must equal what was inspected.
    current.changed !== observed.manifest.changed ||
    current.size !== observed.manifest.size ||
    !current.bytes.equals(observed.manifest.bytes)
  ) {
    await removeOwnFile(temporary, created);
    return "unavailable";
  }
  await hooks.afterValidation?.();
  // The temporary file must still be this call's (it is left as it is when not), and the
  // manifest name must still hold the validated file: reading the content above takes time, and
  // a manifest swapped in meanwhile must not be replaced (see the header).
  if (!(await ownFileHolds(temporary, created, bytes, hooks))) return "unavailable";
  if (!(await manifestStill(entryPath, current, hooks.nameStat))) {
    await removeOwnFile(temporary, created);
    return "unavailable";
  }
  try {
    await rename(temporary, manifestPath(entryPath));
  } catch {
    await removeOwnFile(temporary, created);
    return "failed";
  }
  return (await intact()) ? "written" : "unavailable";
}

// Makes an entry durable: the entry, the workspace root and every directory above it up to the
// filesystem root are flushed, so the publication and the creation of a new root survive a host
// crash (a file flush does not make its directory entry durable). Like the CLI's pending records
// (apps/cli/src/commands/_pending.ts) the whole chain is flushed every time, never only what this
// call created: an earlier attempt may have died before flushing. A directory above the root that
// cannot be opened for reading existed before Cove (Cove could not have created it) and is
// skipped. Rejects when the entry or the root cannot be flushed.
export async function syncEntry(entryPath: string): Promise<void> {
  const root = dirname(entryPath);
  await syncDirectory(entryPath);
  for (let current = root; ; current = dirname(current)) {
    try {
      await syncDirectory(current);
    } catch (error) {
      const code = errorCode(error);
      if (current === root || (code !== "EACCES" && code !== "EPERM")) throw error;
    }
    if (dirname(current) === current) break;
  }
}
