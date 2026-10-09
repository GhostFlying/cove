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
import { RunEventSchema, type BaselineControl, type RunEvent } from "@cove/protocol/terminal";
import { createLogicalGridCheckpoint } from "./logical-grid-checkpoint.js";
import { BoundedRecoveryTail } from "./recovery-checkpoint.js";
import { createScreenPreview } from "./terminal-preview.js";
import { TerminalQueryResponder } from "./terminal-query-responder.js";
import { assertPinnedRecoveryPackages, readPrivateRecoveryState } from "./xterm-recovery-state.js";

const PREVIEW_MAX_CELLS = 120 * 40;

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
  // Control authority after the fact at atSeq, taken in the same model turn as the screen.
  readonly control: BaselineControl;
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
export interface RetainedBytesLease {
  release(): void;
}
export type RetainedBytesReservation = (bytes: number) => RetainedBytesLease | undefined;
export interface TerminalModelOptions {
  readonly run: RunRef;
  readonly geometry: Geometry;
  readonly appearance?: Appearance;
  readonly effectiveBudgets?: EffectiveBudgets;
  readonly onAutomaticOutput: (output: AutomaticOutput) => void;
  readonly reserveRetainedBytes?: RetainedBytesReservation;
  readonly availableRetainedBytes?: () => number;
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
  readonly lease?: RetainedBytesLease;
  readonly run: () => Promise<unknown>;
  readonly resolve: (result: unknown) => void;
  readonly disposedResult: unknown;
  readonly faultedResult: (reason: string) => unknown;
  readonly settledState: boolean;
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
  readonly #reserveRetainedBytes: RetainedBytesReservation | undefined;
  readonly #availableRetainedBytes: (() => number) | undefined;
  #checkpoint: Checkpoint | null = null;
  #checkpointLease: RetainedBytesLease | undefined;
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
  // The last ordered control fact's authority. The model applies control facts in seq order with
  // every other fact, so the value read in a capture turn is exactly the authority at parsedSeq.
  #control: BaselineControl = { epoch: 0, holder: null };
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
    this.#reserveRetainedBytes = options.reserveRetainedBytes;
    this.#availableRetainedBytes = options.availableRetainedBytes;
    this.#sink = options.onAutomaticOutput;
    this.#admittedGeometry = { ...geometry.data };
    this.#tail = new BoundedRecoveryTail(budgets.baselineTailBytes, this.#reserveRetainedBytes);
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
      this.#checkpointLease?.release();
      this.#tail.resetAfterProvedCheckpoint();
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
    let bytes: Uint8Array | undefined;
    const admitted = this.#enqueue<EngineResult<EngineState>>(
      output ? payload!.length : 0,
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
            this.#control = { epoch: event.epoch, holder: structuredClone(event.holder) };
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
      (reason) => failure("faulted", reason),
      true,
      output
        ? () => {
            bytes = payload!.slice();
          }
        : undefined,
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
    let owned: Uint8Array;
    const admitted = this.#enqueue<EngineResult<EngineState>>(
      bytes.length,
      async () => {
        this.#currentOutputSeq = null;
        await this.#write(owned);
        if (this.#disposed) return failure("disposed", "Terminal model disposed");
        if (this.#fault) return failure("faulted", this.#fault);
        return success(this.#state());
      },
      failure("disposed", "Terminal model disposed"),
      (reason) => failure("faulted", reason),
      true,
      () => {
        owned = bytes.slice();
      },
    );
    if (!admitted.ok) return Promise.resolve(admitted.error);
    this.#fenced = true;
    this.#checkpoint = null;
    this.#checkpointLease?.release();
    this.#checkpointLease = undefined;
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
      (reason) => failure("faulted", reason),
      true,
    );
    return admitted.ok ? admitted.promise : Promise.resolve(admitted.error);
  }

  currentState(): EngineState {
    return this.#state();
  }

  captureBaseline(reserveDetached?: (bytes: number) => boolean): Promise<EngineBaselineResult> {
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
        if (reserveDetached) {
          let reserved = false;
          try {
            reserved = reserveDetached(copyBytes + 4096);
          } catch {
            return { status: "unavailable", reason: "Detached baseline reservation failed" };
          }
          if (!reserved)
            return {
              status: "unavailable",
              reason: "Detached baseline exceeds worker retention capacity",
            };
          if (this.#disposed) return { status: "disposed", reason: "Terminal model disposed" };
        }
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
            control: structuredClone(this.#control),
            vt: checkpoint.vt.slice(),
            tail: this.#tail.snapshot(),
            appearance: structuredClone(checkpoint.appearance),
          },
        };
      },
      { status: "disposed", reason: "Terminal model disposed" },
      (reason) => ({ status: "faulted", reason }),
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
        // The preview scratch reservation charges 512 bytes per cell, sized for the original
        // 120x40 grid. Larger grids would reserve most of the shared worker budget on every
        // refresh and could starve recovery checkpoints, so they report no preview instead.
        if (this.#terminal.cols * this.#terminal.rows > PREVIEW_MAX_CELLS)
          return { status: "unavailable", reason: "Current-screen preview exceeds grid cap" };
        const scratchBytes =
          this.#budgets.previewBytesPerRun + 512 * this.#terminal.cols * this.#terminal.rows + 256;
        const scratchLease = this.#reserveRetainedBytes?.(scratchBytes);
        if (this.#reserveRetainedBytes && !scratchLease)
          return {
            status: "unavailable",
            reason: "Preview scratch exceeds worker retention capacity",
          };
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
        } finally {
          scratchLease?.release();
        }
      },
      { status: "disposed", reason: "Terminal model disposed" },
      (reason) => ({ status: "faulted", reason }),
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
    this.#checkpointLease?.release();
    this.#checkpointLease = undefined;
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
    faultedResult: (reason: string) => T,
    settledState = false,
    copy?: () => void,
  ): { ok: true; promise: Promise<T> } | { ok: false; error: EngineResult<never> & { ok: false } } {
    if (
      this.#outstanding.size >= this.#budgets.pendingWorkerCommands ||
      bytes > this.#budgets.parseHardBytes - this.#queuedBytes
    )
      return { ok: false, error: failure("capacity", "Engine FIFO capacity exceeded") };
    const lease = this.#reserveRetainedBytes?.(bytes + 64);
    if (this.#reserveRetainedBytes && !lease)
      return { ok: false, error: failure("capacity", "Worker retention capacity exceeded") };
    try {
      copy?.();
    } catch {
      lease?.release();
      return { ok: false, error: failure("capacity", "Engine payload copy failed") };
    }
    const promise = new Promise<T>((resolve) => {
      const item: Queued = {
        bytes,
        ...(lease && { lease }),
        run,
        resolve: (value) => resolve(value as T),
        disposedResult,
        faultedResult,
        settledState,
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
      if (this.#fault) {
        this.#settle(item, item.faultedResult(this.#fault));
        continue;
      }
      let result: unknown;
      try {
        result = await item.run();
      } catch {
        this.#fault = "Terminal model operation failed";
        result = item.faultedResult(this.#fault);
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
    item.lease?.release();
    if (
      item.settledState &&
      typeof result === "object" &&
      result !== null &&
      "ok" in result &&
      result.ok === true
    )
      item.resolve(success(this.#state()));
    else item.resolve(result);
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
    this.#checkpointLease?.release();
    this.#checkpointLease = undefined;
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
    let settersLease: RetainedBytesLease | undefined;
    let scratchLease: RetainedBytesLease | undefined;
    let candidateLease: RetainedBytesLease | undefined;
    try {
      // Palette setters have at most 256 fixed-size entries under the profile.
      settersLease = this.#reserveRetainedBytes?.(16_512);
      if (this.#reserveRetainedBytes && !settersLease)
        throw new Error("Checkpoint setters exceed worker retention capacity");
      const setters = this.#query.checkpointSetters();
      if (setters.length >= this.#budgets.baselineVtBytes)
        throw new Error("Appearance setters exceed VT cap");
      const available = this.#availableRetainedBytes?.() ?? this.#budgets.workerBytes;
      const gridCap = Math.min(
        this.#budgets.baselineVtBytes - setters.length,
        Math.floor((available - 512 - 3 * setters.length) / 7),
      );
      if (gridCap < 1) throw new Error("Checkpoint scratch exceeds worker retention capacity");
      // 3 encoded copies, 2 text-unit copies, final VT and fixed checkpoint metadata.
      scratchLease = this.#reserveRetainedBytes?.(6 * gridCap + 2 * setters.length + 256);
      if (this.#reserveRetainedBytes && !scratchLease)
        throw new Error("Checkpoint scratch exceeds worker retention capacity");
      const candidate = createLogicalGridCheckpoint(
        this.#terminal,
        this.#outputBytes,
        gridCap,
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
      candidateLease = this.#reserveRetainedBytes?.(vt.length + 256);
      if (this.#reserveRetainedBytes && !candidateLease)
        throw new Error("Checkpoint retention exceeds worker capacity");
      scratchLease?.release();
      scratchLease = undefined;
      const historyLines = Math.max(0, this.#terminal.buffer.normal.length - this.#terminal.rows);
      this.#checkpointLease?.release();
      this.#checkpointLease = candidateLease;
      candidateLease = undefined;
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
        error instanceof Error && error.message.includes("capacity")
          ? "Checkpoint retention capacity exceeded"
          : "Checkpoint construction failed";
    } finally {
      candidateLease?.release();
      scratchLease?.release();
      settersLease?.release();
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
