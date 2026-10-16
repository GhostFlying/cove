import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OperationReceiptKey } from "@cove/protocol/rpc";
import type { Store } from "./database.js";
import type { ProcessRow } from "./sql/processes.js";

// Durable attribution of subprocesses an operation started (migration 001, operation_processes).
// T3b runs each Git command in a process group of its own and records it here before waiting for
// it; after a crash the restarted server must refuse operation.continue/abandon while that exact
// process may still run (S8). A PID alone is not proof: PIDs are reused. A process is identified by
// its PID plus its operating-system start identity, which a reused PID does not share.

export type ProcessRecord = {
  processId: string;
  operation: OperationReceiptKey;
  pid: number;
  pgid: number;
  startIdentity: string;
  startedByInstanceId: string;
  startedAtMs: number;
  endedAtMs: number | null;
};

// alive: the recorded process still runs (same PID and start identity).
// ended: it ended, and no member of its process group can still be running.
// unverifiable: liveness cannot be proven either way (its identity cannot be read, or the leader
//   ended while its process group still has members); callers treat it as possibly alive.
export type ProcessLiveness = "alive" | "ended" | "unverifiable";

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((done) =>
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      (error, stdout) => done(error ? null : stdout.trim()),
    ),
  );
}

// macOS start time with microseconds: kinfo_proc.kp_proc.p_starttime from sysctl
// {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid}. Neither `ps` (lstart has one-second resolution, and
// XNU may reuse a PID within a second) nor the sysctl(8) tool (no kern.proc.pid node) exposes it,
// and Node has no API for another process; /usr/bin/perl's syscall(2) calls __sysctl (202)
// without a native dependency. The struct layout is checked (size and p_pid) before use. Exit
// status 1: no such process; anything else: unreadable.
const DARWIN_START_TIME = String.raw`
my $pid = shift;
my $mib = pack("i4", 1, 14, 1, $pid);
my $buf = "\0" x 4096;
my $len = pack("Q", length $buf);
syscall(202, $mib, 4, $buf, $len, 0, 0) == 0 or exit 2;
my $size = unpack("Q", $len);
exit 1 if $size == 0;
exit 3 if $size < 648 || unpack("l", substr($buf, 40, 4)) != $pid;
my ($sec, $usec) = unpack("q l", $buf);
printf("%d.%06d\n", $sec, $usec);
`;

// This boot's identity: `<platform>:<boot ID>`, or null when it cannot be read.
export async function bootIdentity(): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const boot = await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
    return boot ? `darwin:${boot}` : null;
  }
  return null;
}

// The start identity of a running process, `<boot identity>:<start time>`, or null when it does
// not exist or cannot be read. Linux: start time in clock ticks since boot (/proc/<pid>/stat field
// 22). macOS: p_starttime with microseconds (DARWIN_START_TIME).
export async function processStartIdentity(pid: number): Promise<string | null> {
  const identity = await readStartIdentity(pid);
  // Only identities in the current format are handed out (see parseStartIdentity).
  return identity !== null && parseStartIdentity(identity) !== null ? identity : null;
}

async function readStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const boot = await bootIdentity();
  if (boot === null) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 2 (comm) may contain spaces and parentheses; fields after the last ')' are fixed.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const start = fields[19];
      return start && /^\d+$/.test(start) ? `${boot}:${start}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const start = await run("/usr/bin/perl", ["-e", DARWIN_START_TIME, String(pid)]);
    return start && /^\d+\.\d{6}$/.test(start) ? `${boot}:${start}` : null;
  }
  return null;
}

// A start identity in the current format, split into its parts; null for anything else (an older
// format, a malformed value, or a format of a later build). Only parsed identities support the
// reboot shortcut in ProcessLedger.liveness; anything else is judged conservatively.
//   linux:<boot_id UUID>:<start ticks>
//   darwin:<kern.bootsessionuuid UUID>:<p_starttime seconds>.<microseconds, 6 digits>
// The earlier macOS format `darwin:<kern.boottime seconds>:<ps lstart text>` (second resolution)
// does not parse.
// A Map, not an object literal: the platform field comes from stored text, and a lookup such as
// `__proto__` or `constructor` must miss rather than find an inherited property.
const IDENTITY_FORMATS: ReadonlyMap<string, { boot: RegExp; start: RegExp }> = new Map([
  ["linux", { boot: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, start: /^\d+$/ }],
  ["darwin", { boot: /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/, start: /^\d+\.\d{6}$/ }],
]);

export type ParsedStartIdentity = { platform: string; boot: string; start: string };

export function parseStartIdentity(identity: string): ParsedStartIdentity | null {
  const [platform, boot, start, ...rest] = identity.split(":");
  const format = platform === undefined ? undefined : IDENTITY_FORMATS.get(platform);
  if (!format || boot === undefined || start === undefined || rest.length > 0) return null;
  return format.boot.test(boot) && format.start.test(start)
    ? { platform: platform!, boot, start }
    : null;
}

// A boot identity (`<platform>:<boot ID>`) in the current format, or null.
function parseBootIdentity(identity: string | null): { platform: string; boot: string } | null {
  if (identity === null) return null;
  const [platform, boot, ...rest] = identity.split(":");
  const format = platform === undefined ? undefined : IDENTITY_FORMATS.get(platform);
  return format && boot !== undefined && rest.length === 0 && format.boot.test(boot)
    ? { platform: platform!, boot }
    : null;
}

function exists(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: something runs under that ID that this user cannot signal.
    return code === "EPERM" ? true : null;
  }
}

function toRecord(row: ProcessRow): ProcessRecord {
  return {
    processId: row.process_id,
    operation: {
      serverId: row.operation_server_id,
      principalId: row.operation_principal_id,
      operationId: row.operation_id,
    },
    pid: row.pid,
    pgid: row.pgid,
    startIdentity: row.start_identity,
    startedByInstanceId: row.started_by_instance_id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
  };
}

// The SQL is in store/sql/processes.ts.
export class ProcessLedger {
  constructor(
    private readonly store: Store,
    private readonly relayInstanceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  // Records a started process before the caller waits for it. The caller reads startIdentity
  // (processStartIdentity) right after spawning, while it holds the child, so the PID cannot have
  // been reused yet; a process whose identity cannot be read must not be started for an operation
  // that a restart has to reason about. The record is durable when the returned promise resolves;
  // the caller must not wait for the process before that.
  async record(
    operation: OperationReceiptKey,
    process: { pid: number; pgid: number; startIdentity: string },
  ): Promise<ProcessRecord> {
    // A record must be comparable after a restart; an identity this build cannot parse would leave
    // the operation unverifiable until both the PID and the group are gone.
    if (parseStartIdentity(process.startIdentity) === null)
      throw new Error("The process start identity is not in the current format");
    const processId = randomUUID();
    const at = this.now();
    await this.store.call("processes.record", {
      processId,
      operation: { ...operation },
      pid: process.pid,
      pgid: process.pgid,
      startIdentity: process.startIdentity,
      relayInstanceId: this.relayInstanceId,
      at,
    });
    return {
      processId,
      operation: { ...operation },
      ...process,
      startedByInstanceId: this.relayInstanceId,
      startedAtMs: at,
      endedAtMs: null,
    };
  }

  // Processes of the operation not yet observed to have ended.
  async open(operation: OperationReceiptKey): Promise<ProcessRecord[]> {
    return (await this.store.call("processes.open", { operation: { ...operation } })).map(toRecord);
  }

  markEnded(processId: string): Promise<void> {
    return this.store.call("processes.markEnded", { processId, at: this.now() });
  }

  // Whether a recorded process may still run. Its process group is checked as well: a Git wrapper
  // can leave children in the group after the leader ended, and the group ID cannot be reused while
  // any member exists.
  static async liveness(record: ProcessRecord): Promise<ProcessLiveness> {
    const recorded = parseStartIdentity(record.startIdentity);
    if (recorded === null) {
      // An identity this build cannot interpret (an older or later format, or malformed) cannot
      // be compared, so neither a reboot nor a reused PID can be proven. Only the absence of both
      // the PID and its group proves the end; anything else may still be the recorded process.
      const leader = exists(record.pid);
      return leader === false && exists(-record.pgid) === false ? "ended" : "unverifiable";
    }
    // Recorded during another boot: the process and every member of its group ended with that
    // boot. The current numeric PID and PGID belong to unrelated processes, so they are not probed.
    // Only applied when the current boot identity is readable and in the same platform's format.
    const current = parseBootIdentity(await bootIdentity());
    if (
      current !== null &&
      current.platform === recorded.platform &&
      current.boot !== recorded.boot
    )
      return "ended";
    const leader = exists(record.pid);
    if (leader === null) return "unverifiable";
    if (leader) {
      const identity = await processStartIdentity(record.pid);
      // Unreadable identity: either it ended in between, or it cannot be proven either way.
      if (identity === null)
        return exists(record.pid) === false ? groupState(record) : "unverifiable";
      if (identity === record.startIdentity) return "alive";
    }
    // The leader ended (or its PID now belongs to another process).
    return groupState(record);
  }

  // Checks every open process of the operation; records the ended ones. Returns the overall state:
  // alive or unverifiable when any process may still run.
  async check(operation: OperationReceiptKey): Promise<ProcessLiveness> {
    let overall: ProcessLiveness = "ended";
    for (const record of await this.open(operation)) {
      const state = await ProcessLedger.liveness(record);
      if (state === "ended") await this.markEnded(record.processId);
      else if (state === "alive" || overall === "ended") overall = state;
    }
    return overall;
  }
}

function groupState(record: ProcessRecord): ProcessLiveness {
  // A process group ID is not reused while the group has members. A group that still answers holds
  // members of the recorded group, or, if that group emptied, a new group whose leader reused the
  // ID; the two cannot be told apart, so the process may still run.
  const group = exists(-record.pgid);
  if (group === false) return "ended";
  return "unverifiable";
}
