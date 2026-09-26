import type { Appearance, Geometry } from "./profile.js";
import type { RunRef, SubscriptionRef, WorkerRef } from "./identity.js";
import type { EffectiveBudgets } from "./budgets.js";
import type { PipeCommand, PipeResult, PipeError, PipeEvent, RunStatus } from "./pipe.js";

export type RuntimeResult = PipeResult | PipeError;

export interface RuntimeTerminalPort {
  spawn(input: {
    worker: WorkerRef;
    run: RunRef;
    requestId: string;
    operationId: string;
    executable: string;
    argv: readonly string[];
    cwd: string;
    geometry: Geometry;
    appearance: Appearance;
    effectiveBudgets: EffectiveBudgets;
    profile: "pragmatic-logical-grid-v1";
  }): Promise<RuntimeResult>;
  stop(input: Extract<PipeCommand, { type: "stop" }>): Promise<RuntimeResult>;
  setControl(input: Extract<PipeCommand, { type: "set-control" }>): Promise<RuntimeResult>;
  writeInput(
    input: Extract<PipeCommand, { type: "input" }>,
    bytes: Uint8Array,
  ): Promise<RuntimeResult>;
  resize(input: Extract<PipeCommand, { type: "resize" }>): Promise<RuntimeResult>;
  setAppearance(input: Extract<PipeCommand, { type: "appearance" }>): Promise<RuntimeResult>;
  openSubscription(
    input: Extract<PipeCommand, { type: "subscribe" | "recover" }>,
  ): Promise<RuntimeResult>;
  closeSubscription(input: Extract<PipeCommand, { type: "unsubscribe" }>): Promise<RuntimeResult>;
  ackApplied(input: Extract<PipeCommand, { type: "applied-ack" }>): Promise<RuntimeResult>;
  ackBaselineProgress(
    input: Extract<PipeCommand, { type: "baseline-progress" }>,
  ): Promise<RuntimeResult>;
  getStatus(input: Extract<PipeCommand, { type: "status" }>): Promise<RunStatus>;
  refreshPreview(input: Extract<PipeCommand, { type: "preview-refresh" }>): Promise<RuntimeResult>;
  onEvent(listener: (event: PipeEvent, payload: Uint8Array) => void): { dispose(): void };
}

export type RuntimePreviewCache = {
  run: RunRef;
  version: number;
  generatedAtMs: number;
  checkedAtMs: number;
  stale: boolean;
  status: RunStatus;
  vt: Uint8Array;
};

export type RuntimeSubscriptionRoute = {
  run: RunRef;
  subscription: SubscriptionRef;
  worker: WorkerRef;
};
