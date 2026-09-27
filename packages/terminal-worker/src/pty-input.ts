import type {
  BoundedWriteRejectionReason,
  IBoundedWriteAdmission,
  IBoundedWriteSettlement,
} from "node-pty";
import type { RetainedBytesReservation } from "@cove/terminal-engine";

export type NativeInputOrigin = "user" | "query" | "focus";

export type NativeInputRejectionReason =
  | "empty"
  | "invalid-bytes"
  | "invalid-callback"
  | "fenced"
  | "pty-byte-limit"
  | "pty-task-limit"
  | "factory-byte-limit"
  | "factory-task-limit"
  | "worker-byte-limit"
  | "native-not-enabled"
  | "native-closed"
  | "native-error"
  | "native-empty"
  | "native-invalid-data"
  | "native-byte-limit"
  | "native-task-limit"
  | "native-ticket-exhausted";

export type NativeInputAdmission =
  | {
      readonly kind: "accepted";
      readonly ticket: number;
      readonly byteLength: number;
      readonly origin: NativeInputOrigin;
    }
  | {
      readonly kind: "rejected";
      readonly reason: NativeInputRejectionReason;
      readonly writtenBytes: 0;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "native-call-threw" | "native-admission-invalid";
      readonly byteLength: number;
      readonly cause: unknown;
    };

export type NativeInputSettlement =
  | {
      readonly kind: "written";
      readonly ticket: number;
      readonly status: "written";
      readonly originalBytes: number;
      readonly writtenBytes: number;
      readonly remainingBytes: 0;
    }
  | {
      readonly kind: "unknown";
      readonly ticket: number;
      readonly status: "written" | "error" | "closed" | "invalid";
      readonly originalBytes: number;
      readonly writtenBytes: number;
      readonly remainingBytes: number;
      readonly errorCode?: string;
      readonly errorMessage?: string;
    };

export interface NativeInputFault {
  readonly reason:
    | "native-write-threw"
    | "native-admission-invalid"
    | "native-settlement-invalid"
    | "native-settlement-duplicate"
    | "native-settlement-unknown"
    | "settlement-observer-threw"
    | "retire-input-failed";
  readonly cause?: unknown;
}

export interface NativeInputSnapshot {
  readonly allocatedBytes: number;
  readonly tasks: number;
  readonly peakAllocatedBytes: number;
  readonly peakTasks: number;
  readonly maxBytes: number;
  readonly maxTasks: number;
}

export interface NativeBoundedWriter {
  writeBounded(
    data: Buffer,
    onSettled: (settlement: IBoundedWriteSettlement) => void,
  ): IBoundedWriteAdmission;
  disposeBoundedWrite(): boolean;
}

interface BudgetReservation {
  release(): void;
}

type BudgetRejection = "byte-limit" | "task-limit";

class InputBudget {
  readonly #maxBytes: number;
  readonly #maxTasks: number;
  #allocatedBytes = 0;
  #tasks = 0;
  #peakAllocatedBytes = 0;
  #peakTasks = 0;

  constructor(maxBytes: number, maxTasks: number) {
    this.#maxBytes = maxBytes;
    this.#maxTasks = maxTasks;
  }

  reserve(byteLength: number): BudgetReservation | BudgetRejection {
    if (this.#tasks >= this.#maxTasks) return "task-limit";
    if (byteLength > this.#maxBytes - this.#allocatedBytes) return "byte-limit";

    this.#allocatedBytes += byteLength;
    this.#tasks += 1;
    this.#peakAllocatedBytes = Math.max(this.#peakAllocatedBytes, this.#allocatedBytes);
    this.#peakTasks = Math.max(this.#peakTasks, this.#tasks);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#allocatedBytes -= byteLength;
        this.#tasks -= 1;
      },
    };
  }

  snapshot(): NativeInputSnapshot {
    return {
      allocatedBytes: this.#allocatedBytes,
      tasks: this.#tasks,
      peakAllocatedBytes: this.#peakAllocatedBytes,
      peakTasks: this.#peakTasks,
      maxBytes: this.#maxBytes,
      maxTasks: this.#maxTasks,
    };
  }
}

export class SharedNativeInputBudget {
  readonly #budget: InputBudget;

  constructor(maxBytes: number, maxTasks: number) {
    this.#budget = new InputBudget(maxBytes, maxTasks);
  }

  reserve(byteLength: number): BudgetReservation | BudgetRejection {
    return this.#budget.reserve(byteLength);
  }

  snapshot(): NativeInputSnapshot {
    return this.#budget.snapshot();
  }
}

export interface PtyInputControllerOptions {
  readonly writer: NativeBoundedWriter;
  readonly sharedBudget: SharedNativeInputBudget;
  readonly maxBytes: number;
  readonly maxTasks: number;
  readonly onFault: (fault: NativeInputFault) => void;
  readonly reserveRetainedBytes?: RetainedBytesReservation;
}

const NATIVE_REJECTIONS = new Set<BoundedWriteRejectionReason>([
  "not-enabled",
  "closed",
  "error",
  "empty",
  "invalid-data",
  "byte-limit",
  "task-limit",
  "ticket-exhausted",
]);
const SETTLEMENT_TICKET_BYTES = 768;
const MAX_SETTLEMENT_CODE_BYTES = 32;
const MAX_SETTLEMENT_MESSAGE_BYTES = 128;

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

type ParsedAdmission =
  | { readonly kind: "accepted"; readonly ticket: number }
  | { readonly kind: "rejected"; readonly reason: BoundedWriteRejectionReason };

function parseAdmission(value: unknown, byteLength: number): ParsedAdmission | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<IBoundedWriteAdmission>;
  const accepted = candidate.accepted;
  if (accepted === true) {
    const ticket = candidate.ticket;
    return Number.isSafeInteger(ticket) && Number(ticket) > 0 && candidate.byteLength === byteLength
      ? { kind: "accepted", ticket: Number(ticket) }
      : undefined;
  }
  if (accepted !== false) return undefined;
  const reason = candidate.reason;
  return typeof reason === "string" && NATIVE_REJECTIONS.has(reason as BoundedWriteRejectionReason)
    ? { kind: "rejected", reason: reason as BoundedWriteRejectionReason }
    : undefined;
}

type CapturedSettlement =
  | { readonly kind: "invalid"; readonly ticket?: number }
  | {
      readonly kind: "captured";
      readonly ticket: number;
      readonly status: "written" | "error" | "closed";
      readonly originalBytes: number;
      readonly writtenBytes: number;
      readonly remainingBytes: number;
      readonly errorCode?: string;
      readonly errorMessage?: string;
    };

function boundedAsciiCode(value: string): string | undefined {
  const chars: string[] = [];
  for (let index = 0; index < value.length && chars.length < MAX_SETTLEMENT_CODE_BYTES; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return undefined;
    chars.push(String.fromCharCode(code));
  }
  return chars.join("");
}

function boundedUtf8Message(value: string): string {
  const chars: string[] = [];
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const original = value.codePointAt(index)!;
    const scalar = original >= 0xd800 && original <= 0xdfff ? 0xfffd : original;
    const width = scalar < 0x80 ? 1 : scalar < 0x800 ? 2 : scalar < 0x10000 ? 3 : 4;
    if (bytes + width > MAX_SETTLEMENT_MESSAGE_BYTES) break;
    chars.push(String.fromCodePoint(scalar));
    bytes += width;
    index += original > 0xffff ? 2 : 1;
  }
  return chars.join("");
}

function captureSettlement(value: unknown): CapturedSettlement {
  if (typeof value !== "object" || value === null) return { kind: "invalid" };
  const source = value as Partial<IBoundedWriteSettlement>;
  let ticket: number | undefined;
  try {
    const actualTicket = source.ticket;
    if (Number.isSafeInteger(actualTicket) && Number(actualTicket) > 0) ticket = actualTicket;
    const status = source.status;
    const originalBytes = source.originalBytes;
    const writtenBytes = source.writtenBytes;
    const remainingBytes = source.remainingBytes;
    const errorCode = source.errorCode;
    const errorMessage = source.errorMessage;
    if (
      ticket === undefined ||
      (status !== "written" && status !== "error" && status !== "closed") ||
      !isSafeCount(originalBytes) ||
      !isSafeCount(writtenBytes) ||
      !isSafeCount(remainingBytes) ||
      (errorCode !== undefined && typeof errorCode !== "string") ||
      (errorMessage !== undefined && typeof errorMessage !== "string")
    )
      return { kind: "invalid", ...(ticket === undefined ? {} : { ticket }) };
    const code = errorCode === undefined ? undefined : boundedAsciiCode(errorCode);
    return {
      kind: "captured",
      ticket,
      status,
      originalBytes,
      writtenBytes,
      remainingBytes,
      ...(code === undefined ? {} : { errorCode: code }),
      ...(errorMessage === undefined ? {} : { errorMessage: boundedUtf8Message(errorMessage) }),
    };
  } catch {
    return { kind: "invalid", ...(ticket === undefined ? {} : { ticket }) };
  }
}

function settlementResult(
  value: CapturedSettlement,
  ticket: number,
  byteLength: number,
): NativeInputSettlement {
  if (value.kind === "invalid") return invalidSettlement(ticket, byteLength);
  const {
    ticket: actualTicket,
    status,
    originalBytes,
    writtenBytes,
    remainingBytes,
    errorCode,
    errorMessage,
  } = value;
  const valid =
    actualTicket === ticket &&
    originalBytes === byteLength &&
    (status === "written" || status === "error" || status === "closed") &&
    isSafeCount(writtenBytes) &&
    isSafeCount(remainingBytes) &&
    writtenBytes <= byteLength &&
    remainingBytes <= byteLength &&
    writtenBytes + remainingBytes === byteLength &&
    (errorCode === undefined || typeof errorCode === "string") &&
    (errorMessage === undefined || typeof errorMessage === "string");
  if (!valid) return invalidSettlement(ticket, byteLength);
  if (status === "written" && writtenBytes === byteLength && remainingBytes === 0) {
    return {
      kind: "written",
      ticket,
      status,
      originalBytes: byteLength,
      writtenBytes,
      remainingBytes: 0,
    };
  }
  return {
    kind: "unknown",
    ticket,
    status,
    originalBytes: byteLength,
    writtenBytes,
    remainingBytes,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function invalidSettlement(ticket: number, byteLength: number): NativeInputSettlement {
  return {
    kind: "unknown",
    ticket,
    status: "invalid",
    originalBytes: byteLength,
    writtenBytes: 0,
    remainingBytes: byteLength,
  };
}

function toBuffer(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function settlementTicket(value: CapturedSettlement | undefined): number | undefined {
  return value?.ticket;
}

export class PtyInputController {
  readonly #writer: NativeBoundedWriter;
  readonly #sharedBudget: SharedNativeInputBudget;
  readonly #localBudget: InputBudget;
  readonly #onFault: (fault: NativeInputFault) => void;
  readonly #reserveRetainedBytes: RetainedBytesReservation | undefined;
  #fenced = false;
  #retired = false;

  constructor(options: PtyInputControllerOptions) {
    this.#writer = options.writer;
    this.#sharedBudget = options.sharedBudget;
    this.#localBudget = new InputBudget(options.maxBytes, options.maxTasks);
    this.#onFault = options.onFault;
    this.#reserveRetainedBytes = options.reserveRetainedBytes;
  }

  submit(
    bytes: Uint8Array,
    origin: NativeInputOrigin,
    onSettled: (result: NativeInputSettlement) => void,
  ): NativeInputAdmission {
    if (!(bytes instanceof Uint8Array)) {
      return { kind: "rejected", reason: "invalid-bytes", writtenBytes: 0 };
    }
    if (bytes.byteLength === 0) {
      return { kind: "rejected", reason: "empty", writtenBytes: 0 };
    }
    if (typeof onSettled !== "function") {
      return { kind: "rejected", reason: "invalid-callback", writtenBytes: 0 };
    }
    if (this.#fenced) {
      return { kind: "rejected", reason: "fenced", writtenBytes: 0 };
    }

    const local = this.#localBudget.reserve(bytes.byteLength);
    if (local === "byte-limit") {
      return { kind: "rejected", reason: "pty-byte-limit", writtenBytes: 0 };
    }
    if (local === "task-limit") {
      return { kind: "rejected", reason: "pty-task-limit", writtenBytes: 0 };
    }
    const shared = this.#sharedBudget.reserve(bytes.byteLength);
    if (shared === "byte-limit" || shared === "task-limit") {
      local.release();
      return {
        kind: "rejected",
        reason: shared === "byte-limit" ? "factory-byte-limit" : "factory-task-limit",
        writtenBytes: 0,
      };
    }

    // The native owner and this callback may each retain the full original intent.
    // Two intents plus bounded capture/result diagnostics and their overlapping envelopes.
    const retained = this.#reserveRetainedBytes?.(bytes.byteLength * 2 + SETTLEMENT_TICKET_BYTES);
    if (this.#reserveRetainedBytes && !retained) {
      local.release();
      shared.release();
      return { kind: "rejected", reason: "worker-byte-limit", writtenBytes: 0 };
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      local.release();
      shared.release();
      retained?.release();
    };
    let admission: Extract<IBoundedWriteAdmission, { accepted: true }> | undefined;
    let earlySettlement: CapturedSettlement | undefined;
    let uncertainCall = false;
    let settlementCallbacks = 0;
    let settlementHandled = false;
    const handleSettlement = (value: CapturedSettlement): void => {
      if (!admission || settlementHandled) return;
      settlementHandled = true;
      let result: NativeInputSettlement;
      try {
        result = settlementResult(value, admission.ticket, bytes.byteLength);
      } catch (error) {
        result = invalidSettlement(admission.ticket, bytes.byteLength);
        this.#faultAndFence("native-settlement-invalid", error);
      }
      if (result.status === "invalid") {
        this.#faultAndFence("native-settlement-invalid", new Error("Invalid settlement"));
      } else if (result.kind === "unknown") {
        this.#faultAndFence(
          "native-settlement-unknown",
          new Error("Native input settled as " + result.status),
        );
      }
      try {
        onSettled(result);
      } catch (error) {
        this.#faultAndFence("settlement-observer-threw", error);
      } finally {
        // Both ledgers retain the whole allocation while the consumer observes
        // settlement, including when that callback reenters submit.
        earlySettlement = undefined;
        release();
      }
    };
    const nativeSettlement = (value: IBoundedWriteSettlement): void => {
      try {
        settlementCallbacks += 1;
        if (settlementCallbacks !== 1) {
          this.#faultAndFence(
            "native-settlement-duplicate",
            new Error("Native input settled more than once"),
          );
          return;
        }
        // Capture before the synchronous callback can leave an owned early record.
        const captured = captureSettlement(value);
        if (!admission) {
          earlySettlement = captured;
          const ticket = settlementTicket(captured);
          if (uncertainCall && ticket !== undefined) {
            admission = { accepted: true, ticket, byteLength: bytes.byteLength };
            handleSettlement(captured);
          }
          return;
        }
        handleSettlement(captured);
      } catch (error) {
        this.#faultAndFence("native-settlement-invalid", error);
      }
    };

    let rawAdmission: unknown;
    try {
      rawAdmission = this.#writer.writeBounded(toBuffer(bytes), nativeSettlement);
    } catch (error) {
      uncertainCall = true;
      const earlyTicket = settlementTicket(earlySettlement);
      if (earlySettlement && earlyTicket !== undefined) {
        admission = {
          accepted: true,
          ticket: earlyTicket,
          byteLength: bytes.byteLength,
        };
        handleSettlement(earlySettlement);
        return {
          kind: "accepted",
          ticket: admission.ticket,
          byteLength: bytes.byteLength,
          origin,
        };
      }
      this.#faultAndFence("native-write-threw", error);
      return {
        kind: "unknown",
        reason: "native-call-threw",
        byteLength: bytes.byteLength,
        cause: error,
      };
    }

    try {
      const parsedAdmission = parseAdmission(rawAdmission, bytes.byteLength);
      if (parsedAdmission?.kind === "accepted") {
        admission = {
          accepted: true,
          ticket: parsedAdmission.ticket,
          byteLength: bytes.byteLength,
        };
        if (earlySettlement) handleSettlement(earlySettlement);
        return {
          kind: "accepted",
          ticket: admission.ticket,
          byteLength: bytes.byteLength,
          origin,
        };
      }
      if (parsedAdmission?.kind === "rejected" && earlySettlement === undefined) {
        release();
        if (
          parsedAdmission.reason === "not-enabled" ||
          parsedAdmission.reason === "closed" ||
          parsedAdmission.reason === "error" ||
          parsedAdmission.reason === "empty" ||
          parsedAdmission.reason === "invalid-data" ||
          parsedAdmission.reason === "ticket-exhausted"
        ) {
          this.#faultAndFence(
            "native-admission-invalid",
            new Error("Unexpected native rejection: " + parsedAdmission.reason),
          );
        }
        return {
          kind: "rejected",
          reason: ("native-" + parsedAdmission.reason) as NativeInputRejectionReason,
          writtenBytes: 0,
        };
      }
    } catch (error) {
      uncertainCall = true;
      this.#faultAndFence("native-admission-invalid", error);
      return {
        kind: "unknown",
        reason: "native-admission-invalid",
        byteLength: bytes.byteLength,
        cause: error,
      };
    }

    uncertainCall = true;
    const earlyTicket = settlementTicket(earlySettlement);
    if (earlySettlement && earlyTicket !== undefined) {
      admission = {
        accepted: true,
        ticket: earlyTicket,
        byteLength: bytes.byteLength,
      };
      handleSettlement(earlySettlement);
    }
    const cause = new Error("Invalid native input admission");
    this.#faultAndFence("native-admission-invalid", cause);
    return {
      kind: "unknown",
      reason: "native-admission-invalid",
      byteLength: bytes.byteLength,
      cause,
    };
  }

  retire(): void {
    this.#fenced = true;
    this.#retireWriter();
  }

  markWriterClosed(): void {
    this.#fenced = true;
  }

  snapshot(): NativeInputSnapshot {
    return this.#localBudget.snapshot();
  }

  #faultAndFence(reason: NativeInputFault["reason"], cause?: unknown): void {
    this.#fenced = true;
    this.#reportFault(reason, cause);
    this.#retireWriter();
  }

  #retireWriter(): void {
    if (this.#retired) return;
    this.#retired = true;
    try {
      if (!this.#writer.disposeBoundedWrite()) {
        this.#reportFault("retire-input-failed", new Error("Bounded writer refused retirement"));
      }
    } catch (error) {
      this.#reportFault("retire-input-failed", error);
    }
  }

  #reportFault(reason: NativeInputFault["reason"], cause?: unknown): void {
    try {
      this.#onFault(cause === undefined ? { reason } : { reason, cause });
    } catch {
      // Fault reporting is observational. It cannot escape into node-pty and
      // perturb the native settlement/accounting stack.
    }
  }
}
