import { z } from "zod";
import {
  OpaqueIdSchema,
  RunRefSchema,
  SequenceSchema,
  SubscriptionRefSchema,
  sameRunRef,
  sameSubscriptionRef,
} from "./identity.js";
import {
  BASELINE_ENCODING,
  BaselineEncodingSchema,
  GeometrySchema,
  PROFILE,
  ProfileSchema,
  RecoveryCoverageSchema,
} from "./profile.js";
import { M0_LIMITS } from "./budgets.js";

export const BaselineDescriptorSchema = z.object({
  baselineId: OpaqueIdSchema,
  run: RunRefSchema,
  subscription: SubscriptionRefSchema,
  profile: ProfileSchema,
  encoding: BaselineEncodingSchema,
  checkpointSeq: SequenceSchema,
  atSeq: SequenceSchema,
  captureGeometry: GeometrySchema,
  currentGeometry: GeometrySchema,
  coverage: RecoveryCoverageSchema,
  vtBytes: z.number().int().min(1).max(M0_LIMITS.baselineVtBytes),
  tailBytes: z.number().int().min(0).max(M0_LIMITS.baselineTailBytes),
  chunkCount: z.number().int().min(1).max(M0_LIMITS.baselineChunks),
});
export type BaselineDescriptor = z.infer<typeof BaselineDescriptorSchema>;

export const BaselineStartSchema = z.object({
  type: z.literal("baseline-start"),
  descriptor: BaselineDescriptorSchema,
});
export const BaselineChunkSchema = z.object({
  type: z.literal("baseline-chunk"),
  run: RunRefSchema,
  baselineId: OpaqueIdSchema,
  subscription: SubscriptionRefSchema,
  ordinal: z
    .number()
    .int()
    .min(0)
    .max(M0_LIMITS.baselineChunks - 1),
});
export const BaselineEndSchema = z.object({
  type: z.literal("baseline-end"),
  run: RunRefSchema,
  baselineId: OpaqueIdSchema,
  subscription: SubscriptionRefSchema,
  chunkCount: z.number().int().min(1).max(M0_LIMITS.baselineChunks),
  totalBytes: z
    .number()
    .int()
    .min(1)
    .max(M0_LIMITS.baselineVtBytes + M0_LIMITS.baselineTailBytes),
  atSeq: SequenceSchema,
});
export type BaselineChunk = z.infer<typeof BaselineChunkSchema>;
export type BaselineEnd = z.infer<typeof BaselineEndSchema>;

export function validateBaselineDescriptor(
  input: unknown,
  historyLimit = M0_LIMITS.historyLines,
): BaselineDescriptor | null {
  if (
    !Number.isSafeInteger(historyLimit) ||
    historyLimit < 0 ||
    historyLimit > M0_LIMITS.historyLines
  )
    return null;
  const parsed = BaselineDescriptorSchema.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (
    value.checkpointSeq > value.atSeq ||
    !sameSubscriptionRef(value.subscription, { ...value.subscription, run: value.run })
  )
    return null;
  if (
    value.captureGeometry.cols !== value.currentGeometry.cols ||
    value.captureGeometry.rows !== value.currentGeometry.rows
  )
    return null;
  if (
    value.coverage.normal.includedHistoryLines > value.coverage.normal.historyLines ||
    value.coverage.normal.historyLines > historyLimit
  )
    return null;
  const totalBytes = value.vtBytes + value.tailBytes;
  if (value.chunkCount > totalBytes || value.chunkCount * 65_536 < totalBytes) return null;
  return value;
}

// The transfer validates byte accounting before any controller commits ACK N.
export function validateBaselineTransfer(
  descriptor: BaselineDescriptor,
  chunks: readonly { metadata: unknown; payload: Uint8Array }[],
  end: unknown,
): boolean {
  if (!validateBaselineDescriptor(descriptor) || chunks.length !== descriptor.chunkCount)
    return false;
  const parsedEnd = BaselineEndSchema.safeParse(end);
  if (!parsedEnd.success) return false;
  const finish = parsedEnd.data;
  if (
    !sameRunRef(finish.run, descriptor.run) ||
    finish.baselineId !== descriptor.baselineId ||
    !sameSubscriptionRef(finish.subscription, descriptor.subscription) ||
    finish.atSeq !== descriptor.atSeq ||
    finish.chunkCount !== descriptor.chunkCount ||
    finish.totalBytes !== descriptor.vtBytes + descriptor.tailBytes
  )
    return false;
  let total = 0;
  for (let index = 0; index < chunks.length; index++) {
    const item = chunks[index]!;
    const parsed = BaselineChunkSchema.safeParse(item.metadata);
    if (
      !parsed.success ||
      !sameRunRef(parsed.data.run, descriptor.run) ||
      parsed.data.ordinal !== index ||
      parsed.data.baselineId !== descriptor.baselineId ||
      !sameSubscriptionRef(parsed.data.subscription, descriptor.subscription) ||
      item.payload.byteLength < 1 ||
      item.payload.byteLength > 65_536
    )
      return false;
    total += item.payload.byteLength;
    if (total > finish.totalBytes) return false;
  }
  return total === finish.totalBytes;
}

export const DEFAULT_PROFILE_DESCRIPTOR = Object.freeze({
  profile: PROFILE,
  encoding: BASELINE_ENCODING,
});
