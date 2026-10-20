import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { domainError, type DomainError } from "@cove/protocol/errors";
import type { RunRef } from "@cove/protocol/identity";
import type { OperationReceiptKey } from "@cove/protocol/rpc";
import { M1_LIMITS } from "@cove/protocol/workspace";
import {
  executeDatabaseWriteCommitted,
  recordedWrite,
  storeReadError,
  type DatabaseWriteContext,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts, ReceiptVerifier } from "../operations/operation-receipts.js";
import type { Store } from "../store/database.js";
import { refusedStoreCall, retryRefused } from "../store/store-errors.js";
import { ProcessLedger } from "../store/processes.js";
import type { bindingOperations, DeletionRow } from "../store/sql/bindings.js";
import { attentionRecord, type Attempt, type Progress } from "../store/sql/worktrees.js";
import {
  forceRemoveWorktree,
  listWorktrees,
  sourceChanges,
  type StepResult,
  type StepTimeouts,
} from "../git/worktree.js";
import type { LocalRuntime } from "../terminal/local-runtime.js";
import { liveRunsUsing } from "./tabs.js";
import { STORE_HANDOFF, STORE_RETRY, type WorktreeService } from "./worktrees.js";

// Binding changes and managed worktree deletion (docs/milestones/m1.md T5, S6; D3, D10;
// relay-protocol §11.4, §11.5). The store side is store/sql/bindings.ts.
//
// The threat model is T3b's (domain/worktrees.ts, m1.md D1): Cove is single-user and the
// authenticated user is its trusted owner. Cove does not defend against the owner fabricating
// look-alike artifacts or editing concurrently; a change the user makes between a check below and
// the Git command it guards is an accepted residual window. Cleanup is judged by data loss: the
// owner's explicit confirmation (`confirmed: true`, which the params schema itself requires, so a
// request without it is invalid params and nothing is deleted whichever client sent it) is what
// authorizes deleting a worktree with its uncommitted and untracked changes.
//
// Live runs. A run without an end record that uses the path (its start cwd, or a mount of its
// recorded mapping, is the path or below it: domain/tabs.ts liveRunsUsing) blocks both writes;
// they are refused with LIVE_RUNS_PRESENT and the runs. A run whose worker is out of contact counts
// (loss of contact is not an exit). The accepting transaction asks the store again, so a run
// started meanwhile by Cove itself is seen (store/sql/bindings.ts).
//
// binding.convert (D3) replaces a ready checkout mount with a new managed worktree of the same
// registered clone, from a commit only, by the base rule of D1 (fetch unless --no-fetch, the main
// branch resolved from the remote, never the local HEAD). Only this task's runs that use the
// checkout block it: the checkout itself is not changed, so another task's runs or a terminal run
// in it are unaffected, while a run of this task would see its workspace change under it. The
// changes in the source checkout are counted (sourceChanges: staged, unstaged, untracked) and
// shown in the result; they stay where they are: nothing is stashed, reset, switched or carried
// over, and the source clone's HEAD, branch and working tree are never written to. Order:
// 1. the receipt is looked up; the task, the mount (a ready checkout of an active task), its
//    registration and the live runs are checked; a seat for the preparation is reserved (BUSY when
//    none), the branch is checked by Git's rules and the source changes are counted, both in the
//    shared Git slots;
// 2. one transaction rechecks all of it and records the conversion and the target's attempt
//    (store/sql/bindings.ts binding.convert; migration 004). The mount is not changed: it keeps its
//    checkout binding, the manifest still names the checkout, and the workspace revision stays;
// 3. WorktreeService prepares the target `<entry>/<name>` exactly as for mount.add (fetch, base,
//    intent, branch, worktree, checkout, each verified), including its restart verification,
//    continue and abandon. Runs started meanwhile, also from the entry, see the checkout;
// 4. only once the target is verified ready (switchConversion), one transaction checks the
//    preconditions again (the same ready checkout, the task active, no run of the task using the
//    checkout) and switches: the mount becomes the ready worktree mount at the target, the
//    checkout binding is unbound and the worktree binding recorded, and the revision grows by one,
//    together with the operation's final receipt (store/sql/bindings.ts bindings.switch). Runs
//    started earlier keep their recorded mapping, which names the checkout.
// This is design §3's order: prepare, verify, then switch. A preparation that fails, or is
// abandoned, never touched the mount: the checkout stays bound and the result's `left` names what
// was left in place, as for T3b. A switch refused because a precondition no longer holds (a run
// of the task started using the checkout during the preparation) leaves the prepared target and
// the operation requires_attention with that reason: continue switches once it is gone, abandon
// removes the target as T3b removes any unbound preparation.
//
// binding.delete (D10) deletes the managed worktree bound to a mount and removes the mount; the
// branch is always kept. The worktree may be ready, or what a failed or abandoned preparation left
// in place (its outcome's `left`), so that every managed worktree has a Cove path to its deletion.
// A checkout is never deleted. Order:
// 1. the receipt is looked up; the mount must be a worktree mount whose preparation (or an earlier
//    deletion) has ended and that has a managed worktree to delete; the live runs are checked; a
//    seat is reserved;
// 2. one transaction rechecks it and accepts the deletion before Git removes anything: the mount
//    becomes pending (no tab may start in it, and nothing else acts on it), the deletion is
//    recorded with the mount's prior state (migration 004) and the receipt stays running;
//    From then on no run is accepted whose cwd or mount mapping uses the worktree
//    (store/sql/deletions.ts), so no run of Cove's own can start between the checks and the
//    removal;
// 3. the deletion runs on the seat (finishDeletion): the live runs are checked once more (one the
//    acceptance left out as exited but still recorded live); the state is observed; a registered
//    worktree is removed with `git worktree remove --force` as a recorded step in a process group
//    of its own (git/worktree.ts); then the state is observed again. One transaction ends it with
//    the operation's receipt: deleted (Git no longer lists it and its directory is gone: the mount
//    is removed and unbound, the worktree recorded deleted), or restored (the mount back in its
//    prior state, the operation failed) when nothing was removed: a run appeared
//    (LIVE_RUNS_PRESENT), Git refused (GIT_UNAVAILABLE; its stderr is not interpreted, e.g. a
//    locked worktree, which one --force does not remove), or something Git does not know as a
//    worktree is at the path (INVALID_ARGUMENT, left alone).
// A step not seen to end, a Git slot not free in time or a state that cannot be observed leaves the
// operation requires_attention (recoveryActions: continue only). So does a restart while it is
// pending (createBindingVerifier: the store alone, no Git). operation.continue is refused while a
// process it recorded may still run (OPERATION_EFFECTS_ACTIVE) and then repeats step 3 from what it
// observes: a worktree already gone is recorded deleted, one still registered is removed. The
// confirmed request is to delete it, so this is not a blind repeat. A deletion is never abandoned:
// the mount would stay pending without a path to its worktree.
//
// binding.list returns a mount's binding history (oldest first), also after the mount was removed
// or its worktree deleted.

type ConvertParams = {
  operationId: string;
  taskId: string;
  mountId: string;
  expectedWorkspaceRevision?: number;
  branch?: string;
  base?: string;
  noFetch?: boolean;
};
type DeleteParams = {
  operationId: string;
  taskId: string;
  mountId: string;
  expectedWorkspaceRevision?: number;
  confirmed: true;
};
type BindingRecord = NonNullable<
  ReturnType<(typeof bindingOperations)["bindings.history"]>
>[number];

export type BindingServiceOptions = {
  store: Store;
  receipts: OperationReceipts;
  serverId: string;
  encodeUtf8: (text: string) => Uint8Array;
  runtime: LocalRuntime;
  // The task module's worktree executor: its seats, shared budgets and entry writes.
  worktrees: WorktreeService;
  // The effective RPC response budget a task record must fit (domain/record-bounds.ts).
  responseBytes: number;
  // The deadline of the Git work a request does before it is accepted, from its start.
  requestStepMs?: number;
  timeouts?: StepTimeouts;
  now?: () => number;
};

const REQUEST_STEP_MS = 20_000;
// As for the worktree steps (domain/worktrees.ts): how long a deletion waits for a Git slot and
// how long a filesystem check may take from its permit.
const GIT_SLOT_WAIT_MS = 60_000;
const FS_DEADLINE_MS = 20_000;

const UNKNOWN = Symbol("unknown");
type Unknown = typeof UNKNOWN;

// What the worktree path holds: Git's registration of it (gone: neither registered nor present),
// something Git does not know as a worktree (foreign), or unknown.
type Observed = "registered" | "gone" | "foreign" | "unknown";

// What a requires_attention conversion whose target is ready but not switched to shows.
const SWITCH_PROGRESS: Progress = {
  completedSteps: ["intent", "branch", "worktree", "checkout"],
  remainingEffects: ["switch-binding"],
  recoveryActions: ["continue", "abandon"],
};

// What a requires_attention deletion shows (OperationProgressSchema).
function deletionProgress(processActive: boolean): Progress {
  return {
    completedSteps: [],
    remainingEffects: processActive
      ? ["remove-worktree", "record", "git-process"]
      : ["remove-worktree", "record"],
    recoveryActions: ["continue"],
  };
}

export class BindingService {
  private readonly ledger: ProcessLedger;

  constructor(private readonly options: BindingServiceOptions) {
    this.ledger = new ProcessLedger(
      options.store,
      options.receipts.composition.relayInstanceId,
      options.now,
    );
    options.worktrees.resumeWith("binding.delete", (key) => this.finishDeletion(key));
    options.worktrees.convertWith((attempt, key) => this.switchConversion(attempt, key));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get context(): DatabaseWriteContext {
    return {
      serverId: this.options.serverId,
      receipts: this.options.receipts,
      encodeUtf8: this.options.encodeUtf8,
    };
  }

  private get limits() {
    return {
      serverId: this.options.serverId,
      operationRecordBytes: this.options.receipts.composition.budgets.operationRecordBytes,
    };
  }

  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.options.serverId, principalId, operationId };
  }

  private requestDeadline(): number {
    return performance.now() + (this.options.requestStepMs ?? REQUEST_STEP_MS);
  }

  // The runs that block a change of `path` (see the header), of `taskId` only when it is given,
  // and the runs without an end record in the store whose exit the runtime has observed, which
  // the accepting transaction leaves out. Rejects on a store failure: nobody may assume then that
  // no run uses the path.
  private async runsUsing(
    path: string,
    taskId?: string,
  ): Promise<{ live: RunRef[]; exited: RunRef[] }> {
    const { store, runtime } = this.options;
    const live = (await liveRunsUsing(store, runtime, path))
      .filter((run) => taskId === undefined || run.taskId === taskId)
      .map((run) => run.run);
    const exited = (await store.call("tabs.liveRunsUsing", { path }))
      .filter((run) => runtime.registry.get(run.run)?.status.status === "exited")
      .map((run) => run.run);
    return { live, exited };
  }

  // ---------------------------------------------------------------------------------------------
  // binding.convert

  async convert(principalId: string, params: ConvertParams): Promise<DatabaseWriteOutcome> {
    const method = "binding.convert";
    const recorded = await recordedWrite(this.context, principalId, method, params);
    if (recorded) return recorded;
    const refuse = async (error: DomainError): Promise<DatabaseWriteOutcome> =>
      (await recordedWrite(this.context, principalId, method, params)) ?? { error };
    const { store, worktrees } = this.options;
    let task;
    let repo;
    try {
      task = await store.call("tasks.get", { taskId: params.taskId });
      if (!task) return refuse(domainError("TASK_NOT_FOUND"));
      const mount = task.record.workspace.mounts.find((item) => item.mountId === params.mountId);
      if (!mount) return refuse(domainError("MOUNT_NOT_FOUND"));
      repo = await store.call("repos.get", { repoId: mount.repoId });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    const { record } = task;
    const mount = record.workspace.mounts.find((item) => item.mountId === params.mountId)!;
    // Advisory; the transaction checks each of these again with the current rows.
    if (record.archived) return refuse(domainError("TASK_ARCHIVED"));
    if (
      params.expectedWorkspaceRevision !== undefined &&
      params.expectedWorkspaceRevision !== record.workspace.revision
    )
      return refuse(domainError("REVISION_CONFLICT"));
    if (mount.source !== "checkout" || mount.state !== "ready")
      return refuse(domainError("INVALID_ARGUMENT"));
    if (!repo) return refuse(domainError("REPO_NOT_FOUND"));
    let runs;
    try {
      runs = await this.runsUsing(mount.path, params.taskId);
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (runs.live.length)
      return refuse(
        domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, {
          runs: runs.live.slice(0, 128),
        }),
      );
    // The seat before any Git runs, so that a conversion beyond the cap starts nothing.
    const seat = worktrees.reserve();
    if (!seat) return refuse(domainError("BUSY"));
    let accepted = false;
    try {
      const group = {};
      const planned = await worktrees.plan({
        spec: {
          source: "worktree",
          repoId: mount.repoId,
          name: mount.name,
          ...(params.branch === undefined ? {} : { branch: params.branch }),
          ...(params.base === undefined ? {} : { base: params.base }),
          ...(params.noFetch === undefined ? {} : { noFetch: params.noFetch }),
        },
        repo: { repoId: mount.repoId, commonDir: repo.commonDir },
        name: mount.name,
        slug: record.slug,
        entryPath: record.workspace.entryPath,
        group,
        deadline: this.requestDeadline(),
      });
      if ("error" in planned) return refuse(planned.error);
      const planMount = planned.mount;
      if (planMount.source !== "worktree") return refuse(domainError("INVALID_ARGUMENT"));
      // Shown, never carried over (D3). Without an answer the source state cannot be shown, so
      // the conversion is not accepted.
      const changes = await worktrees.budgets.git<
        Awaited<ReturnType<typeof sourceChanges>> | Unknown
      >(group, this.requestDeadline(), () => sourceChanges(mount.path), UNKNOWN);
      if (changes === UNKNOWN) return refuse(domainError("BUSY"));
      if (changes === null) return refuse(domainError("GIT_UNAVAILABLE"));
      const written = await executeDatabaseWriteCommitted(
        this.context,
        principalId,
        method,
        params,
        {
          name: "binding.convert",
          args: {
            operation: this.key(principalId, params.operationId),
            taskId: params.taskId,
            mountId: params.mountId,
            path: planMount.path,
            branch: planMount.branch,
            spec: planMount.spec,
            commonDir: repo.commonDir,
            sourceChanges: changes,
            exited: runs.exited,
            responseBytes: this.options.responseBytes,
            at: this.now(),
            ...(params.expectedWorkspaceRevision === undefined
              ? {}
              : { expectedWorkspaceRevision: params.expectedWorkspaceRevision }),
          },
        },
      );
      // Only the committing call writes the entry and starts the preparation; a restart verifies
      // one left unfinished.
      // Only the committing call starts the preparation; a restart verifies one left
      // unfinished. Nothing in the workspace changed, so the entry is not written now.
      if (written.committed) {
        accepted = true;
        worktrees.start(seat, principalId, params.operationId);
      }
      return written.outcome;
    } finally {
      if (!accepted) seat.release();
    }
  }

  // Step 4 of a conversion (see the header): its target was prepared and verified ready by the
  // worktree executor, which hands it over here on the operation's seat.
  private async switchConversion(attempt: Attempt, key: OperationReceiptKey): Promise<void> {
    const { store } = this.options;
    let conversion;
    try {
      conversion = await retryRefused(
        () => store.call("bindings.conversion", { attemptId: attempt.attemptId }),
        STORE_RETRY,
      );
    } catch (error) {
      // Still refused after the retries: handed off (domain/worktrees.ts STORE_RETRY). Otherwise
      // the store failed; left running, and the next start verifies it.
      if (refusedStoreCall(error)) return this.switchAttention(key);
      return;
    }
    if (!conversion) return this.switchAttention(key);
    let runs;
    try {
      runs = await this.runsUsing(conversion.sourcePath, conversion.taskId);
    } catch {
      return this.switchAttention(key);
    }
    if (runs.live.length) return this.switchAttention(key, domainError("LIVE_RUNS_PRESENT"));
    let switched;
    const change = {
      attemptId: attempt.attemptId,
      actor: key,
      exited: runs.exited,
      responseBytes: this.options.responseBytes,
      limits: this.limits,
      at: this.now(),
    };
    try {
      switched = await retryRefused(() => store.call("bindings.switch", change), STORE_RETRY);
    } catch (error) {
      // A refusal changed nothing: handed off. Otherwise whether it committed is unknown; the
      // next start verifies it.
      if (refusedStoreCall(error)) return this.switchAttention(key);
      return;
    }
    if (!switched) return this.switchAttention(key);
    if (switched.kind === "refused") return this.switchAttention(key, switched.error);
    await this.options.worktrees.materialize(switched.workspaceId).catch(() => "pending");
  }

  // A prepared target whose switch was refused (or could not be checked) leaves the operation
  // requires_attention with the reason when known: continue switches once the reason is gone (a
  // run ended), abandon removes the target as T3b does for any unbound preparation. The checkout
  // stays bound either way. The record is repeated for as long as the store refuses it
  // (STORE_HANDOFF); a closed or failed store leaves it running, and the next start verifies it.
  private async switchAttention(key: OperationReceiptKey, error?: DomainError): Promise<void> {
    const record = {
      operation: key,
      progress: SWITCH_PROGRESS,
      ...(error ? { error } : {}),
      limits: this.limits,
      at: this.now(),
    };
    try {
      await retryRefused(
        () => this.options.store.call("worktrees.attention", record),
        STORE_HANDOFF,
      );
    } catch {
      // See above.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // binding.delete

  async delete(principalId: string, params: DeleteParams): Promise<DatabaseWriteOutcome> {
    const method = "binding.delete";
    const recorded = await recordedWrite(this.context, principalId, method, params);
    if (recorded) return recorded;
    const refuse = async (error: DomainError): Promise<DatabaseWriteOutcome> =>
      (await recordedWrite(this.context, principalId, method, params)) ?? { error };
    const { store, worktrees } = this.options;
    let source;
    try {
      source = await store.call("bindings.deleteSource", {
        taskId: params.taskId,
        mountId: params.mountId,
      });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (source.kind === "missing") return refuse(source.error);
    // A checkout is never Cove's to delete.
    if (source.source !== "worktree") return refuse(domainError("INVALID_ARGUMENT"));
    // Its preparation, or another deletion, still owns the mount.
    if (source.state === "pending" || source.busy)
      return refuse(domainError("OPERATION_EFFECTS_ACTIVE"));
    // Nothing Cove manages is left at the mount's path (an abandon removed it, or it was never
    // created): `mount remove` drops the mount.
    if (!source.managed) return refuse(domainError("INVALID_ARGUMENT"));
    let runs;
    try {
      runs = await this.runsUsing(source.path);
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (runs.live.length)
      return refuse(
        domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, {
          runs: runs.live.slice(0, 128),
        }),
      );
    const seat = worktrees.reserve();
    if (!seat) return refuse(domainError("BUSY"));
    const key = this.key(principalId, params.operationId);
    let accepted = false;
    try {
      const written = await executeDatabaseWriteCommitted(
        this.context,
        principalId,
        method,
        params,
        {
          name: "binding.delete",
          args: {
            operation: key,
            taskId: params.taskId,
            mountId: params.mountId,
            worktreeId: source.managed.worktreeId,
            exited: runs.exited,
            at: this.now(),
            ...(params.expectedWorkspaceRevision === undefined
              ? {}
              : { expectedWorkspaceRevision: params.expectedWorkspaceRevision }),
          },
        },
      );
      if (written.committed) {
        await worktrees.materialize(source.workspaceId).catch(() => "pending");
        accepted = true;
        worktrees.runOperation(seat, key, () => this.finishDeletion(key));
      }
      return written.outcome;
    } finally {
      if (!accepted) seat.release();
    }
  }

  // Step 3 of a deletion (see the header), after its acceptance or on an explicit continue.
  private async finishDeletion(key: OperationReceiptKey): Promise<void> {
    let deletion: DeletionRow | null;
    try {
      deletion = await retryRefused(
        () => this.options.store.call("bindings.deletion", { operation: key }),
        STORE_RETRY,
      );
    } catch (error) {
      // As in switchConversion.
      if (refusedStoreCall(error)) return this.attention(key);
      return;
    }
    if (!deletion || deletion.outcome !== "pending") return;
    const restore = (error: DomainError) => this.finish(key, "restored", error);
    // Without the registration there is no clone to ask; nothing was removed. (A registration
    // cannot be removed while a mount references it, so this is not expected.)
    if (deletion.clone === null) return restore(domainError("REPO_NOT_FOUND"));
    if (await this.processActive(key)) return this.attention(key);
    let runs;
    try {
      runs = await this.runsUsing(deletion.path);
    } catch {
      return this.attention(key);
    }
    // Not expected once accepted (no run is accepted that uses a path being deleted,
    // store/sql/deletions.ts), but a run the acceptance left out as exited may still be recorded
    // live. The final error names the runs, as a refusal does, as many as a stored record keeps.
    if (runs.live.length)
      return restore(
        domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, {
          runs: runs.live.slice(0, M1_LIMITS.storedErrorRuns),
        }),
      );
    const group = {};
    const before = await this.observe(group, deletion.clone, deletion.path);
    if (before === "unknown") return this.attention(key);
    if (before === "gone") return this.finish(key, "deleted");
    if (before === "foreign") return restore(domainError("INVALID_ARGUMENT"));
    const removed = await this.gitSlot<StepResult>(group, () =>
      forceRemoveWorktree(
        deletion.clone!,
        deletion.path,
        this.recording(key),
        this.options.timeouts,
      ),
    );
    // No slot came free (nothing started), or the step was not seen to end: unknown either way
    // until a continue observes it.
    if (removed === UNKNOWN || removed.kind === "uncertain") return this.attention(key);
    if (removed.kind === "not-started") return restore(domainError("GIT_UNAVAILABLE"));
    const after = await this.observe(group, deletion.clone, deletion.path);
    if (after === "gone") return this.finish(key, "deleted");
    // Git said it removed the worktree but it is still there: not explained, so not settled.
    if (after === "unknown" || removed.code === 0) return this.attention(key);
    return restore(domainError("GIT_UNAVAILABLE"));
  }

  private async finish(
    key: OperationReceiptKey,
    outcome: "deleted" | "restored",
    error?: DomainError,
  ): Promise<void> {
    let done;
    const finish = {
      operation: key,
      outcome,
      ...(error ? { error } : {}),
      limits: this.limits,
      at: this.now(),
    };
    try {
      done = await retryRefused(
        () => this.options.store.call("bindings.finishDelete", finish),
        STORE_RETRY,
      );
    } catch (failure) {
      // As in switchConversion.
      if (refusedStoreCall(failure)) return this.attention(key);
      return;
    }
    if (done) await this.options.worktrees.materialize(done.workspaceId).catch(() => "pending");
  }

  // Records the deletion as requires_attention, as in switchAttention.
  private async attention(key: OperationReceiptKey): Promise<void> {
    try {
      const active = await this.processActive(key);
      const record = {
        operation: key,
        progress: deletionProgress(active),
        limits: this.limits,
        at: this.now(),
      };
      await retryRefused(
        () => this.options.store.call("worktrees.attention", record),
        STORE_HANDOFF,
      );
    } catch {
      // See above.
    }
  }

  private async processActive(key: OperationReceiptKey): Promise<boolean> {
    try {
      return (await this.ledger.check(key)) !== "ended";
    } catch {
      return true;
    }
  }

  // The recording hooks of the removal step under the deletion's own operation: the process is
  // recorded before Git starts and marked ended once it was seen to exit (store/processes.ts).
  private recording(key: OperationReceiptKey) {
    let processId: string | null = null;
    return {
      record: async (process: { pid: number; pgid: number; startIdentity: string }) => {
        processId = (await this.ledger.record(key, process)).processId;
      },
      ended: async () => {
        if (processId !== null) await this.ledger.markEnded(processId);
      },
    };
  }

  private gitSlot<T>(group: object, work: () => Promise<T>): Promise<T | Unknown> {
    return this.options.worktrees.budgets.git<T | Unknown>(
      group,
      performance.now() + GIT_SLOT_WAIT_MS,
      work,
      UNKNOWN,
    );
  }

  // What is at the worktree path now (see Observed). Git's list of the clone's worktrees decides
  // whether it is registered; the filesystem whether something is still there.
  private async observe(group: object, clone: string, path: string): Promise<Observed> {
    const listed = await this.gitSlot(group, () => listWorktrees(clone));
    if (listed === UNKNOWN || listed === null) return "unknown";
    if (listed.some((entry) => entry.path === path)) return "registered";
    const deadline = performance.now() + FS_DEADLINE_MS;
    const admitted = await this.options.worktrees.budgets.fs(group, deadline, () =>
      lstat(path).then(
        () => "present" as const,
        (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? "absent" : "unknown"),
      ),
    );
    if (!admitted) return "unknown";
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"unknown">((done) => {
      timer = setTimeout(() => done("unknown"), Math.max(0, deadline - performance.now()));
      timer.unref();
    });
    const found = await Promise.race([
      admitted.settled.catch(() => "unknown" as const),
      late,
    ]).finally(() => clearTimeout(timer));
    if (found === "unknown") return "unknown";
    return found === "absent" ? "gone" : "foreign";
  }

  // ---------------------------------------------------------------------------------------------
  // binding.list

  async history(params: {
    taskId: string;
    mountId: string;
  }): Promise<{ bindings: BindingRecord[] } | { error: DomainError }> {
    let rows;
    try {
      rows = await this.options.store.call("bindings.history", params);
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (rows === null) return { error: domainError("TASK_NOT_FOUND") };
    if (!rows.length) return { error: domainError("MOUNT_NOT_FOUND") };
    return { bindings: rows };
  }
}

// ---------------------------------------------------------------------------------------------
// Startup verification (operations/recovery-verifiers.ts).

export type BindingRecoveryContext = {
  store: Store;
  serverId: string;
  relayInstanceId: string;
  now: () => number;
};

// A binding.delete an earlier instance left running is requires_attention while its deletion is
// pending (see the header): the store alone cannot tell whether Git removed the worktree. Null
// (the generic requires_attention) when the record names no deletion this server knows.
// binding.convert is verified by the worktree verifier (domain/worktrees.ts).
export function createBindingVerifier(context: BindingRecoveryContext): ReceiptVerifier {
  const ledger = new ProcessLedger(context.store, context.relayInstanceId, context.now);
  return async (record) => {
    // As in createWorktreeVerifier: M1 has a single local principal.
    const principals = await context.store.call("worktrees.recoveringPrincipals", {
      serverId: context.serverId,
      operationId: record.operationId,
    });
    if (principals.length !== 1) return null;
    const key = {
      serverId: context.serverId,
      principalId: principals[0]!,
      operationId: record.operationId,
    };
    const deletion = await context.store.call("bindings.deletion", { operation: key });
    if (!deletion || deletion.outcome !== "pending") return null;
    const active = (await ledger.check(key)) !== "ended";
    return attentionRecord(record, [], null, deletionProgress(active));
  };
}

// For tests: the directory a converted mount's worktree is created at.
export function convertedPath(entryPath: string, name: string): string {
  return join(entryPath, name);
}
