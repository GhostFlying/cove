import { z } from "zod";
import { failure, ProbeErrorSchema, type ProtocolResult } from "./errors.js";
import { OpaqueIdSchema, RunRefSchema, WorkerRefSchema, workerMatchesRun } from "./identity.js";
import { TerminalEventMetadataSchema, validateTerminalMessage } from "./terminal.js";

const common = { worker: WorkerRefSchema, run: RunRefSchema, requestId: OpaqueIdSchema };
export const PipeMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("probe-request"), ...common }),
  z.object({ kind: z.literal("probe-result"), ...common }),
  z.object({ kind: z.literal("terminal-event"), ...common, terminal: TerminalEventMetadataSchema }),
  z.object({ kind: z.literal("error"), ...common, error: ProbeErrorSchema }),
]);
export type PipeMetadata = z.infer<typeof PipeMetadataSchema>;

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
