import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CLOSURE_CLI, CLOSURE_NODE, CLOSURE_SERVER } from "./closure.js";
import { releaseLock, tryExclusiveLock } from "./os-lock.js";

// Where `cove server install` keeps things in a data directory (m2 D1). `home` is always the
// canonical real path: the service unit, the launcher and the lock name it in one spelling.
//
//   install/<build>/          sealed closures, never modified once renamed into place
//   install/current           relative symlink to one of them, switched atomically
//   install/.staging-*        a closure being built or copied (removed on failure)
//   install/.lock.sqlite      held by one install, activation, service change or uninstall;
//                             never removed (os-lock.ts)
//   bin/cove                  the launcher: runs the CLI of install/current
//   server/                   the server's data, which install never touches but for the
//                             start request (server/service/) and the LaunchAgent log
export type InstallLayout = {
  readonly home: string;
  readonly installDirectory: string;
  readonly current: string;
  readonly lock: string;
  // The running server's instance lock (apps/server/src/store/database.ts: `cove.lock` beside the
  // database, held for the server's whole life). Probed, never held (server-state.ts).
  readonly serverLock: string;
  readonly launcher: string;
  readonly rendezvous: string;
  readonly logDirectory: string;
  // The service unit's name, unique per data directory (see unitSuffix).
  readonly label: string;
  readonly systemdUnit: string;
};

// A short digest of the data directory: each data directory gets its own service, and a test's
// temporary home never shares a name with the operator's real service.
function unitSuffix(home: string): string {
  return createHash("sha256").update(home).digest("hex").slice(0, 12);
}

export function installLayout(home: string): InstallLayout {
  const installDirectory = join(home, "install");
  const suffix = unitSuffix(home);
  return {
    home,
    installDirectory,
    current: join(installDirectory, "current"),
    lock: join(installDirectory, ".lock.sqlite"),
    serverLock: join(home, "server", "cove.lock"),
    launcher: join(home, "bin", "cove"),
    rendezvous: join(home, "server", "run", "rendezvous.json"),
    logDirectory: join(home, "server", "log"),
    label: `dev.cove.server.${suffix}`,
    systemdUnit: `cove-server-${suffix}.service`,
  };
}

export function closurePath(layout: InstallLayout, build: string): string {
  return join(layout.installDirectory, build);
}

// What the service unit runs: always through `current`, so that activating another build changes
// what the next start runs and never the unit (D1, S1).
export function serverCommand(layout: InstallLayout, manager: "launchd-agent" | "systemd-user") {
  return [
    join(layout.current, CLOSURE_NODE),
    join(layout.current, CLOSURE_SERVER),
    ...["--mode", "m0-local", "--host", "127.0.0.1"],
    ...["--rendezvous", layout.rendezvous, "--home", layout.home],
    ...["--service", manager],
  ];
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// `<home>/bin/cove`: the installed CLI with this data directory as its default home. A POSIX sh
// script rather than a symlink, because the CLI must run under the closure's own Node.
export function launcherScript(layout: InstallLayout): string {
  return [
    "#!/bin/sh",
    "# Written by `cove server install`; runs the CLI of the active installed build.",
    `if [ -z "\${COVE_HOME:-}" ]; then COVE_HOME=${quoteShell(layout.home)}; fi`,
    "export COVE_HOME",
    `exec ${quoteShell(join(layout.current, CLOSURE_NODE))} ${quoteShell(
      join(layout.current, CLOSURE_CLI),
    )} "$@"`,
    "",
  ].join("\n");
}

// One installation change at a time per data directory: installing, activating, starting or
// stopping the service, restarting, upgrading, pruning and uninstalling. The lock is an OS lock
// that ends with the holding process (os-lock.ts), so a crashed command leaves nothing to take
// over. A second command is refused at once rather than queued: an installation command can run
// for minutes (a closure build, a restart waiting for the new instance). Returns the release
// function.
export async function acquireInstallLock(layout: InstallLayout): Promise<() => void> {
  await mkdir(layout.installDirectory, { recursive: true, mode: 0o700 });
  const held = await tryExclusiveLock(layout.lock);
  if (!held)
    throw new Error(
      `another installation command (${layout.lock}) is running for this data directory`,
    );
  return () => releaseLock(held);
}
