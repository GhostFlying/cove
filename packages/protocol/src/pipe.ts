import { z } from "zod";
import { ERROR_CODES } from "./errors.js";
import { validateEffectiveBudgets } from "./budgets.js";
import { sameRunRef, sameSubscriptionRef, sameWorkerRef, workerMatchesRun } from "./identity.js";
import { boundedJsonStructure } from "./terminal.js";
import { validateBaselineDescriptor } from "./terminal-recovery.js";
import { validateEventBinding } from "./terminal-events.js";
import { validateAppearance } from "./profile.js";
import {
  encodeFrame,
  FrameDecoder,
  MAX_METADATA_BYTES,
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
export const PIPE_REVISION = 2;
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
  if (
    "subscription" in value &&
    value.subscription !== undefined &&
    !sameRunRef(value.run, value.subscription.run)
  )
    return false;
  if (
    value.type === "set-control" &&
    value.holder !== null &&
    (value.expectedEpoch === Number.MAX_SAFE_INTEGER || value.nextEpoch !== value.expectedEpoch + 1)
  )
    return false;
  if (
    value.type === "result" &&
    ((value.runStatus && !sameRunRef(value.run, value.runStatus.run)) ||
      (value.commandType === "status" && value.outcome === "accepted" && !value.runStatus) ||
      ((value.commandType === "subscribe" || value.commandType === "recover") &&
        value.outcome === "accepted" &&
        (value.atSeq === undefined || value.recoveryMode === undefined)) ||
      (value.commandType !== "subscribe" &&
        value.commandType !== "recover" &&
        value.recoveryMode !== undefined) ||
      ((value.commandType === "subscribe" || value.commandType === "recover") &&
        value.outcome !== "accepted" &&
        value.recoveryMode !== undefined) ||
      (value.commandType === "input" &&
        value.outcome === "accepted" &&
        (value.inputSeq === undefined || value.writtenBytes === undefined)))
  )
    return false;
  if (value.type === "terminal-event") {
    if (!sameRunRef(value.run, value.terminal.run)) return false;
    const embeddedSubscription =
      value.terminal.type === "baseline-start"
        ? value.terminal.descriptor.subscription
        : value.terminal.type === "baseline-chunk" || value.terminal.type === "baseline-end"
          ? value.terminal.subscription
          : undefined;
    const needsSubscription =
      value.terminal.type === "output" ||
      value.terminal.type === "resize" ||
      value.terminal.type === "control" ||
      value.terminal.type === "appearance" ||
      value.terminal.type === "exit" ||
      embeddedSubscription !== undefined;
    // Preview is a run cache transfer, while ordinary and baseline delivery are
    // per-subscription. Requiring exactly one convention prevents P2 from guessing routes.
    if (needsSubscription !== (value.subscription !== undefined)) return false;
    if (
      value.subscription &&
      (!sameRunRef(value.run, value.subscription.run) ||
        (embeddedSubscription && !sameSubscriptionRef(value.subscription, embeddedSubscription)))
    )
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
  if (
    value.type === "error" &&
    (value.error.code !== ERROR_CODES[value.error.kind] ||
      (value.commandType === "input" && value.error.kind === "RESULT_UNKNOWN") !==
        (value.error.subject === "input"))
  )
    return false;
  return true;
}

export function validatePipeFrame(
  frame: ByteFrame,
  metadata: unknown,
): ProtocolResult<PipeMetadata> {
  if (
    frame.metadata.byteLength > MAX_METADATA_BYTES ||
    frame.payload.byteLength > MAX_PAYLOAD_BYTES ||
    !boundedJsonStructure(metadata)
  )
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
  if (result.type === "result") {
    const recovery = command.type === "subscribe" || command.type === "recover";
    if (
      (recovery &&
        result.outcome === "accepted" &&
        (result.recoveryMode === undefined || result.atSeq === undefined)) ||
      (!recovery && result.recoveryMode !== undefined) ||
      (recovery && result.outcome !== "accepted" && result.recoveryMode !== undefined)
    )
      return false;
    if (
      command.type === "subscribe" &&
      result.outcome === "accepted" &&
      result.atSeq! < command.atSeq
    )
      return false;
    if (
      command.type === "recover" &&
      result.outcome === "accepted" &&
      ((result.recoveryMode === "replay" && command.appliedSeq === undefined) ||
        (command.appliedSeq !== undefined && result.atSeq! < command.appliedSeq))
    )
      return false;
  }
  if (command.type === "spawn" || command.type === "stop") {
    if (result.type === "result" && result.operationId !== command.operationId) return false;
  }
  if (command.type === "input" && result.type === "result" && result.inputSeq !== command.inputSeq)
    return false;
  if (
    command.type === "input" &&
    result.type === "result" &&
    result.outcome === "accepted" &&
    result.writtenBytes === undefined
  )
    return false;
  if (
    result.type === "result" &&
    result.runStatus &&
    !sameRunRef(command.run, result.runStatus.run)
  )
    return false;
  if (
    command.type === "status" &&
    result.type === "result" &&
    result.outcome === "accepted" &&
    !result.runStatus
  )
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
