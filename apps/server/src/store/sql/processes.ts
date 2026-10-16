import type { OperationReceiptKey } from "@cove/protocol/rpc";
import { statement, type Connection } from "./statements.js";

export type ProcessRow = {
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

// Operation process ownership rows (migration 001); see store/processes.ts.
export const processOperations = {
  "processes.record": (
    db: Connection,
    args: {
      processId: string;
      operation: OperationReceiptKey;
      pid: number;
      pgid: number;
      startIdentity: string;
      relayInstanceId: string;
      at: number;
    },
  ): void => {
    statement(
      db,
      `INSERT INTO operation_processes (process_id, operation_server_id, operation_principal_id,
         operation_id, pid, pgid, start_identity, started_by_instance_id, started_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.processId,
      args.operation.serverId,
      args.operation.principalId,
      args.operation.operationId,
      args.pid,
      args.pgid,
      args.startIdentity,
      args.relayInstanceId,
      args.at,
    );
  },

  "processes.open": (db: Connection, args: { operation: OperationReceiptKey }): ProcessRow[] =>
    statement(
      db,
      `SELECT * FROM operation_processes
       WHERE operation_server_id = ? AND operation_principal_id = ? AND operation_id = ?
         AND ended_at_ms IS NULL
       ORDER BY started_at_ms, process_id`,
    ).all(
      args.operation.serverId,
      args.operation.principalId,
      args.operation.operationId,
    ) as ProcessRow[],

  "processes.markEnded": (db: Connection, args: { processId: string; at: number }): void => {
    statement(
      db,
      "UPDATE operation_processes SET ended_at_ms = ? WHERE process_id = ? AND ended_at_ms IS NULL",
    ).run(args.at, args.processId);
  },
};
