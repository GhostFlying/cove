import { z } from "zod";
import {
  type ConnectionRef,
  ConnectionRefSchema,
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  SubscriptionRefSchema,
  sameConnectionRef,
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
const BaselineStartEventSchema = z.object({
  type: z.literal("baseline-start"),
  ...run,
  descriptor: BaselineDescriptorSchema,
});
const BaselineChunkEventSchema = z.object({ ...BaselineChunkSchema.shape, ...run });
const BaselineEndEventSchema = z.object({ ...BaselineEndSchema.shape, ...run });
const PreviewStartEventSchema = z.object({
  type: z.literal("preview-start"),
  ...preview,
  atSeq: SequenceSchema,
  geometry: GeometrySchema,
  generatedAtMs: SequenceSchema,
  vtBytes: z.number().int().min(1).max(65_536),
  chunkCount: z.number().int().min(1).max(1),
});
const PreviewChunkEventSchema = z.object({
  type: z.literal("preview-chunk"),
  ...preview,
  ordinal: z.literal(0),
});
const PreviewEndEventSchema = z.object({
  type: z.literal("preview-end"),
  ...preview,
  totalBytes: z.number().int().min(1).max(65_536),
  atSeq: SequenceSchema,
});
const ExternalPreviewStartEventSchema = PreviewStartEventSchema.extend({
  subscription: z.never().optional(),
});
const ExternalPreviewChunkEventSchema = PreviewChunkEventSchema.extend({
  subscription: z.never().optional(),
});
const ExternalPreviewEndEventSchema = PreviewEndEventSchema.extend({
  subscription: z.never().optional(),
});
export const TerminalEventSchema = z.discriminatedUnion("type", [
  ...RunEventSchema.options,
  BaselineStartEventSchema,
  BaselineChunkEventSchema,
  BaselineEndEventSchema,
  PreviewStartEventSchema,
  PreviewChunkEventSchema,
  PreviewEndEventSchema,
]);
export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

export const RunEventDeliverySchema = z.object({
  type: z.literal("run-event"),
  subscription: SubscriptionRefSchema,
  event: RunEventSchema,
});
export type RunEventDelivery = z.infer<typeof RunEventDeliverySchema>;

// Transport routing is deliberately separate from TerminalEvent. The renderer and the
// authoritative model continue to consume the unwrapped run fact; only the external lane
// needs the subscription that owns replay position and credit.
export const ExternalTerminalEventSchema = z.discriminatedUnion("type", [
  RunEventDeliverySchema,
  BaselineStartEventSchema,
  BaselineChunkEventSchema,
  BaselineEndEventSchema,
  ExternalPreviewStartEventSchema,
  ExternalPreviewChunkEventSchema,
  ExternalPreviewEndEventSchema,
]);
export type ExternalTerminalEvent = z.infer<typeof ExternalTerminalEventSchema>;

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

export function validateExternalEventBinding(
  event: ExternalTerminalEvent,
  connection?: ConnectionRef,
): boolean {
  if (event.type === "run-event")
    return (
      sameRunRef(event.subscription.run, event.event.run) &&
      (!connection || sameConnectionRef(event.subscription.connection, connection))
    );
  if (!validateEventBinding(event)) return false;
  const subscription =
    event.type === "baseline-start"
      ? event.descriptor.subscription
      : event.type === "baseline-chunk" || event.type === "baseline-end"
        ? event.subscription
        : undefined;
  if (!subscription) return true;
  return !connection || sameConnectionRef(subscription.connection, connection);
}

export function externalEventSubscription(
  event: ExternalTerminalEvent,
): z.infer<typeof SubscriptionRefSchema> | undefined {
  if (event.type === "run-event") return event.subscription;
  if (event.type === "baseline-start") return event.descriptor.subscription;
  if (event.type === "baseline-chunk" || event.type === "baseline-end") return event.subscription;
  return undefined;
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
