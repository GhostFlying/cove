import type { FinalStoreCall, Store } from "./database.js";

export type ServerIdentity = {
  readonly serverId: string;
  // The durable local owner principal (m1 "操作身份跨重启"); it does not change between starts.
  readonly principalId: string;
};

// Reads the persistent identity, creating it on the first start or `cove server init` (D7).
// serverId names the operation namespace and must never change for an existing database.
export async function loadOrCreateIdentity(
  store: Store,
  now: () => number = Date.now,
): Promise<ServerIdentity & { created: boolean }> {
  return store.call("identity.loadOrCreate", { at: now() });
}

// Records a new relay instance. Each start has a fresh relayInstanceId; the row lets later
// starts tell an orderly stop (stopped_at_ms set) from a crash.
export function recordInstanceStart(
  store: Store,
  relayInstanceId: string,
  now: number,
): Promise<void> {
  return store.call("identity.recordStart", { relayInstanceId, at: now });
}

// Whether this database recorded the relay instance (any start of this data directory's server).
export function isRecordedInstance(store: Store, relayInstanceId: string): Promise<boolean> {
  return store.call("identity.isRecorded", { relayInstanceId });
}

export function recordInstanceStop(
  store: Store,
  relayInstanceId: string,
  now: number,
): Promise<void> {
  return store.call("identity.recordStop", { relayInstanceId, at: now });
}

// The instance stop record as a final call of Store.close (see RunLog.stoppedWithServerCall).
export function instanceStopCall(
  relayInstanceId: string,
  now: number,
): Extract<FinalStoreCall, { operation: "identity.recordStop" }> {
  return { operation: "identity.recordStop", args: { relayInstanceId, at: now } };
}
