import { ensureInstallDirectory } from "./layout.js";
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
import { lockHeld } from "./os-lock.js";
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
    release();
  }
}

// The server that answers at the data directory's rendezvous, or null.
async function answering(layout: InstallLayout): Promise<Session | null> {
  try {
    return await openSession(layout.rendezvous);
  } catch {
    return null;
  }
}

// Whether the server of this data directory runs, as far as this command can prove it:
// - running: it answered at its rendezvous (the session is open);
// - stopped: no process holds its instance lock (os-lock.ts), so no server of this data directory
//   runs, whatever the rendezvous file says (a crashed server leaves one behind);
// - unknown: the lock is held but the server did not answer (a handshake timeout, a refusal at
//   capacity, a server still starting or stuck). It may be running with live runs, so a command
//   that stops it or removes builds treats it as possibly running, never as stopped: it asks for
//   confirmation without an impact list, and prune keeps every build.
// The lock is checked only after the server did not answer, so that a probe cannot make a starting
// server find its lock taken. A server that starts just after a "stopped" answer (a service
// manager's crash restart) is the remaining window: the command acts as if none ran, and that
// server, just started, has no live run of its own yet.
type LocalServer =
  | { state: "running"; session: Session }
  | { state: "stopped" }
  | { state: "unknown"; reason: string };

async function localServer(layout: InstallLayout): Promise<LocalServer> {
  let reason: string;
  try {
    return { state: "running", session: await openSession(layout.rendezvous) };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  try {
    if (!lockHeld(layout.serverLock)) return { state: "stopped" };
  } catch (error) {
    reason += `; the server lock cannot be checked: ${(error as Error).message}`;
  }
  return { state: "unknown", reason };
}

function sessionOf(local: LocalServer): Session | null {
  return local.state === "running" ? local.session : null;
}

async function release(local: LocalServer): Promise<void> {
  if (local.state === "running") await closing(local.session, async () => undefined);
}

function unconfirmed(local: { reason: string }): string {
  return (
    "cannot tell whether the server of this data directory is running: it holds the data " +
    `directory but did not answer (${local.reason})`
  );
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
  await ensureInstallDirectory(join(layout.home, "server"));
  await ensureInstallDirectory(dirname(path));
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

// How often a wait for a started server reads the service manager and the service's output.
const START_CHECK_MS = 1_000;
const STARTUP_CAUSE_CHARS = 600;

// The cause in the latest startup-failed event (apps/server/src/entry/main.ts failStart) the
// service wrote at or after `sinceMs`, or null. Only the events' own timestamps decide which start
// an event belongs to, so an earlier start's failure is never shown as this one's. The log is not
// trusted further than that: the cause is bounded and its control characters replaced before it
// is printed.
export function startupFailureSince(output: string | null, sinceMs: number): string | null {
  let found: string | null = null;
  for (const line of output?.split("\n") ?? []) {
    if (!line.startsWith('{"event":"startup-failed"')) continue;
    let event: { atMs?: unknown; category?: unknown; detail?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.atMs !== "number" || event.atMs < sinceMs) continue;
    const cause =
      typeof event.detail === "string"
        ? event.detail
        : `the server's ${typeof event.category === "string" ? event.category : "startup"} step failed`;
    found = Array.from(cause.slice(0, STARTUP_CAUSE_CHARS), (c) =>
      c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? "?" : c,
    ).join("");
  }
  return found;
}

// Waits until a server instance other than `previous` answers at the data directory's rendezvous,
// and returns its status. A new instance ID is the only proof that the start happened: the
// service manager accepting the command is not.
//
// Meanwhile the start may fail (#172). A startup-failed event the service wrote since `sinceMs`
// is shown on stderr as soon as it appears, but is not taken as the end: the service manager
// starts a failed server again, and a cause that was transient (a port still held by the
// previous server) can pass. The wait ends early only when the manager gave up after repeated
// crashes (gaveUpSince), which nothing but `cove server service start` undoes; otherwise it ends
// at START_WAIT_MS. Either error names the latest cause.
async function waitForNewInstance(
  layout: InstallLayout,
  previous: string | null,
  backend: ServiceBackend,
  sinceMs: number,
) {
  const deadline = Date.now() + START_WAIT_MS;
  let cause: string | null = null;
  let checked = 0;
  const latestCause = (): void => {
    const found = startupFailureSince(backend.recentOutput(sinceMs, deadline), sinceMs);
    if (found !== null && found !== cause)
      process.stderr.write(
        `cove: the server failed to start: ${found}; waiting for the service manager to start it again\n`,
      );
    cause = found ?? cause;
  };
  const because = (): string => (cause === null ? "" : `; the last start failed: ${cause}`);
  while (Date.now() < deadline) {
    const instance = await rendezvousInstance(layout);
    if (instance !== null && instance !== previous) {
      const session = await answering(layout);
      if (session)
        return closing(session, async ({ client }) =>
          unwrap("server.status", await client.call("server.status", {})),
        );
    }
    if (Date.now() - checked >= START_CHECK_MS) {
      checked = Date.now();
      latestCause();
      if (backend.gaveUpSince(sinceMs, deadline))
        throw new Error(
          `the server did not start: the service manager stopped restarting it after repeated ` +
            `failed starts${because()}. Fix the cause, then run \`cove server service start\``,
        );
    }
    await sleep(200);
  }
  // Do not start another synchronous manager probe after the startup deadline.
  throw new Error(
    `no new server instance answered within ${START_WAIT_MS / 1000} s${because()}; ` +
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

export function describeImpact(impact: ServerImpactResult): string {
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
// A server whose state is unknown may be running: the confirmation is asked all the same, saying
// that the impact cannot be listed; --yes goes ahead, which is how an operator stops a server
// that no longer answers. Only a server proven stopped needs no confirmation. `done` says what the
// command already did when it is refused (upgrade asks again after installing), and `context`
// is added to the printed refusal.
async function confirmStop(
  args: Arguments,
  local: LocalServer,
  action: string,
  done = "nothing was done",
  context: Record<string, unknown> = {},
): Promise<ServerImpactResult | null> {
  if (local.state === "stopped") return null;
  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
  if (local.state === "unknown") {
    const message = `${action}: ${unconfirmed(local)}`;
    if (args.flags.has("--yes")) {
      process.stderr.write(`cove: ${message}; going ahead (--yes)\n`);
      return null;
    }
    if (!interactive) {
      print({
        action,
        ...context,
        confirmed: false,
        state: "unknown",
        reason: local.reason,
        impact: null,
      });
      throw new StatusError(
        `${message}. If it is running, every live run ends and they cannot be listed. ` +
          `Confirm with --yes; ${done}`,
        2,
      );
    }
    process.stderr.write(
      `${message}.\nIf it is running, every live run ends; they cannot be listed.\n`,
    );
    if (!(await ask(`${action}? [y/N] `))) throw new StatusError(`not confirmed; ${done}`, 1);
    return null;
  }
  const { session } = local;
  const impact = unwrap("server.impact", await session.client.call("server.impact", {}));
  if (args.flags.has("--yes")) return impact;
  if (!interactive) {
    print({ action, ...context, confirmed: false, state: "running", impact });
    // Every consequence on stderr as well (#175), as a terminal would have been shown it: a
    // script that reads only stderr must not miss, say, the end of its nohup'd processes.
    process.stderr.write(describeImpact(impact));
    throw new StatusError(
      `${action} stops the running server: ${impact.liveRuns.length} live run(s) end. ` +
        `Confirm with --yes; ${done}`,
      2,
    );
  }
  process.stderr.write(describeImpact(impact));
  if (!(await ask(`${action}? [y/N] `))) throw new StatusError(`not confirmed; ${done}`, 1);
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
    const local = await localServer(layout);
    if (local.state === "unknown")
      throw new Error(
        `build ${installed.build} was installed and activated, but the entry ports and the ` +
          `service were left unchanged: ${unconfirmed(local)}. Run \`cove server install\` ` +
          "again once it answers",
      );
    const session = sessionOf(local);
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
        const since = Date.now();
        if (!session) await requestStart(layout);
        await found.backend.register(!session);
        if (!session) await waitForNewInstance(layout, previous, found.backend, since);
        service = found.backend.status();
        warnLinger(service);
      }
    } finally {
      await release(local);
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
// `install --prune`; a separate subcommand because the CLI's switches are shared). When the
// server's state is unknown, any installed build may be the one it runs, so nothing is removed.
export async function serverPrune(args: Arguments): Promise<number> {
  takeFlags(args, []);
  noWords(args, 2, "server prune takes no arguments");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const keep = new Set<string>();
    const current = await currentBuild(layout);
    if (current) keep.add(current);
    const local = await localServer(layout);
    if (local.state === "unknown")
      throw new Error(
        `nothing was removed: ${unconfirmed(local)}, so any installed build may be the one it runs`,
      );
    if (local.state === "running")
      await closing(local.session, async ({ client }) =>
        keep.add(unwrap("server.status", await client.call("server.status", {})).buildVersion),
      );
    print({ kept: [...keep], removed: await prune(layout, keep) });
    return 0;
  });
}

// The build a running server runs, when it is one of this installation's; null otherwise.
async function runningInstalledBuild(layout: InstallLayout, session: Session) {
  const status = unwrap("server.status", await session.client.call("server.status", {}));
  return (await installedBuilds(layout)).includes(status.buildVersion) ? status.buildVersion : null;
}

// `cove server uninstall [--yes]`: stops the service, removes its unit, the installed builds and
// the launcher; the data directory stays (S1). The builds are removed only once no server of the
// data directory runs from one of them.
export async function serverUninstall(args: Arguments): Promise<number> {
  takeFlags(args, ["--yes"]);
  noWords(args, 2, "server uninstall takes no arguments");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const found = serviceBackend(layout);
    const backend = "unavailable" in found ? null : found.backend;
    const before = await localServer(layout);
    try {
      // A server in the foreground keeps running: no confirmation, and its build is checked below.
      const foreground =
        before.state === "running" &&
        (unwrap("server.status", await before.session.client.call("server.status", {})).service
          ?.manager ?? "foreground") === "foreground";
      if (!foreground) await confirmStop(args, before, "server uninstall");
    } finally {
      await release(before);
    }
    await backend?.unregister();
    const after = await localServer(layout);
    try {
      if (after.state === "unknown")
        throw new Error(
          `the service was removed, but the installed builds were kept: ${unconfirmed(after)}`,
        );
      // Still running after the service was removed: a server started in the foreground, which
      // uninstall does not stop. Removing the build it runs from would break it.
      const inUse =
        after.state === "running" ? await runningInstalledBuild(layout, after.session) : null;
      if (inUse)
        throw new Error(
          `the service was removed, but the installed builds were kept: a server started in the ` +
            `foreground runs build ${inUse}; stop it and run \`cove server uninstall\` again`,
        );
    } finally {
      await release(after);
    }
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
      const local = await localServer(layout);
      try {
        await confirmStop(args, local, "server service stop");
      } finally {
        await release(local);
      }
      await backend.stop();
      print(backend.status());
      return 0;
    }
    if (!(await currentBuild(layout)))
      throw new Error("nothing is installed; run `cove server install` first");
    const local = await localServer(layout);
    await release(local);
    if (local.state === "running")
      throw new Error("a server is already running for this data directory");
    if (local.state === "unknown") throw new Error(`not started: ${unconfirmed(local)}`);
    const previous = await rendezvousInstance(layout);
    const since = Date.now();
    await requestStart(layout);
    if (backend.status().registered) await backend.start();
    else await backend.register(true);
    const status = await waitForNewInstance(layout, previous, backend, since);
    print({ ...backend.status(), relayInstanceId: status.relayInstanceId });
    warnLinger(backend.status());
    return 0;
  });
}

type RunningServer = { serverId: string; relayInstanceId: string; buildVersion: string };

// The running server's identity before a restart; refuses a server started in the foreground,
// which the service manager cannot restart.
async function restartable(local: LocalServer): Promise<RunningServer | null> {
  if (local.state !== "running") return null;
  const status = unwrap("server.status", await local.session.client.call("server.status", {}));
  if (status.service?.manager === "foreground")
    throw new Error(
      "the running server was started in the foreground (`cove server start`); stop it there " +
        "and run `cove server service start`",
    );
  return status;
}

// Restarts the service with whatever `current` names. The caller holds the lock, confirmed, and
// has already closed its own session to the server: the service manager calls block this process
// (spawnSync), so a session still open could not answer the stopping server's WebSocket close
// handshake, and the server's orderly shutdown would wait for it until the manager's stop timeout
// (TimeoutStopSec, ExitTimeOut) killed it.
async function restartService(layout: InstallLayout, before: RunningServer | null) {
  const backend = backendOrThrow(layout);
  const stale = before?.relayInstanceId ?? (await rendezvousInstance(layout));
  const since = Date.now();
  await requestStart(layout);
  if (backend.status().registered) await backend.restart();
  else await backend.register(true);
  const after = await waitForNewInstance(layout, stale, backend, since);
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
    const local = await localServer(layout);
    let impact;
    let before;
    try {
      impact = await confirmStop(args, local, "server restart");
      before = await restartable(local);
    } finally {
      await release(local);
    }
    print({ ...(await restartService(layout, before)), impact });
    return 0;
  });
}

// `cove server upgrade [--yes] [--closure DIR]`: confirm, install and activate, confirm again if
// the server changed meanwhile, restart.
export async function serverUpgrade(args: Arguments): Promise<number> {
  takeFlags(args, ["--yes", "--closure"]);
  noWords(args, 2, "server upgrade takes no arguments");
  const source = flag(args, "--closure");
  const layout = await layoutOf(args);
  return withLock(layout, async () => {
    const local = await localServer(layout);
    let impact;
    let before;
    try {
      impact = await confirmStop(args, local, "server upgrade");
      before = await restartable(local);
    } finally {
      await release(local);
    }
    const installed = await installClosure(
      layout,
      source === undefined ? undefined : resolve(source),
    );
    await activate(layout, installed.build);
    // Installing can take minutes, and the confirmation above was for the server as it was then:
    // one may have started meanwhile (a service manager's crash restart, a foreground start) or
    // stopped answering. The state is read again right before the restart, and a change is
    // confirmed again; the restart is the step that ends runs, so a refusal here leaves the new
    // build installed and active, to take effect at the next restart.
    const notRestarted = `build ${installed.build} was installed and activated, but the server was not restarted`;
    const now = await localServer(layout);
    try {
      const instance =
        now.state === "running"
          ? unwrap("server.status", await now.session.client.call("server.status", {}))
              .relayInstanceId
          : null;
      // Unchanged: the same state, and for a running server the same instance. With --yes the
      // impact is read again all the same, so that the output lists what the restart ends.
      const unchanged = now.state === local.state && instance === (before?.relayInstanceId ?? null);
      if (!unchanged || args.flags.has("--yes"))
        impact = await confirmStop(args, now, "server upgrade", notRestarted, {
          build: installed.build,
        });
      before = await restartable(now);
    } catch (error) {
      if (error instanceof StatusError) throw error;
      throw new Error(`${notRestarted}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await release(now);
    }
    print({ build: installed.build, ...(await restartService(layout, before)), impact });
    return 0;
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
  const local = await localServer(layout);
  const server =
    local.state === "running"
      ? await closing(local.session, async ({ client }) =>
          unwrap("server.status", await client.call("server.status", {})),
        )
      : null;
  print({
    home: layout.home,
    installedBuild: await currentBuild(layout),
    builds: await installedBuilds(layout),
    unit: "unavailable" in found ? found : found.backend.status(),
    // running, stopped, or unknown with the reason (localServer).
    serverState: local.state,
    ...(local.state === "unknown" ? { serverError: local.reason } : {}),
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
