import { z } from "zod";
import { EntryRecordSchema } from "./auth.js";
import { OpaqueIdSchema, SequenceSchema } from "./identity.js";
import { RunStatusSchema } from "./pipe.js";
import { OperationRecordSchema } from "./rpc-methods.js";
import {
  ConfigRecordSchema,
  RepoRecordSchema,
  RunHistoryRecordSchema,
  TabRecordSchema,
  TaskRecordSchema,
} from "./workspace.js";

// Business cursors have no relationship to PTY output seq/controlEpoch. They are valid only
// inside one publication generation, and only for the exact normalized kind filter.
export const BUSINESS_EVENT_CAPABILITY = "business-events-v1";
export const BUSINESS_EVENT_PATH = "/events";
export const BUSINESS_KINDS = [
  "repo",
  "task",
  "tab",
  "run",
  "operation",
  "config",
  "runtime",
] as const;
export const BusinessKindSchema = z.enum(BUSINESS_KINDS);
export type BusinessKind = z.infer<typeof BusinessKindSchema>;
export const BUSINESS_LIMITS = Object.freeze({
  frameBytes: 256 * 1024,
  windowBytes: 8 * 1024 * 1024,
  windowItems: 4096,
  journalItems: 4096,
  snapshotBytes: 16 * 1024 * 1024,
  snapshotItems: 65_536,
  concurrentSnapshots: 4,
  subscriptions: 32,
  queueBytes: 1024 * 1024,
  queueItems: 128,
  progressTimeoutMs: 30_000,
});

export const BusinessFilterSchema = z
  .object({
    kinds: z.array(BusinessKindSchema).min(1).max(BUSINESS_KINDS.length).optional(),
  })
  .strict();
export type BusinessFilter = z.infer<typeof BusinessFilterSchema>;
export function normalizedBusinessKinds(filter: BusinessFilter): BusinessKind[] {
  return BUSINESS_KINDS.filter((kind) => !filter.kinds || filter.kinds.includes(kind));
}
export function businessFilterIdentity(filter: BusinessFilter): string {
  return normalizedBusinessKinds(filter).join(",");
}
export const BusinessCursorSchema = z
  .object({
    serverId: OpaqueIdSchema,
    relayInstanceId: OpaqueIdSchema,
    streamId: OpaqueIdSchema,
    sequence: SequenceSchema,
    filter: z.string().min(1).max(128),
  })
  .strict();
export type BusinessCursor = z.infer<typeof BusinessCursorSchema>;

// A compact confirmed runtime observation, separate from the durable history row. In particular,
// a delayed durable "running" row cannot overwrite a confirmed worker exit. No terminal bytes,
// parser state or ordinary-shell busy/idle inference belongs in this stream.
export const BusinessRuntimeFactSchema = RunStatusSchema.omit({
  receivedSeq: true,
  parsedSeq: true,
  reason: true,
});
export type BusinessRuntimeFact = z.infer<typeof BusinessRuntimeFactSchema>;
export const BusinessRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo"), id: z.string().min(1).max(512), record: RepoRecordSchema }),
  z.object({
    kind: z.literal("task"),
    id: z.string().min(1).max(512),
    record: TaskRecordSchema,
    // The stored mount/entry projection does not prove current filesystem liveness. A checked
    // task.get/list observation is a separate read; it must not be silently merged by revision.
    filesystem: z.literal("unobserved"),
  }),
  z.object({ kind: z.literal("tab"), id: z.string().min(1).max(512), record: TabRecordSchema }),
  z.object({
    kind: z.literal("run"),
    id: z.string().min(1).max(512),
    record: RunHistoryRecordSchema,
  }),
  z.object({
    kind: z.literal("operation"),
    id: z.string().min(1).max(512),
    record: OperationRecordSchema,
  }),
  z.object({
    kind: z.literal("config"),
    id: z.enum(["server", "entry"]),
    // Entry's restartRequired is a live listener observation, not a stored fact. entry.get
    // supplies it when requested; never invent false merely to fit the persistent projection.
    record: z.union([ConfigRecordSchema, EntryRecordSchema.omit({ restartRequired: true })]),
  }),
  z.object({
    kind: z.literal("runtime"),
    id: z.string().min(1).max(512),
    record: BusinessRuntimeFactSchema,
  }),
]);
export type BusinessRecord = z.infer<typeof BusinessRecordSchema>;
export const BusinessChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upsert"), value: BusinessRecordSchema }),
  z.object({ type: z.literal("delete"), kind: BusinessKindSchema, id: z.string().min(1).max(512) }),
]);
export type BusinessChange = z.infer<typeof BusinessChangeSchema>;
export const BusinessSubscribeSchema = z
  .object({
    type: z.literal("subscribe"),
    filter: BusinessFilterSchema.default({}),
    since: BusinessCursorSchema.optional(),
  })
  .strict();
export type BusinessSubscribe = z.infer<typeof BusinessSubscribeSchema>;
export const BUSINESS_RESET_REASONS = [
  "identity",
  "generation",
  "filter",
  "gap",
  "overflow",
  "publication-uncertain",
  "unavailable",
] as const;
export type BusinessResetReason = (typeof BUSINESS_RESET_REASONS)[number];

export const BusinessFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot-begin"), snapshotId: OpaqueIdSchema }),
  z.object({
    type: z.literal("snapshot-page"),
    snapshotId: OpaqueIdSchema,
    page: SequenceSchema,
    records: z.array(BusinessRecordSchema).max(BUSINESS_LIMITS.snapshotItems),
  }),
  z.object({
    type: z.literal("snapshot-end"),
    snapshotId: OpaqueIdSchema,
    pages: SequenceSchema,
    cursor: BusinessCursorSchema,
    // This is a complete current-resource view, not a complete retained history. A session
    // preserves its own unresolved operation IDs even when absent here and verifies them by RPC.
    history: z.literal("latest-and-active-runs-unresolved-operations"),
  }),
  z.object({ type: z.literal("ready"), cursor: BusinessCursorSchema }),
  z.object({
    type: z.literal("changes"),
    after: BusinessCursorSchema,
    cursor: BusinessCursorSchema,
    changes: z.array(BusinessChangeSchema).max(BUSINESS_LIMITS.journalItems),
  }),
  z.object({ type: z.literal("reset"), reason: z.enum(BUSINESS_RESET_REASONS) }),
  z.object({
    type: z.literal("error"),
    reason: z.enum(["snapshot-too-large", "busy", "unavailable"]),
  }),
]);
export type BusinessFrame = z.infer<typeof BusinessFrameSchema>;
export function businessRunId(run: { relayInstanceId: string; runId: string }): string {
  return JSON.stringify([run.relayInstanceId, run.runId]);
}
