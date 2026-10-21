import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { domainError, type DomainError, type DomainErrorKind } from "@cove/protocol/errors";
import type { OperationReceiptKey, OperationRecord, WriteRpcMethod } from "@cove/protocol/rpc";
import { HostPathSchema, type MountSpec, type WorkspaceRecord } from "@cove/protocol/workspace";
import {
  executeDatabaseWriteCommitted,
  recordedWrite,
  storeReadError,
  type DatabaseWriteContext,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts, ReceiptVerifier } from "../operations/operation-receipts.js";
import type { Store } from "../store/database.js";
import { refusedStoreCall, retryRefused, type RetrySchedule } from "../store/store-errors.js";
import { ProcessLedger } from "../store/processes.js";
import type { NewMount } from "../store/sql/workspaces.js";
import {
  appendStep,
  attentionRecord,
  credited,
  lastRun,
  remainingArtifacts,
  settledRecord,
  type Attempt,
  type AttemptPhase,
  type Progress,
  type StepEntry,
  type StepName,
} from "../store/sql/worktrees.js";
import { isValidBranchName } from "../git/repository.js";
import {
  addWorktree,
  branchCommit,
  branchesUnder,
  checkOut,
  createBranch,
  deleteBranch,
  fetchRemote,
  gitPath,
  isSymbolicRef,
  listWorktrees,
  removeWorktree,
  resolveBase,
  statusEmpty,
  type Recording,
  type StepResult,
  type StepTimeouts,
  type WorktreeEntry,
} from "../git/worktree.js";

// Managed worktree creation (docs/milestones/m1.md T3b, S3, S4, S8; D1, D2; relay-protocol §11.4,
// §11.5).
//
// The threat model (user decision of 2026-10-18, m1.md D1). Cove is single-user, and the
// authenticated user is its trusted owner: Cove does not defend against the owner attacking
// themselves, whether by fabricating look-alike artifacts at its managed paths (while the server is
// down or concurrently), by editing concurrently, or by crafting inputs, and keeps no evidence of
// provenance for that. The criterion is no data loss, not provenance: what Cove removes is the
// attempt's own never-ready worktree and branch, matched to the recorded intent by shape, with
// Git's own refusal as the safeguard (see Removal); the criterion for going on is that the state
// matches the recorded intent by its shape. Cove never overwrites work (a checkout runs only into
// a pristine worktree), never removes with force, never repeats a step blindly and never reports
// an uncertain step as success: whatever it cannot establish goes to requires_attention, never to
// success and never to a silent retry. Changes the user makes while a step or a cleanup runs are
// an accepted residual (see the end of Removal).
// Input validation stays, for correctness rather than as a defense against the owner: RPC
// arguments are validated and bounded, and branch, base, remote and path values that reach Git are
// checked by Git's own rules and never passed where they could be read as options (option-looking
// names, oversized values; git/repository.ts, git/worktree.ts). Content and refs from Git remotes
// are third-party data and are handled as such: no option injection from remote names or refs (the
// remote's HEAD names only a remote-tracking ref Cove resolves itself), no lazy fetch beyond the
// intended one (GIT_NO_LAZY_FETCH, git/run.ts), and the network environment isolation of fetch and
// ls-remote (networkEnvironment).
//
// Order of an attempt. task.create, mount.add or mount.retry commits the mount as pending with an
// attempt (migration 003) and the operation receipt, which stays running (store/sql/receipts.ts).
// After the entry is published, the executor prepares the operation's attempts one after another.
// Each attempt goes through recorded phases, so a continue resumes where it stopped and repeats
// nothing that completed:
// 1. planned: the entry is verified (the T3a materialization: the entry and its root are Cove's,
//    the manifest is current) and its device and inode recorded; then the source remote is
//    fetched, unless the request said --no-fetch (D1: a fetch that fails fails the mount with
//    FETCH_FAILED and creates nothing; Cove never drops the fetch on its own);
// 2. fetched: the entry is verified again (a fetch may take minutes), then the base commit is
//    resolved (git/worktree.ts resolveBase: never the local HEAD) and recorded;
// 3. resolved: the branch and the path must be free, then the intent (managed_worktrees: path,
//    branch, base commit, owning operation) is recorded, durably, before any Git side effect;
// 4. intent: the three Git steps (branch, worktree, checkout), each a single recorded command in a
//    process group of its own (git/worktree.ts runGitStep);
// 5. the attempt settles ready: in one transaction with the managed worktree, the mount, the
//    workspace revision and, for the operation's last attempt, the operation's final receipt.
// An attempt that fails ends failed with its error and leaves the others alone: the operation goes
// on with the next one and ends failed with every mount's outcome (S4); a failed mount can be
// retried (mount.retry) once its operation ended, or removed. Nothing is started for the task: no
// run, no tab.
//
// The step ledger. Every effect is appended to the attempt's steps (store/sql/worktrees.ts
// StepEntry) as started before it begins, and then marked with what became of it. Only two things
// credit an effect to the attempt: Cove's own command exited with status 0 (succeeded), or it was
// not seen to end and, once its process is known to have ended, the state is exactly what the step
// makes from the recorded intent (verified, see verifyUncertain). A known failure is never
// credited, even when the state now looks like what the step would have made: someone else made
// it (a branch created between Cove's check and its update-ref is not Cove's to use or delete). A
// credited effect that has since disappeared or changed stops the attempt as requires_attention;
// it is not made again.
//
// Uncertainty first. Before an attempt does anything else, a last step that is started or
// uncertain is resolved: while any process the operation recorded may still run
// (store/processes.ts), the operation is requires_attention with `git-process` in its progress,
// whatever the state looks like (an unfinished checkout can look complete). Once none does, the
// state is observed again: the step is verified when the state is exactly its effect, void when
// nothing of it exists (it may run again), and otherwise the attempt stays requires_attention.
//
// The entry. Every filesystem-affecting step (worktree add, checkout, a removal) is preceded and
// followed by a verification of the entry: materialized and still the directory recorded at the
// attempt's start. Any difference stops the attempt as requires_attention, because the path
// `<entry>/<name>` may now lead somewhere that is not Cove's. For worktree add and the checkout the
// check before runs once the step holds its Git slot, immediately before its command starts (step
// guard): a check made before waiting for the slot (up to GIT_SLOT_WAIT_MS) would let the command
// write through an entry replaced in the meantime. The check after only detects a change during the
// step; it cannot undo a write.
//
// The checkout. `read-tree -m -u HEAD` keeps untracked files in its way, but it replaces or removes
// entries someone staged in the worktree's index. So it runs only on a worktree that is exactly
// what `worktree add --no-checkout` left, checked in the same guard: nothing but its `.git` file,
// pointing at its own administrative directory, and no index there. Anything else is
// requires_attention, and whatever is there stays.
//
// Ready. Before an attempt settles ready, also when a continue finds every step credited, the entry
// is verified again and so is each effect: the branch is a plain ref at the base, the worktree is
// registered at the path on the branch, and the checkout is physically there (its directory, its
// `.git` file pointing at its administrative directory and back, and an index). A registration
// alone is no proof: Git keeps it for a worktree whose directory was deleted.
//
// Removal (a failed attempt's cleanup, or an abandon) considers the artifacts the ledger credits
// to the attempt. The worktree is Cove's own and was never reported ready, so nobody was meant to
// work in it (user decision of 2026-10-18, m1.md D1): Cove cleans it up with Git's own refusal as
// the only safeguard, adding no clean check of its own, and never uses force (git/worktree.ts):
// - the worktree, when it is registered at the recorded path on the recorded branch, by plain
//   `git worktree remove <path>` in the source clone, whether or not the checkout ran; Git
//   refuses a worktree with changes or untracked files, and any refusal keeps it. Ignored files
//   go with it, as Git removes them. One exception: a worktree never checked out (no index,
//   nothing but its `.git` file, which points at its own administrative directory and back, HEAD
//   still on the branch), which `worktree remove` would refuse as dirty, is removed by deleting
//   that `.git` file and then the directory, only while it is empty;
// - the branch, when it is a plain ref (not symbolic) at the recorded base commit that no
//   worktree has checked out, by `update-ref --no-deref -d` with the base as the old value: it
//   then holds nothing the base does not. A worktree left in place has it checked out, so it
//   stays too.
// Anything else is preserved and listed (the mount's `left` and the remaining effects). A removal
// that may still be running after its deadline is outstanding: continue and abandon are refused
// with OPERATION_EFFECTS_ACTIVE until it settled (`mutate`), as for a recorded process.
//
// Accepted residual windows (m1.md D1). The checks above and the removal they guard are separate
// steps, and the user may change the clone or the worktree in between, while a cleanup runs; that
// is out of scope by decision. Concretely: a branch checked out by a new worktree, a component of
// the path swapped for a symlink, or the unchecked worktree put to use after its check, may be
// acted on as checked. Git's refusal in `worktree remove`, the old value for `update-ref -d` and
// rmdir's refusal of a non-empty directory narrow the windows but do not close them.
//
// Restart (createWorktreeVerifier, registered in operations/recovery-verifiers.ts). It reads the
// store and the process records only; it runs no Git and touches no file. An operation left running
// by an earlier instance whose attempts were all recorded as ended gets the outcome they record
// (succeeded only when every one is ready); any other becomes requires_attention with the recorded
// progress. operation.continue and operation.abandon are explicit writes with their own operation
// IDs, refused (OPERATION_EFFECTS_ACTIVE, nothing accepted) while a process the operation recorded
// may still run. A continue after a crash observes the state again for the step that was not seen
// to end (evidence): a removal whose artifact is gone is recorded removed, and one whose artifact
// is still there goes through the checks above again; no step is repeated without that.
//
// Abandon is accepted before anything is removed: one transaction commits the abandon running and
// claims the target's pending attempts, so nothing else acts on them; the removals follow, each in
// the ledger under the abandon's own process records, and one transaction ends both operations
// (store/sql/worktrees.ts). An abandon interrupted by a restart, or whose removal was not seen to
// end, is itself requires_attention, and a continue of it resumes its removals.
//
// Budgets. All Git and filesystem work of the preparation runs in the server's shared Git slots and
// filesystem permits (domain/workspaces.ts), with deadlines; no answer in time is an unknown state
// (requires_attention), never a guess. At most `actors` operations are driven at once and `queue`
// more wait; a request that would start another is refused with BUSY before it is accepted.
//
// One operation is driven by one actor at a time (one server owns the data directory).

// The writes that prepare managed worktrees through attempts. binding.convert (m1 T5,
// domain/bindings.ts) prepares its target like mount.add while the mount stays the checkout, so it
// is continued, abandoned and verified at startup like the others; only its switch to a ready
// target is the binding module's (convertWith).
const WORKTREE_METHODS: ReadonlySet<WriteRpcMethod> = new Set([
  "task.create",
  "mount.add",
  "mount.retry",
  "binding.convert",
]);

const STEPS = ["branch", "worktree", "checkout"] as const;

type EntryState = WorkspaceRecord["entryState"];

// The shared Git slots and filesystem permits (domain/workspaces.ts Slots and FsPermits).
export type WorktreeBudgets = {
  git<T>(group: object, deadline: number, work: () => Promise<T>, busy: T): Promise<T>;
  fs<T>(
    group: object,
    deadline: number,
    work: () => Promise<T>,
  ): Promise<{ settled: Promise<T> } | null>;
};

export type WorktreeServiceOptions = {
  store: Store;
  receipts: OperationReceipts;
  serverId: string;
  relayInstanceId: string;
  encodeUtf8: (text: string) => Uint8Array;
  // Brings the workspace entry up to its current revision and returns its state
  // (domain/workspaces.ts materialize). A worktree is only created inside a ready entry.
  materialize: (workspaceId: string) => Promise<EntryState>;
  budgets: WorktreeBudgets;
  timeouts?: StepTimeouts;
  // Operations driven at once, and accepted ones waiting for that (see the header); 2 and 8.
  actors?: number;
  queue?: number;
  // The deadline of the Git work a request does before it is accepted (the branch name check of
  // mount.retry), from its start; the server passes its write step budget.
  requestStepMs?: number;
  // The deadline of a filesystem operation from its permit (FS_DEADLINE_MS).
  fsDeadlineMs?: number;
  // Test hooks: runs inside the filesystem work of an unchecked removal, before it changes
  // anything.
  hooks?: { beforeUncheckedRemoval?: (path: string) => Promise<void> };
  now?: () => number;
  newId?: () => string;
};

// How long an actor waits for a Git slot (a step holds one for as long as it runs) and how long
// a filesystem operation may take, from its permit.
const GIT_SLOT_WAIT_MS = 60_000;
const FS_DEADLINE_MS = 20_000;
// How many default branch names are tried (`cove/<slug>`, then `-2` ... `-100`), as in Orca.
const DEFAULT_BRANCH_CANDIDATES = 100;
const REQUEST_STEP_MS = 20_000;
// The actors' store calls (#126 item 9). A refused call (store-errors.ts refusedStoreCall: a full
// queue, or a transaction that rolled back) changed nothing. A transient refusal (a full queue,
// SQLite contention: transientStoreRefusal) is repeated: a ledger read or write a few times over
// about a second and a half, after which the operation is handed to requires_attention; that
// hand-off is repeated for as long as it is refused transiently, so an operation is not left
// running without an actor because of a passing refusal. A persistent store error (a read-only,
// corrupt or full database, an I/O error) is not repeated (#144 item 4): the operation is handed
// off at once, and if the hand-off fails the same way it is left running, the store having logged
// both errors (Store.onOperationError). That, a closed or failed store, or a call whose outcome is
// unknown ends an actor without a record; the next start verifies the operation
// (createWorktreeVerifier).
export const STORE_RETRY: RetrySchedule = { tries: 6, delayMs: 50, capMs: 800 };
export const STORE_HANDOFF: RetrySchedule = { tries: Infinity, delayMs: 50, capMs: 5_000 };

const UNKNOWN = Symbol("unknown");
type Unknown = typeof UNKNOWN;

type Outcome =
  { kind: "ready" } | { kind: "failed"; error: DomainErrorKind } | { kind: "attention" };

const ATTENTION: Outcome = { kind: "attention" };
const failed = (error: DomainErrorKind): Outcome => ({ kind: "failed", error });

type RetryParams = {
  operationId: string;
  taskId: string;
  mountId: string;
  branch?: string;
  base?: string;
  noFetch?: boolean;
};
type TargetParams = { operationId: string; targetOperationId: string };

// A store write of the ledger was refused (the attempt is no longer this actor's) or failed: the
// actor stops, and the operation is verified at the next start or by an explicit continue.
class Stopped extends Error {}

// One actor's run: its turn group for the shared budgets, and the operation it acts as (the
// attempt's own operation, or the abandon that claimed it), under which processes are recorded.
type Run = { group: object; actor: OperationReceiptKey };

// Seats of the actors (see the header, budgets). A seat is reserved before the request is
// accepted, so an accepted operation always has one; it runs its work once a running place is
// free, and a place passes straight to the next waiter.
export type Seat = { run: (work: () => Promise<void>) => Promise<void>; release: () => void };

class Actors {
  private running = 0;
  private held = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly size: number,
    private readonly waiting: number,
  ) {}

  reserve(): Seat | null {
    if (this.held >= this.size + this.waiting) return null;
    this.held++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.held--;
    };
    return {
      release,
      run: async (work) => {
        if (released) return;
        if (this.running >= this.size) await new Promise<void>((go) => this.waiters.push(go));
        else this.running++;
        try {
          await work();
        } finally {
          const next = this.waiters.shift();
          if (next) next();
          else this.running--;
          release();
        }
      },
    };
  }
}

// What a requires_attention record shows of an operation's attempts (OperationProgressSchema):
// for the first pending one, the steps the ledger records complete and the effects still to come;
// `git-process` while a recorded process may still run; `more-mounts` when other attempts wait.
export function progressOf(attempts: readonly Attempt[], processActive: boolean): Progress {
  const pending = attempts.filter((attempt) => attempt.outcome === "pending");
  const first = pending[0];
  const completed: string[] = [];
  const remaining: string[] = [];
  if (first) {
    const phase = PHASE_ORDER.indexOf(first.phase);
    if (credited(first.steps, "fetch")) completed.push("fetch");
    else if (!first.noFetch && phase < 1) remaining.push("fetch");
    if (phase >= 2) completed.push("base");
    else remaining.push("base");
    if (phase >= 3) completed.push("intent");
    else remaining.push("intent");
    for (const step of STEPS) if (credited(first.steps, step)) completed.push(step);
    if (failedStep(first)) {
      for (const artifact of remainingArtifacts(first.steps))
        remaining.push(artifact === "worktree" ? "remove-worktree" : "delete-branch");
    } else for (const step of STEPS) if (!credited(first.steps, step)) remaining.push(step);
    remaining.push("record");
  }
  if (processActive) remaining.push("git-process");
  if (pending.length > 1) remaining.push("more-mounts");
  return {
    completedSteps: completed.slice(0, 8),
    remainingEffects: remaining.slice(-8),
    recoveryActions: ["continue", "abandon"],
  };
}

// The same for an abandon: the removals done so far, and that the rest of them remain.
function abandonProgress(attempts: readonly Attempt[], processActive: boolean): Progress {
  const completed: string[] = [];
  for (const attempt of attempts)
    for (const step of ["remove-worktree", "delete-branch"] as const)
      if (lastRun(attempt.steps, step)?.outcome === "removed" && !completed.includes(step))
        completed.push(step);
  return {
    completedSteps: completed,
    remainingEffects: processActive ? ["cleanup", "record", "git-process"] : ["cleanup", "record"],
    recoveryActions: ["continue"],
  };
}

const PHASE_ORDER: readonly AttemptPhase[] = ["planned", "fetched", "resolved", "intent"];

// The creation step that failed, which turns the rest of the attempt into its cleanup.
function failedStep(attempt: Pick<Attempt, "steps">): StepName | null {
  for (const step of STEPS) if (lastRun(attempt.steps, step)?.outcome === "failed") return step;
  return null;
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

type PathState =
  | { kind: "absent" }
  | { kind: "present"; directory: boolean; identity: string }
  | { kind: "unknown" };

async function pathState(path: string): Promise<PathState> {
  try {
    const stats = await lstat(path);
    return {
      kind: "present",
      directory: stats.isDirectory() && !stats.isSymbolicLink(),
      identity: `${stats.dev}:${stats.ino}`,
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unknown" };
  }
}

// The administrative directory a worktree's `.git` file names, when it is one of the clone's
// (`<common>/worktrees/<id>`) and its `gitdir` file points back at that `.git` file. Git writes both
// links as absolute paths, or, with `worktree.useRelativePaths` (Git 2.48+), relative to the
// file's own directory: the `.git` link to the worktree, the `gitdir` backlink to the
// administrative directory. Each is resolved from its own location and compared by real path
// (#126 item 8: compared as raw text, a relative link never matched, so such a worktree never
// finished preparing and an abandon kept one it could have removed). `dotGit` is the `.git`
// file's content, `admin` the administrative directory's real path and `backlink` the backlink
// resolved as written; null when the links do not match. Filesystem only; rejects when a file
// cannot be read.
async function linkedAdmin(
  worktree: string,
  common: string,
): Promise<{ dotGit: string; admin: string; backlink: string } | null> {
  const dotGitPath = join(worktree, ".git");
  if (!(await lstat(dotGitPath)).isFile()) return null;
  const dotGit = await readFile(dotGitPath, "utf8");
  const link = /^gitdir: (.+)\n?$/.exec(dotGit)?.[1];
  if (!link) return null;
  const admin = await realpath(resolve(worktree, link));
  if (dirname(admin) !== (await realpath(join(common, "worktrees")))) return null;
  const backlink = resolve(admin, (await readFile(join(admin, "gitdir"), "utf8")).trim());
  const target = await realpath(backlink).catch(() => null);
  return target === (await realpath(dotGitPath)) ? { dotGit, admin, backlink } : null;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function operationKey(key: OperationReceiptKey): string {
  return JSON.stringify([key.serverId, key.principalId, key.operationId]);
}

export class WorktreeService {
  private readonly ledger: ProcessLedger;
  private readonly actors: Actors;
  // Operations being driven now (see the header); for each, the promise of its actor.
  private readonly busy = new Map<string, Promise<void>>();
  // Mutating filesystem work that outlived its deadline, by the operation it ran for (see the
  // header, removal): until it settles, nothing may continue or finish that operation.
  private readonly outstanding = new Map<string, Set<Promise<unknown>>>();
  // The views of earlier attempts' leftovers being removed (clearPrior), each with the attempt
  // that removes it: their steps go into the leftover's ledger under that attempt.
  private readonly priorViews = new WeakMap<Attempt, Attempt>();
  // Other methods whose requires_attention operations operation.continue resumes, with the work
  // that resumes one (binding.delete, domain/bindings.ts). They are never abandoned.
  // How a verified conversion target is switched to (binding.convert, domain/bindings.ts): a
  // conversion's attempt never settles ready here, since its mount is still the checkout.
  private converter: ((attempt: Attempt, key: OperationReceiptKey) => Promise<void>) | null = null;
  private readonly resumers = new Map<
    WriteRpcMethod,
    (key: OperationReceiptKey) => Promise<void>
  >();

  constructor(private readonly options: WorktreeServiceOptions) {
    this.ledger = new ProcessLedger(options.store, options.relayInstanceId, options.now);
    this.actors = new Actors(options.actors ?? 2, options.queue ?? 8);
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

  private get limits() {
    return {
      serverId: this.options.serverId,
      operationRecordBytes: this.options.receipts.composition.budgets.operationRecordBytes,
    };
  }

  private key(principalId: string, operationId: string): OperationReceiptKey {
    return { serverId: this.options.serverId, principalId, operationId };
  }

  // Settles once every operation being driven now has stopped; for tests and an orderly stop.
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.all([...this.busy.values()]);
  }

  // A seat for an operation about to be accepted (see the header, budgets); null when as many are
  // driven and waiting as allowed, and the request is refused with BUSY. The caller releases it
  // when the operation was not committed.
  reserve(): Seat | null {
    return this.actors.reserve();
  }

  // The shared budgets and the entry materialization, for the binding operations
  // (domain/bindings.ts), which share this service's budgets and actors.
  get budgets(): WorktreeBudgets {
    return this.options.budgets;
  }

  materialize(workspaceId: string): Promise<EntryState> {
    return this.options.materialize(workspaceId);
  }

  // Registers how operation.continue resumes a requires_attention operation of `method`, which
  // otherwise only continues worktree preparations and abandons. The continue is accepted under
  // the same rules (the processes the target recorded must have ended) and `resume` runs on its
  // actor's seat.
  resumeWith(method: WriteRpcMethod, resume: (key: OperationReceiptKey) => Promise<void>): void {
    this.resumers.set(method, resume);
  }

  // Registers how a conversion's target, once prepared and verified ready, is switched to. Its
  // failure settles here as for any attempt (the checkout stays bound).
  convertWith(convert: (attempt: Attempt, key: OperationReceiptKey) => Promise<void>): void {
    this.converter = convert;
  }

  // Drives the operation `key` with `work` on `seat` (reserved for it before it was accepted),
  // unless another actor has it; for the binding operations.
  runOperation(seat: Seat, key: OperationReceiptKey, work: () => Promise<void>): void {
    this.claim(seat, key, work);
  }

  // Drives `key` with `work` on `seat`, unless another actor has the operation.
  private claim(seat: Seat, key: OperationReceiptKey, work: () => Promise<void>): void {
    const id = JSON.stringify([key.serverId, key.principalId, key.operationId]);
    if (this.busy.has(id)) {
      seat.release();
      return;
    }
    const running = seat
      .run(work)
      .catch(() => undefined)
      .finally(() => this.busy.delete(id));
    this.busy.set(id, running);
  }

  // ---------------------------------------------------------------------------------------------
  // Shared budgets (see the header).

  private git<T>(run: Run, work: () => Promise<T>): Promise<T | Unknown> {
    return this.options.budgets.git<T | Unknown>(
      run.group,
      performance.now() + GIT_SLOT_WAIT_MS,
      work,
      UNKNOWN,
    );
  }

  // A filesystem operation under a permit, answered by its deadline; `work` reports its own
  // expected errors, and anything else is no answer.
  private async fs<T>(run: Run, work: () => Promise<T>, mutating = false): Promise<T | Unknown> {
    const deadline = performance.now() + (this.options.fsDeadlineMs ?? FS_DEADLINE_MS);
    const admitted = await this.options.budgets.fs(run.group, deadline, work);
    if (!admitted) return UNKNOWN;
    if (mutating) this.track(run.actor, admitted.settled);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Unknown>((done) => {
      timer = setTimeout(() => done(UNKNOWN), Math.max(0, deadline - performance.now()));
      timer.unref();
    });
    try {
      return await Promise.race([admitted.settled.catch((): Unknown => UNKNOWN), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Filesystem work that changes something: as fs, and outstanding for its operation until it
  // settles, whatever the caller was answered (codex #7: a timed-out removal may still run).
  private mutate<T>(run: Run, work: () => Promise<T>): Promise<T | Unknown> {
    return this.fs(run, work, true);
  }

  private track(key: OperationReceiptKey, settled: Promise<unknown>): void {
    const id = operationKey(key);
    let set = this.outstanding.get(id);
    if (!set) this.outstanding.set(id, (set = new Set()));
    const entry = settled.then(
      () => undefined,
      () => undefined,
    );
    set.add(entry);
    void entry.then(() => {
      set.delete(entry);
      if (!set.size && this.outstanding.get(id) === set) this.outstanding.delete(id);
    });
  }

  private pathState(run: Run, path: string): Promise<PathState> {
    return this.fs(run, () => pathState(path)).then((found) =>
      found === UNKNOWN ? { kind: "unknown" } : found,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Planning (before the write that records the mount).

  // A worktree spec resolved for the write: its branch (the given one checked by Git's own rules,
  // or the default chosen by defaultBranch, D1) and its path `<entry>/<name>`. `repo` and `name`
  // were resolved by the caller.
  async plan(input: {
    spec: Extract<MountSpec, { source: "worktree" }>;
    repo: { repoId: string; commonDir: string };
    name: string;
    slug: string;
    entryPath: string;
    // The request's turn group for the shared Git slots, and its deadline for this check.
    group: object;
    deadline: number;
    // Branches already planned for other mounts of the same repository in this request.
    planned?: readonly string[];
  }): Promise<{ mount: NewMount } | { error: DomainError }> {
    const { spec } = input;
    let branch: string;
    if (spec.branch !== undefined) {
      branch = spec.branch;
      const invalid = await this.checkBranchName(input.group, input.deadline, branch);
      if (invalid) return { error: invalid };
    } else {
      const chosen = await this.defaultBranch(
        input.group,
        input.deadline,
        input.repo.commonDir,
        input.slug,
        input.planned,
      );
      if (typeof chosen !== "string") return { error: chosen };
      branch = chosen;
    }
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

  // Checks `branch` by Git's own rules (git/repository.ts) in a shared Git slot: null when it is
  // valid; BUSY when no slot came free by `deadline` (nothing ran), as for any request's Git work
  // (domain/workspaces.ts).
  private async checkBranchName(
    group: object,
    deadline: number,
    branch: string,
  ): Promise<DomainError | null> {
    const valid = await this.options.budgets.git<boolean | null | Unknown>(
      group,
      deadline,
      () => isValidBranchName(branch),
      UNKNOWN,
    );
    if (valid === UNKNOWN) return domainError("BUSY");
    if (valid === null) return domainError("GIT_UNAVAILABLE");
    return valid ? null : domainError("INVALID_ARGUMENT");
  }

  // The default branch of a worktree mount (D1, user decision of 2026-10-21): `cove/<slug>`, or,
  // when a branch of that name already exists locally or as a remote-tracking branch of any
  // remote, the first free one of `cove/<slug>-2` ... `cove/<slug>-100`; BRANCH_EXISTS when all
  // are taken. Only the generated default is suffixed: an explicit --branch that exists still
  // fails with BRANCH_EXISTS. The choice is made here, before the write, in the request's Git
  // slot; the write records it as the attempt's branch (and the mount's) before any effect, so a
  // restart, its verification or a continue goes on with the same name, and only a new attempt
  // (mount retry) chooses again. Refs that appear after the choice are not seen here (a residual
  // window, m1.md D1): a local branch of that name created meanwhile, also by another preparation
  // of Cove's own that chose the same name, fails the attempt with BRANCH_EXISTS at the executor's
  // check before it creates the branch, as for any branch; a remote-tracking branch that only the
  // attempt's own fetch brings does not stop it, as Git allows both. Names are compared here, in
  // a Unicode case fold (foldName), against every local and remote-tracking branch under `cove/`
  // (git/worktree.ts branchesUnder): a candidate is taken by a name equal to it or below it.
  // `cove/<slug>` is checked by Git's rules; appending `-N` to its last component cannot make it
  // invalid.
  private async defaultBranch(
    group: object,
    deadline: number,
    commonDir: string,
    slug: string,
    planned: readonly string[] = [],
  ): Promise<string | DomainError> {
    const base = `cove/${slug}`;
    const invalid = await this.checkBranchName(group, deadline, base);
    if (invalid) return invalid;
    const found = await this.options.budgets.git<string[] | "unavailable" | Unknown>(
      group,
      deadline,
      () => branchesUnder(commonDir, "cove"),
      UNKNOWN,
    );
    if (found === UNKNOWN) return domainError("BUSY");
    if (found === "unavailable") return domainError("GIT_UNAVAILABLE");
    const taken = [...found, ...planned].map(foldName);
    for (let suffix = 1; suffix <= DEFAULT_BRANCH_CANDIDATES; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const folded = foldName(candidate);
      if (!taken.some((name) => name === folded || name.startsWith(`${folded}/`))) return candidate;
    }
    return domainError("BRANCH_EXISTS");
  }

  // Starts preparing the attempts of an operation that was just committed running, on the seat
  // reserved for it.
  start(seat: Seat, principalId: string, operationId: string): void {
    const key = this.key(principalId, operationId);
    this.claim(seat, key, () => this.drive(key));
  }

  // ---------------------------------------------------------------------------------------------
  // The executor.

  private async drive(key: OperationReceiptKey): Promise<void> {
    const run: Run = { group: {}, actor: key };
    let attempts: Attempt[];
    try {
      attempts = await this.stored(() =>
        this.options.store.call("worktrees.attempts", { operation: key }),
      );
    } catch (error) {
      // Still refused after the retries: handed off (see STORE_RETRY). Otherwise the store failed
      // and the next start verifies the operation.
      if (refusedStoreCall(error)) return this.attention(key);
      return;
    }
    for (const attempt of attempts) {
      if (attempt.outcome !== "pending" || attempt.abandon) continue;
      let outcome: Outcome;
      try {
        outcome = await this.prepare(run, attempt);
      } catch {
        outcome = ATTENTION;
      }
      if (outcome.kind === "attention") return this.attention(key);
      if (attempt.conversion && outcome.kind === "ready") {
        // Without the binding module the target cannot be switched to: left for a continue.
        if (!this.converter) return this.attention(key);
        await this.converter(attempt, key);
        continue;
      }
      let settled;
      const settle = {
        attemptId: attempt.attemptId,
        actor: key,
        outcome: outcome.kind,
        ...(outcome.kind === "failed" ? { error: domainError(outcome.error) } : {}),
        limits: this.limits,
        at: this.now(),
      };
      try {
        settled = await this.stored(() => this.options.store.call("worktrees.settle", settle));
      } catch (error) {
        // A refusal changed nothing: the attempt is still pending with its ledger, and the
        // operation is handed off. Otherwise whether it committed is unknown; the next start
        // verifies it.
        if (refusedStoreCall(error)) return this.attention(key);
        return;
      }
      if (!settled) return this.attention(key);
      if (settled.revision !== null)
        await this.options.materialize(attempt.workspaceId).catch(() => "pending");
    }
  }

  // A store call of an actor, repeated while it is refused (see STORE_RETRY).
  private stored<T>(call: () => Promise<T>, schedule = STORE_RETRY): Promise<T> {
    return retryRefused(call, schedule);
  }

  // Records the operation as requires_attention with what its ledger shows, repeated for as long
  // as the store refuses it (STORE_HANDOFF). A closed or failed store leaves it running; the next
  // start verifies it.
  private async attention(key: OperationReceiptKey): Promise<void> {
    try {
      const attempts = await this.stored(
        () => this.options.store.call("worktrees.attempts", { operation: key }),
        STORE_HANDOFF,
      );
      const active = await this.processActive([key]);
      const record = {
        operation: key,
        progress: progressOf(attempts, active),
        limits: this.limits,
        at: this.now(),
      };
      await this.stored(
        () => this.options.store.call("worktrees.attention", record),
        STORE_HANDOFF,
      );
    } catch {
      // See above.
    }
  }

  // Whether a process recorded under any of `keys` may still run (store/processes.ts), or
  // filesystem work of theirs is outstanding (see `mutate`); an unreadable record counts as one
  // that may.
  private async processActive(keys: readonly OperationReceiptKey[]): Promise<boolean> {
    for (const key of keys) {
      if (this.outstanding.has(operationKey(key))) return true;
      try {
        if ((await this.ledger.check(key)) !== "ended") return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  // Records `patch` in the attempt's ledger (store worktrees.advance) and mirrors it in `attempt`.
  private async record(
    run: Run,
    attempt: Attempt,
    patch: {
      step?: StepEntry;
      phase?: AttemptPhase;
      baseCommit?: string;
      entryIdentity?: string;
    },
  ): Promise<void> {
    let recorded: boolean;
    const remover = this.priorViews.get(attempt);
    // A leftover's view records into the leftover's ledger, as the attempt removing it.
    const advance = {
      attemptId: (remover ?? attempt).attemptId,
      actor: run.actor,
      ...patch,
      ...(remover ? { prior: true as const } : {}),
      at: this.now(),
    };
    try {
      recorded = await this.stored(() => this.options.store.call("worktrees.advance", advance));
    } catch {
      // Still refused, or the store failed: the actor stops, handing the operation off.
      recorded = false;
    }
    if (!recorded) throw new Stopped();
    if (patch.step) attempt.steps = appendStep(attempt.steps, patch.step);
    if (patch.phase && PHASE_ORDER.indexOf(patch.phase) > PHASE_ORDER.indexOf(attempt.phase))
      attempt.phase = patch.phase;
    if (patch.baseCommit) attempt.baseCommit = patch.baseCommit;
    if (patch.entryIdentity) attempt.entryIdentity = patch.entryIdentity;
  }

  // Runs one step in a Git slot, recorded before it starts and after it ends: succeeded only for
  // a definite exit 0 of Cove's own command. "busy" when no slot came free (nothing started).
  // A step whose end could not be recorded is treated as uncertain. `guard`, when given, runs once
  // the slot is held and right before anything is recorded or started (see the header, the
  // entry); "blocked" when it refused (nothing started). It uses only filesystem permits, never
  // another Git slot, so it cannot wait on the slot it holds.
  private async step(
    run: Run,
    attempt: Attempt,
    name: StepName,
    work: (recorder: Recording) => Promise<StepResult>,
    options: { onSuccess?: { phase?: AttemptPhase }; guard?: () => Promise<boolean> } = {},
  ): Promise<"succeeded" | "failed" | "uncertain" | "busy" | "blocked"> {
    const onSuccess = options.onSuccess ?? {};
    const done = await this.git(run, async () => {
      if (options.guard && !(await options.guard())) return "blocked" as const;
      await this.record(run, attempt, { step: { step: name, outcome: "started" } });
      const result = await work(recording(this.ledger, run.actor));
      const outcome =
        result.kind === "exited" && result.code === 0
          ? "succeeded"
          : result.kind === "uncertain"
            ? "uncertain"
            : "failed";
      try {
        await this.record(run, attempt, {
          step: { step: name, outcome },
          ...(outcome === "succeeded" ? onSuccess : {}),
        });
      } catch {
        return "uncertain" as const;
      }
      return outcome;
    });
    return done === UNKNOWN ? "busy" : done;
  }

  // The entry check before and after every filesystem-affecting step (see the header): ok when
  // the entry is materialized and still the directory recorded at the attempt's start (recorded
  // now if this is the start).
  private async entry(run: Run, attempt: Attempt): Promise<"ok" | "unavailable" | "changed"> {
    const state = await this.options.materialize(attempt.workspaceId).catch(() => "unavailable");
    if (state !== "ready") return "unavailable";
    const found = await this.pathState(run, dirname(attempt.path));
    if (found.kind !== "present" || !found.directory) return "changed";
    if (attempt.entryIdentity === null) {
      await this.record(run, attempt, { entryIdentity: found.identity });
      return "ok";
    }
    return found.identity === attempt.entryIdentity ? "ok" : "changed";
  }

  private worktrees(run: Run, clone: string): Promise<WorktreeEntry[] | null> {
    return this.git(run, () => listWorktrees(clone)).then((found) =>
      found === UNKNOWN ? null : found,
    );
  }

  // Prepares one attempt from its recorded phase (see the header).
  private async prepare(run: Run, attempt: Attempt): Promise<Outcome> {
    const repo = attempt.repo;
    const effects = attempt.steps.some((entry) => entry.step !== "fetch");
    if (!repo) return effects || attempt.phase === "intent" ? ATTENTION : failed("REPO_NOT_FOUND");
    const uncertain = await this.verifyUncertain(run, attempt, repo.path, [attempt.operation]);
    if (uncertain) return uncertain;
    if (attempt.phase === "planned") {
      const entry = await this.entry(run, attempt);
      if (entry === "changed") return ATTENTION;
      if (entry !== "ok") return failed("WORKSPACE_ENTRY_UNAVAILABLE");
      if (attempt.noFetch) await this.record(run, attempt, { phase: "fetched" });
      else {
        const fetched = await this.step(
          run,
          attempt,
          "fetch",
          (recorder) => fetchRemote(repo.path, recorder, this.options.timeouts),
          { onSuccess: { phase: "fetched" } },
        );
        // Fetching changes only remote-tracking refs, which are not an artifact of the attempt.
        if (fetched === "failed") return failed("FETCH_FAILED");
        // A fetch not seen to end is not a failed fetch: it may still be running.
        if (fetched !== "succeeded") return ATTENTION;
      }
    }
    if (attempt.phase === "fetched") {
      if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
      const base = await this.git(run, () =>
        resolveBase(repo.path, {
          base: attempt.baseRef,
          mainBranch: repo.mainBranch,
          offline: attempt.noFetch,
        }),
      );
      if (base === UNKNOWN) return ATTENTION;
      if (base.kind === "unresolved") return failed("MAIN_BRANCH_UNRESOLVED");
      if (base.kind === "invalid-base") return failed("INVALID_ARGUMENT");
      if (base.kind === "unavailable") return failed("GIT_UNAVAILABLE");
      await this.record(run, attempt, { phase: "resolved", baseCommit: base.commit });
    }
    if (attempt.phase === "resolved") {
      if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
      if (attempt.prior) {
        const held = await this.clearPrior(run, attempt, repo.path);
        if (held) return held;
      }
      const existing = await this.git(run, () => branchCommit(repo.path, attempt.branch));
      if (existing === UNKNOWN) return ATTENTION;
      if (existing === "unavailable") return failed("GIT_UNAVAILABLE");
      if (existing !== null) return failed("BRANCH_EXISTS");
      const free = await this.pathState(run, attempt.path);
      if (free.kind === "unknown") return ATTENTION;
      if (free.kind === "present") return failed("WORKSPACE_ENTRY_UNAVAILABLE");
      const worktreeId = this.newId();
      let recorded: "recorded" | "taken" | "gone";
      try {
        recorded = await this.options.store.call("worktrees.recordIntent", {
          attemptId: attempt.attemptId,
          actor: run.actor,
          worktreeId,
          at: this.now(),
        });
      } catch {
        return ATTENTION;
      }
      if (recorded === "taken") return failed("MOUNT_NAME_CONFLICT");
      if (recorded === "gone") return failed("REPO_NOT_FOUND");
      attempt.phase = "intent";
      attempt.worktreeId = worktreeId;
    }
    if (failedStep(attempt)) return this.failWith(run, attempt, repo.path);
    return this.create(run, attempt, repo.path);
  }

  // Removes what an earlier failed attempt of the mount left at the path (store/sql/worktrees.ts
  // PriorAttempt; #126 item 4, #132) before the attempt checks that its branch and path are free.
  // The leftover is removed as the cleanup of a failed attempt or an abandon removes its own
  // artifacts (see the header, removal): Cove's own never-ready worktree by plain `git worktree
  // remove`, Git's refusal as the only safeguard, then its branch; an unproven effect stays. Each
  // step is recorded in the leftover's ledger through a view of it: the earlier attempt's branch,
  // base and steps with this attempt's entry, path and registration. Null once nothing of it is
  // left (the store freed the path with the last removal); MOUNT_NAME_CONFLICT when Git still
  // refuses, the outcome naming what is left (resultWith); attention while a process that acted on
  // it may still run, or a removal cannot be established.
  private async clearPrior(run: Run, attempt: Attempt, clone: string): Promise<Outcome | null> {
    if ((await this.removePrior(run, attempt, clone, [run.actor])) === "attention")
      return ATTENTION;
    if (remainingArtifacts(attempt.prior!.steps).length) return failed("MOUNT_NAME_CONFLICT");
    attempt.prior = null;
    return null;
  }

  // The removal of an attempt's prior leftover, for clearPrior and for an abandon of the attempt
  // (finishAbandon), which must not end the operation while a removal it started is unresolved
  // (#141 review): any process that acted on it must have ended (`keys` and the prior's actors),
  // a removal not seen to end is verified from the state first, then what is left is removed by
  // the cleanup rules or kept. The prior's steps are updated in place. Without the entry identity
  // (an abandon of an attempt that never verified its entry, so never acted on the leftover) only
  // the verification runs: nothing establishes the path still leads into Cove's entry, and the
  // leftover stays as it was, listed in the outcome.
  private async removePrior(
    run: Run,
    attempt: Attempt,
    clone: string,
    keys: readonly OperationReceiptKey[],
  ): Promise<"done" | "attention"> {
    const prior = attempt.prior!;
    const all = [...keys, ...prior.actors];
    if (await this.processActive(all)) return "attention";
    const view: Attempt = {
      ...attempt,
      attemptId: prior.attemptId,
      branch: prior.branch,
      baseCommit: prior.baseCommit,
      steps: prior.steps,
      prior: null,
    };
    this.priorViews.set(view, attempt);
    const uncertain = await this.verifyUncertain(run, view, clone, all, true);
    let done: "done" | "attention" = uncertain ? "attention" : "done";
    if (done === "done" && attempt.entryIdentity !== null)
      done = await this.cleanup(run, view, clone);
    prior.steps = view.steps;
    return done;
  }

  // The three Git steps of an attempt with its intent recorded.
  private async create(run: Run, attempt: Attempt, clone: string): Promise<Outcome> {
    const base = attempt.baseCommit!;
    // Also on a continue that finds the steps credited (see the header, ready).
    if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
    if (!credited(attempt.steps, "branch")) {
      const created = await this.step(run, attempt, "branch", (recorder) =>
        createBranch(
          clone,
          { branch: attempt.branch, baseCommit: base, attemptId: attempt.attemptId },
          recorder,
          this.options.timeouts,
        ),
      );
      if (created === "failed") return this.failWith(run, attempt, clone);
      if (created !== "succeeded") return ATTENTION;
    }
    // A credited branch that is gone, moved or replaced by a symbolic ref is not made again.
    if ((await this.branchState(run, attempt, clone)) !== "intended") return ATTENTION;
    const ref = `refs/heads/${attempt.branch}`;
    if (!credited(attempt.steps, "worktree")) {
      if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
      const free = await this.pathState(run, attempt.path);
      const listed = await this.worktrees(run, clone);
      // Something at the path that the ledger does not credit to this attempt is not Cove's.
      if (free.kind !== "absent" || !listed || listed.some((entry) => entry.path === attempt.path))
        return ATTENTION;
      const added = await this.step(
        run,
        attempt,
        "worktree",
        (recorder) =>
          addWorktree(clone, attempt.path, attempt.branch, recorder, this.options.timeouts),
        {
          guard: async () =>
            (await this.entry(run, attempt)) === "ok" &&
            (await this.pathState(run, attempt.path)).kind === "absent",
        },
      );
      if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
      if (added === "failed") return this.failWith(run, attempt, clone);
      if (added !== "succeeded") return ATTENTION;
    }
    const listed = await this.worktrees(run, clone);
    const registered = listed?.find((entry) => entry.path === attempt.path);
    if (registered?.branch !== ref) return ATTENTION;
    if (!credited(attempt.steps, "checkout")) {
      if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
      const checked = await this.step(
        run,
        attempt,
        "checkout",
        (recorder) => checkOut(attempt.path, recorder, this.options.timeouts),
        {
          guard: async () =>
            (await this.entry(run, attempt)) === "ok" && (await this.pristine(run, attempt)),
        },
      );
      if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
      if (checked === "failed") return this.failWith(run, attempt, clone);
      if (checked !== "succeeded") return ATTENTION;
    }
    // Validated again before ready (see the header): the entry and the checkout itself.
    if ((await this.entry(run, attempt)) !== "ok") return ATTENTION;
    if (!(await this.checkedOut(run, attempt))) return ATTENTION;
    return { kind: "ready" };
  }

  // The branch as the recorded intent left it (see the header, removal): intended (a plain ref at
  // the base), absent, other (a symbolic ref, or another commit), or unknown.
  private async branchState(
    run: Run,
    attempt: Attempt,
    clone: string,
  ): Promise<"intended" | "absent" | "other" | "unknown"> {
    const base = attempt.baseCommit;
    const at = await this.git(run, () => branchCommit(clone, attempt.branch));
    if (at === UNKNOWN || at === "unavailable") return "unknown";
    if (at === null) return "absent";
    if (!base || at !== base) return "other";
    const symbolic = await this.git(run, () => isSymbolicRef(clone, attempt.branch));
    if (symbolic === UNKNOWN || symbolic === null) return "unknown";
    return symbolic ? "other" : "intended";
  }

  // Whether the worktree is exactly what `worktree add --no-checkout` left (see the header, the
  // checkout): the unchecked proof, and no index in its administrative directory. Filesystem
  // permits only (it runs in the checkout's guard).
  private async pristine(run: Run, attempt: Attempt): Promise<boolean> {
    const proof = await this.unchecked(run, attempt, "");
    if (!proof) return false;
    const index = await this.pathState(run, join(proof.admin, "index"));
    if (index.kind !== "absent") return false;
    // `worktree add` writes HEAD as a symbolic ref to the branch; anything else is not its work.
    const head = await this.fs(run, () =>
      readFile(join(proof.admin, "HEAD"), "utf8").catch(() => null),
    );
    return head === `ref: refs/heads/${attempt.branch}\n`;
  }

  // Whether the checkout is physically there (see the header, ready): the directory, its `.git`
  // file naming an administrative directory of the clone whose `gitdir` points back at it, and an
  // index in that directory.
  private async checkedOut(run: Run, attempt: Attempt): Promise<boolean> {
    const common = attempt.repo?.commonDir;
    if (!common) return false;
    const found = await this.fs(run, async () => {
      try {
        if (!(await lstat(attempt.path)).isDirectory()) return false;
        const linked = await linkedAdmin(attempt.path, common);
        return linked !== null && (await lstat(join(linked.admin, "index"))).isFile();
      } catch {
        return false;
      }
    });
    return found === true;
  }

  // A creation step failed: the attempt's own artifacts are removed as described under Removal,
  // and it fails. GIT_UNAVAILABLE: Git gave no usable answer to a step that should have worked
  // (its stderr is not interpreted; it may hold paths or remote URLs); BRANCH_EXISTS when the
  // branch step lost to a branch someone else created.
  private async failWith(run: Run, attempt: Attempt, clone: string): Promise<Outcome> {
    const cleaned = await this.cleanup(run, attempt, clone);
    if (cleaned === "attention") return ATTENTION;
    if (failedStep(attempt) === "branch") {
      const existing = await this.git(run, () => branchCommit(clone, attempt.branch));
      if (existing !== UNKNOWN && existing !== null && existing !== "unavailable")
        return failed("BRANCH_EXISTS");
    }
    return failed("GIT_UNAVAILABLE");
  }

  // ---------------------------------------------------------------------------------------------
  // Uncertain steps (see the header, uncertainty first).

  // Resolves a last step that is started or uncertain; null when there is none (any more), the
  // attention outcome while it cannot be resolved.
  private async verifyUncertain(
    run: Run,
    attempt: Attempt,
    clone: string,
    keys: readonly OperationReceiptKey[],
    abandoning = false,
  ): Promise<Outcome | null> {
    const last = attempt.steps.at(-1);
    if (!last || (last.outcome !== "started" && last.outcome !== "uncertain")) return null;
    if (await this.processActive(keys)) return ATTENTION;
    const verdict = await this.evidence(run, attempt, clone, last.step);
    // A continue cannot go on from an effect that is not proven either way. An abandon can: the
    // effect is left in place and listed (store/sql/worktrees.ts unproven), never removed.
    if (verdict === "attention") {
      if (!abandoning || !(STEPS as readonly string[]).includes(last.step)) return ATTENTION;
      await this.record(run, attempt, { step: { step: last.step, outcome: "unproven" } });
      return null;
    }
    await this.record(run, attempt, { step: { step: last.step, outcome: verdict } });
    return null;
  }

  // What the state proves about a step whose end was not seen, now that its process has ended:
  // verified (the state is exactly the step's effect), void (nothing of it is there, so
  // it may run again), removed (a removal's artifact is gone), or attention.
  private async evidence(
    run: Run,
    attempt: Attempt,
    clone: string,
    step: StepName,
  ): Promise<"verified" | "void" | "removed" | "attention"> {
    const base = attempt.baseCommit;
    const ref = `refs/heads/${attempt.branch}`;
    switch (step) {
      // A fetch only changes remote-tracking refs; it is simply run again.
      case "fetch":
        return "void";
      case "branch": {
        if (!base) return "attention";
        // Exactly what the step makes: a plain ref at the base.
        const state = await this.branchState(run, attempt, clone);
        return state === "intended" ? "verified" : state === "absent" ? "void" : "attention";
      }
      case "worktree": {
        const listed = await this.worktrees(run, clone);
        if (!listed) return "attention";
        const registered = listed.find((entry) => entry.path === attempt.path);
        const at = await this.pathState(run, attempt.path);
        if (!registered) return at.kind === "absent" ? "void" : "attention";
        // Exactly what the step makes: registered at the path on the attempt's branch, holding
        // nothing but the `.git` file `worktree add --no-checkout` writes, which points at its own
        // entry.
        return registered.branch === ref && (await this.unchecked(run, attempt, clone)) !== null
          ? "verified"
          : "attention";
      }
      case "checkout": {
        const index = await this.git(run, () => gitPath(attempt.path, "index"));
        if (index === UNKNOWN || index === null) return "attention";
        const found = await this.pathState(run, index);
        if (found.kind === "absent")
          return (await this.unchecked(run, attempt, clone)) !== null ? "void" : "attention";
        if (found.kind !== "present") return "attention";
        // Checked out, with nothing changed, untracked or ignored: exactly what the checkout makes.
        const clean = await this.git(run, () => statusEmpty(attempt.path));
        return clean === true ? "verified" : "attention";
      }
      case "remove-worktree": {
        const listed = await this.worktrees(run, clone);
        const at = await this.pathState(run, attempt.path);
        if (!listed) return "attention";
        const registered = listed.some((entry) => entry.path === attempt.path);
        return !registered && at.kind === "absent" ? "removed" : "void";
      }
      case "delete-branch": {
        const at = await this.git(run, () => branchCommit(clone, attempt.branch));
        if (at === UNKNOWN || at === "unavailable") return "attention";
        if (at !== null) return "void";
        const listed = await this.worktrees(run, clone);
        if (!listed) return "attention";
        return listed.some((entry) => entry.branch === ref) ? "attention" : "removed";
      }
    }
  }

  // The proof that a worktree was never checked out and is this attempt's: the directory holds
  // only its `.git` file, which names an administrative directory of the clone whose `gitdir`
  // points back at it (linkedAdmin). Returns that file's content, the administrative directory and
  // its backlink, or null.
  private async unchecked(
    run: Run,
    attempt: Attempt,
    clone: string,
  ): Promise<{ dotGit: string; admin: string; backlink: string } | null> {
    const common = attempt.repo?.commonDir;
    if (!common) return null;
    const found = await this.fs(run, async () => {
      try {
        const names = await readdir(attempt.path);
        if (names.length !== 1 || names[0] !== ".git") return null;
        return await linkedAdmin(attempt.path, common);
      } catch {
        return null;
      }
    });
    void clone;
    return found === UNKNOWN ? null : found;
  }

  // ---------------------------------------------------------------------------------------------
  // Removal (see the header). Each removal is recorded in the attempt's ledger; "done" when every
  // artifact the ledger credits was removed or preserved, "attention" when one was not seen to end
  // or its state could not be established.

  private async cleanup(run: Run, attempt: Attempt, clone: string): Promise<"done" | "attention"> {
    if (remainingArtifacts(attempt.steps).includes("worktree")) {
      // An unproven worktree is left in place (store/sql/worktrees.ts).
      const removed = credited(attempt.steps, "worktree")
        ? await this.removeOwnWorktree(run, attempt, clone)
        : "preserved";
      if (removed === "attention") return "attention";
      await this.record(run, attempt, { step: { step: "remove-worktree", outcome: removed } });
    }
    if (remainingArtifacts(attempt.steps).includes("branch")) {
      // A worktree left in place has the branch checked out.
      const deleted =
        remainingArtifacts(attempt.steps).includes("worktree") || !credited(attempt.steps, "branch")
          ? "preserved"
          : await this.deleteOwnBranch(run, attempt, clone);
      if (deleted === "attention") return "attention";
      await this.record(run, attempt, { step: { step: "delete-branch", outcome: deleted } });
    }
    return "done";
  }

  private async removeOwnWorktree(
    run: Run,
    attempt: Attempt,
    clone: string,
  ): Promise<"removed" | "preserved" | "attention"> {
    // Behind a changed entry, the path may lead somewhere else.
    if ((await this.entry(run, attempt)) !== "ok") return "preserved";
    const listed = await this.worktrees(run, clone);
    if (!listed) return "attention";
    const registered = listed.find((entry) => entry.path === attempt.path);
    const at = await this.pathState(run, attempt.path);
    if (at.kind === "unknown") return "attention";
    if (!registered) return at.kind === "absent" ? "removed" : "preserved";
    if (registered.branch !== `refs/heads/${attempt.branch}`) return "preserved";
    // Never checked out: `worktree remove` would see every file as deleted from an index that
    // does not exist and refuse, so the directory holding only its `.git` file is removed by hand.
    if (await this.pristine(run, attempt)) return this.removeUnchecked(run, attempt, clone);
    // Otherwise Git decides: plain `worktree remove`, whose refusal (changes, untracked files, a
    // missing index, a lock) keeps the worktree.
    const removed = await this.step(run, attempt, "remove-worktree", (recorder) =>
      removeWorktree(clone, attempt.path, recorder, this.options.timeouts),
    );
    if (removed === "failed") return "preserved";
    if (removed !== "succeeded") return "attention";
    const after = await this.pathState(run, attempt.path);
    return after.kind === "absent" ? "removed" : "preserved";
  }

  // A worktree never checked out: without its `.git` file Git no longer sees a worktree there, and
  // rmdir removes the directory only while it is empty, so a file someone put there in the
  // meantime keeps it (and the `.git` file is put back).
  private async removeUnchecked(
    run: Run,
    attempt: Attempt,
    clone: string,
  ): Promise<"removed" | "preserved" | "attention"> {
    const proof = await this.unchecked(run, attempt, clone);
    if (!proof) return "preserved";
    await this.record(run, attempt, { step: { step: "remove-worktree", outcome: "started" } });
    const dotGitPath = join(attempt.path, ".git");
    const before = this.options.hooks?.beforeUncheckedRemoval;
    const result = await this.mutate(run, async () => {
      if (before) await before(attempt.path);
      await unlink(dotGitPath);
      try {
        await rmdir(attempt.path);
      } catch (error) {
        await writeFile(dotGitPath, proof.dotGit, { flag: "wx" }).catch(() => undefined);
        return errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST"
          ? ("preserved" as const)
          : ("unknown" as const);
      }
      // Its `gitdir` still names the `.git` file just deleted (absolute, or relative to the
      // administrative directory): nothing else took the administrative directory meanwhile.
      const back = (await readFile(join(proof.admin, "gitdir"), "utf8")).trim();
      if (resolve(proof.admin, back) === proof.backlink) await rm(proof.admin, { recursive: true });
      return "removed" as const;
    });
    if (result === UNKNOWN || result === "unknown") return "attention";
    return result;
  }

  private async deleteOwnBranch(
    run: Run,
    attempt: Attempt,
    clone: string,
  ): Promise<"removed" | "preserved" | "attention"> {
    const base = attempt.baseCommit;
    if (!base) return "preserved";
    const ref = `refs/heads/${attempt.branch}`;
    const state = await this.branchState(run, attempt, clone);
    if (state === "unknown") return "attention";
    if (state === "absent") return "removed";
    if (state === "other") return "preserved";
    const listed = await this.worktrees(run, clone);
    if (!listed) return "attention";
    if (listed.some((entry) => entry.branch === ref)) return "preserved";
    const deleted = await this.step(run, attempt, "delete-branch", (recorder) =>
      deleteBranch(clone, attempt.branch, base, recorder, this.options.timeouts),
    );
    if (deleted === "failed") return "preserved";
    return deleted === "succeeded" ? "removed" : "attention";
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
    // A process the previous attempt recorded may still be changing what this one would create.
    if (await this.processActive(source.prior))
      return refuse(domainError("OPERATION_EFFECTS_ACTIVE"));
    let task;
    try {
      task = await this.options.store.call("tasks.get", { taskId: params.taskId });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (!task) return refuse(domainError("TASK_NOT_FOUND"));
    // The overrides apply to this attempt only; otherwise the original request is repeated: a
    // given branch as given, the default chosen again (a branch the failed attempt left in place
    // makes it take the next suffix).
    const given = params.branch ?? source.spec.branch ?? undefined;
    // The seat before any Git runs, so that a retry beyond the cap starts nothing.
    const seat = this.reserve();
    if (!seat) return refuse(domainError("BUSY"));
    let committed = false;
    try {
      const deadline = performance.now() + (this.options.requestStepMs ?? REQUEST_STEP_MS);
      let branch: string;
      if (given !== undefined || source.commonDir === null) {
        // Without its registration the preparation fails with REPO_NOT_FOUND; the default name is
        // then only recorded.
        branch = given ?? `cove/${task.record.slug}`;
        const invalid = await this.checkBranchName({}, deadline, branch);
        if (invalid) return refuse(invalid);
      } else {
        const chosen = await this.defaultBranch({}, deadline, source.commonDir, task.record.slug);
        if (typeof chosen !== "string") return refuse(chosen);
        branch = chosen;
      }
      const written = await executeDatabaseWriteCommitted(
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
      committed = written.committed;
      if (committed) {
        await this.options.materialize(source.workspaceId).catch(() => "pending");
        this.start(seat, principalId, params.operationId);
      }
      return written.outcome;
    } finally {
      if (!committed) seat.release();
    }
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
    const refuse = async (error: DomainError) => ({
      outcome: await this.refuseTarget(principalId, method, params, error),
    });
    const key = this.key(principalId, params.targetOperationId);
    let record: OperationRecord | null;
    try {
      record = await this.options.receipts.get(key);
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (!record) return refuse(domainError("OPERATION_NOT_FOUND"));
    // A continue also resumes an abandon that stopped; an abandon is never abandoned itself.
    const actionable =
      WORKTREE_METHODS.has(record.method) ||
      (method === "operation.continue" &&
        (record.method === "operation.abandon" || this.resumers.has(record.method)));
    if (!actionable || record.state !== "requires_attention")
      return refuse(domainError("OPERATION_NOT_RESUMABLE"));
    // While a process the target recorded may still run, it is neither continued nor
    // abandoned (S8).
    const keys = [key];
    try {
      if (record.method === "operation.abandon") {
        const claimed = await this.options.store.call("worktrees.claimed", { abandon: key });
        for (const attempt of claimed) keys.push(attempt.operation);
      }
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (await this.processActive(keys)) return refuse(domainError("OPERATION_EFFECTS_ACTIVE"));
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

  async continueOperation(
    principalId: string,
    params: TargetParams,
  ): Promise<DatabaseWriteOutcome> {
    const method = "operation.continue";
    const found = await this.target(principalId, method, params);
    if ("outcome" in found) return found.outcome;
    const { record, key } = found;
    const seat = this.reserve();
    if (!seat) return this.refuseTarget(principalId, method, params, domainError("BUSY"));
    let committed = false;
    try {
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
      committed = written.committed;
      // The target is running again; its actor goes on from its recorded ledger.
      if (committed) {
        const resume = this.resumers.get(record.method);
        this.claim(seat, key, () =>
          resume
            ? resume(key)
            : record.method === "operation.abandon"
              ? this.finishAbandon(key)
              : this.drive(key),
        );
      }
      return written.outcome;
    } finally {
      if (!committed) seat.release();
    }
  }

  async abandonOperation(principalId: string, params: TargetParams): Promise<DatabaseWriteOutcome> {
    const method = "operation.abandon";
    const found = await this.target(principalId, method, params);
    if ("outcome" in found) return found.outcome;
    const { record, key } = found;
    const seat = this.reserve();
    if (!seat) return this.refuseTarget(principalId, method, params, domainError("BUSY"));
    const abandon = this.key(principalId, params.operationId);
    let committed = false;
    try {
      // Accepted, and the target's attempts claimed, before anything is removed (see the header).
      const written = await executeDatabaseWriteCommitted(
        this.context,
        principalId,
        method,
        params,
        {
          name: "operation.abandon",
          args: {
            operation: abandon,
            target: key,
            expectedRevision: record.revision,
            at: this.now(),
          },
        },
      );
      committed = written.committed;
      if (committed) this.claim(seat, abandon, () => this.finishAbandon(abandon));
      return written.outcome;
    } finally {
      if (!committed) seat.release();
    }
  }

  // The removals of an accepted abandon, then the transaction that ends it and its target; the
  // abandon becomes requires_attention when a removal cannot be finished now.
  private async finishAbandon(abandon: OperationReceiptKey): Promise<void> {
    const run: Run = { group: {}, actor: abandon };
    let attempts: Attempt[];
    let target: OperationReceiptKey;
    try {
      const record = await this.stored(() => this.options.receipts.get(abandon));
      const targetId = record?.result?.targetOperationId;
      if (!targetId) return;
      target = { ...abandon, operationId: targetId };
      attempts = await this.stored(() => this.options.store.call("worktrees.claimed", { abandon }));
    } catch (error) {
      // As in drive.
      if (refusedStoreCall(error)) return this.abandonAttention(abandon);
      return;
    }
    const workspaces = new Set<string>();
    for (const attempt of attempts) {
      if (attempt.outcome !== "pending") continue;
      workspaces.add(attempt.workspaceId);
      let done: "done" | "attention";
      try {
        if (!attempt.repo) {
          // Without the registration there is no clone to act on; nothing is removed.
          done = "done";
        } else {
          const uncertain = await this.verifyUncertain(
            run,
            attempt,
            attempt.repo.path,
            [abandon, attempt.operation],
            true,
          );
          done = uncertain ? "attention" : await this.cleanup(run, attempt, attempt.repo.path);
          // An earlier attempt's leftover the attempt was removing (clearPrior): its removal is
          // resolved too, and what stays of it is listed (store worktrees.finishAbandon).
          if (done === "done" && attempt.prior)
            done = await this.removePrior(run, attempt, attempt.repo.path, [
              abandon,
              attempt.operation,
            ]);
        }
      } catch {
        done = "attention";
      }
      if (done === "attention") return this.abandonAttention(abandon);
    }
    const finish = { abandon, target, limits: this.limits, at: this.now() };
    try {
      const finished = await this.stored(() =>
        this.options.store.call("worktrees.finishAbandon", finish),
      );
      if (!finished) return this.abandonAttention(abandon);
    } catch (error) {
      // As in drive.
      if (refusedStoreCall(error)) return this.abandonAttention(abandon);
      return;
    }
    for (const workspaceId of workspaces)
      await this.options.materialize(workspaceId).catch(() => "pending");
  }

  private async abandonAttention(abandon: OperationReceiptKey): Promise<void> {
    try {
      const attempts = await this.stored(
        () => this.options.store.call("worktrees.claimed", { abandon }),
        STORE_HANDOFF,
      );
      const active = await this.processActive([abandon]);
      const record = {
        operation: abandon,
        progress: abandonProgress(attempts, active),
        limits: this.limits,
        at: this.now(),
      };
      await this.stored(
        () => this.options.store.call("worktrees.attention", record),
        STORE_HANDOFF,
      );
    } catch {
      // As in attention: left running only when the store failed; the next start verifies it.
    }
  }
}

// A branch name as a case-insensitive file system compares it (#138): Unicode case folded and
// normalized, so that `cove/École`, `cove/école` and their decomposed forms are one name. JavaScript
// has no case fold; upper- then lower-casing also folds what lower-casing alone keeps apart (`ß`
// and `SS`, `ſ` and `s`). Folding more than a file system does only makes a candidate skipped.
function foldName(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

// ---------------------------------------------------------------------------------------------
// Startup verification (operations/recovery-verifiers.ts).

export type WorktreeRecoveryContext = {
  store: Store;
  serverId: string;
  relayInstanceId: string;
  now: () => number;
};

// Proves what the store records about a worktree-creating operation, or an abandon, that an
// earlier instance left unfinished (see the header, restart): the outcome of an operation whose
// attempts were all recorded as ended, otherwise requires_attention with the recorded progress.
// Null (the generic requires_attention) when the record names no attempt this server knows.
export function createWorktreeVerifier(context: WorktreeRecoveryContext): ReceiptVerifier {
  const ledger = new ProcessLedger(context.store, context.relayInstanceId, context.now);
  const active = async (key: OperationReceiptKey) => (await ledger.check(key)) !== "ended";
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
    if (record.method === "operation.abandon") {
      const claimed = await context.store.call("worktrees.claimed", { abandon: key });
      return attentionRecord(record, [], null, abandonProgress(claimed, await active(key)));
    }
    const attempts = await context.store.call("worktrees.attempts", { operation: key });
    if (!attempts.length) return null;
    const revision = await context.store.call("worktrees.workspaceRevision", {
      workspaceId: attempts[0]!.workspaceId,
    });
    // Succeeded or failed only from outcomes the attempts recorded; any attempt still pending,
    // even one whose every step is recorded complete, is requires_attention.
    return (
      settledRecord(record, attempts, revision) ??
      attentionRecord(record, attempts, revision, progressOf(attempts, await active(key)))
    );
  };
}
