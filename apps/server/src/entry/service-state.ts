import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { stampedBuild, INSTALL_STAMP } from "../build-id.js";
import type { Store } from "../store/database.js";
import type { LiveRunImpact, PreviousStart, ServiceStartRecord } from "../store/sql/entry.js";
import type { ServiceManagerName } from "./m0-local-options.js";

export type ServiceManager = ServiceManagerName | "foreground";
export type StartReason = ServiceStartRecord["reason"];
export type ImpactConsequence =
  "live-runs-end" | "cgroup-processes-end" | "detached-processes-launchd" | "logout-stops-server";

// Where `cove` asks for a start (apps/cli/src/install/): before it starts or restarts the service
// it writes this file, and the server that starts next consumes it. It only says "a person asked
// for this start" for the start reason; it holds no secret and grants nothing.
export const START_REQUEST = join("server", "service", "start-request.json");
// A request older than this, or from the future beyond the tolerance, is stale: a start that was
// asked for and failed must not make a much later boot or crash restart look manual.
const START_REQUEST_FRESH_MS = 120_000;
const CLOCK_TOLERANCE_MS = 10_000;

// Why this instance started (m2 D2, S1, S2; server.status service.lastStart):
// - manual: a foreground `cove server start`, or a service start, restart or upgrade asked for
//   through `cove` (the start request);
// - crash-restart: the service manager started it again in the same host boot after the previous
//   instance ended without recording an orderly stop (crash, kill -9);
// - boot (Linux) / login (macOS): the first start of another host boot, or of a new login session
//   (macOS stops a LaunchAgent at logout and starts it at login; a Linux user manager without
//   linger does the same);
// - unknown: the service manager started it in the same boot after an orderly stop, and nobody
//   asked through `cove` (for example `systemctl --user start` typed directly).
// A boot ID that cannot be read is never taken to be the same boot, so an unreadable host never
// reports a crash restart it cannot prove.
export function startReason(input: {
  manager: ServiceManager;
  requested: boolean;
  previous: PreviousStart | null;
  bootId: string | null;
  platform: "linux" | "darwin";
  linger: boolean | null;
}): StartReason {
  if (input.manager === "foreground" || input.requested) return "manual";
  const sameBoot = input.bootId !== null && input.previous?.bootId === input.bootId;
  if (sameBoot && input.previous && !input.previous.stopped) return "crash-restart";
  if (input.platform === "darwin") return "login";
  if (!sameBoot) return "boot";
  return input.linger === false ? "login" : "unknown";
}

// This host boot's identity: Linux's boot_id, macOS's kern.bootsessionuuid; null when unreadable.
export function hostBootId(): string | null {
  try {
    const text =
      process.platform === "linux"
        ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
        : execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
            encoding: "utf8",
            timeout: 2_000,
            stdio: ["ignore", "pipe", "ignore"],
          });
    const id = text.trim();
    return /^[0-9A-Za-z-]{8,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Linux only: whether systemd keeps this user's manager running without a login (linger), which
// is what lets the service run after logout and start at boot (D2). Read from logind's state
// directory rather than by running loginctl. Null elsewhere.
export function lingerEnabled(): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    return existsSync(join("/var/lib/systemd/linger", userInfo().username));
  } catch {
    return false;
  }
}

function platform(): "linux" | "darwin" {
  return process.platform === "darwin" ? "darwin" : "linux";
}

// Consumes the start request, if any; true when a fresh one was there.
async function takeStartRequest(home: string, now: number): Promise<boolean> {
  const path = join(home, START_REQUEST);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return false;
  }
  await unlink(path).catch(() => undefined);
  try {
    const { requestedAtMs } = JSON.parse(text) as { requestedAtMs?: unknown };
    return (
      typeof requestedAtMs === "number" &&
      requestedAtMs <= now + CLOCK_TOLERANCE_MS &&
      now - requestedAtMs <= START_REQUEST_FRESH_MS
    );
  } catch {
    return false;
  }
}

// Records how this instance started (service_starts), once, before anything is served.
export async function recordServiceStart(
  store: Store,
  input: { home: string; relayInstanceId: string; manager: ServiceManager; now?: number },
): Promise<StartReason> {
  const now = input.now ?? Date.now();
  const requested = await takeStartRequest(input.home, now);
  const previous = await store.call("service.previousStart", {
    relayInstanceId: input.relayInstanceId,
  });
  const bootId = hostBootId();
  const reason = startReason({
    manager: input.manager,
    requested,
    previous,
    bootId,
    platform: platform(),
    linger: lingerEnabled(),
  });
  await store.call("service.recordStart", {
    relayInstanceId: input.relayInstanceId,
    manager: input.manager,
    bootId,
    reason,
  });
  return reason;
}

// The build `<home>/install/current` names (D1), or null when nothing is installed or the link
// does not lead to a stamped closure.
export function installedBuild(home: string): string | null {
  try {
    const target = realpathSync(join(home, "install", "current"));
    return stampedBuild(readFileSync(join(target, INSTALL_STAMP), "utf8"));
  } catch {
    return null;
  }
}

// What stopping this server ends, by how it runs (D2). Every live run ends and is recorded
// interrupted, never re-run. A systemd stop ends the unit's whole cgroup (KillMode=control-group,
// the default D2 chose), detached processes included; under launchd it is launchd's decision, and
// logging out stops the agent too.
export function consequences(manager: ServiceManager): ImpactConsequence[] {
  if (manager === "systemd-user") return ["live-runs-end", "cgroup-processes-end"];
  if (manager === "launchd-agent")
    return ["live-runs-end", "detached-processes-launchd", "logout-stops-server"];
  return ["live-runs-end"];
}

// How this server instance runs (server.status `service`, server.impact).
export class ServiceState {
  constructor(
    private readonly options: {
      store: Store;
      home: string;
      relayInstanceId: string;
      manager: ServiceManager;
      lastStart: StartReason;
    },
  ) {}

  // Read on every status, so an install or activation since this server started shows up as
  // pending without a restart (S2).
  status(runningBuild: string) {
    const installed = installedBuild(this.options.home);
    return {
      manager: this.options.manager,
      installedBuild: installed,
      pendingBuild: installed !== null && installed !== runningBuild ? installed : null,
      lastStart: this.options.lastStart,
      linger: lingerEnabled(),
    };
  }

  async impact(): Promise<{
    platform: "linux" | "darwin";
    manager: ServiceManager;
    liveRuns: LiveRunImpact[];
    consequences: ImpactConsequence[];
  }> {
    return {
      platform: platform(),
      manager: this.options.manager,
      liveRuns: await this.options.store.call("service.liveRuns", {
        relayInstanceId: this.options.relayInstanceId,
      }),
      consequences: consequences(this.options.manager),
    };
  }
}
