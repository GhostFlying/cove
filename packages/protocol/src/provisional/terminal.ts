import { z } from "zod";
import { failure, type ProtocolResult } from "./errors.js";
import { OpaqueIdSchema, RunRefSchema, SequenceSchema } from "./identity.js";
import { ProbeErrorSchema } from "./errors.js";

const output = z.object({ kind: z.literal("output"), run: RunRefSchema, seq: SequenceSchema });
const input = z.object({ kind: z.literal("input"), run: RunRefSchema, requestId: OpaqueIdSchema });
const baselineChunk = z.object({
  kind: z.literal("baseline-chunk"),
  run: RunRefSchema,
  baselineId: OpaqueIdSchema,
  atSeq: SequenceSchema,
  chunkIndex: z.number().int().min(0).max(255),
  chunkCount: z.number().int().min(1).max(256),
  totalBytes: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 * 1024),
});
const error = z.object({ kind: z.literal("error"), run: RunRefSchema, error: ProbeErrorSchema });

export const TerminalMetadataSchema = z.discriminatedUnion("kind", [
  output,
  input,
  baselineChunk,
  error,
]);
export const TerminalEventMetadataSchema = z.discriminatedUnion("kind", [output, baselineChunk]);
export type TerminalMetadata = z.infer<typeof TerminalMetadataSchema>;
export type TerminalEventMetadata = z.infer<typeof TerminalEventMetadataSchema>;

export function validateTerminalMessage(
  metadata: unknown,
  payload: Uint8Array,
): ProtocolResult<TerminalMetadata> {
  const parsed = TerminalMetadataSchema.safeParse(metadata);
  if (!parsed.success) return failure("INVALID_METADATA");
  const value = parsed.data;
  if (value.kind === "error" && payload.byteLength !== 0) return failure("INVALID_METADATA");
  if (value.kind === "baseline-chunk") {
    const { chunkCount, chunkIndex, totalBytes } = value;
    if (chunkIndex >= chunkCount) return failure("INVALID_METADATA");
    if (totalBytes === 0) {
      if (chunkCount !== 1 || chunkIndex !== 0 || payload.byteLength !== 0)
        return failure("INVALID_METADATA");
    } else {
      if (payload.byteLength < 1 || payload.byteLength > 65_536) return failure("INVALID_METADATA");
      if (totalBytes < chunkCount || totalBytes > chunkCount * 65_536)
        return failure("INVALID_METADATA");
      if (
        totalBytes < payload.byteLength + chunkCount - 1 ||
        totalBytes > payload.byteLength + (chunkCount - 1) * 65_536
      )
        return failure("INVALID_METADATA");
    }
  }
  return { ok: true, value };
}

export { OpaqueIdSchema, RunRefSchema, SequenceSchema, sameRunRef } from "./identity.js";
export type { RunRef } from "./identity.js";
export { ProbeErrorSchema } from "./errors.js";
export type { ProbeError, ProtocolFailure, ProtocolResult } from "./errors.js";
