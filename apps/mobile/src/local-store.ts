import { ActionError } from "./action-error.js";
import { z } from "zod";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import { PortSchema, TsnetNodeIdSchema } from "@cove/protocol/auth";
import { OperationRecordSchema } from "@cove/protocol/rpc";
import { utf8 } from "./codec.js";

export const ProfileSchema = z.object({
  id: z.string().uuid(),
  serverId: OpaqueIdSchema,
  label: z.string().min(1).max(64),
  peerID: TsnetNodeIdSchema,
  port: PortSchema,
  state: z.enum(["pending", "ready", "forgetting"]),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const JournalSchema = z.object({
  profileId: z.string().uuid(),
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  operationId: OpaqueIdSchema,
  method: z.string().min(1).max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().min(1).max(160),
  state: z.enum(["pending", "unknown", "not-sent", "observed"]),
  observation: z.enum(["unqueried", "record", "not-found", "unavailable"]),
  createdAt: z.number().int().nonnegative(),
  record: OperationRecordSchema.optional(),
});
export type Journal = z.infer<typeof JournalSchema>;
export type SqlValue = string | number | null;
export interface SQL {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: SqlValue[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
export interface Database {
  read: SQL;
  transaction<T>(body: (tx: SQL) => Promise<T>): Promise<T>;
}
const MAX_LEDGER_BYTES = 1024 * 1024;
export const credentialKey = (profile: Pick<Profile, "id">): string => `cove.mobile.${profile.id}`;

/** One private database, one writer. No credential or replayable request is stored here. */
export class LocalStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: Database) {}
  private serial<T>(body: () => Promise<T>): Promise<T> {
    const next = this.tail.then(body);
    this.tail = next.catch(() => {});
    return next;
  }
  async initialize(): Promise<void> {
    await this.db.read.execAsync(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    // A broken record is an error, never an empty installation or permission to replay.
    await this.profiles();
    await this.operations();
  }
  async profiles(): Promise<Profile[]> {
    await this.tail;
    const rows = await this.db.read.getAllAsync<{ payload: string }>(
      "SELECT payload FROM profiles ORDER BY rowid",
    );
    if (rows.length > 64) throw new ActionError("Profile capacity exceeded");
    return rows.map(({ payload }) => ProfileSchema.parse(JSON.parse(payload)));
  }
  async operations(): Promise<Journal[]> {
    await this.tail;
    const rows = await this.db.read.getAllAsync<{ payload: string }>(
      "SELECT payload FROM operations ORDER BY rowid DESC",
    );
    if (
      rows.length > 256 ||
      rows.reduce((n, r) => n + utf8.encode(r.payload).byteLength, 0) > MAX_LEDGER_BYTES
    )
      throw new ActionError("Operation capacity exceeded");
    return rows.map(({ payload }) => JournalSchema.parse(JSON.parse(payload)));
  }
  putProfile(input: Profile): Promise<void> {
    const row = ProfileSchema.parse(input);
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        const rows = await tx.getAllAsync<{ id: string }>("SELECT id FROM profiles");
        if (!rows.some((v) => v.id === row.id) && rows.length >= 64)
          throw new ActionError("Profile capacity reached");
        await tx.runAsync(
          "INSERT OR REPLACE INTO profiles(id,payload) VALUES(?,?)",
          row.id,
          JSON.stringify(row),
        );
      }),
    );
  }
  removeProfile(id: string): Promise<void> {
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        // Keep journal references even after forgetting credentials; they must never be rebound
        // to a fresh principal's pairing just because serverId matches.
        await tx.runAsync("DELETE FROM profiles WHERE id=?", id);
      }),
    );
  }
  putOperation(input: Journal, admission = false): Promise<void> {
    const row = JournalSchema.parse(input);
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        const rows = await tx.getAllAsync<{ id: string; payload: string }>(
          "SELECT id,payload FROM operations",
        );
        const previous = rows.find((v) => v.id === row.operationId);
        if (admission && previous) throw new ActionError("Operation ID already admitted");
        if (!previous && rows.length >= 256)
          throw new ActionError("Operation capacity reached; acknowledge completed records");
        if (previous) {
          const old = JournalSchema.parse(JSON.parse(previous.payload));
          if (
            old.digest !== row.digest ||
            old.profileId !== row.profileId ||
            old.serverId !== row.serverId ||
            old.method !== row.method
          )
            throw new ActionError("Operation identity mismatch");
        }
        const payload = JSON.stringify(row);
        const bytes = rows
          .filter((v) => v !== previous)
          .reduce((n, v) => n + utf8.encode(v.payload).byteLength, utf8.encode(payload).byteLength);
        if (bytes > MAX_LEDGER_BYTES) throw new ActionError("Operation storage capacity reached");
        await tx.runAsync(
          "INSERT OR REPLACE INTO operations(id,payload) VALUES(?,?)",
          row.operationId,
          payload,
        );
      }),
    );
  }
  acknowledge(id: string): Promise<void> {
    return this.serial(() =>
      this.db.transaction(async (tx) => {
        const rows = await tx.getAllAsync<{ payload: string }>(
          "SELECT payload FROM operations WHERE id=?",
          id,
        );
        const row = rows[0] ? JournalSchema.parse(JSON.parse(rows[0].payload)) : undefined;
        if (
          row &&
          row.state !== "not-sent" &&
          !(
            row.state === "observed" &&
            row.record &&
            ["succeeded", "failed", "cancelled"].includes(row.record.state)
          )
        )
          throw new ActionError("Unresolved operation must remain available");
        await tx.runAsync("DELETE FROM operations WHERE id=?", id);
      }),
    );
  }
}
