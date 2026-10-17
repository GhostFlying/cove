import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import type { OperationReceiptKey, OperationRecord, WriteRpcMethod } from "@cove/protocol/rpc";
import { HostPathSchema, type MountSpec, type WorkspaceRecord } from "@cove/protocol/workspace";
import {
  executeDatabaseWriteCommitted,
  recordedWrite,
  storeReadError,
  type DatabaseWriteContext,
  type DatabaseWriteOutcome,
  type OperationResultData,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { ReceiptVerifier } from "../operations/operation-receipts.js";
import type { Store } from "../store/database.js";
import { ProcessLedger } from "../store/processes.js";
import type { NewMount } from "../store/sql/workspaces.js";
import {
  REUSABLE_MANAGED_STATES,
  type ManagedWorktree,
  type Preparation,
} from "../store/sql/worktrees.js";
import { isValidBranchName } from "../git/repository.js";
import {
  addWorktree,
  branchCommit,
  checkOut,
  createBranch,
  deleteBranch,
  fetchRemote,
  observe,
  removeWorktree,
  resolveBase,
  type Observation,
  type Recording,
  type StepResult,
} from "../git/worktree.js";

// Managed worktree creation (docs/milestones/m1.md T3b, S3, S4, S8; D1, D2; relay-protocol §11.4,
// §11.5).
//
// Order of a creation. task.create or mount.add (domain/workspaces.ts) commits the mount as
// pending together with its preparation (migration 003) and the operation receipt, which stays
// running (store/sql/receipts.ts). After the entry is published, the executor prepares the
// operation's worktree mounts one after another, each through these steps:
// 1. fetch the source remote, unless the request said --no-fetch (D1: a failed fetch fails the
//    mount with FETCH_FAILED and creates nothing; Cove never drops the fetch on its own);
// 2. resolve the base commit (git/worktree.ts resolveBase: never the local HEAD) and check that
//    the branch and the path are free;
// 3. record the intent (managed_worktrees: path, branch, base commit, owning operation), durably,
//    before any Git side effect;
// 4. the three Git steps (branch, worktree, checkout), each a single recorded command in a process
//    group of its own (git/worktree.ts runGitStep);
// 5. record the mount ready, the worktree ready and the workspace's next revision.
// A mount that fails ends failed with its error and leaves the others alone: the operation goes
// on with the next mount and ends failed with every mount's outcome (S4); a failed mount can be
// retried (mount.retry) or removed. Nothing is started for the task: no run, no tab.
//
// Observe, then act. Steps 4 and 5 are driven by observation, never by memory of what was run:
// before each step the executor observes the branch and the worktree (git/worktree.ts observe)
// and runs the one step that state calls for, then observes again. A step that ran and changed
// nothing has failed: what it created of the intent so far is removed again where it still
// matches the intent exactly (see cleanup), and the mount fails. Any state that is not on the path
// from the intent to the finished worktree (the branch moved, something foreign at the path, a
// worktree with changes, a step whose process was not seen to exit, a question Git did not
// answer) stops the operation as requires_attention with what was observed, because nothing tells
// whether acting on it would destroy someone's work. The same driver serves the first run and an
// explicit operation.continue, so a continue repeats no step that already took effect.
//
// Restart (createWorktreeVerifier, registered in operations/recovery-verifiers.ts). An operation
// left running by an earlier instance whose worktree mounts all ended is proven: it gets the
// outcome of its mounts. One with a pending mount becomes requires_attention with the observed
// progress (completed steps, remaining effects, whether a recorded Git process may still run); no
// step is run again by itself. operation.continue and operation.abandon are explicit writes with
// their own operation IDs, refused (OPERATION_EFFECTS_ACTIVE, nothing accepted) while a process the
// operation recorded may still run (store/processes.ts), and decided only from a fresh observation
// once none does. Abandon removes only artifacts that match the intent exactly (the branch still at
// the recorded base and checked out nowhere else, the worktree at the recorded path on that branch
// and clean or not checked out); anything else is left in place and listed as a remaining effect.
//
// One operation is driven by one actor at a time: the executor, a continue or an abandon holds an
// in-process lock on it (one server owns the data directory).

const WORKTREE_METHODS: ReadonlySet<WriteRpcMethod> = new Set([
  "task.create",
  "mount.add",
  "mount.retry",
]);

type EntryState = WorkspaceRecord["entryState"];

export type WorktreeServiceOptions = {
  store: Store;
  receipts: OperationReceipts;
  serverId: string;
  relayInstanceId: string;
  encodeUtf8: (text: string) => Uint8Array;
  // Brings the workspace entry up to its current revision and returns its state
  // (domain/workspaces.ts materialize). A worktree is only created inside a ready entry.
  materialize: (workspaceId: string) => Promise<EntryState>;
  now?: () => number;
  newId?: () => string;
};

type MountOutcome =
  | { kind: "ready" }
  | { kind: "failed"; error: DomainError; abandonIntent: boolean }
  | { kind: "attention"; progress: Progress };

type Progress = NonNullable<OperationRecord["progress"]>;

type RetryParams = {
  operationId: string;
  taskId: string;
  mountId: string;
  branch?: string;
  base?: string;
  noFetch?: boolean;
};
type TargetParams = { operationId: string; targetOperationId: string };

const STEPS = ["branch", "worktree", "checkout"] as const;
type Step = (typeof STEPS)[number];

// The intent recorded for a mount, when this operation recorded it and it is still an intent.
function ownIntent(prep: Preparation, key: OperationReceiptKey): ManagedWorktree | null {
  const managed = prep.managed;
  return managed &&
    managed.state === "intent" &&
    managed.operation.serverId === key.serverId &&
    managed.operation.principalId === key.principalId &&
    managed.operation.operationId === key.operationId
    ? managed
    : null;
}

function completedOf(observation: Observation): Step[] {
  const steps: Step[] = [];
  if (observation.branch !== "at-base") return steps;
  steps.push("branch");
  if (!["unchecked", "partial", "clean", "changed"].includes(observation.worktree)) return steps;
  steps.push("worktree");
  if (observation.worktree === "clean") steps.push("checkout");
  return steps;
}

// The next step the observed state calls for (see the header): a step, done, or a state off the
// path from the intent to the finished worktree.
function nextStep(observation: Observation): Step | "done" | "unknown" | "mismatch" {
  const { branch, worktree } = observation;
  if (branch === "unknown" || worktree === "unknown") return "unknown";
  if (branch === "absent") return worktree === "absent" ? "branch" : "mismatch";
  if (branch !== "at-base") return "mismatch";
  switch (worktree) {
    case "absent":
      return "worktree";
    case "unchecked":
    case "partial":
      return "checkout";
    case "clean":
      return "done";
    default:
      return "mismatch";
  }
}

// What a requires_attention record shows about the mount in progress (OperationProgressSchema):
// the steps observed complete, the effects still to come and whether a recorded process may
// still run; `more` when other mounts of the operation have not been prepared yet.
function progressOf(
  prep: Preparation,
  observation: Observation | null,
  intent: boolean,
  processActive: boolean,
  more: boolean,
): Progress {
  const completed: string[] = intent ? ["intent"] : [];
  const done = observation ? completedOf(observation) : [];
  completed.push(...done);
  const remaining: string[] = [];
  if (!intent) {
    if (!prep.noFetch) remaining.push("fetch");
    remaining.push("intent");
  }
  remaining.push(...STEPS.filter((step) => !done.includes(step)), "record");
  if (processActive) remaining.push("git-process");
  if (more) remaining.push("more-mounts");
  return {
    completedSteps: completed.slice(0, 8),
    remainingEffects: remaining.slice(0, 8),
    recoveryActions: ["continue", "abandon"],
  };
}

// The operation's result with each of its worktree mounts at its current state, for a record that
// reports where the operation stands. Checkout mounts of a task.create keep their outcome.
function resultWith(
  current: OperationRecord,
  preps: Preparation[],
  workspaceRevision: number | null,
): OperationResultData {
  const result: OperationResultData = { ...current.result };
  const byMount = new Map(preps.map((prep) => [prep.mountId, prep]));
  if (result.mounts)
    result.mounts = result.mounts.map((outcome) => {
      const prep = byMount.get(outcome.mountId);
      if (!prep) return outcome;
      return {
        mountId: outcome.mountId,
        state: prep.mountState,
        ...(prep.mountState === "failed" && prep.errorKind ? { errorKind: prep.errorKind } : {}),
      };
    });
  if (workspaceRevision !== null && result.workspaceRevision !== undefined)
    result.workspaceRevision = workspaceRevision;
  return result;
}

// The outcome record of an operation whose worktree mounts all ended: succeeded when every one is
// ready, otherwise failed with the first failure's error kind (the per-mount outcomes are in the
// result).
function settledRecord(
  current: OperationRecord,
  preps: Preparation[],
  workspaceRevision: number | null,
): OperationRecord {
  const failed = preps.find((prep) => prep.mountState === "failed");
  const { progress: _progress, error: _error, ...rest } = current;
  return {
    ...rest,
    revision: current.revision + 1,
    state: failed ? "failed" : "succeeded",
    result: resultWith(current, preps, workspaceRevision),
    ...(failed ? { error: domainError(failed.errorKind ?? "RESULT_UNKNOWN") } : {}),
  };
}

function attentionRecord(
  current: OperationRecord,
  preps: Preparation[],
  workspaceRevision: number | null,
  progress: Progress,
): OperationRecord {
  return {
    ...current,
    revision: current.revision + 1,
    state: "requires_attention",
    result: resultWith(current, preps, workspaceRevision),
    progress,
    error: domainError("RESULT_UNKNOWN", "unknown"),
  };
}

const failed = (kind: DomainErrorKind, abandonIntent = true): MountOutcome => ({
  kind: "failed",
  error: domainError(kind),
  abandonIntent,
});

async function pathFree(path: string): Promise<boolean | null> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? true : null;
  }
}

// Recording hooks of one Git step under `key` (git/worktree.ts runGitStep): the process is
// recorded before git starts and marked ended once it was seen to exit.
function recording(ledger: ProcessLedger, key: OperationReceiptKey): Recording {
  let processId: string | null = null;
  return {
    record: async (process) => {
      processId = (await ledger.record(key, process)).processId;
    },
    ended: async () => {
      if (processId !== null) await ledger.markEnded(processId);
    },
  };
}

// The result of removing what an intent created (see the header): `left` names the artifacts that
// did not match the intent and stay; uncertain when a removal was not seen to end or Git did not
// answer.
type Cleanup = { kind: "done"; left: string[]; completed: Step[] } | { kind: "uncertain" };

async function cleanup(
  ledger: ProcessLedger,
  key: OperationReceiptKey,
  clone: string,
  intent: ManagedWorktree,
): Promise<Cleanup> {
  const target = { path: intent.path, branch: intent.branch, baseCommit: intent.baseCommit };
  let seen = await observe(clone, target);
  const completed = completedOf(seen);
  if (seen.branch === "unknown" || seen.worktree === "unknown") return { kind: "uncertain" };
  // Only a worktree exactly as Cove created it: on the branch, and clean or never checked out.
  if (seen.worktree === "unchecked" || seen.worktree === "clean") {
    const removed = await removeWorktree(clone, intent.path, recording(ledger, key));
    if (removed.kind === "uncertain") return { kind: "uncertain" };
    seen = await observe(clone, target);
    if (seen.branch === "unknown" || seen.worktree === "unknown") return { kind: "uncertain" };
  }
  const left: string[] = [];
  if (seen.worktree !== "absent") left.push("worktree");
  // update-ref deletes it only while it still points at the base commit (git/worktree.ts).
  if (seen.branch === "at-base" && seen.worktree === "absent" && !seen.branchUsedElsewhere) {
    const deleted = await deleteBranch(
      clone,
      intent.branch,
      intent.baseCommit,
      recording(ledger, key),
    );
    if (deleted.kind === "uncertain") return { kind: "uncertain" };
    seen = await observe(clone, target);
    if (seen.branch === "unknown") return { kind: "uncertain" };
  }
  // A branch Cove did not create as recorded (moved, or someone else's of the same name) is not
  // Cove's to delete; it is listed so the operator sees it.
  if (seen.branch !== "absent") left.push("branch");
  return { kind: "done", left, completed };
}

export class WorktreeService {
  private readonly ledger: ProcessLedger;
  // Operations being driven now (see the header); for each, the promise of its actor.
  private readonly busy = new Map<string, Promise<void>>();

  constructor(private readonly options: WorktreeServiceOptions) {
    this.ledger = new ProcessLedger(options.store, options.relayInstanceId, options.now);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private newId(): string {
    return (this.options.newId ?? randomUUID)();
  }

  private get context(): DatabaseWriteContext {
    return {
      serverId: this.options.serverId,
      receipts: this.options.receipts,
      encodeUtf8: this.options.encodeUtf8,
    };
  }

  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.options.serverId, principalId, operationId };
  }

  // Settles once every operation being driven now has stopped; for tests and an orderly stop.
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.all([...this.busy.values()]);
  }

  // Takes the operation for `work` unless another actor has it.
  private claim(key: OperationReceiptKey, work: () => Promise<void>): boolean {
    const id = JSON.stringify([key.serverId, key.principalId, key.operationId]);
    if (this.busy.has(id)) return false;
    const running = work()
      .catch(() => undefined)
      .finally(() => this.busy.delete(id));
    this.busy.set(id, running);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Planning (before the write that records the mount).

  // A worktree spec resolved for the write: its branch (`cove/<slug>` unless given, D1) checked by
  // Git's own rules, and its path `<entry>/<name>`. `repo` and `name` were resolved by the caller.
  async plan(input: {
    spec: Extract<MountSpec, { source: "worktree" }>;
    repo: { repoId: string; commonDir: string };
    name: string;
    slug: string;
    entryPath: string;
  }): Promise<{ mount: NewMount } | { error: DomainError }> {
    const { spec } = input;
    const branch = spec.branch ?? `cove/${input.slug}`;
    const valid = await isValidBranchName(branch);
    if (valid === null) return { error: domainError("GIT_UNAVAILABLE") };
    if (!valid) return { error: domainError("INVALID_ARGUMENT") };
    const path = join(input.entryPath, input.name);
    if (!HostPathSchema.safeParse(path).success) return { error: domainError("INVALID_ARGUMENT") };
    return {
      mount: {
        mountId: this.newId(),
        name: input.name,
        source: "worktree",
        repoId: input.repo.repoId,
        path,
        commonDir: input.repo.commonDir,
        branch,
        spec: {
          branch: spec.branch ?? null,
          baseRef: spec.base ?? null,
          noFetch: spec.noFetch ?? false,
        },
      },
    };
  }

  // Starts preparing the worktree mounts of an operation that was just committed running.
  start(principalId: string, operationId: string): void {
    const key = this.key(principalId, operationId);
    this.claim(key, () => this.drive(key));
  }

  // ---------------------------------------------------------------------------------------------
  // The executor.

  private async drive(key: OperationReceiptKey): Promise<void> {
    const preps = await this.options.store.call("worktrees.preparations", { operation: key });
    const pending = preps.filter((prep) => prep.mountState === "pending");
    for (const [index, prep] of pending.entries()) {
      const outcome = await this.prepare(key, prep);
      if (outcome.kind === "attention") {
        const more = index + 1 < pending.length;
        if (more && !outcome.progress.remainingEffects.includes("more-mounts"))
          outcome.progress.remainingEffects = [
            ...outcome.progress.remainingEffects,
            "more-mounts",
          ].slice(0, 8);
        await this.conclude(key, outcome.progress);
        return;
      }
      const revision = await this.options.store.call("worktrees.settle", {
        operation: key,
        mountId: prep.mountId,
        state: outcome.kind,
        ...(outcome.kind === "failed"
          ? { error: outcome.error, abandonIntent: outcome.abandonIntent }
          : {}),
        at: this.now(),
      });
      if (revision !== null)
        await this.options.materialize(prep.workspaceId).catch(() => "pending");
    }
    await this.conclude(key, null);
  }

  // Records the operation's outcome: settled from its mounts, or requires_attention with
  // `progress`. A store failure leaves it running; the next start verifies it.
  private async conclude(key: OperationReceiptKey, progress: Progress | null): Promise<void> {
    const current = await this.options.receipts.get(key);
    if (!current || current.state !== "running") return;
    const preps = await this.options.store.call("worktrees.preparations", { operation: key });
    const workspaceId = preps[0]?.workspaceId;
    const revision = workspaceId
      ? await this.options.store.call("worktrees.workspaceRevision", { workspaceId })
      : null;
    const next = progress
      ? attentionRecord(current, preps, revision, progress)
      : settledRecord(current, preps, revision);
    await this.options.receipts.update(key, next);
  }

  // Prepares one mount from what is observed now (see the header).
  private async prepare(key: OperationReceiptKey, prep: Preparation): Promise<MountOutcome> {
    const repo = prep.repo;
    let intent = ownIntent(prep, key);
    if (!repo)
      return intent
        ? { kind: "attention", progress: progressOf(prep, null, true, false, false) }
        : failed("REPO_NOT_FOUND");
    if (!intent) {
      if (prep.managed && !REUSABLE_MANAGED_STATES.has(prep.managed.state))
        return failed("MOUNT_NAME_CONFLICT");
      const entry = await this.options.materialize(prep.workspaceId).catch(() => "unavailable");
      if (entry !== "ready") return failed("WORKSPACE_ENTRY_UNAVAILABLE");
      if (!prep.noFetch) {
        const fetched = await fetchRemote(repo.path, recording(this.ledger, key));
        // Fetching changes only remote-tracking refs, which are not an artifact of the intent;
        // one that did not end is left to the process record.
        if (fetched.kind !== "exited" || fetched.code !== 0) return failed("FETCH_FAILED");
      }
      const base = await resolveBase(repo.path, {
        base: prep.baseRef,
        mainBranch: repo.mainBranch,
        offline: prep.noFetch,
      });
      if (base.kind === "unresolved") return failed("MAIN_BRANCH_UNRESOLVED");
      if (base.kind === "invalid-base") return failed("INVALID_ARGUMENT");
      if (base.kind === "unavailable") return failed("GIT_UNAVAILABLE");
      const existing = await branchCommit(repo.path, prep.branch);
      if (existing === "unavailable") return failed("GIT_UNAVAILABLE");
      if (existing !== null) return failed("BRANCH_EXISTS");
      const free = await pathFree(prep.path);
      if (free === null) return failed("GIT_UNAVAILABLE");
      if (!free) return failed("WORKSPACE_ENTRY_UNAVAILABLE");
      const worktreeId = this.newId();
      const recorded = await this.options.store.call("worktrees.recordIntent", {
        operation: key,
        mountId: prep.mountId,
        worktreeId,
        baseCommit: base.commit,
        at: this.now(),
      });
      if (recorded === "taken") return failed("MOUNT_NAME_CONFLICT");
      if (recorded === "gone") return failed("REPO_NOT_FOUND");
      intent = {
        worktreeId,
        path: prep.path,
        branch: prep.branch,
        baseCommit: base.commit,
        commonDir: repo.commonDir,
        state: "intent",
        mountId: prep.mountId,
        operation: key,
        completedSteps: [],
      };
    }
    return this.advance(key, prep, repo.path, intent);
  }

  private async advance(
    key: OperationReceiptKey,
    prep: Preparation,
    clone: string,
    intent: ManagedWorktree,
  ): Promise<MountOutcome> {
    const target = { path: intent.path, branch: intent.branch, baseCommit: intent.baseCommit };
    let ran: { step: Step; result: StepResult } | null = null;
    // At most one run of each step, and one observation after the last.
    for (let round = 0; round <= STEPS.length; round++) {
      const seen = await observe(clone, target);
      const completed = completedOf(seen);
      await this.options.store
        .call("worktrees.recordSteps", {
          worktreeId: intent.worktreeId,
          steps: ["intent", ...completed],
          at: this.now(),
        })
        .catch(() => undefined);
      const next = nextStep(seen);
      if (next === "done") return { kind: "ready" };
      const attention = (active = false): MountOutcome => ({
        kind: "attention",
        progress: progressOf(prep, seen, true, active, false),
      });
      // A step whose process was not seen to end may still be changing the state just observed.
      if (ran?.result.kind === "uncertain") return attention(true);
      if (next === "unknown") return attention();
      if (next === "mismatch") {
        // The branch exists but is not the one this intent created (it was there before the
        // first step could create it, or moved since): not Cove's, and nothing else of the
        // intent exists yet. The mount fails as for an existing branch; the branch stays.
        if (seen.branch === "moved" && seen.worktree === "absent")
          return failed("BRANCH_EXISTS", true);
        return attention();
      }
      // The step ran (or could not start) and the state did not move on: it failed.
      if (ran && ran.step === next) return this.fail(key, prep, clone, intent);
      const recorder = recording(this.ledger, key);
      const result: StepResult =
        next === "branch"
          ? await createBranch(clone, intent.branch, intent.baseCommit, recorder)
          : next === "worktree"
            ? await addWorktree(clone, intent.path, intent.branch, recorder)
            : await checkOut(intent.path, recorder);
      ran = { step: next, result };
    }
    return {
      kind: "attention",
      progress: progressOf(prep, null, true, false, false),
    };
  }

  // A step that did not take effect: what the intent created so far is removed where it matches
  // exactly, and the mount fails. GIT_UNAVAILABLE: Git gave no usable answer to a step that should
  // have worked (its stderr is not interpreted; it may hold paths or remote URLs).
  private async fail(
    key: OperationReceiptKey,
    prep: Preparation,
    clone: string,
    intent: ManagedWorktree,
  ): Promise<MountOutcome> {
    const cleaned = await cleanup(this.ledger, key, clone, intent);
    if (cleaned.kind === "uncertain")
      return { kind: "attention", progress: progressOf(prep, null, true, true, false) };
    return failed("GIT_UNAVAILABLE", cleaned.left.length === 0);
  }

  // ---------------------------------------------------------------------------------------------
  // mount.retry

  async retry(principalId: string, params: RetryParams): Promise<DatabaseWriteOutcome> {
    const recorded = await recordedWrite(this.context, principalId, "mount.retry", params);
    if (recorded) return recorded;
    const refuse = async (error: DomainError): Promise<DatabaseWriteOutcome> =>
      (await recordedWrite(this.context, principalId, "mount.retry", params)) ?? { error };
    let source;
    try {
      source = await this.options.store.call("worktrees.retrySource", {
        taskId: params.taskId,
        mountId: params.mountId,
      });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (!source) return refuse(domainError("MOUNT_NOT_FOUND"));
    if (source.archived) return refuse(domainError("TASK_ARCHIVED"));
    if (source.source !== "worktree" || source.state !== "failed" || !source.spec)
      return refuse(domainError("INVALID_ARGUMENT"));
    let task;
    try {
      task = await this.options.store.call("tasks.get", { taskId: params.taskId });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (!task) return refuse(domainError("TASK_NOT_FOUND"));
    // The overrides apply to this attempt only; otherwise the original request is repeated.
    const branch = params.branch ?? source.spec.branch ?? `cove/${task.record.slug}`;
    const valid = await isValidBranchName(branch);
    if (valid === null) return refuse(domainError("GIT_UNAVAILABLE"));
    if (!valid) return refuse(domainError("INVALID_ARGUMENT"));
    const { outcome, committed } = await executeDatabaseWriteCommitted(
      this.context,
      principalId,
      "mount.retry",
      params,
      {
        name: "mount.retry",
        args: {
          operation: this.key(principalId, params.operationId),
          taskId: params.taskId,
          mountId: params.mountId,
          branch,
          baseRef: params.base ?? source.spec.baseRef,
          noFetch: params.noFetch ?? source.spec.noFetch,
          at: this.now(),
        },
      },
    );
    if (committed) {
      await this.options.materialize(source.workspaceId).catch(() => "pending");
      this.start(principalId, params.operationId);
    }
    return outcome;
  }

  // ---------------------------------------------------------------------------------------------
  // operation.continue and operation.abandon

  // The target of a continue or abandon, or why it cannot be acted on. Refusals are decided before
  // anything is accepted.
  private async target(
    principalId: string,
    method: "operation.continue" | "operation.abandon",
    params: TargetParams,
  ): Promise<
    { record: OperationRecord; key: OperationReceiptKey } | { outcome: DatabaseWriteOutcome }
  > {
    const recorded = await recordedWrite(this.context, principalId, method, params);
    if (recorded) return { outcome: recorded };
    const key = this.key(principalId, params.targetOperationId);
    let record: OperationRecord | null;
    try {
      record = await this.options.receipts.get(key);
    } catch (error) {
      return {
        outcome: await this.refuseTarget(principalId, method, params, storeReadError(error)),
      };
    }
    if (!record)
      return {
        outcome: await this.refuseTarget(
          principalId,
          method,
          params,
          domainError("OPERATION_NOT_FOUND"),
        ),
      };
    if (!WORKTREE_METHODS.has(record.method) || record.state !== "requires_attention")
      return {
        outcome: await this.refuseTarget(
          principalId,
          method,
          params,
          domainError("OPERATION_NOT_RESUMABLE"),
        ),
      };
    return { record, key };
  }

  private async refuseTarget(
    principalId: string,
    method: WriteRpcMethod,
    params: TargetParams,
    error: DomainError,
  ): Promise<DatabaseWriteOutcome> {
    return (await recordedWrite(this.context, principalId, method, params)) ?? { error };
  }

  // Whether a process the target recorded may still run (store/processes.ts); such a target is
  // neither continued nor abandoned (S8).
  private async effectsActive(key: OperationReceiptKey): Promise<boolean> {
    return (await this.ledger.check(key)) !== "ended";
  }

  private get limits() {
    return {
      serverId: this.options.serverId,
      operationRecordBytes: this.options.receipts.composition.budgets.operationRecordBytes,
    };
  }

  // Runs `work` as the operation's single actor (see the header) and resolves with the outcome it
  // reports through `answer`; the work may go on after answering (a continue then drives the
  // target). Null when another actor has the operation.
  private act(
    key: OperationReceiptKey,
    work: (answer: (outcome: DatabaseWriteOutcome) => void) => Promise<void>,
  ): Promise<DatabaseWriteOutcome | null> {
    return new Promise((done) => {
      let answered = false;
      const answer = (outcome: DatabaseWriteOutcome) => {
        if (answered) return;
        answered = true;
        done(outcome);
      };
      const claimed = this.claim(key, async () => {
        try {
          await work(answer);
        } finally {
          // Work that failed before it answered accepted nothing.
          answer({ error: domainError("BUSY") });
        }
      });
      if (!claimed) done(null);
    });
  }

  async continueOperation(
    principalId: string,
    params: TargetParams,
  ): Promise<DatabaseWriteOutcome> {
    const method = "operation.continue";
    const found = await this.target(principalId, method, params);
    if ("outcome" in found) return found.outcome;
    const { record, key } = found;
    const refuse = (error: DomainError) => this.refuseTarget(principalId, method, params, error);
    const outcome = await this.act(key, async (answer) => {
      let active: boolean;
      try {
        active = await this.effectsActive(key);
      } catch (error) {
        return answer(await refuse(storeReadError(error)));
      }
      if (active) return answer(await refuse(domainError("OPERATION_EFFECTS_ACTIVE")));
      const { progress: _progress, error: _error, ...rest } = record;
      const next: OperationRecord = { ...rest, revision: record.revision + 1, state: "running" };
      const written = await executeDatabaseWriteCommitted(
        this.context,
        principalId,
        method,
        params,
        {
          name: "operation.continue",
          args: {
            target: key,
            expectedRevision: record.revision,
            next,
            limits: this.limits,
            at: this.now(),
          },
        },
      );
      answer(written.outcome);
      // The target is running again; this actor drives it from what it observes now.
      if (written.committed) await this.drive(key);
    });
    return outcome ?? refuse(domainError("BUSY"));
  }

  async abandonOperation(principalId: string, params: TargetParams): Promise<DatabaseWriteOutcome> {
    const method = "operation.abandon";
    const found = await this.target(principalId, method, params);
    if ("outcome" in found) return found.outcome;
    const { record, key } = found;
    const refuse = (error: DomainError) => this.refuseTarget(principalId, method, params, error);
    const outcome = await this.act(key, async (answer) => {
      let preps: Preparation[];
      try {
        if (await this.effectsActive(key))
          return answer(await refuse(domainError("OPERATION_EFFECTS_ACTIVE")));
        preps = await this.options.store.call("worktrees.preparations", { operation: key });
      } catch (error) {
        return answer(await refuse(storeReadError(error)));
      }
      const pending = preps.filter((prep) => prep.mountState === "pending");
      const abandoned: string[] = [];
      const left: string[] = [];
      const completed: string[] = [];
      const add = (into: string[], items: readonly string[]) => {
        for (const item of items) if (!into.includes(item)) into.push(item);
      };
      for (const prep of pending) {
        const intent = ownIntent(prep, key);
        if (!intent) continue;
        // Without the registration there is no clone to observe; nothing is removed.
        if (!prep.repo) {
          add(left, ["worktree", "branch"]);
          continue;
        }
        const cleaned = await cleanup(this.ledger, key, prep.repo.path, intent);
        // Whatever was removed shows in the next observation; nothing is recorded now, and the
        // same request may be sent again once Git answers.
        if (cleaned.kind === "uncertain")
          return answer(await refuse(domainError("GIT_UNAVAILABLE")));
        add(completed, cleaned.completed);
        if (cleaned.left.length === 0) abandoned.push(intent.worktreeId);
        add(left, cleaned.left);
      }
      // A mount whose preparation was abandoned ends failed; `mount retry` starts a new attempt.
      const ended = domainError("OPERATION_NOT_RESUMABLE");
      const settled = preps.map((prep) =>
        prep.mountState === "pending"
          ? { ...prep, mountState: "failed" as const, errorKind: ended.kind }
          : prep,
      );
      const workspaceId = preps[0]?.workspaceId;
      let revision: number | null = null;
      if (workspaceId)
        try {
          // The abandon write advances the revision once when it fails a mount.
          revision =
            (await this.options.store.call("worktrees.workspaceRevision", { workspaceId })) +
            (pending.length ? 1 : 0);
        } catch (error) {
          return answer(await refuse(storeReadError(error)));
        }
      const next: OperationRecord = {
        ...record,
        revision: record.revision + 1,
        state: "cancelled",
        result: resultWith(record, settled, revision),
        progress: {
          completedSteps: completed.slice(0, 8),
          remainingEffects: left.slice(0, 8),
          recoveryActions: [],
        },
      };
      const written = await executeDatabaseWriteCommitted(
        this.context,
        principalId,
        method,
        params,
        {
          name: "operation.abandon",
          args: {
            target: key,
            expectedRevision: record.revision,
            next,
            limits: this.limits,
            mounts: pending.map((prep) => ({ mountId: prep.mountId, error: ended })),
            abandoned,
            at: this.now(),
          },
        },
      );
      if (written.committed && workspaceId)
        await this.options.materialize(workspaceId).catch(() => "pending");
      answer(written.outcome);
    });
    return outcome ?? refuse(domainError("BUSY"));
  }
}

// ---------------------------------------------------------------------------------------------
// Startup verification (operations/recovery-verifiers.ts).

export type WorktreeRecoveryContext = {
  store: Store;
  serverId: string;
  relayInstanceId: string;
  now: () => number;
};

// Proves what it can about a worktree-creating operation an earlier instance left unfinished (see
// the header, restart): the outcome of an operation whose mounts all ended, otherwise
// requires_attention with the observed progress. Null (the generic requires_attention) when the
// record names no preparation this server knows.
export function createWorktreeVerifier(context: WorktreeRecoveryContext): ReceiptVerifier {
  const ledger = new ProcessLedger(context.store, context.relayInstanceId, context.now);
  return async (record) => {
    // The verifier receives the record, not its key: the key's principal is looked up. M1 has a
    // single local principal; an operation ID recorded under several principals is not guessed.
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
    const preps = await context.store.call("worktrees.preparations", { operation: key });
    if (!preps.length) return null;
    const workspaceId = preps[0]!.workspaceId;
    const revision = await context.store.call("worktrees.workspaceRevision", { workspaceId });
    const pending = preps.filter((prep) => prep.mountState === "pending");
    if (!pending.length) return settledRecord(record, preps, revision);
    const first = pending[0]!;
    const active = (await ledger.check(key)) !== "ended";
    const intent = ownIntent(first, key);
    const seen =
      intent && first.repo
        ? await observe(first.repo.path, {
            path: intent.path,
            branch: intent.branch,
            baseCommit: intent.baseCommit,
          })
        : null;
    return attentionRecord(
      record,
      preps,
      revision,
      progressOf(first, seen, intent !== null, active, pending.length > 1),
    );
  };
}
