import { z } from "zod";
import { ERROR_CODES } from "./errors.js";
import { validateEffectiveBudgets } from "./budgets.js";
import { sameRunRef, sameWorkerRef, workerMatchesRun } from "./identity.js";
import { boundedJsonStructure } from "./terminal.js";
import { validateBaselineDescriptor } from "./terminal-recovery.js";
import { validateEventBinding } from "./terminal-events.js";
import { validateAppearance } from "./profile.js";
import {
  encodeFrame,
  FrameDecoder,
  MAX_PAYLOAD_BYTES,
  type ByteFrame,
} from "./provisional/frame.js";
import { failure, type ProtocolResult } from "./provisional/errors.js";
import {
  PipeCommandSchema,
  PipeErrorSchema,
  PipeEventSchema,
  PipeHelloSchema,
  PipeReadySchema,
  PipeResultSchema,
  type PipeCommand,
  type PipeMetadata,
} from "./pipe-command.js";

export const PIPE_LANE = 4;
export const PIPE_REVISION = 1;
export const PIPE_FRAME_CLASSES = Object.freeze({ command: 1, result: 2, event: 3, error: 4 });
export type PipeFrameClass = 1 | 2 | 3 | 4;

export function createPipeDecoder(): FrameDecoder {
  return new FrameDecoder(PIPE_LANE, PIPE_REVISION);
}

export function encodePipeFrame(
  frameClass: PipeFrameClass,
  metadata: Uint8Array,
  payload: Uint8Array,
): ProtocolResult<Uint8Array> {
  return encodeFrame(PIPE_LANE, PIPE_REVISION, frameClass, metadata, payload);
}

function validPayload(value: PipeMetadata, payload: Uint8Array): boolean {
  if (value.type === "spawn") return payload.byteLength === value.spawnPayloadBytes;
  if (value.type === "input") return payload.byteLength >= 1;
  if (value.type === "terminal-event") {
    const type = value.terminal.type;
    return type === "output" || type === "baseline-chunk" || type === "preview-chunk"
      ? payload.byteLength >= 1
      : payload.byteLength === 0;
  }
  return payload.byteLength === 0;
}

function validIdentity(value: PipeMetadata): boolean {
  if ("effectiveBudgets" in value && !validateEffectiveBudgets(value.effectiveBudgets))
    return false;
  if ("run" in value && !workerMatchesRun(value.worker, value.run)) return false;
  if ("subscription" in value && !sameRunRef(value.run, value.subscription.run)) return false;
  if (value.type === "recover" && !sameRunRef(value.run, value.replacement.run)) return false;
  if (value.type === "terminal-event") {
    if (!sameRunRef(value.run, value.terminal.run)) return false;
    if ("subscription" in value.terminal && !sameRunRef(value.run, value.terminal.subscription.run))
      return false;
    if (
      value.terminal.type === "baseline-start" &&
      !validateBaselineDescriptor(value.terminal.descriptor)
    )
      return false;
    if (!validateEventBinding(value.terminal)) return false;
    if (value.terminal.type === "appearance" && !validateAppearance(value.terminal.appearance))
      return false;
  }
  if (value.type === "spawn" || value.type === "appearance" || value.type === "set-control") {
    if ("appearance" in value && value.appearance && !validateAppearance(value.appearance))
      return false;
  }
  if (value.type === "error" && value.error.code !== ERROR_CODES[value.error.kind]) return false;
  return true;
}

export function validatePipeFrame(
  frame: ByteFrame,
  metadata: unknown,
): ProtocolResult<PipeMetadata> {
  if (!boundedJsonStructure(metadata) || frame.payload.byteLength > MAX_PAYLOAD_BYTES)
    return failure("INVALID_METADATA");
  const parsed =
    frame.kind === 1
      ? z.union([PipeHelloSchema, PipeCommandSchema]).safeParse(metadata)
      : frame.kind === 2
        ? z.union([PipeReadySchema, PipeResultSchema]).safeParse(metadata)
        : frame.kind === 3
          ? PipeEventSchema.safeParse(metadata)
          : frame.kind === 4
            ? PipeErrorSchema.safeParse(metadata)
            : null;
  if (!parsed?.success) return failure("INVALID_METADATA");
  const value = parsed.data;
  if (!validPayload(value, frame.payload) || !validIdentity(value))
    return failure("INVALID_METADATA");
  return { ok: true, value };
}

export function validatePipeReadiness(
  hello: z.infer<typeof PipeHelloSchema>,
  ready: z.infer<typeof PipeReadySchema>,
): boolean {
  return (
    !!validateEffectiveBudgets(hello.effectiveBudgets) &&
    !!validateEffectiveBudgets(ready.effectiveBudgets) &&
    sameWorkerRef(hello.worker, ready.worker) &&
    hello.pipeVersion === ready.pipeVersion &&
    (Object.keys(hello.effectiveBudgets) as (keyof typeof hello.effectiveBudgets)[]).every(
      (key) => hello.effectiveBudgets[key] === ready.effectiveBudgets[key],
    )
  );
}

export function validatePipeResultForCommand(
  command: PipeCommand,
  result: z.infer<typeof PipeResultSchema> | z.infer<typeof PipeErrorSchema>,
): boolean {
  if (
    !sameWorkerRef(command.worker, result.worker) ||
    !sameRunRef(command.run, result.run) ||
    command.requestId !== result.requestId ||
    command.type !== result.commandType
  )
    return false;
  if (command.type === "spawn" || command.type === "stop") {
    if (result.type === "result" && result.operationId !== command.operationId) return false;
  }
  if (command.type === "input" && result.type === "result" && result.inputSeq !== command.inputSeq)
    return false;
  return true;
}

export {
  PipeMetadataSchema,
  PipeCommandSchema,
  PipeResultSchema,
  PipeEventSchema,
  PipeErrorSchema,
  PipeHelloSchema,
  PipeReadySchema,
  SpawnArgumentsSchema,
  RunStatusSchema,
  composeSpawnPayload,
  validateSpawnPayload,
  PIPE_VERSION,
} from "./pipe-command.js";
export type {
  PipeMetadata,
  PipeCommand,
  PipeResult,
  RunStatus,
  SpawnArguments,
} from "./pipe-command.js";
export type { PipeError, PipeEvent } from "./pipe-command.js";
export {
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_METADATA_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_READ_BYTES,
  MAX_READ_FRAMES,
} from "./provisional/frame.js";
