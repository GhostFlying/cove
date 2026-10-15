import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OperationReceiptKey } from "@cove/protocol/rpc";
import type { Store } from "./database.js";

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

// The start identity of a running process, or null when it does not exist or cannot be read.
// Linux: boot ID plus the start time in clock ticks since boot (/proc/<pid>/stat field 22).
// macOS: boot time plus `ps` start time (UTC, one-second resolution; a PID is not reused within
// the same second in practice).
export async function processStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const [boot, stat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      // Field 2 (comm) may contain spaces and parentheses; fields after the last ')' are fixed.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const start = fields[19];
      return start && /^\d+$/.test(start) ? `linux:${boot.trim()}:${start}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const [boot, start] = await Promise.all([
      run("/usr/sbin/sysctl", ["-n", "kern.boottime"]),
      run("/bin/ps", ["-o", "lstart=", "-p", String(pid)]),
    ]);
    const bootSeconds = boot?.match(/sec = (\d+)/)?.[1];
    return bootSeconds && start ? `darwin:${bootSeconds}:${start.replace(/\s+/g, " ")}` : null;
  }
  return null;
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

type Row = {
  process_id: string;
  operation_server_id: string;
  operation_principal_id: string;
  operation_id: string;
  pid: number;
  pgid: number;
  start_identity: string;
  started_by_instance_id: string;
  started_at_ms: number;
  ended_at_ms: number | null;
};

function toRecord(row: Row): ProcessRecord {
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

export class ProcessLedger {
  private readonly statements;
  constructor(
    private readonly store: Store,
    private readonly relayInstanceId: string,
    private readonly now: () => number = Date.now,
  ) {
    const db = store.db;
    this.statements = {
      insert: db.prepare(
        `INSERT INTO operation_processes (process_id, operation_server_id, operation_principal_id,
           operation_id, pid, pgid, start_identity, started_by_instance_id, started_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      open: db.prepare(
        `SELECT * FROM operation_processes
         WHERE operation_server_id = ? AND operation_principal_id = ? AND operation_id = ?
           AND ended_at_ms IS NULL
         ORDER BY started_at_ms, process_id`,
      ),
      ended: db.prepare(
        `UPDATE operation_processes SET ended_at_ms = ? WHERE process_id = ? AND ended_at_ms IS NULL`,
      ),
    };
  }

  // Records a started process before the caller waits for it. The caller reads startIdentity
  // (processStartIdentity) right after spawning, while it holds the child, so the PID cannot have
  // been reused yet; a process whose identity cannot be read must not be started for an operation
  // that a restart has to reason about.
  record(
    operation: OperationReceiptKey,
    process: { pid: number; pgid: number; startIdentity: string },
  ): ProcessRecord {
    const processId = randomUUID();
    const at = this.now();
    this.store.transaction(() =>
      this.statements.insert.run(
        processId,
        operation.serverId,
        operation.principalId,
        operation.operationId,
        process.pid,
        process.pgid,
        process.startIdentity,
        this.relayInstanceId,
        at,
      ),
    );
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
  open(operation: OperationReceiptKey): ProcessRecord[] {
    return (
      this.statements.open.all(
        operation.serverId,
        operation.principalId,
        operation.operationId,
      ) as Row[]
    ).map(toRecord);
  }

  markEnded(processId: string): void {
    this.store.transaction(() => this.statements.ended.run(this.now(), processId));
  }

  // Whether a recorded process may still run. Its process group is checked as well: a Git wrapper
  // can leave children in the group after the leader ended, and the group ID cannot be reused while
  // any member exists.
  static async liveness(record: ProcessRecord): Promise<ProcessLiveness> {
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
    for (const record of this.open(operation)) {
      const state = await ProcessLedger.liveness(record);
      if (state === "ended") this.markEnded(record.processId);
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
