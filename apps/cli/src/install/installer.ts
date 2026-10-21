import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { workspaceRootOf } from "@cove/server/build-id";
import {
  CLOSURE_NODE,
  CLOSURE_SERVER,
  contentsDigest,
  escapingLink,
  readStamp,
  type InstallStamp,
} from "./closure.js";
import { closurePath, launcherScript, type InstallLayout } from "./layout.js";

// Installing and activating closures in a data directory (m2 D1). Callers hold the install lock.

type Spawned = { status: number; stdout: string };

function runChild(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Spawned> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
      ...(env ? { env } : {}),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", fail);
    child.once("close", (code, signal) => done({ status: code ?? (signal ? 128 : 1), stdout }));
  });
}

function staging(layout: InstallLayout): string {
  return join(layout.installDirectory, `.staging-${randomBytes(6).toString("hex")}`);
}

// A sealed closure is usable here only when its stamp is valid, it was built for this platform,
// its contents are what the stamp says, and nothing in it leads outside it.
async function verifyClosure(dir: string): Promise<InstallStamp> {
  const stamp = await readStamp(dir);
  if (!stamp)
    throw new Error(
      `${dir} is not a sealed Cove closure (no valid cove-install.json); ` +
        "build one with `node scripts/runtime-closure.mjs build --out DIR`",
    );
  if (stamp.platform !== process.platform || stamp.arch !== process.arch)
    throw new Error(`${dir} was built for ${stamp.platform}-${stamp.arch}`);
  const link = await escapingLink(dir);
  if (link) throw new Error(`${dir}: ${link} leads outside the closure`);
  if ((await contentsDigest(dir)) !== stamp.contentsSha256)
    throw new Error(`${dir} does not match its stamp; it was changed after it was sealed`);
  return stamp;
}

// Builds this checkout's closure into a staging directory. Only a CLI run from a development
// workspace can: an installed CLI has no sources to build from and installs with --closure.
async function buildClosure(layout: InstallLayout): Promise<string> {
  const root = workspaceRootOf();
  if (!root)
    throw new Error(
      "this CLI is not part of a Cove checkout; pass --closure DIR with a sealed closure",
    );
  const out = staging(layout);
  const result = await runChild(process.execPath, [
    join(root, "scripts", "runtime-closure.mjs"),
    "build",
    "--out",
    out,
  ]);
  if (result.status !== 0) {
    await rm(out, { recursive: true, force: true });
    throw new Error("building the runtime closure failed (see the messages above)");
  }
  return out;
}

// Copies a sealed closure into a staging directory: file clones where the filesystem has them,
// symbolic links as they are (they are relative and stay inside the closure).
async function copyClosure(layout: InstallLayout, source: string): Promise<string> {
  await verifyClosure(source);
  const out = staging(layout);
  try {
    await cp(source, out, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      mode: constants.COPYFILE_FICLONE,
    });
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
  return out;
}

export type Installed = { build: string; dir: string; stamp: InstallStamp; created: boolean };

// Puts a closure at `install/<build>/` (D1): built from this checkout, or copied from `source`.
// It is verified in its staging directory and then renamed into place, so a build directory is
// either complete or absent. Installing a build that is already there keeps the existing copy.
export async function installClosure(
  layout: InstallLayout,
  source: string | undefined,
): Promise<Installed> {
  await mkdir(layout.installDirectory, { recursive: true, mode: 0o700 });
  const staged =
    source === undefined ? await buildClosure(layout) : await copyClosure(layout, source);
  try {
    const stamp = await verifyClosure(staged);
    const dir = closurePath(layout, stamp.build);
    try {
      await lstat(dir);
      // Already installed. The existing copy must still be intact to be reused.
      await verifyClosure(dir);
      return { build: stamp.build, dir, stamp, created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staged, dir);
    return { build: stamp.build, dir, stamp, created: true };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

export type SchemaCheck = { database: number; supported: number };

// The target build's own answer, by running its server in schema mode (it reads the database files
// without opening them, so this never changes the database and works while a server runs).
export async function schemaCheck(layout: InstallLayout, dir: string): Promise<SchemaCheck> {
  const result = await runChild(join(dir, CLOSURE_NODE), [
    join(dir, CLOSURE_SERVER),
    ...["--mode", "schema", "--home", layout.home],
  ]);
  let answer: Partial<SchemaCheck> | undefined;
  try {
    answer = JSON.parse(result.stdout) as Partial<SchemaCheck>;
  } catch {
    answer = undefined;
  }
  if (
    result.status !== 0 ||
    !Number.isSafeInteger(answer?.database) ||
    !Number.isSafeInteger(answer?.supported)
  )
    throw new Error(`the build in ${dir} could not report its schema support`);
  return answer as SchemaCheck;
}

export class IncompatibleSchemaError extends Error {}

// The build `install/current` names, or null.
export async function currentBuild(layout: InstallLayout): Promise<string | null> {
  try {
    const target = await readlink(layout.current);
    return (await readStamp(join(layout.installDirectory, target)))?.build ?? null;
  } catch {
    return null;
  }
}

export async function installedBuilds(layout: InstallLayout): Promise<string[]> {
  const builds: string[] = [];
  let names: string[];
  try {
    names = await readdir(layout.installDirectory);
  } catch {
    return builds;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".") || name === "current") continue;
    const stamp = await readStamp(join(layout.installDirectory, name));
    if (stamp?.build === name) builds.push(name);
  }
  return builds;
}

// Makes `build` the one the service and `<home>/bin/cove` run (D1). Refused, with nothing changed,
// when the build cannot open this data directory's database: M1 D5 builds refuse a newer schema,
// and Cove never downgrades a database. The switch itself is a rename of a new symlink over
// `current`, so every reader sees the old or the new build and never a missing link.
export async function activate(layout: InstallLayout, build: string): Promise<SchemaCheck> {
  const dir = closurePath(layout, build);
  const stamp = await readStamp(dir);
  if (!stamp || stamp.build !== build)
    throw new Error(`build ${build} is not installed in ${layout.installDirectory}`);
  const schema = await schemaCheck(layout, dir);
  if (schema.database > schema.supported)
    throw new IncompatibleSchemaError(
      `build ${build} supports database schema ${schema.supported}, but the database in ` +
        `${layout.home} is already at schema ${schema.database}; nothing was changed. Cove does not ` +
        "downgrade a database. To go back anyway: stop the service (`cove server service stop`), " +
        "replace server/cove.db with the backup taken before the migration (server/backups/; " +
        "records written since then are lost), then run `cove server install --activate " +
        `${build}\` again. See docs/development.md.`,
    );
  const link = join(layout.installDirectory, `.current-${randomBytes(6).toString("hex")}`);
  await symlink(build, link);
  try {
    await rename(link, layout.current);
  } catch (error) {
    await rm(link, { force: true });
    throw error;
  }
  await writeLauncher(layout);
  return schema;
}

async function writeLauncher(layout: InstallLayout): Promise<void> {
  await mkdir(dirname(layout.launcher), { recursive: true, mode: 0o700 });
  const temporary = `${layout.launcher}.${process.pid}.tmp`;
  await writeFile(temporary, launcherScript(layout), { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, layout.launcher);
}

// Removes installed builds other than `keep` (the active one and the running one). Returns them.
export async function prune(layout: InstallLayout, keep: ReadonlySet<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const build of await installedBuilds(layout)) {
    if (keep.has(build)) continue;
    await rm(closurePath(layout, build), { recursive: true, force: true });
    removed.push(build);
  }
  // Staging directories left by an interrupted install.
  for (const name of await readdir(layout.installDirectory).catch(() => [] as string[]))
    if (name.startsWith(".staging-") || name.startsWith(".current-"))
      await rm(join(layout.installDirectory, name), { recursive: true, force: true });
  return removed;
}

// Removes every installed build, `current` and the launcher; the data directory stays (S1). The
// install lock file stays too: the caller holds it, and a lock file is never removed (os-lock.ts).
export async function removeInstallation(layout: InstallLayout): Promise<void> {
  for (const name of await readdir(layout.installDirectory).catch(() => [] as string[]))
    if (join(layout.installDirectory, name) !== layout.lock)
      await rm(join(layout.installDirectory, name), { recursive: true, force: true });
  await rm(layout.launcher, { force: true });
}

// Two free loopback ports in 20000-29999 for a data directory without configured ones (D3):
// below the OS ephemeral ranges, so a port chosen today is not later taken by an outgoing
// connection.
export async function freePorts(count: number): Promise<number[]> {
  const chosen: number[] = [];
  for (let attempt = 0; chosen.length < count && attempt < 200; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    if (chosen.includes(port)) continue;
    const free = await new Promise<boolean>((done) => {
      const server = createServer();
      server.once("error", () => done(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
        server.close(() => done(true)),
      );
    });
    if (free) chosen.push(port);
  }
  if (chosen.length < count) throw new Error("no free loopback port in 20000-29999");
  return chosen;
}

// Runs the active build's init mode with ports while no server runs (the caller checked; init is
// refused while a server holds the data directory, and the caller then asks that server). It
// creates the data directory when needed and fills only ports that are not configured yet.
export async function initializeWithPorts(
  layout: InstallLayout,
  ports: [number, number],
): Promise<{ businessPort: number; pairingPort: number }> {
  const dir = await realpath(layout.current);
  const result = await runChild(join(dir, CLOSURE_NODE), [
    join(dir, CLOSURE_SERVER),
    ...["--mode", "init", "--home", layout.home],
    ...["--business-port", String(ports[0]), "--pairing-port", String(ports[1])],
  ]);
  if (result.status !== 0)
    throw new Error("initializing the data directory with the installed build failed");
  const entry = (
    JSON.parse(result.stdout) as { entry?: { businessPort: number; pairingPort: number } }
  ).entry;
  if (!entry) throw new Error("the server's init did not report its entry ports");
  return entry;
}
