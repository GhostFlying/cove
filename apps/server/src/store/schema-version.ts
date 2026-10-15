import { open } from "node:fs/promises";

// The committed schema version (PRAGMA user_version) of a database, read from its files without
// opening it through SQLite.
//
// Why not ask SQLite: a newer build's server may have crashed with committed pages still in
// `<db>-wal`. A read-write connection would read that WAL and, when the refusal closes it as the
// last connection, checkpoint it into the database and delete it, so the "unchanged" newer
// database would not be byte-for-byte unchanged. A read-only connection cannot recover a WAL left
// without its shared-memory index (SQLITE_IOERR_LOCK), and an immutable open ignores the WAL, which
// can hold the newer version. Reading the files is the only check that both sees committed WAL
// content and changes nothing.
//
// Format (https://www.sqlite.org/fileformat2.html): user_version is the big-endian 32-bit integer
// at offset 60 of page 1. The WAL is a 32-byte header followed by frames of a 24-byte header and
// one page. A frame belongs to the log only while its salts equal the header's and the cumulative
// checksum matches; the log ends at the first frame that does not. Only frames up to the last
// commit frame (non-zero database size) are committed. The newest committed copy of page 1 is the
// current one; without one, the database file's page 1 is.

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const USER_VERSION_OFFSET = 60;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;

function checksum(
  data: Buffer,
  start: number,
  end: number,
  initial: [number, number],
  bigEndian: boolean,
): [number, number] {
  let [s0, s1] = initial;
  for (let i = start; i < end; i += 8) {
    const x0 = bigEndian ? data.readUInt32BE(i) : data.readUInt32LE(i);
    const x1 = bigEndian ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

// The committed page 1 in the WAL, or null when the WAL has none (absent, empty, reset or torn).
function walPageOne(wal: Buffer): Buffer | null {
  if (wal.length < WAL_HEADER) return null;
  const magic = wal.readUInt32BE(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) return null;
  const bigEndian = magic === WAL_MAGIC_BE;
  const pageSize = wal.readUInt32BE(8) === 1 ? 65536 : wal.readUInt32BE(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return null;
  let sum = checksum(wal, 0, 24, [0, 0], bigEndian);
  if (sum[0] !== wal.readUInt32BE(24) || sum[1] !== wal.readUInt32BE(28)) return null;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  let pending: Buffer | null = null;
  let committed: Buffer | null = null;
  for (
    let frame = WAL_HEADER;
    frame + FRAME_HEADER + pageSize <= wal.length;
    frame += FRAME_HEADER + pageSize
  ) {
    if (wal.readUInt32BE(frame + 8) !== salt1 || wal.readUInt32BE(frame + 12) !== salt2) break;
    sum = checksum(wal, frame, frame + 8, sum, bigEndian);
    sum = checksum(wal, frame + FRAME_HEADER, frame + FRAME_HEADER + pageSize, sum, bigEndian);
    if (sum[0] !== wal.readUInt32BE(frame + 16) || sum[1] !== wal.readUInt32BE(frame + 20)) break;
    if (wal.readUInt32BE(frame) === 1)
      pending = wal.subarray(frame + FRAME_HEADER, frame + FRAME_HEADER + pageSize);
    // A commit frame makes every frame up to it part of the database.
    if (wal.readUInt32BE(frame + 4) !== 0) committed = pending ?? committed;
  }
  return committed;
}

async function readOptional(path: string, length?: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    if (length === undefined) return await handle.readFile();
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function committedSchemaVersion(databasePath: string): Promise<number> {
  const [database, wal] = await Promise.all([
    readOptional(databasePath, 100),
    readOptional(`${databasePath}-wal`),
  ]);
  const page = (wal && walPageOne(wal)) ?? database;
  // Not a SQLite database (or an empty file): no version here; opening it reports what it is.
  if (!page || page.length < 100 || !page.subarray(0, 16).equals(SQLITE_HEADER)) return 0;
  return page.readInt32BE(USER_VERSION_OFFSET);
}
