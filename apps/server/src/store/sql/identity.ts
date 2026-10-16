import { randomUUID } from "node:crypto";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import { statement, type Connection } from "./statements.js";

export type StoredIdentity = { serverId: string; principalId: string; created: boolean };

// The persistent identity (identity.ts) and the relay instance rows.
export const identityOperations = {
  // Reads the identity, creating it (with the configuration row) on the first open.
  "identity.loadOrCreate": (db: Connection, args: { at: number }): StoredIdentity => {
    const row = statement(
      db,
      "SELECT server_id, local_principal_id FROM server_identity WHERE id = 1",
    ).get() as { server_id: string; local_principal_id: string } | undefined;
    if (row) {
      if (
        !OpaqueIdSchema.safeParse(row.server_id).success ||
        !OpaqueIdSchema.safeParse(row.local_principal_id).success
      )
        throw new Error("Stored server identity is invalid");
      return { serverId: row.server_id, principalId: row.local_principal_id, created: false };
    }
    const identity = { serverId: randomUUID(), principalId: `local-${randomUUID()}` };
    statement(
      db,
      "INSERT INTO principals (principal_id, kind, created_at_ms) VALUES (?, 'local-owner', ?)",
    ).run(identity.principalId, args.at);
    statement(
      db,
      "INSERT INTO server_identity (id, server_id, local_principal_id, created_at_ms) VALUES (1, ?, ?, ?)",
    ).run(identity.serverId, identity.principalId, args.at);
    statement(
      db,
      "INSERT INTO config (id, revision, workspace_root, updated_at_ms) VALUES (1, 0, NULL, ?)",
    ).run(args.at);
    return { ...identity, created: true };
  },

  "identity.recordStart": (db: Connection, args: { relayInstanceId: string; at: number }): void => {
    statement(
      db,
      "INSERT INTO relay_instances (relay_instance_id, started_at_ms) VALUES (?, ?)",
    ).run(args.relayInstanceId, args.at);
  },

  "identity.isRecorded": (db: Connection, args: { relayInstanceId: string }): boolean =>
    statement(db, "SELECT 1 FROM relay_instances WHERE relay_instance_id = ?").get(
      args.relayInstanceId,
    ) !== undefined,

  "identity.recordStop": (db: Connection, args: { relayInstanceId: string; at: number }): void => {
    statement(
      db,
      "UPDATE relay_instances SET stopped_at_ms = ? WHERE relay_instance_id = ? AND stopped_at_ms IS NULL",
    ).run(args.at, args.relayInstanceId);
  },
};
