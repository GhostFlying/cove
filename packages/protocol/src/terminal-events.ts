import { z } from "zod";
import {
  ConnectionRefSchema,
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  SubscriptionRefSchema,
  sameRunRef,
} from "./identity.js";
import { AppearanceSchema, GeometrySchema } from "./profile.js";
import {
  BaselineChunkSchema,
  BaselineDescriptorSchema,
  BaselineEndSchema,
} from "./terminal-recovery.js";

const run = { run: RunRefSchema };
const ordered = { ...run, seq: SequenceSchema.min(1) };
const holder = z.object({
  connection: ConnectionRefSchema,
  viewId: OpaqueIdSchema,
  subscriptionId: OpaqueIdSchema,
});
export const ControlHolderSchema = holder;

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output"), ...ordered }),
  z.object({
    type: z.literal("resize"),
    ...ordered,
    geometry: GeometrySchema,
    requiresBaseline: z.boolean(),
  }),
  z.object({
    type: z.literal("control"),
    ...ordered,
    epoch: SequenceSchema.min(1),
    holder: holder.nullable(),
    geometry: GeometrySchema,
  }),
  z.object({ type: z.literal("appearance"), ...ordered, appearance: AppearanceSchema }),
  z.object({
    type: z.literal("exit"),
    ...ordered,
    exitCode: z.number().int().nullable(),
    signal: z.string().max(64).nullable(),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

const preview = { ...run, previewId: OpaqueIdSchema, version: SequenceSchema };
export const TerminalEventSchema = z.discriminatedUnion("type", [
  ...RunEventSchema.options,
  z.object({ type: z.literal("baseline-start"), ...run, descriptor: BaselineDescriptorSchema }),
  z.object({ ...BaselineChunkSchema.shape, ...run }),
  z.object({ ...BaselineEndSchema.shape, ...run }),
  z.object({
    type: z.literal("preview-start"),
    ...preview,
    atSeq: SequenceSchema,
    geometry: GeometrySchema,
    generatedAtMs: SequenceSchema,
    vtBytes: z.number().int().min(1).max(65_536),
    chunkCount: z.number().int().min(1).max(1),
  }),
  z.object({ type: z.literal("preview-chunk"), ...preview, ordinal: z.literal(0) }),
  z.object({
    type: z.literal("preview-end"),
    ...preview,
    totalBytes: z.number().int().min(1).max(65_536),
    atSeq: SequenceSchema,
  }),
]);
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

export function validateEventBinding(event: TerminalEvent): boolean {
  if (event.type === "baseline-start")
    return (
      sameRunRef(event.run, event.descriptor.run) &&
      sameRunRef(event.run, event.descriptor.subscription.run)
    );
  if (event.type === "baseline-chunk" || event.type === "baseline-end")
    return sameRunRef(event.run, event.subscription.run);
  return true;
}

export function validateContiguousEvents(
  events: readonly RunEvent[],
  previousSeq: number,
): boolean {
  if (!SequenceSchema.safeParse(previousSeq).success) return false;
  let expected = previousSeq;
  for (const event of events) {
    if (expected === Number.MAX_SAFE_INTEGER || event.seq !== expected + 1) return false;
    expected = event.seq;
  }
  return true;
}

export const RecoveryResumeSchema = z.object({
  subscription: SubscriptionRefSchema,
  appliedSeq: SequenceSchema,
});
