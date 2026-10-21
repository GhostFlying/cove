import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { openSession, readRendezvous, type Session } from "../session.js";
import {
  flag,
  homeDirectory,
  print,
  sleep,
  StatusError,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "../commands/_common.js";
import { operationIdFor, submitWrite, printSucceeded } from "../commands/_pending.js";
import {
  activate,
  currentBuild,
  freePorts,
  IncompatibleSchemaError,
  initializeWithPorts,
  installClosure,
  installedBuilds,
  prune,
  removeInstallation,
} from "./installer.js";
import { acquireInstallLock, installLayout, type InstallLayout } from "./layout.js";
import { lingerAdvice, serviceBackend, type ServiceBackend, type UnitStatus } from "./service.js";

// `cove server install|prune|uninstall|service|restart|upgrade|status|impact` (m2 D1, D2, S1,
// S2), dispatched by commands/server.ts. Everything but `status` and `impact` acts on this host's
// installation and service only, never through --server (D11: a paired device can read the
// impact, not restart the service).

// How long a started or restarted service has to publish its new rendezvous.
const START_WAIT_MS = 90_000;

// Mirrors apps/server/src/entry/service-state.ts START_REQUEST (the server consumes it).
const START_REQUEST = join("server", "service", "start-request.json");

async function layoutOf(args: Arguments): Promise<InstallLayout> {
  const home = homeDirectory(args);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return installLayout(await realpath(home));
}

async function withLock<T>(layout: InstallLayout, action: () => Promise<T>): Promise<T> {
  const release = await acquireInstallLock(layout);
  try {
    return await action();
  } finally {
    await release();
  }
}

// The server of this data directory, when one answers at its rendezvous; null otherwise (none
// published, or a record a crashed server left behind).
async function localServer(layout: InstallLayout): Promise<Session | null> {
  try {
    return await openSession(layout.rendezvous);
  } catch {
    return null;
  }
}

async function closing<T>(session: Session, action: (session: Session) => Promise<T>): Promise<T> {
  try {
    return await action(session);
  } finally {
    session.client.dispose();
    await session.close?.();
  }
}

function backendOrThrow(layout: InstallLayout): ServiceBackend {
  const found = serviceBackend(layout);
  if ("unavailable" in found) throw new Error(`no service manager: ${found.unavailable}`);
  return found.backend;
}

// Tells the next server start that a person asked for it (server.status service.lastStart
// "manual"); it holds no secret and grants nothing.
async function requestStart(layout: InstallLayout): Promise<void> {
  const path = join(layout.home, START_REQUEST);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ requestedAtMs: Date.now() })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function rendezvousInstance(layout: InstallLayout): Promise<string | null> {
  try {
    return (await readRendezvous(layout.rendezvous)).relayInstanceId;
  } catch {
    return null;
  }
}

// Waits until a server instance other than `previous` answers at the data directory's rendezvous,
// and returns its status. A new instance ID is the only proof that the start happened: the
// service manager accepting the command is not.
async function waitForNewInstance(layout: InstallLayout, previous: string | null) {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const instance = await rendezvousInstance(layout);
    if (instance !== null && instance !== previous) {
      const session = await localServer(layout);
      if (session)
        return closing(session, async ({ client }) =>
          unwrap("server.status", await client.call("server.status", {})),
        );
    }
    await sleep(200);
  }
  throw new Error(
    `no new server instance answered within ${START_WAIT_MS / 1000} s; ` +
      `check \`cove server service status\` and the service log`,
  );
}

// The part of a server.impact result (ServerImpactResultSchema) the confirmation shows.
type ServerImpactResult = {
  liveRuns: { run: { runId: string }; taskId: string | null; tabId: string | null }[];
  consequences: string[];
};

const CONSEQUENCES: Record<string, string> = {
  "live-runs-end":
    "every live run ends and is recorded as interrupted; nothing is run again automatically",
  "cgroup-processes-end":
    "systemd ends every process of the service's cgroup, including processes a terminal " +
    "detached with nohup, setsid or tmux",
  "detached-processes-launchd":
    "launchd stops the server; whether processes a terminal detached (nohup, tmux) survive is " +
    "launchd's decision (they did in Cove's tests, but nothing promises it)",
  "logout-stops-server": "logging out of macOS also stops the server and all its runs",
};

function describeImpact(impact: ServerImpactResult): string {
  const runs = impact.liveRuns.length
    ? impact.liveRuns
        .map((run) => `  run ${run.run.runId} (task ${run.taskId ?? "-"}, tab ${run.tabId ?? "-"})`)
        .join("\n")
    : "  (no live runs)";
  return (
    `Live runs that end:\n${runs}\n` +
    impact.consequences.map((key) => `- ${CONSEQUENCES[key] ?? key}`).join("\n") +
    "\n"
  );
}

async function ask(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

// Shows what stopping the running server ends (S2) and asks for confirmation. Without --yes and
// without a terminal to ask on, it prints the impact and fails with status 2, having done nothing.
async function confirmStop(
  args: Arguments,
  session: Session | null,
  action: string,
): Promise<ServerImpactResult | null> {
  if (!session) return null;
  const impact = unwrap("server.impact", await session.client.call("server.impact", {}));
  if (args.flags.has("--yes")) return impact;
  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
  if (!interactive) {
    print({ action, confirmed: false, impact });
    throw new StatusError(
      `${action} stops the running server: ${impact.liveRuns.length} live run(s) end. ` +
        "Confirm with --yes; nothing was done",
      2,
    );
  }
  process.stderr.write(describeImpact(impact));
  if (!(await ask(`${action}? [y/N] `)))
    throw new StatusError("not confirmed; nothing was done", 1);
  return impact;
}

function noWords(args: Arguments, count: number, usage: string): void {
  if (args.words.length !== count || args.command) throw new UsageError(usage);
}

// Ports for a data directory that has none configured (D3): through init when no server runs,
// otherwise through the running server's entry configuration.
async function ensurePorts(args: Arguments, layout: InstallLayout, session: Session | null) {
  const ports = (await freePorts(2)) as [number, number];
  if (!session) return initializeWithPorts(layout, ports);
  const entry = unwrap("entry.get", await session.client.call("entry.get", {})).entry;
  const patch = {
    ...(entry.settings.businessPort === null ? { businessPort: ports[0] } : {}),
    ...(entry.settings.pairingPort === null ? { pairingPort: ports[1] } : {}),
  };
  if (Object.keys(patch).length === 0)
    return { businessPort: entry.settings.businessPort, pairingPort: entry.settings.pairingPort };
  const operation = await submitWrite(args, session, "entry.set", {
    operationId: operationIdFor(args),
    expectedRevision: entry.revision,
    patch,
  });
  if (operation.state !== "succeeded") printSucceeded(operation);
  const after = unwrap("entry.get", await session.client.call("entry.get", {})).entry;
  return { businessPort: after.settings.businessPort, pairingPort: after.settings.pairingPort };
}

function warnLinger(status: UnitStatus): void {
  if (status.linger === false) process.stderr.write(`cove: ${lingerAdvice()}\n`);
}

// `cove server install [--closure DIR | --activate BUILD]`.
export async function serverInstall(args: Arguments): Promise<number> {
  takeFlags(args, ["--closure", "--activate"]);
  noWords(args, 2, "server install takes no arguments");
  const source = flag(args, "--closure");
  const target = flag(args, "--activate");
  if (source !== undefined && target !== undefined)
    throw new UsageError("--closure and --activate are separate installs");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    if (target !== undefined) {
      // Only switches `current`; the running server keeps its build until a restart (D1).
      const schema = await activate(layout, target);
      print({ build: target, activated: true, schema });
      return 0;
    }
    const installed = await installClosure(
      layout,
      source === undefined ? undefined : resolve(source),
    );
    try {
      await activate(layout, installed.build);
    } catch (error) {
      if (error instanceof IncompatibleSchemaError)
        throw new Error(
          `build ${installed.build} was installed but not activated: ${error.message}`,
        );
      throw error;
    }
    const session = await localServer(layout);
    let running: string | null = null;
    let entry;
    let service: UnitStatus | { unavailable: string };
    try {
      if (session)
        running = unwrap(
          "server.status",
          await session.client.call("server.status", {}),
        ).buildVersion;
      entry = await ensurePorts(args, layout, session);
      const found = serviceBackend(layout);
      if ("unavailable" in found) service = found;
      else {
        // A server that already runs (under the service or in the foreground) is left alone: the
        // new build takes effect at an explicit restart. Otherwise the service starts now.
        const previous = await rendezvousInstance(layout);
        if (!session) await requestStart(layout);
        await found.backend.register(!session);
        if (!session) await waitForNewInstance(layout, previous);
        service = found.backend.status();
        warnLinger(service);
      }
    } finally {
      if (session) await closing(session, async () => undefined);
    }
    print({
      build: installed.build,
      dir: installed.dir,
      created: installed.created,
      activated: true,
      runningBuild: running,
      pending: running !== null && running !== installed.build,
      entry,
      service,
    });
    return 0;
  });
}

// `cove server prune`: removes installed builds other than the active and the running one (D1's
// `install --prune`; a separate subcommand because the CLI's switches are shared).
export async function serverPrune(args: Arguments): Promise<number> {
  takeFlags(args, []);
  noWords(args, 2, "server prune takes no arguments");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const keep = new Set<string>();
    const current = await currentBuild(layout);
    if (current) keep.add(current);
    const session = await localServer(layout);
    if (session)
      await closing(session, async ({ client }) =>
        keep.add(unwrap("server.status", await client.call("server.status", {})).buildVersion),
      );
    print({ kept: [...keep], removed: await prune(layout, keep) });
    return 0;
  });
}

// `cove server uninstall [--yes]`: stops the service, removes its unit, the installed builds and
// the launcher; the data directory stays (S1).
export async function serverUninstall(args: Arguments): Promise<number> {
  takeFlags(args, ["--yes"]);
  noWords(args, 2, "server uninstall takes no arguments");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const found = serviceBackend(layout);
    const backend = "unavailable" in found ? null : found.backend;
    const session = backend?.status().registered ? await localServer(layout) : null;
    if (session) await closing(session, (s) => confirmStop(args, s, "server uninstall"));
    await backend?.unregister();
    await removeInstallation(layout);
    print({ uninstalled: true, home: layout.home, unit: backend?.unitPath ?? null });
    return 0;
  });
}

// `cove server service start|stop|status`.
export async function serviceCommand(args: Arguments): Promise<number> {
  const sub = args.words[2];
  if (sub === "status") {
    takeFlags(args, []);
    noWords(args, 3, "server service status takes no arguments");
    const layout = await layoutOf(args);
    const found = serviceBackend(layout);
    print("unavailable" in found ? found : found.backend.status());
    return 0;
  }
  if (sub !== "start" && sub !== "stop")
    throw new UsageError(`Unknown server service command ${sub ?? ""}`.trim());
  takeFlags(args, sub === "stop" ? ["--yes"] : []);
  noWords(args, 3, `server service ${sub} takes no arguments`);
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const backend = backendOrThrow(layout);
    if (!backend.status().registered && sub === "stop") {
      print(backend.status());
      return 0;
    }
    if (sub === "stop") {
      const session = await localServer(layout);
      if (session) await closing(session, (s) => confirmStop(args, s, "server service stop"));
      await backend.stop();
      print(backend.status());
      return 0;
    }
    if (!(await currentBuild(layout)))
      throw new Error("nothing is installed; run `cove server install` first");
    const session = await localServer(layout);
    if (session) {
      await closing(session, async () => undefined);
      throw new Error("a server is already running for this data directory");
    }
    const previous = await rendezvousInstance(layout);
    await requestStart(layout);
    if (backend.status().registered) await backend.start();
    else await backend.register(true);
    const status = await waitForNewInstance(layout, previous);
    print({ ...backend.status(), relayInstanceId: status.relayInstanceId });
    warnLinger(backend.status());
    return 0;
  });
}

// Restarts the service with whatever `current` names. The caller holds the lock and confirmed.
async function restartService(layout: InstallLayout, previous: Session | null) {
  const backend = backendOrThrow(layout);
  let before: { serverId: string; relayInstanceId: string; buildVersion: string } | null = null;
  if (previous) {
    const status = unwrap("server.status", await previous.client.call("server.status", {}));
    if (status.service?.manager === "foreground")
      throw new Error(
        "the running server was started in the foreground (`cove server start`); stop it there " +
          "and run `cove server service start`",
      );
    before = status;
  }
  const stale = before?.relayInstanceId ?? (await rendezvousInstance(layout));
  await requestStart(layout);
  if (backend.status().registered) await backend.restart();
  else await backend.register(true);
  const after = await waitForNewInstance(layout, stale);
  return {
    serverId: after.serverId,
    previousRelayInstanceId: before?.relayInstanceId ?? null,
    relayInstanceId: after.relayInstanceId,
    previousBuild: before?.buildVersion ?? null,
    buildVersion: after.buildVersion,
    service: after.service ?? null,
  };
}

// `cove server restart [--yes]` (S2): lists the live runs and consequences first, and restarts
// only when confirmed.
export async function serverRestart(args: Arguments): Promise<number> {
  takeFlags(args, ["--yes"]);
  noWords(args, 2, "server restart takes no arguments");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const session = await localServer(layout);
    if (!session) {
      print(await restartService(layout, null));
      return 0;
    }
    return closing(session, async (s) => {
      const impact = await confirmStop(args, s, "server restart");
      print({ ...(await restartService(layout, s)), impact });
      return 0;
    });
  });
}

// `cove server upgrade [--yes] [--closure DIR]`: confirm, install and activate, restart.
export async function serverUpgrade(args: Arguments): Promise<number> {
  takeFlags(args, ["--yes", "--closure"]);
  noWords(args, 2, "server upgrade takes no arguments");
  const source = flag(args, "--closure");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const session = await localServer(layout);
    const run = async (s: Session | null) => {
      const impact = await confirmStop(args, s, "server upgrade");
      const installed = await installClosure(
        layout,
        source === undefined ? undefined : resolve(source),
      );
      await activate(layout, installed.build);
      print({ build: installed.build, ...(await restartService(layout, s)), impact });
      return 0;
    };
    return session ? closing(session, run) : run(null);
  });
}

// `cove server status`: this host's installation and service, and the running server's status.
// With --server, only the paired server's status.
export async function serverStatus(args: Arguments, remote: boolean): Promise<number> {
  takeFlags(args, []);
  noWords(args, 2, "server status takes no arguments");
  if (remote)
    return withSession(args, async ({ client }) => {
      print({ server: unwrap("server.status", await client.call("server.status", {})) });
      return 0;
    });
  const layout = await layoutOf(args);
  const found = serviceBackend(layout);
  const session = await localServer(layout);
  const server = session
    ? await closing(session, async ({ client }) =>
        unwrap("server.status", await client.call("server.status", {})),
      )
    : null;
  print({
    home: layout.home,
    installedBuild: await currentBuild(layout),
    builds: await installedBuilds(layout),
    unit: "unavailable" in found ? found : found.backend.status(),
    server,
  });
  return 0;
}

// `cove server impact`: what stopping the server would end; a read, also with --server.
export async function serverImpact(args: Arguments): Promise<number> {
  takeFlags(args, []);
  noWords(args, 2, "server impact takes no arguments");
  return withSession(args, async ({ client }) => {
    print(unwrap("server.impact", await client.call("server.impact", {})));
    return 0;
  });
}
