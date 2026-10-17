import {
  canonicalOperationIntent,
  RPC_METHODS,
  type OperationRecord,
  type OperationReceiptKey,
} from "@cove/protocol/rpc";
import { domainError, type DomainError } from "@cove/protocol/errors";
import {
  DEFAULT_APPEARANCE,
  PROFILE,
  type Appearance,
  type Geometry,
} from "@cove/protocol/profile";
import { OpaqueIdSchema, type RunRef } from "@cove/protocol/identity";
import type { SpawnArguments } from "@cove/protocol/pipe";
import type { RuntimeResult } from "@cove/protocol/runtime";
import { LocalRuntime } from "../terminal/local-runtime.js";
import { RuntimeComposition } from "../terminal/runtime-composition.js";
import { uncertainStoreOutcome } from "../store/store-errors.js";
import { storeReadError } from "./database-operations.js";
import { OperationReceipts, type ReceiptPreparation } from "./operation-receipts.js";

export type OperationOutcome = { operation: OperationRecord } | { error: DomainError };

// Durable run records (store/runs.ts). Only the hook D9 needs: a run is recorded when accepted,
// marked running once spawned and dropped when the worker definitely refused it; exit facts are
// recorded by the server composition from runtime events. A tab launch records its run inside the
// transaction that accepts it (store/sql/tabs.ts), so `started` serves terminal.create only.
export interface RunRecorder {
  started(run: RunRef, cwd: string, operationId: string): Promise<void>;
  spawned(run: RunRef): Promise<void>;
  notStarted(run: RunRef): Promise<void>;
  // The highest N of the recorded run IDs `run-N` (store/sql/runs.ts runs.highestNumber).
  highestNumber?(): Promise<number>;
}

// Writes that start a PTY run, and writes that stop one.
export type LaunchMethod = "terminal.create" | "tab.create" | "tab.reopen";
export type StopMethod = "terminal.stop" | "tab.stop";
const LAUNCH_METHODS: ReadonlySet<string> = new Set<LaunchMethod>([
  "terminal.create",
  "tab.create",
  "tab.reopen",
]);
const TERMINAL_METHODS: ReadonlySet<string> = new Set(["terminal.create", "terminal.stop"]);

// What the acceptance step of a launch reports. `accepted`: the run record and the accepted
// receipt are durable, so the spawn may follow. `not-accepted`: nothing will run; `outcome` is
// the answer (the record of an identical request that committed first, a refusal, or
// RESULT_UNKNOWN when the store failed with the receipt in flight), and `runRecorded` says whether
// a run record may exist that the launch must drop (nothing was spawned for it).
export type LaunchAcceptance =
  | {
      kind: "accepted";
      record: OperationRecord;
      // A tab launch sets `env` to its run identity (D8: COVE_TASK_ID, COVE_TAB_ID); a
      // terminal.create run belongs to no tab and carries none.
      spawn: SpawnArguments;
    }
  | { kind: "not-accepted"; outcome: OperationOutcome; runRecorded: boolean };

export type LaunchRequest = {
  principalId: string;
  operationId: string;
  method: LaunchMethod;
  // canonicalWriteIntent of the request.
  intent: string;
  geometry: Geometry;
  appearance?: Appearance;
  // Execution preconditions of new work, checked only when the request has no receipt.
  precondition?: () => DomainError | null;
  // Records the run and the accepted receipt (see LaunchAcceptance). It runs after the run was
  // reserved on a worker and with the receipt key reserved in memory, which `preparation` holds.
  accept: (run: RunRef, preparation: ReceiptPreparation) => Promise<LaunchAcceptance>;
};

export type StopRequest = {
  principalId: string;
  operationId: string;
  method: StopMethod;
  intent: string;
  run: RunRef;
  // Domain result kept on the record in every state (a tab stop names its tab). Terminal stops
  // carry none; their result is the run and its exit.
  result?: OperationRecord["result"];
  precondition?: () => DomainError | null;
};

const RESULT_UNKNOWN = (): OperationOutcome => ({
  error: domainError("RESULT_UNKNOWN", "unknown"),
});

// Terminal runs as operations: terminal.create and terminal.stop (M0), and the launches and stops
// of tabs (T4, domain/tabs.ts), which share the same receipt and spawn ordering.
//
// Run IDs are `run-N`. With a run recorder, N continues after the highest recorded one, so a run
// ID names exactly one recorded run of this server across restarts (a tab's history pages by run
// ID); IDs the store never recorded may repeat, which nothing observes.
export class TerminalOperations {
  private runCounter = 0;
  private runNumbersSeeded = false;
  private requestCounter = 0;
  private disposed = false;
  constructor(
    private readonly options: {
      composition: RuntimeComposition;
      runtime: LocalRuntime;
      receipts: OperationReceipts;
      encodeUtf8: (text: string) => Uint8Array;
      runs?: RunRecorder;
    },
  ) {
    if (
      options.runtime.composition !== options.composition ||
      options.receipts.composition !== options.composition
    )
      throw new Error("Runtime composition mismatch");
    this.options = { ...options };
  }

  get composition(): RuntimeComposition {
    return this.options.composition;
  }
  get runtime(): LocalRuntime {
    return this.options.runtime;
  }

  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.options.composition.serverId, principalId, operationId };
  }
  private failure(kind: Parameters<typeof domainError>[0]): OperationOutcome {
    return { error: domainError(kind) };
  }
  private nextRequest(): string | null {
    if (this.requestCounter === Number.MAX_SAFE_INTEGER) return null;
    return `runtime-${++this.requestCounter}`;
  }

  // The next run reference, or null when the store could not say where numbering continues
  // (the caller refuses the request as BUSY) or the counter is exhausted.
  private async nextRun(): Promise<RunRef | null> {
    const highest = this.options.runs?.highestNumber;
    if (!this.runNumbersSeeded && highest) {
      let recorded: number;
      try {
        recorded = await highest.call(this.options.runs);
      } catch {
        return null;
      }
      // Concurrent first launches may each read the store; the counter only moves forward.
      this.runCounter = Math.max(this.runCounter, recorded);
      this.runNumbersSeeded = true;
    }
    if (this.runCounter >= Number.MAX_SAFE_INTEGER) return null;
    return {
      serverId: this.options.composition.serverId,
      relayInstanceId: this.options.composition.relayInstanceId,
      runId: `run-${++this.runCounter}`,
    };
  }

  async create(principalId: string, input: unknown): Promise<OperationOutcome> {
    const parsed = RPC_METHODS["terminal.create"].params.safeParse(input);
    if (this.disposed || !OpaqueIdSchema.safeParse(principalId).success || !parsed.success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const params = parsed.data;
    const intent = canonicalOperationIntent("terminal.create", params, this.options.encodeUtf8);
    if (!intent) return this.failure("CAPABILITY_UNAVAILABLE");
    const runs = this.options.runs;
    return this.launch({
      principalId,
      operationId: params.operationId,
      method: "terminal.create",
      intent,
      geometry: params.geometry,
      ...(params.appearance ? { appearance: params.appearance } : {}),
      // Only new work must target the current instance (m1 "操作身份跨重启").
      precondition: () =>
        params.expectedRelayInstanceId === this.options.composition.relayInstanceId
          ? null
          : domainError("INSTANCE_MISMATCH"),
      // Store ordering (each step is durable before the next starts): the run record, then the
      // receipt. A PTY is never started for an operation whose receipt or run record the store
      // could not confirm.
      accept: async (run, preparation) => {
        try {
          await runs?.started(run, params.cwd, params.operationId);
        } catch {
          // No receipt was written: the operation was not accepted. When the store failed with
          // the record in flight, the record may exist as `starting`; the next start marks it
          // interrupted.
          return { kind: "not-accepted", outcome: this.failure("BUSY"), runRecorded: false };
        }
        const record: OperationRecord = {
          operationId: params.operationId,
          method: "terminal.create",
          revision: 0,
          state: "accepted",
          run,
        };
        let committed: boolean;
        try {
          committed = await preparation.commit(record);
        } catch (error) {
          // The receipt may have been committed: the operation's outcome is unknown to the
          // client, and the next start moves such a receipt to requires_attention. Nothing ran.
          return {
            kind: "not-accepted",
            outcome: uncertainStoreOutcome(error) ? RESULT_UNKNOWN() : this.failure("BUSY"),
            runRecorded: true,
          };
        }
        if (!committed)
          return { kind: "not-accepted", outcome: this.failure("BUSY"), runRecorded: true };
        return {
          kind: "accepted",
          record,
          spawn: { executable: params.executable, argv: params.argv, cwd: params.cwd },
        };
      },
    });
  }

  // Starts one run as the operation `request` describes. The receipt is looked up before the
  // execution preconditions (m1 "操作身份跨重启"): a same-intent resend returns the original record
  // even when its run belongs to an earlier instance, and a changed intent is a conflict. Only a
  // request without a record is new work.
  //
  // Ordering: the run is reserved on a worker, `accept` makes the run record and the accepted
  // receipt durable, the receipt moves to `running`, and only then is the spawn sent. A store
  // failure before the spawn can leave an uncertain receipt or a `starting` run record (which the
  // next start marks interrupted), never an unrecorded process.
  async launch(request: LaunchRequest): Promise<OperationOutcome> {
    if (this.disposed || !OpaqueIdSchema.safeParse(request.principalId).success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const key = this.key(request.principalId, request.operationId);
    const found = await this.options.receipts.lookup(key, request.intent);
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return this.failure("OPERATION_ID_CONFLICT");
    const refused = request.precondition?.();
    if (refused) return { error: refused };
    if (found.kind !== "reserve") return this.failure("BUSY");
    const requestId = this.nextRequest();
    if (!requestId) return this.failure("COUNTER_EXHAUSTED");
    const preparation = await this.options.receipts.prepare(key, request.intent);
    if (!preparation) return this.failure("BUSY");
    if (this.disposed) {
      preparation.cancel();
      return this.failure("CAPABILITY_UNAVAILABLE");
    }
    const run = await this.nextRun();
    if (!run || this.disposed) {
      preparation.cancel();
      return this.failure(
        this.disposed
          ? "CAPABILITY_UNAVAILABLE"
          : this.runCounter >= Number.MAX_SAFE_INTEGER
            ? "COUNTER_EXHAUSTED"
            : "BUSY",
      );
    }
    const worker = this.options.runtime.reserveRun(run, request.geometry);
    if (!worker) {
      preparation.cancel();
      return this.failure("BUSY");
    }
    const runs = this.options.runs;
    const abandon = async (): Promise<void> => {
      preparation.cancel();
      this.options.runtime.cancelRunReservation(run, worker);
      // Nothing was spawned. Best effort: a failed store keeps the record for the next start.
      await this.recordRun(() => runs?.notStarted(run));
    };
    let accepted: LaunchAcceptance;
    try {
      accepted = await request.accept(run, preparation);
    } catch (error) {
      accepted = {
        kind: "not-accepted",
        outcome: uncertainStoreOutcome(error) ? RESULT_UNKNOWN() : this.failure("BUSY"),
        runRecorded: uncertainStoreOutcome(error),
      };
    }
    if (accepted.kind === "not-accepted") {
      if (accepted.runRecorded) await abandon();
      else {
        preparation.cancel();
        this.options.runtime.cancelRunReservation(run, worker);
      }
      return accepted.outcome;
    }
    // The receipt is durable now (a tab launch inserted it in its own transaction); the in-memory
    // reservation has done its work.
    preparation.cancel();
    const record = accepted.record;
    try {
      await this.options.receipts.update(key, { ...record, revision: 1, state: "running" });
    } catch {
      // The receipt is accepted, but the store cannot record progress: do not spawn.
      await abandon();
      return RESULT_UNKNOWN();
    }
    let result: RuntimeResult;
    try {
      result = await this.options.runtime.spawn({
        ...accepted.spawn,
        worker,
        run,
        requestId,
        operationId: request.operationId,
        geometry: request.geometry,
        appearance: request.appearance ?? DEFAULT_APPEARANCE,
        effectiveBudgets: this.options.composition.budgets,
        profile: PROFILE,
      });
    } catch {
      result = {
        type: "error",
        commandType: "spawn",
        worker,
        run,
        requestId,
        error: domainError("RESULT_UNKNOWN", "unknown"),
      };
    }
    const uncertain =
      (result.type === "error" && result.error.acceptance === "unknown") ||
      (result.type === "result" && result.outcome === "unknown");
    // An uncertain spawn keeps its `starting` record: the next start marks it interrupted.
    if (!uncertain)
      await this.recordRun(() =>
        result.type === "error" || result.outcome === "rejected"
          ? runs?.notStarted(run)
          : runs?.spawned(run),
      );
    return this.complete(key, result);
  }

  // Run records follow the terminal path; a failed record write never changes its outcome.
  private async recordRun(write: () => Promise<void> | undefined): Promise<void> {
    try {
      await write();
    } catch {
      /* The run keeps its previous record; a restart marks it interrupted. */
    }
  }

  async stop(principalId: string, input: unknown): Promise<OperationOutcome> {
    const parsed = RPC_METHODS["terminal.stop"].params.safeParse(input);
    if (this.disposed || !OpaqueIdSchema.safeParse(principalId).success || !parsed.success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const params = parsed.data;
    const intent = canonicalOperationIntent("terminal.stop", params, this.options.encodeUtf8);
    if (!intent) return this.failure("CAPABILITY_UNAVAILABLE");
    const composition = this.options.composition;
    return this.stopRun({
      principalId,
      operationId: params.operationId,
      method: "terminal.stop",
      intent,
      run: params.run,
      precondition: () =>
        params.expectedRelayInstanceId !== composition.relayInstanceId ||
        params.run.serverId !== composition.serverId ||
        params.run.relayInstanceId !== composition.relayInstanceId
          ? domainError("INSTANCE_MISMATCH")
          : null,
    });
  }

  // Stops one run as the operation `request` describes; same receipt order as launch. The stop
  // is sent only after the store confirmed the receipt and `running`.
  async stopRun(request: StopRequest): Promise<OperationOutcome> {
    if (this.disposed || !OpaqueIdSchema.safeParse(request.principalId).success)
      return this.failure("CAPABILITY_UNAVAILABLE");
    const key = this.key(request.principalId, request.operationId);
    const found = await this.options.receipts.lookup(key, request.intent);
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return this.failure("OPERATION_ID_CONFLICT");
    const refused = request.precondition?.();
    if (refused) return { error: refused };
    if (found.kind !== "reserve") return this.failure("BUSY");
    const entry = this.options.runtime.registry.get(request.run);
    if (!entry) return this.failure("RUN_NOT_FOUND");
    const requestId = this.nextRequest();
    if (!requestId) return this.failure("COUNTER_EXHAUSTED");
    const preparation = await this.options.receipts.prepare(key, request.intent);
    if (!preparation) return this.failure("BUSY");
    const record: OperationRecord = {
      operationId: request.operationId,
      method: request.method,
      revision: 0,
      state: "accepted",
      run: request.run,
      ...(request.result ? { result: request.result } : {}),
    };
    let committed: boolean;
    try {
      committed = await preparation.commit(record);
    } catch (error) {
      preparation.cancel();
      return uncertainStoreOutcome(error) ? RESULT_UNKNOWN() : this.failure("BUSY");
    }
    if (!committed) {
      preparation.cancel();
      return this.failure("BUSY");
    }
    try {
      await this.options.receipts.update(key, { ...record, revision: 1, state: "running" });
    } catch {
      return RESULT_UNKNOWN();
    }
    let result: RuntimeResult;
    try {
      result = await this.options.runtime.stop({
        type: "stop",
        worker: entry.worker,
        run: request.run,
        requestId,
        operationId: request.operationId,
      });
    } catch {
      result = {
        type: "error",
        commandType: "stop",
        worker: entry.worker,
        run: request.run,
        requestId,
        error: domainError("RESULT_UNKNOWN", "unknown"),
      };
    }
    return this.complete(key, result);
  }

  // Records the runtime's answer. When the store cannot, the client learns that the outcome is
  // unknown; the receipt stays running and the next start moves it to requires_attention.
  private async complete(
    key: OperationReceiptKey,
    result: RuntimeResult,
  ): Promise<OperationOutcome> {
    try {
      return await this.recordOutcome(key, result);
    } catch {
      return RESULT_UNKNOWN();
    }
  }

  // A launch succeeds once spawned; a stop stays running until the run's exit is observed (here
  // or by a later operation.get). Terminal methods report the run and its exit as their result;
  // tab methods keep the domain result their record was accepted with, in every state, so a
  // failed tab.create still names the tab it recorded.
  private async recordOutcome(
    key: OperationReceiptKey,
    result: RuntimeResult,
  ): Promise<OperationOutcome> {
    const record = await this.options.receipts.get(key);
    if (!record) return this.failure("OPERATION_NOT_FOUND");
    const uncertain =
      (result.type === "error" && result.error.acceptance === "unknown") ||
      (result.type === "result" && result.outcome === "unknown");
    const rejected = result.type === "error" || result.outcome === "rejected";
    const exited = result.type === "result" && result.runStatus?.status === "exited";
    const state = uncertain
      ? "requires_attention"
      : rejected
        ? "failed"
        : LAUNCH_METHODS.has(record.method) || exited
          ? "succeeded"
          : "running";
    const terminal = TERMINAL_METHODS.has(record.method);
    const next: OperationRecord = {
      ...record,
      revision: record.revision + 1,
      state,
      ...(uncertain
        ? { error: domainError("RESULT_UNKNOWN", "unknown") }
        : result.type === "error"
          ? { error: result.error }
          : {}),
      ...(state === "succeeded" && terminal
        ? {
            result: {
              run: record.run!,
              ...(exited
                ? {
                    exitCode: result.type === "result" ? result.runStatus!.exitCode : null,
                    signal: result.type === "result" ? result.runStatus!.signal : null,
                  }
                : {}),
            },
          }
        : {}),
    };
    await this.options.receipts.update(key, next);
    const stored = await this.options.receipts.get(key);
    return stored ? { operation: stored } : this.failure("OPERATION_NOT_FOUND");
  }

  // Queried by durable identity only; the record may reference a run of an earlier instance. A
  // stop still running completes here once the registry holds the run's exit fact.
  async get(principalId: string, operationId: string): Promise<OperationOutcome> {
    const key = this.key(principalId, operationId);
    try {
      let record = await this.options.receipts.get(key);
      if (
        (record?.method === "terminal.stop" || record?.method === "tab.stop") &&
        record.state === "running" &&
        record.run
      ) {
        const status = this.options.runtime.registry.get(record.run)?.status;
        if (status?.status === "exited") {
          await this.options.receipts.update(key, {
            ...record,
            revision: record.revision + 1,
            state: "succeeded",
            ...(record.method === "terminal.stop"
              ? { result: { run: record.run, exitCode: status.exitCode, signal: status.signal } }
              : {}),
          });
          record = await this.options.receipts.get(key);
        }
      }
      return record ? { operation: record } : this.failure("OPERATION_NOT_FOUND");
    } catch (error) {
      return { error: storeReadError(error) };
    }
  }
  dispose(): void {
    this.disposed = true;
  }
}
