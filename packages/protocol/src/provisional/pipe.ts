import { z } from "zod";
import { failure, ProbeErrorSchema, type ProtocolResult } from "./errors.js";
import { OpaqueIdSchema, RunRefSchema, WorkerRefSchema, workerMatchesRun } from "./identity.js";
import { TerminalEventMetadataSchema, validateTerminalMessage } from "./terminal.js";
import { encodeFrame, FrameDecoder, type ByteFrame } from "./frame.js";

const common = { worker: WorkerRefSchema, run: RunRefSchema, requestId: OpaqueIdSchema };
export const PipeMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("probe-request"), ...common }),
  z.object({ kind: z.literal("probe-result"), ...common }),
  z.object({ kind: z.literal("terminal-event"), ...common, terminal: TerminalEventMetadataSchema }),
  z.object({ kind: z.literal("error"), ...common, error: ProbeErrorSchema }),
]);
export type PipeMetadata = z.infer<typeof PipeMetadataSchema>;

export const PIPE_REVISION = 1;
export type PipeKind = PipeMetadata["kind"];
const kindCode: Record<PipeKind, 1 | 2 | 3 | 4> = {
  "probe-request": 1,
  "probe-result": 2,
  "terminal-event": 3,
  error: 4,
};

export function encodePipeFrame(kind: PipeKind, metadata: Uint8Array, payload: Uint8Array) {
  return encodeFrame(2, PIPE_REVISION, kindCode[kind], metadata, payload);
}

export function createPipeDecoder(): FrameDecoder {
  return new FrameDecoder(2, PIPE_REVISION);
}

export function validatePipeFrame(
  frame: ByteFrame,
  metadata: unknown,
): ProtocolResult<PipeMetadata> {
  const checked = validatePipeMessage(metadata, frame.payload);
  if (!checked.ok) return checked;
  return kindCode[checked.value.kind] === frame.kind ? checked : failure("INVALID_METADATA");
}

export function validatePipeMessage(
  metadata: unknown,
  payload: Uint8Array,
): ProtocolResult<PipeMetadata> {
  const parsed = PipeMetadataSchema.safeParse(metadata);
  if (!parsed.success) return failure("INVALID_METADATA");
  const value = parsed.data;
  if (!workerMatchesRun(value.worker, value.run)) return failure("IDENTITY_MISMATCH");
  if (value.kind === "error" && payload.byteLength !== 0) return failure("INVALID_METADATA");
  if (value.kind === "terminal-event") {
    if (
      value.terminal.run.serverId !== value.run.serverId ||
      value.terminal.run.relayInstanceId !== value.run.relayInstanceId ||
      value.terminal.run.runId !== value.run.runId
    )
      return failure("IDENTITY_MISMATCH");
    const checked = validateTerminalMessage(value.terminal, payload);
    if (!checked.ok) return checked;
  }
  return { ok: true, value };
}

export {
  OpaqueIdSchema,
  RunRefSchema,
  WorkerRefSchema,
  workerMatchesRun,
  sameRunRef,
  sameWorkerRef,
} from "./identity.js";
export type { RunRef, WorkerRef } from "./identity.js";
export { ProbeErrorSchema } from "./errors.js";
export type { ProbeError, ProtocolFailure, ProtocolResult } from "./errors.js";
export type { ByteFrame, ReadResult, ReadStatus } from "./frame.js";
export {
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_METADATA_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_READ_BYTES,
  MAX_READ_FRAMES,
} from "./frame.js";
