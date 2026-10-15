import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readRendezvous } from "../session.js";
import { harnessPageRoot, startHarnessServer, type HarnessServer } from "../harness-server.js";
import {
  flag,
  homeDirectory,
  homeRendezvousPath,
  integerFlag,
  print,
  rendezvousPath,
  sleep,
  StatusError,
  takeFlags,
  UsageError,
  type Arguments,
} from "./_common.js";

export const usage = `  server init [--workspace-root DIR]
  server start [--port N] [--origin URL]... [--harness [--harness-port N]]

The data directory is --home, $COVE_HOME or ~/.cove; the server keeps its database there and
refuses to start while another server uses it. \`server init\` prepares it while no server runs;
\`server start\` initializes it with defaults when needed.
The rendezvous path defaults to <home>/server/run/rendezvous.json (or $COVE_RENDEZVOUS).
With --harness, the M0 browser test page is served on 127.0.0.1 and its URL, which carries the
server secret in its fragment, is printed once the server is ready.`;

const RENDEZVOUS_WAIT_MS = 20_000;

function serverEntry(): Promise<string> {
  // The CLI depends on @cove/server as a workspace package, so its installed manifest is the
  // single source for the executable path; no repository-relative path is assumed.
  const manifestPath = createRequire(import.meta.url).resolve("@cove/server/package.json");
  return readFile(manifestPath, "utf8").then((text) => {
    const bin = (JSON.parse(text) as { bin?: Record<string, string> }).bin?.["cove-server"];
    if (!bin) throw new Error("@cove/server does not declare the cove-server executable");
    return join(dirname(manifestPath), bin);
  });
}

// The data directory is created owner-only before the server starts so that it can be
// canonicalized (macOS /tmp and /var are symlinks); the server checks and narrows it again.
async function prepareHome(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  return realpath(home);
}

// The server publishes the rendezvous only into an owner-only directory reached through no
// symlinked ancestor, and creates that final directory itself. Create the ancestors with 0700
// and canonicalize them so the server's checks pass.
async function prepareRendezvousPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const runDirectory = dirname(absolute);
  const base = dirname(runDirectory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  return join(await realpath(base), basename(runDirectory), basename(absolute));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// One server path must map to one lock however it is spelled, and the key must not change
// when the server creates the run directory mid-start. The parent of the run directory
// already exists (the server creates only the final directory), so its native realpath
// gives the on-disk spelling.
async function lockKey(path: string): Promise<string> {
  const runDirectory = dirname(path);
  let parent: string;
  try {
    parent = await realpath(dirname(runDirectory));
  } catch {
    throw new Error(`Cannot resolve ${dirname(runDirectory)} for the server start lock`);
  }
  // Lowercased so the key is stable across run-directory creation; on a case-sensitive
  // filesystem case-only variants merely serialize their starts.
  return `${parent}/${basename(runDirectory).toLowerCase()}/${basename(path).toLowerCase()}`;
}

// The rendezvous record carries no pid, so a record cannot be traced back to the process
// that published it. Instead `server start` holds an exclusive lock from its existence check
// until readiness is announced: while the lock is held no other CLI start can spawn a server
// for this path, so a new record that appears after our check was published by our child.
// Without it two concurrent starts both pass the check and the loser announces the winner's
// record while its own child fails to link the path and exits. A crashed CLI can leave the lock
// behind; that is reported rather than silently broken, because breaking a live start's lock
// would reintroduce the race. The lock lives in the CLI's part of the data directory, keyed by
// the canonical rendezvous path, because the server contract does not require the rendezvous
// directory's parent to be writable.
async function acquireStartLock(home: string, path: string): Promise<() => Promise<void>> {
  const locks = join(home, "cli", "locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = join(
    locks,
    `${createHash("sha256")
      .update(await lockKey(path))
      .digest("hex")}.lock`,
  );
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `${lock} exists; another \`cove server start\` is in progress. ` +
        "Remove the file if no such command is running.",
    );
  }
  const owned = await handle.stat();
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return async () => {
    // Remove only the lock this process created, never one an operator replaced.
    try {
      const current = await lstat(lock);
      if (current.dev === owned.dev && current.ino === owned.ino) await unlink(lock);
    } catch {
      /* Already gone. */
    }
  };
}

// Waits for the child's record. `stale` is the instance of a record that already existed at the
// data directory's own rendezvous path: the child replaces it only after taking the database lock
// (D7), so a record naming another instance is the child's. Every start has a new instance ID.
async function waitForRendezvous(path: string, child: ChildProcess, stale: string | null) {
  const running = () => child.exitCode === null && child.signalCode === null;
  let failed = false;
  child.once("error", () => (failed = true));
  const deadline = Date.now() + RENDEZVOUS_WAIT_MS;
  while (Date.now() < deadline) {
    if (failed || !running())
      throw new Error("cove-server exited before publishing its rendezvous");
    if (await exists(path)) {
      let record;
      try {
        record = await readRendezvous(path);
      } catch {
        // The server links a complete file atomically; a failed read is a foreign file, unless a
        // stale file is still waiting to be replaced.
        if (stale === null) throw new Error(`Unexpected rendezvous content at ${path}`);
      }
      if (record && record.relayInstanceId !== stale) {
        // A child that already exited cannot own the record it would be announced with.
        if (failed || !running())
          throw new Error("cove-server exited before its rendezvous could be confirmed");
        return record;
      }
    }
    await sleep(50);
  }
  throw new Error("cove-server did not publish its rendezvous in time");
}

// The fragment is never sent to any server; the page drops it from the address bar as soon
// as it has read it.
function pageUrl(
  harness: HarnessServer,
  record: { endpoint: string; serverId: string; relayInstanceId: string; secret: string },
): string {
  const fragment = new URLSearchParams({
    endpoint: record.endpoint,
    serverId: record.serverId,
    instance: record.relayInstanceId,
    secret: record.secret,
    cwd: process.cwd(),
    shell: process.env.SHELL || "/bin/sh",
  });
  return `${harness.origin}/#${fragment}`;
}

function childStatus(code: number | null, signal: NodeJS.Signals | null): number {
  // Report the server's own status; a signal death uses the shell's 128 + N convention.
  return code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
}

async function serverInit(args: Arguments): Promise<number> {
  takeFlags(args, ["--workspace-root"]);
  if (args.words.length !== 2 || args.command)
    throw new UsageError("server init takes no arguments");
  const home = await prepareHome(homeDirectory(args));
  const root = flag(args, "--workspace-root");
  const entry = await serverEntry();
  // The server binary owns the store; init runs it in its bootstrap mode, which takes the same
  // database lock and is therefore refused while a server of this data directory runs.
  const child = spawn(
    process.execPath,
    [
      entry,
      ...["--mode", "init", "--home", home],
      ...(root === undefined ? [] : ["--workspace-root", resolve(root)]),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  return new Promise<number>((done) => {
    child.once("error", () => done(1));
    child.once("exit", (code, signal) => done(childStatus(code, signal)));
  });
}

async function serverStart(args: Arguments): Promise<number> {
  takeFlags(args, ["--port", "--origin", "--harness", "--harness-port"]);
  if (args.words.length !== 2 || args.command)
    throw new UsageError("server start takes no arguments");
  const port = integerFlag(args, "--port", 0);
  const withHarness = args.flags.has("--harness");
  if (!withHarness && args.flags.has("--harness-port"))
    throw new UsageError("--harness-port needs --harness");
  const harnessPort = integerFlag(args, "--harness-port", 0);
  const pageRoot = withHarness ? await harnessPageRoot() : undefined;
  const home = await prepareHome(homeDirectory(args));
  const path = await prepareRendezvousPath(rendezvousPath(args));
  // Only the data directory's own rendezvous may be replaced by the server that holds its lock.
  const ownRendezvous = path === homeRendezvousPath(home);
  const origins = args.flags.get("--origin") ?? [];
  const entry = await serverEntry();
  const releaseLock = await acquireStartLock(home, path);
  let exit: Promise<number>;
  let harness: HarnessServer | undefined;
  try {
    let stale: string | null = null;
    if (await exists(path)) {
      if (!ownRendezvous)
        throw new Error(
          `${path} already exists; another server may be running. ` +
            "Stop it, or remove the file if that server is gone.",
        );
      // Possibly a crashed server's record. The new server decides: it replaces the record only
      // after taking the data directory's lock, and refuses to start while a server holds it.
      try {
        stale = (await readRendezvous(path)).relayInstanceId;
      } catch {
        stale = "";
      }
    }
    // The page listener starts first: the server must allow the page's exact origin, which
    // includes the listener's port.
    if (pageRoot) harness = await startHarnessServer(pageRoot, harnessPort);
    const child = spawn(
      process.execPath,
      [
        entry,
        ...["--mode", "m0-local", "--host", "127.0.0.1", "--port", String(port)],
        ...["--rendezvous", path, "--home", home],
        ...[...origins, ...(harness ? [harness.origin] : [])].flatMap((origin) => [
          "--origin",
          origin,
        ]),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const page = harness;
    exit = new Promise<number>((done) => {
      child.once("error", () => done(1));
      child.once("exit", (code, signal) => done(childStatus(code, signal)));
    }).then(async (status) => {
      // The page server lives exactly as long as the server it points at.
      await page?.close();
      return status;
    });
    // The server retires its rendezvous and PTYs on SIGINT/SIGTERM; forward them instead of
    // dying first so the operator's Ctrl-C always reaches an orderly shutdown.
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => child.kill(signal));
    try {
      const record = await waitForRendezvous(path, child, stale);
      harness?.allowEndpoint(record.endpoint);
      print({
        endpoint: record.endpoint,
        serverId: record.serverId,
        relayInstanceId: record.relayInstanceId,
        home,
        rendezvous: path,
        pid: child.pid,
        ...(harness ? { harness: pageUrl(harness, record) } : {}),
      });
    } catch (error) {
      // A child that ended on its own before readiness owns the status; one we stop here
      // (timeout or foreign record) is a CLI failure and keeps the generic status.
      const endedOnItsOwn = child.exitCode !== null || child.signalCode !== null;
      child.kill("SIGTERM");
      const status = await exit;
      if (endedOnItsOwn && error instanceof Error) throw new StatusError(error.message, status);
      throw error;
    }
  } catch (error) {
    // Before the child exists nothing else owns the page server; afterwards `exit` also
    // closes it, and closing is idempotent.
    await harness?.close();
    throw error;
  } finally {
    await releaseLock();
  }
  return exit;
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "start") return serverStart(args);
  if (sub === "init") return serverInit(args);
  throw new UsageError(`Unknown server command ${sub ?? ""}`.trim());
}
