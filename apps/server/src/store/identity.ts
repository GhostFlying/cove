import { randomUUID } from "node:crypto";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import type { Store } from "./database.js";

export type ServerIdentity = {
  readonly serverId: string;
  // The durable local owner principal (m1 "操作身份跨重启"); it does not change between starts.
  readonly principalId: string;
};

// Reads the persistent identity, creating it on the first start or `cove server init` (D7).
// serverId names the operation namespace and must never change for an existing database.
export function loadOrCreateIdentity(
  store: Store,
  now: () => number = Date.now,
): ServerIdentity & { created: boolean } {
  return store.transaction(() => {
    const row = store.db
      .prepare("SELECT server_id, local_principal_id FROM server_identity WHERE id = 1")
      .get() as { server_id: string; local_principal_id: string } | undefined;
    if (row) {
      if (
        !OpaqueIdSchema.safeParse(row.server_id).success ||
        !OpaqueIdSchema.safeParse(row.local_principal_id).success
      )
        throw new Error("Stored server identity is invalid");
      return { serverId: row.server_id, principalId: row.local_principal_id, created: false };
    }
    const at = now();
    const identity = { serverId: randomUUID(), principalId: `local-${randomUUID()}` };
    store.db
      .prepare(
        "INSERT INTO principals (principal_id, kind, created_at_ms) VALUES (?, 'local-owner', ?)",
      )
      .run(identity.principalId, at);
    store.db
      .prepare(
        "INSERT INTO server_identity (id, server_id, local_principal_id, created_at_ms) VALUES (1, ?, ?, ?)",
      )
      .run(identity.serverId, identity.principalId, at);
    store.db
      .prepare(
        "INSERT INTO config (id, revision, workspace_root, updated_at_ms) VALUES (1, 0, NULL, ?)",
      )
      .run(at);
    return { ...identity, created: true };
  });
}

// Records a new relay instance. Each start has a fresh relayInstanceId; the row lets later
// starts tell an orderly stop (stopped_at_ms set) from a crash.
export function recordInstanceStart(store: Store, relayInstanceId: string, now: number): void {
  store.transaction(() => {
    store.db
      .prepare("INSERT INTO relay_instances (relay_instance_id, started_at_ms) VALUES (?, ?)")
      .run(relayInstanceId, now);
  });
}

export function recordInstanceStop(store: Store, relayInstanceId: string, now: number): void {
  store.transaction(() => {
    store.db
      .prepare(
        "UPDATE relay_instances SET stopped_at_ms = ? WHERE relay_instance_id = ? AND stopped_at_ms IS NULL",
      )
      .run(now, relayInstanceId);
  });
}
