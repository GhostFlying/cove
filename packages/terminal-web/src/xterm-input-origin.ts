import type { Terminal } from "@xterm/xterm";
import manifest from "@xterm/xterm/package.json" with { type: "json" };
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import type { InputSource } from "./browser-input-intents.js";

const SUPPORTED_XTERM_VERSION = "6.0.0";
const attached = new WeakSet<Terminal>();

interface CoreServiceSurface {
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
  triggerBinaryEvent(data: string): void;
  onUserInput(listener: () => void): { dispose(): void };
}

interface PrivateTerminalSurface {
  _core?: { coreService?: CoreServiceSurface };
}

export interface InputOriginAttachment {
  ownsSurface(): boolean;
  dispose(): void;
}

function encodeTextBounded(value: string): Uint8Array | null {
  const target = new Uint8Array(M0_LIMITS.inputQueueBytes);
  const result = new TextEncoder().encodeInto(value, target);
  if (result.read !== value.length) return null;
  return target.slice(0, result.written);
}

function encodeBinaryBounded(value: string): Uint8Array | null {
  if (value.length > M0_LIMITS.inputQueueBytes) return null;
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value.charCodeAt(index);
    if (byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

// This is the production form of the frozen Q1 adapter. Q1's probe remains unchanged so an
// xterm upgrade must pass both its historical corpus and the V1 browser acceptance corpus.
export function attachInputOrigin(
  terminal: Terminal,
  source: (fallback: InputSource) => InputSource,
  emit: (bytes: Uint8Array, source: InputSource) => void,
  rejectInput: (error: DomainError) => void,
): InputOriginAttachment {
  if (manifest.version !== SUPPORTED_XTERM_VERSION) throw domainError("PROFILE_UNSUPPORTED");
  if (attached.has(terminal)) throw domainError("PROFILE_UNSUPPORTED");
  const core = (terminal as unknown as PrivateTerminalSurface)._core?.coreService;
  if (
    !core ||
    typeof core.triggerDataEvent !== "function" ||
    typeof core.triggerBinaryEvent !== "function" ||
    typeof core.onUserInput !== "function"
  )
    throw domainError("PROFILE_UNSUPPORTED");

  const originalData = core.triggerDataEvent;
  const originalBinary = core.triggerBinaryEvent;
  let disposed = false;
  let userSignals = 0;
  const userSignal = core.onUserInput(() => userSignals++);
  if (!userSignal || typeof userSignal.dispose !== "function")
    throw domainError("PROFILE_UNSUPPORTED");

  const dataWrapper = function (
    this: CoreServiceSurface,
    data: string,
    wasUserInput = false,
  ): void {
    if (disposed || !wasUserInput) return;
    const bytes = encodeTextBounded(data);
    if (!bytes) {
      rejectInput(domainError("INPUT_REJECTED"));
      return;
    }
    const before = userSignals;
    originalData.call(this, data, true);
    if (userSignals <= before) {
      rejectInput(domainError("PROFILE_UNSUPPORTED"));
      return;
    }
    emit(bytes, source("keyboard"));
  };
  const binaryWrapper = function (this: CoreServiceSurface, data: string): void {
    if (disposed) return;
    const bytes = encodeBinaryBounded(data);
    if (!bytes) {
      rejectInput(domainError("INPUT_REJECTED"));
      return;
    }
    originalBinary.call(this, data);
    emit(bytes, source("mouse"));
  };

  core.triggerDataEvent = dataWrapper;
  core.triggerBinaryEvent = binaryWrapper;
  attached.add(terminal);
  return {
    ownsSurface: () =>
      !disposed &&
      core.triggerDataEvent === dataWrapper &&
      core.triggerBinaryEvent === binaryWrapper,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (core.triggerDataEvent === dataWrapper) core.triggerDataEvent = originalData;
      if (core.triggerBinaryEvent === binaryWrapper) core.triggerBinaryEvent = originalBinary;
      userSignal.dispose();
      attached.delete(terminal);
    },
  };
}

export const xtermInputOriginVersion = SUPPORTED_XTERM_VERSION;
