import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ensureInstallDirectory, serverCommand, type InstallLayout } from "./layout.js";

// Preflight all paths that a start will adopt before activation or any service stop. The
// high-level commands call this before earlier mutations; backend entry points repeat it for
// direct callers and already-registered launchd jobs. Stop-only repair commands need no new log.
export async function prepareServiceStart(layout: InstallLayout): Promise<void> {
  await ensureInstallDirectory(join(layout.home, "server"));
  await ensureInstallDirectory(join(layout.home, "server", "service"));
  if (process.platform === "darwin") await ensureInstallDirectory(layout.logDirectory);
}

// The user-level service manager that runs an installed server (m2 D2): a LaunchAgent in the
// macOS gui domain, a systemd user unit on Linux. Both detach the server from the shell, SSH
// session and client that started it, restart it after a crash and not after an orderly exit (the
// server exits 0 on SIGTERM), and reference only `<home>/install/current`. Crash restarts are
// bounded (D2): by the systemd unit's start limit, and under launchd, which has no such limit, by
// the server itself (apps/server/src/entry/service-state.ts CRASH_RESTART_BUDGET).
//
// Neither manager gives a service the login shell's environment, so the unit carries what the
// server needs: SHELL, which terminals start, and a PATH of the system directories plus the
// directory of the git the installing shell finds (the server runs git; a terminal's login shell
// sets up its own PATH). The installing shell's whole PATH is not copied: it can name a checkout
// (node_modules/.bin) or other session-specific directories the service must not depend on. Node
// itself comes from the closure and is never looked up on PATH.

export type Manager = "launchd-agent" | "systemd-user";

export type UnitStatus = {
  manager: Manager;
  unit: string;
  unitPath: string;
  // The manager knows the unit (a loaded LaunchAgent; a systemd unit that is not "not-found").
  registered: boolean;
  running: boolean;
  pid: number | null;
  // Linux: whether the user manager outlives logout and starts at boot (D2); null on macOS.
  linger: boolean | null;
  // The server crashed repeatedly and is no longer restarted (D2's bounded crash restart): systemd
  // hit the unit's start limit, or under launchd the server stopped itself at its crash restart
  // budget (apps/server/src/entry/service-state.ts). `cove server service start` starts it again.
  stoppedAfterCrashes: boolean;
};

// Mirrors apps/server/src/entry/service-state.ts CRASH_STOP (the server writes it).
const CRASH_STOP = join("server", "service", "crash-stop.json");

export interface ServiceBackend {
  readonly manager: Manager;
  readonly unit: string;
  readonly unitPath: string;
  // Writes the unit and makes the manager know it; starts it only when `start` is set.
  register(start: boolean): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): UnitStatus;
  // Stops the server and removes the unit; the data directory is untouched.
  unregister(): Promise<void>;
  // Whether the manager gave up restarting the server after repeated crashes at or after
  // `sinceMs` (stoppedAfterCrashes, but never an earlier episode's): a start that is definitively
  // over. `cove` waits for a started server with it (install/commands.ts waitForNewInstance).
  gaveUpSince(sinceMs: number, deadlineMs?: number): boolean;
  // The latest output of the service (the server's stderr), at most SERVICE_LOG_BYTES and
  // SERVICE_LOG_LINES, from about `sinceMs` on; null when it cannot be read. Bounded in time as
  // well: a journal that cannot answer quickly is null, never a hang.
  recentOutput(sinceMs: number, deadlineMs?: number): string | null;
}

export const SERVICE_LOG_BYTES = 64 * 1024;
export const SERVICE_LOG_LINES = 200;
const JOURNAL_TIMEOUT_MS = 5_000;

function probeTimeout(deadlineMs = Infinity): number {
  return Math.max(0, Math.min(JOURNAL_TIMEOUT_MS, deadlineMs - Date.now()));
}

// Slice before decoding and discard a partial leading line/code point. Malformed UTF-8 can
// expand to three-byte replacement characters, so also bound the final encoded output. Both
// cuts retain complete recent lines (including a bounded startup diagnostic after noisy data).
export function serviceOutputTail(bytes: Buffer, maxBytes = SERVICE_LOG_BYTES): string {
  const wholeLines = (source: Buffer): string => {
    const start = Math.max(0, source.length - maxBytes);
    let tail = source.subarray(start);
    if (start > 0) {
      const newline = tail.indexOf(10);
      tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
    }
    return tail.toString("utf8").split("\n").slice(-SERVICE_LOG_LINES).join("\n");
  };
  const decoded = wholeLines(bytes);
  return Buffer.byteLength(decoded) > maxBytes ? wholeLines(Buffer.from(decoded)) : decoded;
}

function journalOutput(args: string[], deadlineMs?: number): string | null {
  const timeout = probeTimeout(deadlineMs);
  if (timeout <= 0) return null;
  const result = spawnSync("journalctl", args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0 && result.stdout
    ? serviceOutputTail(result.stdout)
    : null;
}

// The last `maxBytes` of a file, cut to whole lines, or null when it cannot be read.
export function fileTail(path: string, maxBytes: number = SERVICE_LOG_BYTES): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    let tail = buffer;
    // Drop partial lines before decoding, including a split leading UTF-8 code point.
    if (length < size) {
      const newline = tail.indexOf(10);
      tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
    }
    return serviceOutputTail(tail);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// When the crash-stop record (CRASH_STOP) says the server stopped itself, or null.
function crashStoppedAtMs(home: string): number | null {
  try {
    const record = JSON.parse(readFileSync(join(home, CRASH_STOP), "utf8")) as {
      stoppedAtMs?: unknown;
    } | null;
    return typeof record?.stoppedAtMs === "number" ? record.stoppedAtMs : null;
  } catch {
    return null;
  }
}

// Longer than the plist's ExitTimeOut, after which launchd kills a server that does not stop.
const LAUNCHD_WAIT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

type Result = { status: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], timeout = 60_000): Result {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    // The journal read is bounded by SERVICE_LOG_*; this only keeps a runaway output finite.
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

function check(command: string, args: string[]): Result {
  const result = run(command, args);
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "not run"}): ` +
        result.stderr.trim().slice(0, 500),
    );
  return result;
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o644 });
  await rename(temporary, path);
}

const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function gitDirectory(): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter))
    if (isAbsolute(directory) && existsSync(join(directory, "git"))) return directory;
  return null;
}

export function servicePath(): string {
  const git = gitDirectory();
  return [...(git && !SYSTEM_PATH.includes(git) ? [git] : []), ...SYSTEM_PATH].join(delimiter);
}

function serviceEnvironment(layout: InstallLayout): Record<string, string> {
  return {
    COVE_HOME: layout.home,
    PATH: servicePath(),
    ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}),
  };
}

// Linux: logind keeps a lingering user's manager running without a session.
export function lingerEnabled(): boolean | null {
  if (process.platform !== "linux") return null;
  return existsSync(join("/var/lib/systemd/linger", userInfo().username));
}

export function lingerAdvice(): string {
  return (
    "linger is off: the service stops when you log out and does not start at boot. " +
    `Enable it with \`sudo loginctl enable-linger ${userInfo().username}\` (cove never runs sudo).`
  );
}

// ---- macOS LaunchAgent -------------------------------------------------------------------------

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function launchAgentPlist(layout: InstallLayout): string {
  const strings = (values: string[]) =>
    values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const environment = Object.entries(serviceEnvironment(layout))
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  const log = join(layout.logDirectory, "service.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(layout.label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(serverCommand(layout, "launchd-agent"))}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

class LaunchAgent implements ServiceBackend {
  readonly manager = "launchd-agent" as const;
  readonly unit: string;
  readonly unitPath: string;
  private readonly domain = `gui/${process.getuid?.() ?? 0}`;

  constructor(private readonly layout: InstallLayout) {
    this.unit = layout.label;
    this.unitPath = join(homedir(), "Library", "LaunchAgents", `${layout.label}.plist`);
  }

  private get target(): string {
    return `${this.domain}/${this.unit}`;
  }

  private loaded(deadlineMs?: number): Result | null {
    const timeout = probeTimeout(deadlineMs);
    if (timeout <= 0) return null;
    const result = run("/bin/launchctl", ["print", this.target], timeout);
    return result.status === 0 ? result : null;
  }

  async register(start: boolean): Promise<void> {
    await prepareServiceStart(this.layout);
    await writeAtomically(this.unitPath, launchAgentPlist(this.layout));
    if (start) await this.start();
  }

  // Bootstrapping loads the plist as it is now and starts the server (RunAtLoad); a job that is
  // already loaded is only started.
  async start(): Promise<void> {
    await prepareServiceStart(this.layout);
    if (this.loaded()) check("/bin/launchctl", ["kickstart", this.target]);
    else await this.bootstrap();
  }

  // launchd refuses to bootstrap a label while a job of that label is still being removed
  // (error 5, EIO); `bootout` returns before the removal completes, so a bootstrap right after
  // it is retried for a while.
  private async bootstrap(): Promise<void> {
    const deadline = Date.now() + LAUNCHD_WAIT_MS;
    for (;;) {
      const result = run("/bin/launchctl", ["bootstrap", this.domain, this.unitPath]);
      if (result.status === 0) return;
      if (Date.now() > deadline || this.loaded())
        throw new Error(
          `launchctl bootstrap ${this.domain} ${this.unitPath} failed (${result.status ?? "not run"}): ` +
            result.stderr.trim().slice(0, 500),
        );
      await sleep(250);
    }
  }

  // `bootout` unloads the job, so KeepAlive cannot start it again; launchd sends SIGTERM and waits
  // up to ExitTimeOut for the orderly stop. (`launchctl kill SIGTERM` would be taken for a crash:
  // a job that dies of a signal did not exit successfully.)
  async stop(): Promise<void> {
    if (!this.loaded()) return;
    check("/bin/launchctl", ["bootout", this.target]);
    // The job is gone once launchd no longer knows the label: by then the server has exited.
    const deadline = Date.now() + LAUNCHD_WAIT_MS;
    while (this.loaded()) {
      if (Date.now() > deadline) throw new Error(`launchd still has ${this.target} after bootout`);
      await sleep(250);
    }
  }

  // Unload and load again rather than `kickstart -k`, so that the restarted job also picks up a
  // plist that install rewrote (PATH, SHELL) since it was loaded.
  async restart(): Promise<void> {
    await prepareServiceStart(this.layout);
    await this.stop();
    await this.bootstrap();
  }

  status(): UnitStatus {
    const printed = this.loaded();
    const pid = printed ? /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1] : undefined;
    const state = printed ? /^\s*state = (\S+)$/m.exec(printed.stdout)?.[1] : undefined;
    return {
      manager: this.manager,
      unit: this.unit,
      unitPath: this.unitPath,
      registered: printed !== null,
      running: state === "running",
      pid: pid === undefined ? null : Number(pid),
      linger: null,
      stoppedAfterCrashes: state !== "running" && existsSync(join(this.layout.home, CRASH_STOP)),
    };
  }

  // The crash-stop record outlives the episode it reports until a start serves, so only one
  // written since `sinceMs` counts.
  gaveUpSince(sinceMs: number, deadlineMs?: number): boolean {
    const stoppedAt = crashStoppedAtMs(this.layout.home);
    if (stoppedAt === null || stoppedAt < sinceMs) return false;
    const printed = this.loaded(deadlineMs);
    // A failed/missing manager probe is unknown, never proof that it stopped.
    return printed !== null && !/^\s*state = running$/m.test(printed.stdout);
  }

  // launchd appends the server's stdout and stderr to service.log (launchAgentPlist); the
  // caller tells this start's lines by their own timestamps.
  recentOutput(_sinceMs: number): string | null {
    return fileTail(join(this.layout.logDirectory, "service.log"));
  }

  async unregister(): Promise<void> {
    await this.stop();
    await rm(this.unitPath, { force: true });
  }
}

// ---- Linux systemd user unit -------------------------------------------------------------------

// systemd's own quoting: inside double quotes a backslash and a quote are escaped; `%` starts a
// specifier everywhere, so it is doubled. `$` starts a variable only in ExecStart's arguments,
// where it is doubled too; the executable path (the first word) and Environment= values are not
// variable-expanded, so a `$$` there would stay two characters. The replacements are functions
// because a replacement string gives `$` a meaning of its own ("$$" inserts a single `$`).
function systemdWord(value: string, variables: boolean): string {
  const escaped = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%")
    .replaceAll("\n", () => "\\n");
  return `"${variables ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

// KillMode is left at its default, control-group (D2): stopping or restarting ends every process
// of the unit, including ones a terminal detached with nohup or tmux. server.impact says so.
export function systemdUnit(layout: InstallLayout): string {
  const environment = Object.entries(serviceEnvironment(layout))
    .map(([key, value]) => systemdWord(`${key}=${value}`, false))
    .join(" ");
  return `[Unit]
Description=Cove server (${layout.home.replaceAll("%", "%%")})
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${serverCommand(layout, "systemd-user")
    .map((word, index) => systemdWord(word, index > 0))
    .join(" ")}
Environment=${environment}
Restart=on-failure
RestartSec=2
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

const JOURNAL_LINES = 50;

// Whether systemd stopped restarting a failed unit because it hit the start limit (D2), from the
// unit's Result and, when needed, its journal (`journal` is read only then). When automatic
// restarts hit the limit, systemd (255 on Ubuntu 24.04) logs "Start request repeated too quickly"
// but keeps the last failure's Result (`signal`, `exit-code`); only a refused manual start
// records `start-limit-hit`. Neither the Result nor NRestarts tells that case from a unit that
// failed in a stop someone asked for after earlier crash restarts, so the journal decides: the
// start limit message must come after the unit's last start or stop. A journal that cannot be
// read claims no cause.
export function systemdGaveUp(result: string | undefined, journal: () => string | null): boolean {
  if (result === "start-limit-hit") return true;
  const lines = journal()?.split("\n");
  if (!lines) return false;
  const last = (pattern: RegExp) => lines.findLastIndex((line) => pattern.test(line));
  const limit = last(/Start request repeated too quickly/);
  return limit >= 0 && limit > last(/^(Starting|Stopping) /);
}

class SystemdUser implements ServiceBackend {
  readonly manager = "systemd-user" as const;
  readonly unit: string;
  readonly unitPath: string;

  constructor(private readonly layout: InstallLayout) {
    this.unit = layout.systemdUnit;
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    this.unitPath = join(config, "systemd", "user", layout.systemdUnit);
  }

  private systemctl(...args: string[]): Result {
    return check("systemctl", ["--user", ...args]);
  }

  private show(deadlineMs?: number): Record<string, string> {
    const timeout = probeTimeout(deadlineMs);
    if (timeout <= 0) return {};
    const result = run(
      "systemctl",
      ["--user", "show", "-p", "LoadState,ActiveState,SubState,MainPID,Result", this.unit],
      timeout,
    );
    if (result.status !== 0) return {};
    const values: Record<string, string> = {};
    for (const line of result.stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
    }
    return values;
  }

  // The unit is written where this CLI's environment says the user's units are. A manager that
  // does not look there (a different HOME or XDG_CONFIG_HOME than the manager's own) is told
  // about the file with `systemctl --user link`, which `disable` removes again.
  async register(start: boolean): Promise<void> {
    await writeAtomically(this.unitPath, systemdUnit(this.layout));
    this.systemctl("daemon-reload");
    if (this.show().LoadState === "not-found") {
      this.systemctl("link", this.unitPath);
      this.systemctl("daemon-reload");
    }
    this.systemctl("enable", this.unit);
    if (start) await this.start();
  }

  // A person's start also clears a unit that hit its start limit after repeated crashes (D2),
  // which systemd otherwise refuses to start until the interval has passed.
  async start(): Promise<void> {
    run("systemctl", ["--user", "reset-failed", this.unit]);
    this.systemctl("start", this.unit);
  }

  async stop(): Promise<void> {
    this.systemctl("stop", this.unit);
  }

  async restart(): Promise<void> {
    this.systemctl("daemon-reload");
    run("systemctl", ["--user", "reset-failed", this.unit]);
    this.systemctl("restart", this.unit);
  }

  status(): UnitStatus {
    const values = this.show();
    const pid = Number(values.MainPID);
    return {
      manager: this.manager,
      unit: this.unit,
      unitPath: this.unitPath,
      registered: values.LoadState !== undefined && values.LoadState !== "not-found",
      running: values.ActiveState === "active" && values.SubState === "running",
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      linger: lingerEnabled(),
      stoppedAfterCrashes:
        values.ActiveState === "failed" && systemdGaveUp(values.Result, () => this.journal()),
    };
  }

  // start() and restart() reset a failed unit first, so a unit failed at its start limit now
  // failed during this start.
  gaveUpSince(_sinceMs: number, deadlineMs?: number): boolean {
    const values = this.show(deadlineMs);
    return (
      values.ActiveState === "failed" &&
      systemdGaveUp(values.Result, () => this.journal(deadlineMs))
    );
  }

  // The unit's journal from `sinceMs` (whole seconds, so a little earlier; the caller filters by
  // the lines' own timestamps), bounded in lines and time.
  recentOutput(sinceMs: number, deadlineMs?: number): string | null {
    return journalOutput(
      [
        ...["--user", "-u", this.unit, "--since", `@${Math.floor(sinceMs / 1000)}`],
        ...["-n", String(SERVICE_LOG_LINES), "-o", "cat", "--no-pager"],
      ],
      deadlineMs,
    );
  }

  // The unit's latest journal messages (systemd's own lines among them), or null when the journal
  // cannot be read.
  private journal(deadlineMs?: number): string | null {
    return journalOutput(
      [...["--user", "-u", this.unit, "-n", String(JOURNAL_LINES)], ...["-o", "cat", "--no-pager"]],
      deadlineMs,
    );
  }

  async unregister(): Promise<void> {
    // Disabling also removes `link` registrations and reloads the manager. Stop first while
    // its definition is still discoverable; `disable --now` can otherwise fail to find it.
    if (this.status().registered) {
      await this.stop();
      this.systemctl("disable", this.unit);
    }
    await rm(this.unitPath, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "reset-failed", this.unit]);
  }
}

// The service manager of this host, or why there is none (D2: a host without a systemd user
// manager, such as a container, keeps the foreground `cove server start`).
export function serviceBackend(
  layout: InstallLayout,
): { backend: ServiceBackend } | { unavailable: string } {
  if (process.platform === "darwin") {
    const domain = run("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 0}`]);
    if (domain.status !== 0)
      return { unavailable: "there is no launchd gui domain for this user (no login session)" };
    return { backend: new LaunchAgent(layout) };
  }
  if (process.platform === "linux") {
    const manager = run("systemctl", ["--user", "show-environment"]);
    if (manager.status !== 0)
      return {
        unavailable:
          "there is no systemd user manager for this user; use `cove server start` in the foreground",
      };
    return { backend: new SystemdUser(layout) };
  }
  return { unavailable: `${process.platform} has no supported service manager` };
}
