import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// better-sqlite3 is a dependency of the server only (docs/milestones/m1.md T1); resolving it from
// the server manifest keeps the check on the artifact the compiled server actually loads.
const serverRequire = createRequire(join(root, "apps/server/package.json"));

export const BETTER_SQLITE3_VERSION = "13.0.3";

// better-sqlite3 13 is an N-API addon whose prebuilds ship inside the published tarball; the
// workspace denies its implicit node-gyp build (pnpm-workspace.yaml allowBuilds). Verify that the
// exact version loads its in-package prebuild for this platform from this checkout's install and
// that a real database works under the running Node, rather than trusting install success.
export async function prepareBetterSqlite3(lookup = serverRequire, checkout = root) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(`better-sqlite3 preparation is unsupported on ${process.platform}`);
  const manifestPath = lookup.resolve("better-sqlite3/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== BETTER_SQLITE3_VERSION)
    throw new Error(`Unexpected better-sqlite3 version ${manifest.version}`);
  const packageRoot = await realpath(dirname(manifestPath));
  const packageStore = join(await realpath(checkout), "node_modules", ".pnpm") + sep;
  if (!packageRoot.startsWith(packageStore))
    throw new Error("better-sqlite3 resolved outside this checkout's install");
  const Database = lookup("better-sqlite3");
  const directory = await mkdtemp(join(tmpdir(), "cove-sqlite-prepare-"));
  let sqliteVersion;
  let journalMode;
  try {
    // A file database exercises WAL and FULL synchronous, the settings the server store uses.
    const db = new Database(join(directory, "probe.db"));
    try {
      journalMode = db.pragma("journal_mode = WAL", { simple: true });
      db.pragma("synchronous = FULL");
      db.exec("CREATE TABLE probe (value INTEGER NOT NULL)");
      db.prepare("INSERT INTO probe (value) VALUES (?)").run(7);
      if (db.prepare("SELECT value FROM probe").get()?.value !== 7)
        throw new Error("better-sqlite3 round trip failed");
      sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (journalMode !== "wal") throw new Error("better-sqlite3 did not enable WAL");
  const target = `${process.platform}-${process.arch}`;
  const loaded = Object.keys(lookup.cache).filter(
    (path) => path.startsWith(`${packageRoot}${sep}`) && path.endsWith(".node"),
  );
  if (loaded.length !== 1) throw new Error("better-sqlite3 native binary did not load once");
  const nativeBinary = await realpath(loaded[0]);
  if (nativeBinary !== join(packageRoot, "prebuilds", `${target}.node`))
    throw new Error("better-sqlite3 loaded a binary other than its in-package prebuild");
  const nativeSha256 = createHash("sha256")
    .update(await readFile(nativeBinary))
    .digest("hex");
  return {
    version: manifest.version,
    nativeBinary,
    nativeSha256,
    sqliteVersion,
    node: process.version,
    napi: process.versions.napi,
    target,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareBetterSqlite3()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
