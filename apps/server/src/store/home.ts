import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// The Cove data directory (docs/milestones/m1.md D5): `~/.cove` unless `--home` or COVE_HOME
// names another one. Tests always pass a temporary home so they never touch the user's data.
export function resolveHome(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const chosen = explicit ?? (env.COVE_HOME || join(homedir(), ".cove"));
  return resolve(chosen);
}

export type HomeLayout = {
  // Canonical real path of the data directory.
  readonly home: string;
  // Server-owned state: the database, its backups and the default rendezvous.
  readonly serverDirectory: string;
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly runDirectory: string;
  readonly rendezvousPath: string;
};

export function homeLayout(home: string): HomeLayout {
  if (!isAbsolute(home)) throw new Error("Cove home must be an absolute path");
  const serverDirectory = join(home, "server");
  const runDirectory = join(serverDirectory, "run");
  return {
    home,
    serverDirectory,
    databasePath: join(serverDirectory, "cove.db"),
    backupDirectory: join(serverDirectory, "backups"),
    runDirectory,
    rendezvousPath: join(runDirectory, "rendezvous.json"),
  };
}

// Which directories Cove holds to its own rules (#172, user decision 2026-10-22): the ones it
// manages below the data directory (`<home>/server`, its run directory and the like), whether this
// start or an earlier one created them, and a data directory Cove creates itself. They hold the
// database, the identity and the rendezvous secret, so they must be real directories owned by this
// user with mode 0700. A violation is refused, not repaired: a Cove directory that is not
// owner-only was changed by someone, and a silent chmod would hide that.
//
// A data directory that already existed (one the user chose, or one made earlier) and everything
// above it ($HOME and up) are not checked: Cove does not manage them, and on many hosts they
// legitimately belong to another account or are group-writable. What keeps Cove's data private is
// the owner-only directories below them and the owner-only files, not those ancestors.
const MANAGED_RULE =
  "Cove's own directories must be owned by the current user, have mode 0700 and not be symbolic links";

export class HomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeError";
  }
}

// The directory facts the rule reads, as lstat gives them.
export type DirectoryFacts = {
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

// Refuses a Cove-managed directory that breaks the rule, naming the directory, what it is and the
// rule. The message carries a path, a uid and a mode only: nothing secret.
export function checkManagedDirectory(path: string, info: DirectoryFacts): void {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new HomeError(`Cove directory ${path}: ownership is unavailable on this platform`);
  let found: string | undefined;
  if (info.isSymbolicLink()) found = "is a symbolic link";
  else if (!info.isDirectory()) found = "is not a directory";
  else if (info.uid !== uid || (info.mode & 0o777) !== 0o700)
    found = `has owner uid ${info.uid} and mode ${(info.mode & 0o777).toString(8).padStart(4, "0")}`;
  if (found)
    throw new HomeError(`Cove directory ${path} ${found}; ${MANAGED_RULE} (uid ${uid}, mode 0700)`);
}

// Creates one Cove-managed directory (0700; its parent must exist) or checks the one already
// there. Returns whether this call created it.
export async function ensureManagedDirectory(path: string): Promise<boolean> {
  let created = true;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  }
  checkManagedDirectory(path, await lstat(path));
  return created;
}

// Prepares `<home>` and `<home>/server` and returns the layout under the home's real path, so the
// database, the lock and the rendezvous are reached through one spelling. A missing home is created
// 0700 (with any missing ancestors, which Cove then made, so 0700 as well) and held to the rule; an
// existing one only has to resolve to a directory, possibly through a symbolic link.
// `<home>/server` is Cove's own. The run directory is created by the rendezvous publisher itself
// (local-rendezvous.ts).
export async function prepareHome(home: string): Promise<HomeLayout> {
  const absolute = resolve(home);
  let created: boolean;
  try {
    // A recursive mkdir returns the first directory it created, or undefined when none was.
    created = (await mkdir(absolute, { recursive: true, mode: 0o700 })) !== undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR")
      throw new HomeError(`The Cove data directory ${absolute} is not a directory`);
    throw error;
  }
  if (created) checkManagedDirectory(absolute, await lstat(absolute));
  else if (!(await stat(absolute)).isDirectory())
    throw new HomeError(`The Cove data directory ${absolute} is not a directory`);
  const canonical = await realpath(absolute);
  const layout = homeLayout(canonical);
  await ensureManagedDirectory(layout.serverDirectory);
  return layout;
}
