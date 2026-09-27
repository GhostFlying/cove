import { M0_LIMITS, validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import { domainError, type DomainErrorKind } from "@cove/protocol/errors";
import {
  sameRunRef,
  sameWorkerRef,
  workerMatchesRun,
  WorkerRefSchema,
  type RunRef,
  type SubscriptionRef,
  type WorkerRef,
} from "@cove/protocol/identity";
import {
  PipeCommandSchema,
  validateSpawnPayload,
  type PipeCommand,
  type PipeError,
  type PipeResult,
  type RunStatus,
} from "@cove/protocol/pipe";
import { PROFILE, validateAppearance, type Geometry } from "@cove/protocol/profile";
import { createNativePtyFactory, type NativePtyFactory } from "./native-pty.js";
import {
  createWorkerRunSession,
  type RunSession,
  type RunSessionDisposalReceipt,
  type RunSessionOperation,
  type RunSessionOperationResult,
  type RunSessionOptions,
  type RunSessionSnapshot,
  type WorkerRunSessionCapability,
} from "./run-session.js";
import { WorkerRetainedBytes, type RetainedLease } from "./worker-retained-bytes.js";

export { createRunSession } from "./run-session.js";
export type {
  RunSession,
  RunSessionDisposalReceipt,
  RunSessionFault,
  RunSessionOptions,
  RunSessionSnapshot,
  RunSessionStart,
} from "./run-session.js";

const RUN_RECORD_BYTES = 6144;
const INPUT_KEY_BYTES = 192;
const COMMAND_RECORD_BYTES = 128;
const MAX_INPUT_BYTES = 65_536;

interface RunRecord {
  readonly run: RunRef;
  readonly session?: RunSession;
  readonly capability?: WorkerRunSessionCapability;
  readonly initialGeometry: Geometry;
  lastStatus?: RunStatus;
  stopReceipt?: RunSessionDisposalReceipt;
}

export interface WorkerExecutionOptions {
  readonly worker: WorkerRef;
  readonly effectiveBudgets: EffectiveBudgets;
  readonly factory?: NativePtyFactory;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onFact?: RunSessionOptions["onFact"];
  readonly onFault?: RunSessionOptions["onFault"];
}

export interface WorkerExecutionSnapshot {
  readonly worker: WorkerRef;
  readonly runIds: number;
  readonly pendingCommands: number;
  readonly ordinaryPendingCommands: number;
  readonly reservedStatusPending: boolean;
  readonly reservedStopPending: boolean;
  readonly inputIdentities: number;
  readonly accountedBytes: number;
  readonly peakAccountedBytes: number;
  readonly retainedBreakdown: ReturnType<WorkerRetainedBytes["snapshot"]>;
  readonly shuttingDown: boolean;
  readonly runs: readonly RunStatus[];
  readonly sessions: readonly { readonly run: RunRef; readonly snapshot: RunSessionSnapshot }[];
}

export interface WorkerExecution {
  execute(command: PipeCommand, payload?: Uint8Array): Promise<PipeResult | PipeError>;
  snapshot(): WorkerExecutionSnapshot;
  shutdown(reason: string): Promise<readonly RunSessionDisposalReceipt[]>;
}

function correlatedError(
  command: PipeCommand,
  kind: DomainErrorKind,
  acceptance: "not-accepted" | "unknown" = "not-accepted",
  input = false,
): PipeError {
  return {
    type: "error",
    worker: command.worker,
    run: command.run,
    requestId: command.requestId,
    commandType: command.type,
    error: domainError(kind, acceptance, input ? "input" : undefined),
  };
}

function accepted(command: PipeCommand, fields: Partial<PipeResult> = {}): PipeResult {
  return {
    type: "result",
    worker: command.worker,
    run: command.run,
    requestId: command.requestId,
    commandType: command.type,
    outcome: "accepted",
    ...fields,
  };
}

function resultError(command: PipeCommand, result: RunSessionOperationResult): PipeError {
  if (result.kind === "unknown")
    return correlatedError(command, "RESULT_UNKNOWN", "unknown", command.type === "input");
  const reason = result.kind === "rejected" ? result.reason : "session-fenced";
  const kind: DomainErrorKind =
    reason === "stale-control"
      ? "STALE_CONTROL"
      : reason === "input-sequence"
        ? "INPUT_REJECTED"
        : reason === "counter-exhausted"
          ? "COUNTER_EXHAUSTED"
          : reason === "input-identity-cap" || reason === "queue-full" || reason.includes("limit")
            ? "BUSY"
            : "WORKER_UNAVAILABLE";
  return correlatedError(command, kind);
}

function sameBudgets(left: EffectiveBudgets, right: EffectiveBudgets): boolean {
  return (Object.keys(M0_LIMITS) as (keyof EffectiveBudgets)[]).every(
    (key) => left[key] === right[key],
  );
}

function bytesForIdentity(run: RunRef): number {
  return (
    RUN_RECORD_BYTES +
    Buffer.byteLength(run.serverId) +
    Buffer.byteLength(run.relayInstanceId) +
    Buffer.byteLength(run.runId)
  );
}

function bytesForInputIdentity(subscription: SubscriptionRef): number {
  return (
    INPUT_KEY_BYTES +
    Buffer.byteLength(subscription.connection.connectionId) +
    Buffer.byteLength(subscription.viewId) +
    Buffer.byteLength(subscription.subscriptionId)
  );
}

class WorkerExecutionCore {
  readonly #worker: WorkerRef;
  readonly #budgets: EffectiveBudgets;
  readonly #factory: NativePtyFactory;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #onFact: RunSessionOptions["onFact"];
  readonly #onFault: RunSessionOptions["onFault"];
  readonly #runs = new Map<string, RunRecord>();
  readonly #pendingRequests = new Set<string>();
  readonly #account: WorkerRetainedBytes;
  readonly #workerLeases = new Map<number, RetainedLease[]>();
  #inputIdentities = 0;
  #ordinaryPendingCommands = 0;
  #reservedStatusPending = false;
  #reservedStopPending = false;
  #shuttingDown = false;
  #shutdownPromise: Promise<readonly RunSessionDisposalReceipt[]> | undefined;

  constructor(options: WorkerExecutionOptions) {
    const worker = WorkerRefSchema.safeParse(options.worker);
    const budgets = validateEffectiveBudgets(options.effectiveBudgets);
    if (!worker.success || !budgets) throw new TypeError("Invalid worker identity or budgets");
    this.#worker = Object.freeze({ ...worker.data });
    this.#budgets = budgets;
    this.#account = new WorkerRetainedBytes(budgets.workerBytes, budgets.reservedControlBytes);
    if (options.factory && options.factory.retainedBytesAccounting !== "participating")
      throw new TypeError("Injected native factory must participate in worker retention");
    this.#factory =
      options.factory ??
      createNativePtyFactory({
        maxOwners: budgets.maxRuns,
        aggregateInputBytes: budgets.workerBytes,
        aggregateInputTasks: budgets.pendingWorkerCommands,
        perPtyInputBytes: Math.min(budgets.inputQueueBytes, MAX_INPUT_BYTES, budgets.workerBytes),
        perPtyInputTasks: budgets.pendingWorkerCommands,
        earlyOutputBytes: budgets.parseHardBytes,
      });
    this.#env = options.env ?? process.env;
    this.#onFact = options.onFact;
    this.#onFault = options.onFault;
  }

  async execute(input: PipeCommand, payload?: Uint8Array): Promise<PipeResult | PipeError> {
    const parsed = PipeCommandSchema.safeParse(input);
    if (!parsed.success) throw new TypeError("Invalid pipe command at worker admission boundary");
    const command = parsed.data;
    if (
      !sameWorkerRef(command.worker, this.#worker) ||
      !workerMatchesRun(this.#worker, command.run)
    )
      return correlatedError(command, "INSTANCE_MISMATCH");
    if ("subscription" in command && !sameRunRef(command.run, command.subscription.run))
      return correlatedError(command, "INSTANCE_MISMATCH");
    if (
      "geometry" in command &&
      (command.geometry.cols > this.#budgets.maxCols ||
        command.geometry.rows > this.#budgets.maxRows)
    )
      return correlatedError(command, "INVALID_SIZE");
    if (
      (command.type === "appearance" || command.type === "set-control") &&
      command.appearance !== undefined &&
      !validateAppearance(command.appearance)
    )
      return correlatedError(command, "PROFILE_UNSUPPORTED");
    if (this.#shuttingDown) return correlatedError(command, "WORKER_UNAVAILABLE");
    if (this.#pendingRequests.has(command.requestId))
      return correlatedError(command, "OPERATION_ID_CONFLICT");
    const reservedStatus = command.type === "status";
    const reservedStop = command.type === "stop";
    if (
      reservedStatus
        ? this.#reservedStatusPending
        : reservedStop
          ? this.#reservedStopPending
          : this.#ordinaryPendingCommands >= this.#budgets.pendingWorkerCommands
    )
      return correlatedError(command, "BUSY");
    if (command.type !== "spawn" && command.type !== "input" && payload !== undefined)
      return correlatedError(command, "INPUT_REJECTED");
    if (
      command.type === "input" &&
      (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > MAX_INPUT_BYTES)
    )
      return correlatedError(command, "INPUT_REJECTED");
    if (command.type === "spawn" && !(payload instanceof Uint8Array))
      return correlatedError(command, "INPUT_REJECTED");
    const charge =
      reservedStatus || reservedStop
        ? 0
        : COMMAND_RECORD_BYTES +
          Buffer.byteLength(JSON.stringify(command)) +
          (payload?.byteLength ?? 0);
    if (charge && !this.#reserveBytes(charge)) return correlatedError(command, "BUSY");
    this.#pendingRequests.add(command.requestId);
    if (reservedStatus) this.#reservedStatusPending = true;
    else if (reservedStop) this.#reservedStopPending = true;
    else this.#ordinaryPendingCommands++;
    try {
      // Reserve before copying caller memory, which may be reused immediately.
      const copied = payload === undefined ? undefined : Buffer.from(payload);
      return await this.#executeAdmitted(command, copied);
    } finally {
      this.#pendingRequests.delete(command.requestId);
      if (reservedStatus) this.#reservedStatusPending = false;
      else if (reservedStop) this.#reservedStopPending = false;
      else this.#ordinaryPendingCommands--;
      if (charge) this.#releaseBytes(charge);
    }
  }

  async #executeAdmitted(command: PipeCommand, payload?: Buffer): Promise<PipeResult | PipeError> {
    if (command.type === "spawn") return this.#spawn(command, payload!);
    if (
      command.type === "subscribe" ||
      command.type === "recover" ||
      command.type === "unsubscribe" ||
      command.type === "applied-ack" ||
      command.type === "baseline-progress" ||
      command.type === "preview-refresh"
    )
      return correlatedError(command, "CAPABILITY_UNAVAILABLE");
    const record = this.#runs.get(command.run.runId);
    if (!record?.session || !record.capability) return correlatedError(command, "RUN_NOT_FOUND");
    if (command.type === "stop") {
      const stopped = await record.capability.execute({ type: "stop" });
      if (stopped.kind !== "stopped") return resultError(command, stopped);
      record.stopReceipt = stopped.receipt;
      return accepted(command, { operationId: command.operationId });
    }
    if (command.type === "status") {
      const observation = await record.capability.execute({
        type: "status",
        cached: this.#ordinaryPendingCommands > 0,
      });
      if (observation.kind === "settled") record.lastStatus = this.#runStatus(record, observation);
      const status = this.#runStatus(
        record,
        observation.kind === "settled" ? observation : undefined,
      );
      record.lastStatus = status;
      return accepted(command, { runStatus: status });
    }
    const operation: RunSessionOperation =
      command.type === "set-control"
        ? {
            type: "control",
            expectedEpoch: command.expectedEpoch,
            nextEpoch: command.nextEpoch,
            holder: command.holder,
            geometry: command.geometry,
            ...(command.appearance && { appearance: command.appearance }),
          }
        : command.type === "input"
          ? {
              type: "input",
              subscription: command.subscription,
              epoch: command.epoch,
              inputSeq: command.inputSeq,
              bytes: payload!,
            }
          : command.type === "resize"
            ? {
                type: "resize",
                subscription: command.subscription,
                epoch: command.epoch,
                geometry: command.geometry,
              }
            : {
                type: "appearance",
                subscription: command.subscription,
                epoch: command.epoch,
                appearance: command.appearance,
              };
    const result = await record.capability.execute(operation);
    if (result.kind === "settled") {
      record.lastStatus = this.#runStatus(record, result);
      return accepted(command, { atSeq: result.atSeq });
    }
    if (result.kind === "written") {
      return accepted(command, {
        atSeq: result.atSeq,
        inputSeq: command.type === "input" ? command.inputSeq : undefined,
        writtenBytes: result.writtenBytes,
      });
    }
    return resultError(command, result);
  }

  #spawn(
    command: Extract<PipeCommand, { type: "spawn" }>,
    payload: Buffer,
  ): PipeResult | PipeError {
    if (this.#runs.has(command.run.runId)) return correlatedError(command, "OPERATION_ID_CONFLICT");
    if (this.#runs.size >= this.#budgets.maxRuns) return correlatedError(command, "BUSY");
    if (command.profile !== PROFILE || !sameBudgets(command.effectiveBudgets, this.#budgets))
      return correlatedError(command, "PROFILE_UNSUPPORTED");
    if (!validateAppearance(command.appearance)) return correlatedError(command, "INPUT_REJECTED");
    if (
      command.geometry.cols > this.#budgets.maxCols ||
      command.geometry.rows > this.#budgets.maxRows
    )
      return correlatedError(command, "INVALID_SIZE");
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      return correlatedError(command, "INPUT_REJECTED");
    }
    const args = validateSpawnPayload(command, payload, decoded, (text) =>
      new TextEncoder().encode(text),
    );
    if (!args) return correlatedError(command, "INPUT_REJECTED");
    const identityBytes = bytesForIdentity(command.run);
    if (!this.#reserveBytes(identityBytes)) return correlatedError(command, "BUSY");
    const record: RunRecord = {
      run: Object.freeze({ ...command.run }),
      initialGeometry: command.geometry,
    };
    this.#runs.set(command.run.runId, record);
    let created: ReturnType<typeof createWorkerRunSession>;
    try {
      created = createWorkerRunSession({
        run: record.run,
        geometry: command.geometry,
        appearance: command.appearance,
        effectiveBudgets: this.#budgets,
        spawn: {
          file: args.executable,
          args: args.argv,
          cwd: args.cwd,
          env: this.#env,
          inputBytes: Math.min(this.#budgets.inputQueueBytes, this.#budgets.workerBytes),
          inputTasks: this.#budgets.pendingWorkerCommands,
        },
        factory: this.#factory,
        ...(this.#onFact && { onFact: this.#onFact }),
        ...(this.#onFault && { onFault: this.#onFault }),
        reserveIngressBytes: (bytes) => this.#reserveBytes(bytes),
        releaseIngressBytes: (bytes) => this.#releaseBytes(bytes),
        reserveRetainedBytes: (bytes) => this.#account.reserve("engine", bytes),
        availableRetainedBytes: () => this.#account.availableOrdinaryBytes(),
        reserveNativeRetainedBytes: (category, bytes) => this.#account.reserve(category, bytes),
        reserveInputIdentity: (subscription) => {
          if (this.#inputIdentities >= this.#budgets.pendingWorkerCommands) return false;
          const charge = bytesForInputIdentity(subscription);
          if (!this.#reserveBytes(charge)) return false;
          this.#inputIdentities++;
          return true;
        },
      });
    } catch (error) {
      return correlatedError(
        command,
        error instanceof Error && error.message.includes("capacity")
          ? "BUSY"
          : "WORKER_UNAVAILABLE",
      );
    }
    if (created.kind !== "created") {
      return correlatedError(
        command,
        created.kind === "rejected" ? "WORKER_UNAVAILABLE" : "RESULT_UNKNOWN",
        created.kind === "rejected" ? "not-accepted" : "unknown",
      );
    }
    Object.assign(record, { session: created.session, capability: created.capability });
    return accepted(command, { operationId: command.operationId, atSeq: 0 });
  }

  #runStatus(
    record: RunRecord,
    observation?: Extract<RunSessionOperationResult, { kind: "settled" }>,
  ): RunStatus {
    const snap = record.session!.snapshot();
    const previous = record.lastStatus;
    const state = observation?.state ?? snap.settledState;
    const leader = snap.leader.kind === "exit-observed" ? snap.leader.exit : undefined;
    const status = leader ? "exited" : snap.disposed || snap.faulted ? "unverifiable" : "live";
    return {
      run: record.run,
      status,
      geometry: state?.geometry ?? snap.geometry ?? previous?.geometry ?? record.initialGeometry,
      controlEpoch: snap.controlEpoch,
      controlHolder: snap.controlHolder,
      receivedSeq: snap.receivedSeq,
      parsedSeq: snap.parsedSeq,
      recovery: state?.recovery.state ?? previous?.recovery ?? "unavailable",
      ...(snap.writableFenced
        ? { reason: "Control or input transaction is uncertain" }
        : snap.counterExhausted
          ? { reason: "Run fact sequence exhausted" }
          : snap.epochCounterExhausted && snap.controlEpoch === Number.MAX_SAFE_INTEGER
            ? { reason: "Control epoch exhausted" }
            : snap.currentInputCounterExhausted
              ? { reason: "Current input sequence exhausted" }
              : state?.recovery.reason
                ? { reason: state.recovery.reason.slice(0, 128) }
                : {}),
      exitCode: leader?.exitCode ?? null,
      signal: leader?.signal === undefined ? null : String(leader.signal),
    };
  }

  snapshot(): WorkerExecutionSnapshot {
    const account = this.#account.snapshot();
    const runs = [...this.#runs.values()]
      .filter((record) => record.session)
      .map((record) => this.#runStatus(record));
    const sessions = [...this.#runs.values()]
      .filter((record): record is RunRecord & { session: RunSession } => !!record.session)
      .map((record) => ({ run: record.run, snapshot: record.session.snapshot() }));
    return {
      worker: this.#worker,
      runIds: this.#runs.size,
      pendingCommands: this.#pendingRequests.size,
      ordinaryPendingCommands: this.#ordinaryPendingCommands,
      reservedStatusPending: this.#reservedStatusPending,
      reservedStopPending: this.#reservedStopPending,
      inputIdentities: this.#inputIdentities,
      accountedBytes: account.accountedBytes,
      peakAccountedBytes: account.peakAccountedBytes,
      retainedBreakdown: account,
      shuttingDown: this.#shuttingDown,
      runs,
      sessions,
    };
  }

  shutdown(_reason: string): Promise<readonly RunSessionDisposalReceipt[]> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    // Every owned session starts its bounded stop before any deadline is awaited.
    this.#shutdownPromise = Promise.all(
      [...this.#runs.values()]
        .filter((record): record is RunRecord & { session: RunSession } => !!record.session)
        .map(async (record) => {
          const receipt = await record.session.dispose();
          record.stopReceipt = receipt;
          return receipt;
        }),
    );
    return this.#shutdownPromise;
  }

  #reserveBytes(bytes: number): boolean {
    const lease = this.#account.reserve("worker", bytes);
    if (!lease) return false;
    const leases = this.#workerLeases.get(bytes) ?? [];
    leases.push(lease);
    this.#workerLeases.set(bytes, leases);
    return true;
  }

  #releaseBytes(bytes: number): void {
    const leases = this.#workerLeases.get(bytes);
    leases?.pop()?.release();
    if (leases?.length === 0) this.#workerLeases.delete(bytes);
  }
}

export function createWorkerExecution(options: WorkerExecutionOptions): WorkerExecution {
  const core = new WorkerExecutionCore(options);
  return Object.freeze({
    execute: (command: PipeCommand, payload?: Uint8Array) => core.execute(command, payload),
    snapshot: () => core.snapshot(),
    shutdown: (reason: string) => core.shutdown(reason),
  });
}
