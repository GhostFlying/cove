import type { DomainError } from "@cove/protocol/errors";
import type { OperationResultData } from "../../operations/receipt-records.js";
import {
  nextEntryConfig,
  type EntryConfigSetArgs,
  type EntryConfigState,
} from "../config-rules.js";
import { statement, type Connection } from "./statements.js";

// Entry configuration and service start records (m2 T3; migration 007).

type EntryRow = {
  revision: number;
  business_port: number | null;
  pairing_port: number | null;
  ssh_target: string | null;
  tsnet_hostname: string | null;
};

function read(db: Connection): EntryConfigState {
  const row = statement(
    db,
    `SELECT revision, business_port, pairing_port, ssh_target, tsnet_hostname
     FROM entry_config WHERE id = 1`,
  ).get() as EntryRow | undefined;
  if (!row) throw new Error("Entry configuration is not initialized");
  return {
    revision: row.revision,
    businessPort: row.business_port,
    pairingPort: row.pairing_port,
    sshTarget: row.ssh_target,
    tsnetHostname: row.tsnet_hostname,
  };
}

function write(db: Connection, next: EntryConfigState, at: number): void {
  const changed = statement(
    db,
    `UPDATE entry_config SET revision = ?, business_port = ?, pairing_port = ?, ssh_target = ?,
     tsnet_hostname = ?, updated_at_ms = ? WHERE id = 1`,
  ).run(
    next.revision,
    next.businessPort,
    next.pairingPort,
    next.sshTarget,
    next.tsnetHostname,
    at,
  ).changes;
  if (changed !== 1) throw new Error("Entry configuration is not initialized");
}

// The previous relay instance of this database, as the start reason needs it (service-start.ts).
export type PreviousStart = {
  // Whether it recorded an orderly stop (identity.recordStop). One that did not crashed or was
  // killed: it cannot still be running, since the new instance holds the database lock.
  stopped: boolean;
  // The host boot it ran in; null for an instance of a build before migration 007, or a host
  // whose boot ID could not be read.
  bootId: string | null;
};

export type ServiceStartRecord = {
  relayInstanceId: string;
  manager: "systemd-user" | "launchd-agent" | "foreground";
  bootId: string | null;
  reason: "manual" | "crash-restart" | "boot" | "login" | "unknown";
};

export type RecentStart = {
  reason: ServiceStartRecord["reason"] | null;
  startedAtMs: number;
};

export type LiveRunImpact = {
  run: { serverId: string; relayInstanceId: string; runId: string };
  taskId: string | null;
  tabId: string | null;
};

export const entryOperations = {
  "entry.read": (db: Connection): EntryConfigState => read(db),

  // `cove server install` (D3): fixes the business and pairing ports that are not configured yet,
  // through the bootstrap init mode while no server runs (entry/main.ts). A configured port is
  // never replaced. Returns the configuration after the change.
  "entry.initializePorts": (
    db: Connection,
    args: { businessPort: number; pairingPort: number; at: number },
  ): EntryConfigState => {
    const current = read(db);
    const next = {
      ...current,
      businessPort: current.businessPort ?? args.businessPort,
      pairingPort: current.pairingPort ?? args.pairingPort,
    };
    if (next.businessPort === current.businessPort && next.pairingPort === current.pairingPort)
      return current;
    if (next.businessPort === next.pairingPort)
      throw new Error("The business and pairing ports must differ");
    next.revision = current.revision + 1;
    write(db, next, args.at);
    return next;
  },

  // The most recent relay instance other than `relayInstanceId` (insertion order, which does not
  // depend on the wall clock), or null on the first start.
  "service.previousStart": (
    db: Connection,
    args: { relayInstanceId: string },
  ): PreviousStart | null => {
    const row = statement(
      db,
      `SELECT r.stopped_at_ms AS stopped_at_ms, s.boot_id AS boot_id
       FROM relay_instances r LEFT JOIN service_starts s USING (relay_instance_id)
       WHERE r.relay_instance_id <> ? ORDER BY r.rowid DESC LIMIT 1`,
    ).get(args.relayInstanceId) as
      { stopped_at_ms: number | null; boot_id: string | null } | undefined;
    return row ? { stopped: row.stopped_at_ms !== null, bootId: row.boot_id } : null;
  },

  // The `limit` most recent relay instances, newest first, with their start reason (null for an
  // instance of a build before migration 007) and start time: what the crash restart budget counts
  // (service-state.ts crashRestartsOverBudget).
  "service.recentStarts": (db: Connection, args: { limit: number }): RecentStart[] =>
    (
      statement(
        db,
        `SELECT s.reason AS reason, r.started_at_ms AS started_at_ms
         FROM relay_instances r LEFT JOIN service_starts s USING (relay_instance_id)
         ORDER BY r.rowid DESC LIMIT ?`,
      ).all(args.limit) as { reason: ServiceStartRecord["reason"] | null; started_at_ms: number }[]
    ).map((row) => ({ reason: row.reason, startedAtMs: row.started_at_ms })),

  "service.recordStart": (db: Connection, args: ServiceStartRecord): void => {
    statement(
      db,
      `INSERT INTO service_starts (relay_instance_id, manager, boot_id, reason)
       VALUES (?, ?, ?, ?)`,
    ).run(args.relayInstanceId, args.manager, args.bootId, args.reason);
  },

  // The live runs of an instance with the task and tab they belong to (server.impact, S2): what an
  // orderly stop of this instance ends.
  "service.liveRuns": (db: Connection, args: { relayInstanceId: string }): LiveRunImpact[] =>
    (
      statement(
        db,
        `SELECT r.server_id, r.relay_instance_id, r.run_id, r.tab_id, t.task_id
         FROM runs r LEFT JOIN tabs t ON t.tab_id = r.tab_id
         WHERE r.relay_instance_id = ? AND r.lifecycle IN ('starting', 'running')
         ORDER BY r.run_seq`,
      ).all(args.relayInstanceId) as {
        server_id: string;
        relay_instance_id: string;
        run_id: string;
        tab_id: string | null;
        task_id: string | null;
      }[]
    ).map((row) => ({
      run: { serverId: row.server_id, relayInstanceId: row.relay_instance_id, runId: row.run_id },
      taskId: row.task_id,
      tabId: row.tab_id,
    })),
};

// Database writes applied inside receipts.write (store/sql/receipts.ts), in the same transaction
// as the receipt.
export const entryWrites = {
  "entry.set": (
    db: Connection,
    args: EntryConfigSetArgs & { at: number },
  ): { result: OperationResultData } | { error: DomainError } => {
    const applied = nextEntryConfig(read(db), args);
    if ("error" in applied) return applied;
    write(db, applied.next, args.at);
    return { result: applied.result };
  },
};
