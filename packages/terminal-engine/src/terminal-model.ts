import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";
import { M0_LIMITS, validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import { RunRefSchema, sameRunRef, type RunRef } from "@cove/protocol/identity";
import {
  BASELINE_ENCODING,
  DEFAULT_APPEARANCE,
  GeometrySchema,
  PROFILE,
  QUERY_SUPPORT,
  validateAppearance,
  type Appearance,
  type Geometry,
  type RecoveryCoverage,
} from "@cove/protocol/profile";
import { RunEventSchema, type RunEvent } from "@cove/protocol/terminal";
import { createLogicalGridCheckpoint } from "./logical-grid-checkpoint.js";
import { BoundedRecoveryTail } from "./recovery-checkpoint.js";
import { createScreenPreview } from "./terminal-preview.js";
import { TerminalQueryResponder } from "./terminal-query-responder.js";
import { assertPinnedRecoveryPackages, readPrivateRecoveryState } from "./xterm-recovery-state.js";

export type EngineErrorCode = "invalid" | "capacity" | "disposed" | "faulted";
export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: EngineErrorCode; readonly reason: string };
    };
export interface EngineState {
  readonly receivedSeq: number;
  readonly parsedSeq: number;
  readonly geometry: Geometry;
  readonly appearance: Appearance;
  readonly appearanceEpoch: number;
  readonly supportedQueryIds: readonly string[];
  readonly knownPaletteIndices: readonly number[];
  readonly activeBuffer: "normal" | "alternate";
  readonly focusReportMode: boolean;
  readonly recovery: {
    readonly state: "ready" | "waiting-checkpoint" | "unavailable";
    readonly reason?: string;
  };
  readonly resources: {
    readonly queuedBytes: number;
    readonly pendingOperations: number;
    readonly checkpointBytes: number;
    readonly tailBytes: number;
    readonly tailAllocatedBytes: number;
    readonly peakAccountedBytes: number;
  };
}
export interface EngineBaseline {
  readonly profile: typeof PROFILE;
  readonly encoding: typeof BASELINE_ENCODING;
  readonly checkpointSeq: number;
  readonly atSeq: number;
  readonly captureGeometry: Geometry;
  readonly currentGeometry: Geometry;
  readonly coverage: RecoveryCoverage;
  readonly vt: Uint8Array;
  readonly tail: Uint8Array;
  readonly appearance: Appearance;
}
export type EngineBaselineResult =
  | { readonly status: "ready"; readonly baseline: EngineBaseline }
  | {
      readonly status: "waiting-checkpoint" | "unavailable" | "disposed" | "faulted";
      readonly reason: string;
    };
export interface EnginePreview {
  readonly atSeq: number;
  readonly geometry: Geometry;
  readonly vt: Uint8Array;
}
export type EnginePreviewResult =
  | { readonly status: "ready"; readonly preview: EnginePreview }
  | { readonly status: "unavailable" | "disposed" | "faulted"; readonly reason: string };
export interface AutomaticOutput {
  readonly atSeq: number | null;
  readonly kind: "query" | "focus";
  readonly bytes: Uint8Array;
}
export interface TerminalModelOptions {
  readonly run: RunRef;
  readonly geometry: Geometry;
  readonly appearance?: Appearance;
  readonly effectiveBudgets?: EffectiveBudgets;
  readonly onAutomaticOutput: (output: AutomaticOutput) => void;
}

interface Checkpoint {
  readonly vt: Uint8Array;
  readonly seq: number;
  readonly geometry: Geometry;
  readonly coverage: RecoveryCoverage;
  readonly appearance: Appearance;
}
interface Queued {
  readonly bytes: number;
  readonly run: () => Promise<unknown>;
  readonly resolve: (result: unknown) => void;
  readonly disposedResult: unknown;
  settled: boolean;
}
const failure = (code: EngineErrorCode, reason: string): EngineResult<never> & { ok: false } => ({
  ok: false,
  error: { code, reason },
});
const success = <T>(value: T): EngineResult<T> => ({ ok: true, value });
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } =
  require("@xterm/headless") as typeof import("@xterm/headless");

// All mutating and capture work shares this FIFO; only the worker assigns run-event seq.
export class TerminalModel {
  readonly #run: RunRef;
  readonly #terminal: Terminal;
  readonly #budgets: EffectiveBudgets;
  readonly #query: TerminalQueryResponder;
  readonly #sink: (output: AutomaticOutput) => void;
  readonly #tail: BoundedRecoveryTail;
  #checkpoint: Checkpoint | null = null;
  #queue: Queued[] = [];
  #outstanding = new Set<Queued>();
  #busy = false;
  #cancelWrite: (() => void) | null = null;
  #receivedSeq = 0;
  #parsedSeq = 0;
  #outputBytes = 0;
  #queuedBytes = 0;
  #peakAccountedBytes = 0;
  #admittedGeometry: Geometry;
  #presence = false;
  #currentOutputSeq: number | null = null;
  #disposed = false;
  #fenced = false;
  #fault: string | null = null;
  #privateFailure = false;
  #recoveryReason = "";
  #historyTruncated = false;

  constructor(options: TerminalModelOptions) {
    const run = RunRefSchema.safeParse(options.run);
    const geometry = GeometrySchema.safeParse(options.geometry);
    const budgets = validateEffectiveBudgets(options.effectiveBudgets ?? M0_LIMITS);
    const appearance = validateAppearance(options.appearance ?? DEFAULT_APPEARANCE);
    if (
      !run.success ||
      !geometry.success ||
      !budgets ||
      !appearance ||
      geometry.data.cols > budgets.maxCols ||
      geometry.data.rows > budgets.maxRows ||
      typeof options.onAutomaticOutput !== "function"
    )
      throw new Error("Invalid terminal model options");
    assertPinnedRecoveryPackages();
    this.#run = run.data;
    this.#budgets = budgets;
    this.#sink = options.onAutomaticOutput;
    this.#admittedGeometry = { ...geometry.data };
    this.#tail = new BoundedRecoveryTail(budgets.baselineTailBytes);
    this.#terminal = new HeadlessTerminal({
      cols: geometry.data.cols,
      rows: geometry.data.rows,
      scrollback: budgets.historyLines,
      allowProposedApi: true,
    });
    try {
      this.#query = new TerminalQueryResponder(this.#terminal, appearance, (kind, bytes) => {
        if (this.#disposed || this.#fault) return;
        try {
          this.#sink({ atSeq: this.#currentOutputSeq, kind, bytes: bytes.slice() });
        } catch {
          this.#fault = "Automatic output sink failed";
        }
      });
      this.#refreshCheckpoint();
      if (!this.#checkpoint)
        throw new Error(this.#recoveryReason || "Initial checkpoint unavailable");
    } catch (error) {
      this.#terminal.dispose();
      throw error;
    }
  }

  apply(input: RunEvent, payload?: Uint8Array): Promise<EngineResult<EngineState>> {
    const blocked = this.#admissionError<EngineState>();
    if (blocked) return Promise.resolve(blocked);
    const parsed = RunEventSchema.safeParse(input);
    if (
      !parsed.success ||
      !sameRunRef(parsed.data.run, this.#run) ||
      this.#receivedSeq === Number.MAX_SAFE_INTEGER ||
      parsed.data.seq !== this.#receivedSeq + 1
    )
      return Promise.resolve(failure("invalid", "Run event identity or sequence is invalid"));
    const event = parsed.data;
    const output = event.type === "output";
    if (
      (output &&
        (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > 65_536)) ||
      (!output && payload !== undefined)
    )
      return Promise.resolve(failure("invalid", "Run event payload is invalid"));
    if (
      event.type === "resize" &&
      (event.geometry.cols > this.#budgets.maxCols || event.geometry.rows > this.#budgets.maxRows)
    )
      return Promise.resolve(failure("invalid", "Resize exceeds effective geometry"));
    if (
      event.type === "control" &&
      (event.geometry.cols !== this.#admittedGeometry.cols ||
        event.geometry.rows !== this.#admittedGeometry.rows)
    )
      return Promise.resolve(failure("invalid", "Control geometry differs from ordered model"));
    if (event.type === "appearance" && !validateAppearance(event.appearance))
      return Promise.resolve(failure("invalid", "Appearance is invalid"));
    const bytes = output ? payload!.slice() : undefined;
    const admitted = this.#enqueue<EngineResult<EngineState>>(
      bytes?.length ?? 0,
      async () => {
        if (this.#disposed) return failure("disposed", "Terminal model disposed");
        this.#currentOutputSeq = event.seq;
        try {
          if (event.type === "output") {
            await this.#write(bytes!);
            if (this.#disposed) return failure("disposed", "Terminal model disposed");
            this.#outputBytes += bytes!.length;
            this.#tail.append(bytes!);
            if (
              this.#terminal.buffer.normal.length >=
              this.#terminal.rows + this.#budgets.historyLines
            )
              this.#historyTruncated = true;
          } else if (event.type === "resize") {
            if (
              this.#terminal.cols !== event.geometry.cols ||
              this.#terminal.rows !== event.geometry.rows
            ) {
              this.#terminal.resize(event.geometry.cols, event.geometry.rows);
              this.#invalidateCheckpoint("Geometry changed before a new checkpoint");
            }
          } else if (event.type === "appearance") {
            this.#query.setAppearance(event.appearance);
            this.#invalidateCheckpoint("Appearance changed before a new checkpoint");
          } else if (event.type === "control") {
            const present = event.holder !== null;
            if (present !== this.#presence && this.#terminal.modes.sendFocusMode)
              this.#query.emitFocus(present);
            this.#presence = present;
          }
          this.#parsedSeq = event.seq;
          if (
            !this.#fenced &&
            (this.#checkpoint === null ||
              !this.#tail.available ||
              this.#tail.retainedBytes >= Math.max(1, Math.floor(this.#tail.cap / 2)))
          )
            this.#refreshCheckpoint();
          if (this.#fault) return failure("faulted", this.#fault);
          return success(this.#state());
        } finally {
          this.#currentOutputSeq = null;
        }
      },
      failure("disposed", "Terminal model disposed"),
    );
    if (admitted.ok) {
      this.#receivedSeq = event.seq;
      if (event.type === "resize") this.#admittedGeometry = { ...event.geometry };
      return admitted.promise;
    }
    return Promise.resolve(admitted.error);
  }

  continueUnpublishedOutput(bytes: Uint8Array): Promise<EngineResult<EngineState>> {
    if (this.#disposed) return Promise.resolve(failure("disposed", "Terminal model disposed"));
    if (this.#fault) return Promise.resolve(failure("faulted", this.#fault));
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 65_536)
      return Promise.resolve(failure("invalid", "Unpublished output payload is invalid"));
    const owned = bytes.slice();
    const admitted = this.#enqueue<EngineResult<EngineState>>(
      owned.length,
      async () => {
        this.#currentOutputSeq = null;
        await this.#write(owned);
        if (this.#disposed) return failure("disposed", "Terminal model disposed");
        if (this.#fault) return failure("faulted", this.#fault);
        return success(this.#state());
      },
      failure("disposed", "Terminal model disposed"),
    );
    if (!admitted.ok) return Promise.resolve(admitted.error);
    this.#fenced = true;
    this.#checkpoint = null;
    this.#tail.resetAfterProvedCheckpoint();
    return admitted.promise;
  }

  barrier(): Promise<EngineResult<EngineState>> {
    const blocked = this.#admissionError<EngineState>(true);
    if (blocked) return Promise.resolve(blocked);
    const admitted = this.#enqueue<EngineResult<EngineState>>(
      0,
      async () => success(this.#state()),
      failure("disposed", "Terminal model disposed"),
    );
    return admitted.ok ? admitted.promise : Promise.resolve(admitted.error);
  }

  captureBaseline(): Promise<EngineBaselineResult> {
    const blocked = this.#captureBlock();
    if (blocked) return Promise.resolve(blocked);
    const admitted = this.#enqueue<EngineBaselineResult>(
      0,
      async (): Promise<EngineBaselineResult> => {
        if (this.#disposed) return { status: "disposed", reason: "Terminal model disposed" };
        if (this.#fault) return { status: "faulted", reason: this.#fault };
        if (this.#checkpoint?.seq !== this.#parsedSeq) this.#refreshCheckpoint();
        if (!this.#checkpoint || !this.#tail.available || this.#privateFailure)
          return {
            status:
              this.#privateFailure || !this.#tail.available ? "unavailable" : "waiting-checkpoint",
            reason: this.#recoveryReason || "No valid bounded checkpoint",
          };
        const checkpoint = this.#checkpoint;
        const copyBytes = checkpoint.vt.length + this.#tail.retainedBytes;
        if (this.#accountedBytes(copyBytes) > this.#budgets.workerBytes)
          return { status: "unavailable", reason: "Detached baseline exceeds engine resource cap" };
        return {
          status: "ready",
          baseline: {
            profile: PROFILE,
            encoding: BASELINE_ENCODING,
            checkpointSeq: checkpoint.seq,
            atSeq: this.#parsedSeq,
            captureGeometry: { ...checkpoint.geometry },
            currentGeometry: { cols: this.#terminal.cols, rows: this.#terminal.rows },
            coverage: structuredClone(checkpoint.coverage),
            vt: checkpoint.vt.slice(),
            tail: this.#tail.snapshot(),
            appearance: structuredClone(checkpoint.appearance),
          },
        };
      },
      { status: "disposed", reason: "Terminal model disposed" },
    );
    return admitted.ok
      ? admitted.promise
      : Promise.resolve({ status: "unavailable", reason: admitted.error.error.reason });
  }

  capturePreview(): Promise<EnginePreviewResult> {
    if (this.#disposed)
      return Promise.resolve({ status: "disposed", reason: "Terminal model disposed" });
    if (this.#fault) return Promise.resolve({ status: "faulted", reason: this.#fault });
    if (this.#fenced)
      return Promise.resolve({ status: "unavailable", reason: "Run event delivery is fenced" });
    const admitted = this.#enqueue<EnginePreviewResult>(
      0,
      async () => {
        if (this.#disposed) return { status: "disposed", reason: "Terminal model disposed" };
        if (this.#fault) return { status: "faulted", reason: this.#fault };
        try {
          const vt = createScreenPreview(this.#terminal, this.#budgets.previewBytesPerRun);
          return {
            status: "ready",
            preview: {
              atSeq: this.#parsedSeq,
              geometry: { cols: this.#terminal.cols, rows: this.#terminal.rows },
              vt,
            },
          };
        } catch (error) {
          return {
            status: "unavailable",
            reason: error instanceof Error ? error.message : "Preview construction failed",
          };
        }
      },
      { status: "disposed", reason: "Terminal model disposed" },
    );
    return admitted.ok
      ? admitted.promise
      : Promise.resolve({ status: "unavailable", reason: admitted.error.error.reason });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelWrite?.();
    this.#cancelWrite = null;
    for (const item of this.#outstanding) this.#settle(item, item.disposedResult);
    this.#queue = [];
    this.#query.dispose();
    this.#terminal.dispose();
    this.#checkpoint = null;
    this.#tail.resetAfterProvedCheckpoint();
  }

  #admissionError<T>(allowFenced = false): EngineResult<T> | null {
    if (this.#disposed) return failure("disposed", "Terminal model disposed");
    if (this.#fault) return failure("faulted", this.#fault);
    if (this.#fenced && !allowFenced) return failure("invalid", "Run event delivery is fenced");
    return null;
  }

  #captureBlock(): EngineBaselineResult | null {
    if (this.#disposed) return { status: "disposed", reason: "Terminal model disposed" };
    if (this.#fault) return { status: "faulted", reason: this.#fault };
    if (this.#fenced) return { status: "unavailable", reason: "Run event delivery is fenced" };
    return null;
  }

  #enqueue<T>(
    bytes: number,
    run: () => Promise<T>,
    disposedResult: T,
  ): { ok: true; promise: Promise<T> } | { ok: false; error: EngineResult<never> & { ok: false } } {
    if (
      this.#outstanding.size >= this.#budgets.pendingWorkerCommands ||
      bytes > this.#budgets.parseHardBytes - this.#queuedBytes
    )
      return { ok: false, error: failure("capacity", "Engine FIFO capacity exceeded") };
    const promise = new Promise<T>((resolve) => {
      const item: Queued = {
        bytes,
        run,
        resolve: (value) => resolve(value as T),
        disposedResult,
        settled: false,
      };
      this.#queue.push(item);
      this.#outstanding.add(item);
      this.#queuedBytes += bytes;
      queueMicrotask(() => void this.#drain());
    });
    return { ok: true, promise };
  }

  async #drain(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    while (!this.#disposed && this.#queue.length) {
      const item = this.#queue.shift()!;
      let result: unknown;
      try {
        result = await item.run();
      } catch {
        this.#fault = "Terminal model operation failed";
        result = failure("faulted", this.#fault);
      }
      this.#settle(item, result);
    }
    this.#busy = false;
  }

  #settle(item: Queued, result: unknown): void {
    if (item.settled) return;
    item.settled = true;
    this.#outstanding.delete(item);
    this.#queuedBytes -= item.bytes;
    item.resolve(result);
  }

  #write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.#cancelWrite = null;
        resolve();
      };
      this.#cancelWrite = finish;
      this.#terminal.write(bytes, finish);
    });
  }

  #invalidateCheckpoint(reason: string): void {
    this.#checkpoint = null;
    this.#tail.resetAfterProvedCheckpoint();
    this.#recoveryReason = reason;
  }

  #refreshCheckpoint(): void {
    if (this.#disposed || this.#fenced || this.#privateFailure) return;
    let privateState;
    try {
      privateState = readPrivateRecoveryState(this.#terminal);
    } catch {
      this.#privateFailure = true;
      this.#recoveryReason = "Pinned engine private state changed";
      return;
    }
    if (
      privateState.parserState !== privateState.initialParserState ||
      privateState.utf8Interim.some(Boolean)
    ) {
      this.#recoveryReason = "Parser or UTF-8 sequence remains incomplete";
      return;
    }
    try {
      const setters = this.#query.checkpointSetters();
      if (setters.length >= this.#budgets.baselineVtBytes)
        throw new Error("Appearance setters exceed VT cap");
      const candidate = createLogicalGridCheckpoint(
        this.#terminal,
        this.#outputBytes,
        this.#budgets.baselineVtBytes - setters.length,
        this.#budgets.historyLines,
      );
      const vt = new Uint8Array(setters.length + candidate.vt.length);
      vt.set(setters);
      vt.set(candidate.vt, setters.length);
      const peak = this.#accountedBytes(
        candidate.metrics.accountedPayloadBytes + setters.length * 2 + vt.length,
      );
      if (peak > this.#budgets.workerBytes)
        throw new Error("Checkpoint replacement exceeds engine resource cap");
      this.#peakAccountedBytes = Math.max(this.#peakAccountedBytes, peak);
      const historyLines = Math.max(0, this.#terminal.buffer.normal.length - this.#terminal.rows);
      this.#checkpoint = {
        vt,
        seq: this.#parsedSeq,
        geometry: { cols: this.#terminal.cols, rows: this.#terminal.rows },
        coverage: {
          normal: {
            historyLines,
            includedHistoryLines: historyLines,
            trimmedBefore: this.#historyTruncated,
            resizeContext: "requires-baseline",
          },
          alternate: { included: true, resizeContext: "requires-baseline" },
        },
        appearance: this.#query.appearance,
      };
      this.#tail.resetAfterProvedCheckpoint();
      this.#recoveryReason = "";
    } catch (error) {
      this.#recoveryReason =
        error instanceof Error ? error.message : "Checkpoint construction failed";
    }
  }

  #accountedBytes(extra = 0): number {
    return (
      (this.#checkpoint?.vt.length ?? 0) + this.#tail.allocatedBytes + this.#queuedBytes + extra
    );
  }

  #state(): EngineState {
    const recovery =
      this.#fenced || this.#privateFailure || !this.#tail.available
        ? { state: "unavailable" as const, reason: this.#recoveryReason || "No bounded raw tail" }
        : this.#checkpoint
          ? { state: "ready" as const }
          : { state: "waiting-checkpoint" as const, reason: this.#recoveryReason };
    return {
      receivedSeq: this.#receivedSeq,
      parsedSeq: this.#parsedSeq,
      geometry: { cols: this.#terminal.cols, rows: this.#terminal.rows },
      appearance: this.#query.appearance,
      appearanceEpoch: this.#query.appearanceEpoch,
      supportedQueryIds: QUERY_SUPPORT.map(({ id }) => id),
      knownPaletteIndices: this.#query.knownPaletteIndices,
      activeBuffer: this.#terminal.buffer.active.type,
      focusReportMode: this.#terminal.modes.sendFocusMode,
      recovery,
      resources: {
        queuedBytes: this.#queuedBytes,
        pendingOperations: this.#outstanding.size,
        checkpointBytes: this.#checkpoint?.vt.length ?? 0,
        tailBytes: this.#tail.retainedBytes,
        tailAllocatedBytes: this.#tail.allocatedBytes,
        peakAccountedBytes: this.#peakAccountedBytes,
      },
    };
  }
}

export function createTerminalModel(options: TerminalModelOptions): TerminalModel {
  return new TerminalModel(options);
}
