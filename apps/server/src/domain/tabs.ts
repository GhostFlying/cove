import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename } from "node:path";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { sameRunRef, type RunRef } from "@cove/protocol/identity";
import type { SpawnArguments, SpawnEnv } from "@cove/protocol/pipe";
import type { Appearance, Geometry } from "@cove/protocol/profile";
import { canonicalWriteIntent, type WriteRpcMethod } from "@cove/protocol/rpc";
import {
  M1_LIMITS,
  TabNameSchema,
  type RunHistoryRecord,
  type TabRecord,
} from "@cove/protocol/workspace";
import {
  executeDatabaseWrite,
  recordedWrite,
  storeReadError,
  type DatabaseWriteContext,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type {
  LaunchAcceptance,
  OperationOutcome,
  TerminalOperations,
} from "../operations/terminal-operations.js";
import type { Store } from "../store/database.js";
import { RunLog } from "../store/runs.js";
import type { NewTab, TabLaunchResult } from "../store/sql/tabs.js";
import type { LocalRuntime } from "../terminal/local-runtime.js";
import { jsonSize, PAGE_RESERVE, STRUCTURE_TOKENS } from "./record-bounds.js";
import { worstRun, worstTab } from "./tab-bounds.js";

// Tabs and runs (docs/milestones/m1.md T4, D8, D9; S5, S7).
//
// A tab is a durable logical terminal of a task: name, launch recipe (an executable with its
// arguments, or the user's login shell) and cwd (the workspace entry or one mount). A run is one
// PTY instance of it, an ordinary M0 terminal run: it appears in `terminal list`, can be attached
// in the harness and is stopped through the same worker command. A tab has at most one run
// without an end record at a time; `tab reopen` starts the next one with a new run ID and the
// recorded recipe, and earlier runs stay in the tab's history.
//
// Facts and their owners:
// - A run is "ended" only on an exit fact (the run registry records it, entry/
//   recording-run-registry.ts) or an orderly stop of the server (stopped-with-server). Startup
//   marks runs of an earlier instance without an end record interrupted and unverifiable
//   (store/runs.ts interruptEarlier); they are never shown as live, never probed by PID and never
//   restarted. Loss of contact with a worker is not an exit: such a run keeps blocking reopen and
//   close, and reads report it `unverifiable`.
// - The run record holds, from its start, the task, the workspace revision, the resolved cwd and
//   the mount mapping (store/sql/tabs.ts tabs.launch). Later binding changes never rewrite them.
//
// Write order (relay-protocol §11.3): the receipt is looked up before any check, so a resend of an
// executed request returns its record whatever changed since. A launch (tab.create with a first
// run, tab.reopen) then goes through TerminalOperations.launch, whose acceptance step is one
// store transaction that rechecks the receipt, checks the tab and task, records the run with its
// snapshot and inserts the accepted receipt; only after that commit is the spawn sent, and the
// worker's answer completes the receipt. tab.create without a run and tab.close are plain
// receipt-checked database writes. tab.stop sends the worker's stop for the tab's latest run;
// its receipt stays running until the run's exit is observed, like terminal.stop.
//
// Nothing here repeats input or commands: a launch that failed or whose outcome is unknown is
// never retried by Cove; the operator reopens explicitly (a new operation, a new run ID).

const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 };

type CreateParams = {
  operationId: string;
  taskId: string;
  name?: string;
  recipe: TabRecord["recipe"];
  cwd?: TabRecord["cwd"];
  start?: boolean;
  geometry?: Geometry;
  appearance?: Appearance;
};
type ReopenParams = {
  operationId: string;
  tabId: string;
  geometry?: Geometry;
  appearance?: Appearance;
};
type StopParams = { operationId: string; tabId: string; run?: RunRef };
type CloseParams = { operationId: string; tabId: string };
type ListParams = { taskId: string; limit: number; afterTabId?: string };
type RunsParams = { tabId: string; limit: number; beforeRunId?: string };

type TabRead = { tab: TabRecord; latestRun: RunHistoryRecord | null };

export type TabServiceOptions = {
  store: Store;
  receipts: OperationReceipts;
  operations: TerminalOperations;
  encodeUtf8: (text: string) => Uint8Array;
  // The read response budget every tab and run record must fit (domain/tab-bounds.ts).
  responseBytes?: number;
  now?: () => number;
  newId?: () => string;
  // The user's default login shell for the `shell` recipe.
  loginShell?: () => string;
};

// The environment identifying a tab's run to the process it starts (D8, #120): only these
// identifiers, never the server's own environment or any secret. It travels as the spawn's bounded
// `env` (SpawnEnvSchema); the worker sets it over its inherited environment. Task and tab IDs are
// ResourceIds, so they always fit the schema's printable, length-bounded values.
export function coveRunEnvironment(identity: { taskId: string; tabId: string }): SpawnEnv {
  return { COVE_TASK_ID: identity.taskId, COVE_TAB_ID: identity.tabId };
}

// The login shell of the server's user: the passwd entry, then $SHELL, then /bin/sh. Resolved
// at every launch, so a changed shell applies to the next run. `-l` starts it as a login shell.
function defaultLoginShell(): string {
  let shell: string | null = null;
  try {
    shell = userInfo().shell;
  } catch {
    shell = null;
  }
  return shell || process.env.SHELL || "/bin/sh";
}

// The default tab name: the executable's file name, or "shell".
export function defaultTabName(recipe: TabRecord["recipe"]): string {
  if (recipe.kind === "shell") return "shell";
  const name = [...basename(recipe.executable)].slice(0, M1_LIMITS.displayNameChars).join("");
  return TabNameSchema.safeParse(name).success ? name : "tab";
}

export class TabService {
  private readonly runLog: RunLog;
  constructor(private readonly options: TabServiceOptions) {
    this.runLog = new RunLog(options.store);
  }

  private get runtime(): LocalRuntime {
    return this.options.operations.runtime;
  }
  private get context(): DatabaseWriteContext {
    return {
      serverId: this.options.operations.composition.serverId,
      receipts: this.options.receipts,
      encodeUtf8: this.options.encodeUtf8,
    };
  }
  private get responseBytes(): number {
    return this.options.responseBytes ?? M0_LIMITS.rpcResponseBytes;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // A refusal decided after an await: an identical request may have committed meanwhile, and
  // its record (or OPERATION_ID_CONFLICT) answers instead (database-operations.ts recordedWrite).
  private async refuse(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    error: DomainError,
  ): Promise<DatabaseWriteOutcome> {
    return (await recordedWrite(this.context, principalId, method, params)) ?? { error };
  }

  private spawnArguments(recipe: TabRecord["recipe"], cwd: string): SpawnArguments {
    return recipe.kind === "shell"
      ? { executable: (this.options.loginShell ?? defaultLoginShell)(), argv: ["-l"], cwd }
      : { executable: recipe.executable, argv: recipe.argv, cwd };
  }

  // ---------------------------------------------------------------------------------------------
  // Writes

  async create(principalId: string, params: CreateParams): Promise<OperationOutcome> {
    const recorded = await recordedWrite(this.context, principalId, "tab.create", params);
    if (recorded) return recorded;
    const tab: NewTab = {
      tabId: (this.options.newId ?? randomUUID)(),
      taskId: params.taskId,
      name: params.name ?? defaultTabName(params.recipe),
      recipe: params.recipe,
      cwd: params.cwd ?? { kind: "entry" },
    };
    if (params.start === false)
      return executeDatabaseWrite(this.context, principalId, "tab.create", params, {
        name: "tab.create",
        args: { ...tab, at: this.now(), responseBytes: this.responseBytes },
      });
    return this.launch(principalId, "tab.create", params, { create: tab });
  }

  async reopen(principalId: string, params: ReopenParams): Promise<OperationOutcome> {
    const recorded = await recordedWrite(this.context, principalId, "tab.reopen", params);
    if (recorded) return recorded;
    // An exit the registry observed but the store failed to record must not block the reopen.
    await this.repairExits(params.tabId);
    return this.launch(principalId, "tab.reopen", params, { reopen: { tabId: params.tabId } });
  }

  private launch(
    principalId: string,
    method: "tab.create" | "tab.reopen",
    params: (CreateParams | ReopenParams) & Record<string, unknown>,
    launch: { create: NewTab } | { reopen: { tabId: string } },
  ): Promise<OperationOutcome> {
    const intent = canonicalWriteIntent(method, params, this.options.encodeUtf8);
    if (!intent) return Promise.resolve({ error: domainError("INVALID_ARGUMENT") });
    const composition = this.options.operations.composition;
    return this.options.operations.launch({
      principalId,
      operationId: params.operationId,
      method,
      intent,
      geometry: params.geometry ?? DEFAULT_GEOMETRY,
      ...(params.appearance ? { appearance: params.appearance } : {}),
      accept: async (run): Promise<LaunchAcceptance> => {
        // A store failure rejects; TerminalOperations.launch maps it (RESULT_UNKNOWN when the
        // transaction may have committed).
        const answer: TabLaunchResult = await this.options.store.call("tabs.launch", {
          key: { serverId: composition.serverId, principalId, operationId: params.operationId },
          canonicalIntent: intent,
          method,
          run,
          launch,
          relayInstanceId: composition.relayInstanceId,
          at: this.now(),
          limits: {
            serverId: composition.serverId,
            operationRecordBytes: composition.budgets.operationRecordBytes,
          },
          responseBytes: this.responseBytes,
        });
        if (answer.kind === "existing")
          return {
            kind: "not-accepted",
            outcome: { operation: answer.operation },
            runRecorded: false,
          };
        if (answer.kind === "refused")
          return { kind: "not-accepted", outcome: { error: answer.error }, runRecorded: false };
        return {
          kind: "accepted",
          record: answer.operation,
          spawn: {
            ...this.spawnArguments(answer.recipe, answer.cwd),
            env: coveRunEnvironment({ taskId: answer.taskId, tabId: answer.tabId }),
          },
        };
      },
    });
  }

  // Stops the tab's latest run (or the pinned `run`, which must be it). A run of an earlier
  // instance cannot be stopped (INSTANCE_MISMATCH): it is already recorded interrupted or
  // stopped with its server, and nothing of it is reachable any more.
  async stop(principalId: string, params: StopParams): Promise<OperationOutcome> {
    const intent = canonicalWriteIntent("tab.stop", params, this.options.encodeUtf8);
    if (!intent) return { error: domainError("INVALID_ARGUMENT") };
    const recorded = await recordedWrite(this.context, principalId, "tab.stop", params);
    if (recorded) return recorded;
    let read: TabRead | null;
    try {
      read = await this.options.store.call("tabs.get", { tabId: params.tabId });
    } catch (error) {
      return this.refuse(principalId, "tab.stop", params, storeReadError(error));
    }
    if (!read) return this.refuse(principalId, "tab.stop", params, domainError("TAB_NOT_FOUND"));
    const latest = read.tab.latestRun;
    if (!latest) return this.refuse(principalId, "tab.stop", params, domainError("RUN_NOT_FOUND"));
    // The operator's view is stale when the run it named is no longer the tab's latest.
    if (params.run && !sameRunRef(params.run, latest))
      return this.refuse(principalId, "tab.stop", params, domainError("REVISION_CONFLICT"));
    const composition = this.options.operations.composition;
    return this.options.operations.stopRun({
      principalId,
      operationId: params.operationId,
      method: "tab.stop",
      intent,
      run: latest,
      result: { resource: { kind: "tab", id: read.tab.tabId, revision: read.tab.revision } },
      precondition: () =>
        latest.serverId === composition.serverId &&
        latest.relayInstanceId === composition.relayInstanceId
          ? null
          : domainError("INSTANCE_MISMATCH"),
    });
  }

  async close(principalId: string, params: CloseParams): Promise<DatabaseWriteOutcome> {
    const recorded = await recordedWrite(this.context, principalId, "tab.close", params);
    if (recorded) return recorded;
    await this.repairExits(params.tabId);
    return executeDatabaseWrite(this.context, principalId, "tab.close", params, {
      name: "tab.close",
      args: { tabId: params.tabId },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Reads

  async get(tabId: string): Promise<TabRead | { error: DomainError }> {
    try {
      let read = await this.options.store.call("tabs.get", { tabId });
      if (read?.latestRun && (await this.repair([read.latestRun])))
        read = await this.options.store.call("tabs.get", { tabId });
      if (!read) return { error: domainError("TAB_NOT_FOUND") };
      return { tab: read.tab, latestRun: read.latestRun ? this.observed(read.latestRun) : null };
    } catch (error) {
      return { error: storeReadError(error) };
    }
  }

  // Tabs of a task in tabId order. A page ends before the tab that would not fit one response;
  // every tab fits on its own (tabReadFits at creation), so a page holds at least one.
  async list(
    params: ListParams,
  ): Promise<{ tabs: TabRecord[]; nextAfterTabId?: string } | { error: DomainError }> {
    let rows: TabRead[] | null;
    try {
      rows = await this.options.store.call("tabs.list", {
        taskId: params.taskId,
        afterTabId: params.afterTabId ?? "",
        limit: params.limit,
      });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (!rows) return { error: domainError("TASK_NOT_FOUND") };
    const tabs = this.page(
      rows.slice(0, params.limit).map((row) => row.tab),
      worstTab,
    );
    return rows.length > tabs.length
      ? { tabs, nextAfterTabId: tabs[tabs.length - 1]!.tabId }
      : { tabs };
  }

  // Runs of a tab, newest first, paged like list.
  async runs(
    params: RunsParams,
  ): Promise<{ runs: RunHistoryRecord[]; nextBeforeRunId?: string } | { error: DomainError }> {
    const read = () =>
      this.options.store.call("tabs.runs", {
        tabId: params.tabId,
        limit: params.limit,
        ...(params.beforeRunId === undefined ? {} : { beforeRunId: params.beforeRunId }),
      });
    let answer: Awaited<ReturnType<typeof read>>;
    try {
      answer = await read();
      if (answer && "runs" in answer && (await this.repair(answer.runs))) answer = await read();
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (!answer) return { error: domainError("TAB_NOT_FOUND") };
    if ("error" in answer) return answer;
    const runs = this.page(
      answer.runs.slice(0, params.limit).map((run) => this.observed(run)),
      worstRun,
    );
    return answer.runs.length > runs.length
      ? { runs, nextBeforeRunId: runs[runs.length - 1]!.run.runId }
      : { runs };
  }

  // The longest prefix of `items` that fits one response, sized at each item's worst case so a
  // page never depends on values a later read may show differently.
  private page<T>(items: T[], worst: (item: T) => T): T[] {
    const page: T[] = [];
    let bytes = 0;
    let tokens = 0;
    for (const item of items) {
      const size = jsonSize(worst(item));
      bytes += size.bytes + (page.length ? 1 : 0);
      tokens += size.tokens;
      if (
        page.length &&
        (bytes > this.responseBytes - PAGE_RESERVE.bytes ||
          tokens > STRUCTURE_TOKENS - PAGE_RESERVE.tokens)
      )
        break;
      page.push(item);
    }
    return page;
  }

  // ---------------------------------------------------------------------------------------------
  // Run state as this instance knows it

  // Whether `run` has no end record and belongs to this instance's runtime.
  private current(run: RunHistoryRecord): boolean {
    const composition = this.options.operations.composition;
    return (
      (run.lifecycle === "starting" || run.lifecycle === "running") &&
      run.run.serverId === composition.serverId &&
      run.run.relayInstanceId === composition.relayInstanceId
    );
  }

  // Records exit facts the run registry holds but the store does not (its write failed: the
  // registry's recording is best effort, entry/recording-run-registry.ts). True when it wrote any.
  private async repair(runs: readonly RunHistoryRecord[]): Promise<boolean> {
    let wrote = false;
    for (const run of runs) {
      if (!this.current(run)) continue;
      const status = this.runtime.registry.get(run.run)?.status;
      if (status?.status !== "exited") continue;
      try {
        await this.runLog.exited(run.run, status.exitCode, status.signal);
        wrote = true;
      } catch {
        /* The read reports the stored record; the next read tries again. */
      }
    }
    return wrote;
  }

  private async repairExits(tabId: string): Promise<void> {
    try {
      const read = await this.options.store.call("tabs.get", { tabId });
      if (read?.latestRun) await this.repair([read.latestRun]);
    } catch {
      /* The write's own transaction reads the rows again. */
    }
  }

  // A stored run with what the runtime knows now: a run of this instance without an end record
  // is `live` only while its worker reports it live; out of contact, or not spawned yet, it is
  // `unverifiable` (still not ended: only an exit fact ends it).
  private observed(run: RunHistoryRecord): RunHistoryRecord {
    if (!this.current(run)) return run;
    const status = this.runtime.registry.get(run.run)?.status;
    return status?.status === "live" ? run : { ...run, verification: "unverifiable" };
  }
}

// Runs without an end record that use `path`: their start cwd or a mount of their recorded
// mapping is `path` or lies below it (D10; for T5's binding change and worktree deletion guards).
// `path` is a real path, compared with the recorded real paths. A run whose exit the registry
// observed is not returned; a run of a worker out of contact is (loss of contact is not an exit).
// Rejects on a store failure: the caller must refuse rather than assume that no run uses it.
export async function liveRunsUsing(
  store: Store,
  runtime: LocalRuntime,
  path: string,
): Promise<RunHistoryRecord[]> {
  const runs = await store.call("tabs.liveRunsUsing", { path });
  return runs.filter((run) => runtime.registry.get(run.run)?.status.status !== "exited");
}
