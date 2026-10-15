import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
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

// Creates (or adopts) one owner-only directory. An existing directory must belong to this user
// and is narrowed to 0700: the data directory holds the server identity and operation records.
async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new HomeError(`${path} is not a directory`);
  if (info.uid !== process.getuid?.()) throw new HomeError(`${path} is owned by another user`);
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

export class HomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeError";
  }
}

// Prepares `<home>` and `<home>/server` (both 0700) and returns the layout under the home's real
// path, so the database, the lock and the rendezvous are reached through one spelling. The run
// directory is created by the rendezvous publisher itself (local-rendezvous.ts).
export async function prepareHome(home: string): Promise<HomeLayout> {
  const absolute = resolve(home);
  await ownedDirectory(absolute);
  const canonical = await realpath(absolute);
  const layout = homeLayout(canonical);
  await ownedDirectory(layout.serverDirectory);
  return layout;
}
