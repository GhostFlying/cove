import { z } from "zod";
import { M0_LIMITS } from "./budgets.js";
import { ERROR_CODES } from "./errors.js";
import {
  type ConnectionRef,
  sameConnectionRef,
  sameRunRef,
  sameSubscriptionRef,
} from "./identity.js";
import {
  encodeFrame,
  FrameDecoder,
  MAX_METADATA_BYTES,
  MAX_PAYLOAD_BYTES,
  type ByteFrame,
} from "./provisional/frame.js";
import { failure, type ProtocolResult } from "./provisional/errors.js";
import { validateAppearance } from "./profile.js";
import {
  TerminalCommandSchema,
  TerminalErrorSchema,
  TerminalResultSchema,
  type TerminalCommand,
  type TerminalResult,
} from "./terminal-command.js";
import {
  externalEventSubscription,
  ExternalTerminalEventSchema,
  validateExternalEventBinding,
} from "./terminal-events.js";
import { validateBaselineDescriptor } from "./terminal-recovery.js";

export const TERMINAL_LANE = 3;
export const TERMINAL_REVISION = 2;
export const TERMINAL_FRAME_CLASSES = Object.freeze({ command: 1, result: 2, event: 3, error: 4 });
export type TerminalFrameClass = 1 | 2 | 3 | 4;
export type TerminalMetadata =
  | z.infer<typeof TerminalCommandSchema>
  | z.infer<typeof TerminalResultSchema>
  | z.infer<typeof ExternalTerminalEventSchema>
  | z.infer<typeof TerminalErrorSchema>;

export function createTerminalDecoder(): FrameDecoder {
  return new FrameDecoder(TERMINAL_LANE, TERMINAL_REVISION);
}

export function encodeTerminalFrame(
  frameClass: TerminalFrameClass,
  metadata: Uint8Array,
  payload: Uint8Array,
): ProtocolResult<Uint8Array> {
  return encodeFrame(TERMINAL_LANE, TERMINAL_REVISION, frameClass, metadata, payload);
}

// Count the untrusted full JSON tree before Zod strips optional fields.
export function boundedJsonStructure(value: unknown): boolean {
  const queue: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  const active = new Set<object>();
  let tokens = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (item.leave) {
      active.delete(item.value as object);
      continue;
    }
    if (++tokens > 4096 || item.depth > 16) return false;
    if (item.value === null || typeof item.value !== "object") {
      if (typeof item.value === "number" && !Number.isFinite(item.value)) return false;
      if (typeof item.value === "undefined" || typeof item.value === "function") return false;
      continue;
    }
    if (active.has(item.value)) return false;
    active.add(item.value);
    queue.push({ ...item, leave: true });
    if (Array.isArray(item.value)) {
      for (const value of item.value) queue.push({ value, depth: item.depth + 1 });
    } else {
      for (const [key, value] of Object.entries(item.value)) {
        if (key.length > M0_LIMITS.bootstrapBytes) return false;
        if (++tokens > 4096) return false;
        queue.push({ value, depth: item.depth + 1 });
      }
    }
  }
  return true;
}

function payloadAllowed(
  value: TerminalMetadata,
  frameClass: TerminalFrameClass,
  bytes: Uint8Array,
): boolean {
  if (frameClass === 1 && value.type === "input") return bytes.byteLength >= 1;
  if (
    frameClass === 3 &&
    ((value.type === "run-event" && value.event.type === "output") ||
      value.type === "baseline-chunk" ||
      value.type === "preview-chunk")
  )
    return bytes.byteLength >= 1;
  return bytes.byteLength === 0;
}

function matchingRefs(value: TerminalMetadata, connection?: ConnectionRef): boolean {
  if (
    "run" in value &&
    "subscription" in value &&
    value.subscription !== undefined &&
    !sameRunRef(value.run, value.subscription.run)
  )
    return false;
  if (
    connection &&
    "subscription" in value &&
    value.subscription !== undefined &&
    !sameConnectionRef(value.subscription.connection, connection)
  )
    return false;
  if (
    value.type === "run-event" ||
    value.type === "baseline-start" ||
    value.type === "baseline-chunk" ||
    value.type === "baseline-end" ||
    value.type === "preview-start" ||
    value.type === "preview-chunk" ||
    value.type === "preview-end"
  )
    return (
      (!externalEventSubscription(value) || connection !== undefined) &&
      (value.type !== "baseline-start" || validateBaselineDescriptor(value.descriptor) !== null) &&
      (value.type !== "run-event" ||
        value.event.type !== "appearance" ||
        validateAppearance(value.event.appearance) !== null) &&
      validateExternalEventBinding(value, connection)
    );
  if ("appearance" in value && !validateAppearance(value.appearance)) return false;
  if (
    value.type === "error" &&
    (value.error.code !== ERROR_CODES[value.error.kind] ||
      (value.commandType === "input" && value.error.kind === "RESULT_UNKNOWN") !==
        (value.error.subject === "input"))
  )
    return false;
  return true;
}

export function validateTerminalFrame(
  frame: ByteFrame,
  metadata: unknown,
  connection?: ConnectionRef,
): ProtocolResult<TerminalMetadata> {
  if (
    frame.metadata.byteLength > MAX_METADATA_BYTES ||
    frame.payload.byteLength > MAX_PAYLOAD_BYTES ||
    !boundedJsonStructure(metadata)
  )
    return failure("INVALID_METADATA");
  const parsed =
    frame.kind === 1
      ? TerminalCommandSchema.safeParse(metadata)
      : frame.kind === 2
        ? TerminalResultSchema.safeParse(metadata)
        : frame.kind === 3
          ? ExternalTerminalEventSchema.safeParse(metadata)
          : frame.kind === 4
            ? TerminalErrorSchema.safeParse(metadata)
            : null;
  if (!parsed?.success) return failure("INVALID_METADATA");
  const value = parsed.data;
  if (!payloadAllowed(value, frame.kind, frame.payload) || !matchingRefs(value, connection))
    return failure("INVALID_METADATA");
  return { ok: true, value };
}

export function validateTerminalResultForCommand(
  command: TerminalCommand,
  result: TerminalResult,
): boolean {
  if (
    result.type !== `${command.type}-result` ||
    result.requestId !== command.requestId ||
    !sameRunRef(result.run, command.run)
  )
    return false;
  if (
    "subscription" in command &&
    "subscription" in result &&
    !sameSubscriptionRef(command.subscription, result.subscription)
  )
    return false;
  if (
    command.type === "attach" &&
    result.type === "attach-result" &&
    (!sameConnectionRef(command.connection, result.subscription.connection) ||
      command.viewId !== result.subscription.viewId)
  )
    return false;
  if (
    (command.type === "attach" || command.type === "recover") &&
    (result.type === "attach-result" || result.type === "recover-result")
  )
    if (
      (result.mode === "replay" && !command.resume) ||
      (command.resume && result.atSeq < command.resume.appliedSeq)
    )
      return false;
  if (command.type === "input" && result.type === "input-result")
    return result.inputSeq === command.inputSeq && result.epoch === command.epoch;
  if (
    (command.type === "blur" || command.type === "resize" || command.type === "appearance") &&
    "epoch" in result
  )
    return result.epoch === command.epoch;
  if (command.type === "applied-ack" && result.type === "applied-ack-result")
    return result.appliedSeq === command.appliedSeq;
  if (command.type === "baseline-progress" && result.type === "baseline-progress-result")
    return (
      result.baselineId === command.baselineId &&
      result.lastParsedOrdinal === command.lastParsedOrdinal
    );
  return true;
}

export {
  TerminalCommandSchema,
  TerminalResultSchema,
  TerminalErrorSchema,
} from "./terminal-command.js";
export {
  ExternalTerminalEventSchema,
  externalEventSubscription,
  RunEventDeliverySchema,
  TerminalEventSchema,
  validateExternalEventBinding,
} from "./terminal-events.js";
export type { TerminalCommand, TerminalResult, TerminalError } from "./terminal-command.js";
export { RunEventSchema, validateContiguousEvents } from "./terminal-events.js";
export type {
  ExternalTerminalEvent,
  RunEvent,
  RunEventDelivery,
  TerminalEvent,
} from "./terminal-events.js";
export {
  BaselineDescriptorSchema,
  BaselineStartSchema,
  BaselineChunkSchema,
  BaselineEndSchema,
  validateBaselineDescriptor,
  validateBaselineTransfer,
} from "./terminal-recovery.js";
export type { BaselineDescriptor, BaselineChunk, BaselineEnd } from "./terminal-recovery.js";
export {
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_METADATA_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_READ_BYTES,
  MAX_READ_FRAMES,
} from "./provisional/frame.js";
