import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError, type DomainError } from "@cove/protocol/errors";
import type { WriteRpcMethod } from "@cove/protocol/rpc";
import {
  HostPathSchema,
  MountNameSchema,
  type MountSpec,
  type TaskRecord,
  type WorkspaceRecord,
} from "@cove/protocol/workspace";
import {
  executeDatabaseWrite,
  executeDatabaseWriteCommitted,
  recordedWrite,
  storeReadError,
  type DatabaseWriteApply,
  type DatabaseWriteContext,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { ConfigService } from "../store/config.js";
import type { Store } from "../store/database.js";
import type { ManifestSource, NewMount, StoredTask } from "../store/sql/workspaces.js";
import { discoverRepository, type RepositoryRefusal } from "../git/repository.js";
import { GIT_TIMEOUT_MS } from "../git/run.js";
import { checkoutDirectory, gitMetadata } from "../workspace-fs/checkout.js";
import {
  inspectEntry,
  MANIFEST_NOTE,
  pathOccupied,
  publishEntry,
  realWorkspaceRoot,
  replaceManifest,
  syncEntry,
  type EntryWrite,
  type Manifest,
} from "../workspace-fs/entry.js";
import { jsonSize, PAGE_RESERVE, STRUCTURE_TOKENS } from "./record-bounds.js";
import { refusalError } from "./repos.js";

// Tasks, workspaces and checkout mounts (docs/milestones/m1.md T3a, S2; D1, D2 = C, D4).
//
// Model. A task has exactly one workspace; the workspace has one entry directory
// `<workspaceRoot>/<slug>-<short id>` (D1; the root is the setting at creation time, resolved to
// its real path, and never changes afterwards) and up to 16 mounts. A checkout mount names a
// registered clone or an existing, explicitly given worktree of it; Cove does not own it, never
// writes to it, and it is meant for read-only use (D4, a convention Cove does not enforce). Two
// tasks may mount the same checkout; each shows the other (sharedWithTaskIds), with no lock.
//
// Worktree mounts (T3b) are refused with CAPABILITY_UNAVAILABLE right after the receipt lookup,
// before anything is recorded: creating one needs a durable intent, a startup verifier and
// operation continue/abandon, which T3b adds together. A task.create that names one is refused as
// a whole, so no task is left half prepared.
//
// Checkout admission (D2). A checkout path must lead to the registered clone itself or to a
// worktree that shares its Git common directory; the mount records the real top level of that
// working tree. A path recorded as a Cove-managed worktree, of any task including archived ones,
// is refused with MANAGED_WORKTREE_NOT_MOUNTABLE, on task.create and on mount.add alike: the
// managed worktree belongs to its own workspace, and deleting it (D10) must never pull a
// directory from under another task. The Git checks run before the write; the write rechecks
// the registration and the managed-worktree records inside its transaction.
//
// Checkout identity (verifyCheckout). A checkout stays the binding it was admitted as only while
// its recorded path is still that working tree: the same real directory, reached without a
// symlink, whose Git top level is that path and whose common directory is the registration's, and
// that is not a Cove-managed worktree. Every read checks this for each ready checkout and reports
// a mismatch as missing and a check that could not be made as unavailable. Only proof that the
// binding is gone is reported as missing: when Git refuses the directory while its `.git` is still
// there (unreadable metadata, a safe.directory refusal), the check could not be made. A write
// checks it once more for every new checkout right before its transaction, after all other
// checks, which leaves only the moment between that Git query and the commit uncovered: Git cannot
// run inside the store transaction, and the next read reports any change made in that moment.
//
// Read budget. A read answers within readBudgetMs (3 s by default, inside the clients' 5 s request
// timeout): a check (or an entry inspection) not finished by then is reported as unavailable while
// it runs to its end in the background. One page of task.list checks each distinct checkout once.
// All Git discoveries of the service, of reads and writes alike, share gitConcurrency slots, so
// concurrent requests cannot start an unbounded number of Git processes, and a discovery holds its
// slot no longer than its deadline (the read's; a write's is writeStepBudgetMs per discovery):
// discoverRepository starts no Git command past it, gives each one only what is left of it, and
// stops waiting for its filesystem probes then (git/repository.ts). A request waiting for a slot
// leaves the queue at its deadline without starting anything, and free slots go to the waiting
// requests in turn (round robin), so one large task.list cannot keep a single task.get waiting
// behind all of its checks; a waiter whose deadline passed before the slot came free does not get
// it either (Places).
//
// Abandoned work. A deadline bounds the answer, not the work: a filesystem probe or an entry write
// cut off by it keeps running. So the service bounds the filesystem work it has started and not
// yet seen settle: fsConcurrency permits (16 by default), each held until the operation itself
// settles, not until its answer is abandoned. Every filesystem operation of a request goes
// through them: checkout checks, the probes of a discovery and entry materializations, and a
// write's own checks before its transaction (the real path of a checkout, the workspace root and
// the entry path). A request holds at most half of the permits; its further work, such as the rest
// of a large page, waits for a permit until its deadline, and permits that come free go to the
// waiting requests in turn, so a healthy page larger than the bound is still verified in full.
// When every permit is held by work whose deadline has passed (abandoned work that has not settled)
// a request does not wait: its check is answered at once without starting anything, and a request
// already waiting when the last holder's deadline passes is answered then (Places). Every answer
// given up at a deadline is given up only once performance.now() has reached it (atDeadline), so
// the work it gave up on already counts as abandoned when the next request asks. A read reports
// such a check as unavailable; a write is refused with BUSY (not accepted, nothing recorded; the
// same request may be sent again later), never with a refusal that would describe the path, since
// nothing about the path is known. Each of a write's own steps answers within writeStepBudgetMs
// (DISCOVERY_MS by default); one that started and gave no answer refuses the write as for Git
// without an answer, GIT_UNAVAILABLE (WORKSPACE_ENTRY_UNAVAILABLE for the workspace root and the
// entry path), so a write never goes on without a check it needs. A permit or slot handed over
// is used only after a last check of its deadline (see expired).
//
// Concurrent requests share one in-flight check of a checkout and one entry materialization per
// workspace: a request joins what is running, and at most one more materialization waits behind
// it. Each request observes shared work only until its own deadline, and an observer that gives up
// is removed from it (Shared), so reads that time out against work that never settles leave
// nothing behind. Nothing is started for a deadline that has already passed, and every promise
// started gets a rejection handler, so an abandoned operation that fails later is never an
// unhandled rejection. A write waits for its own entry materialization after its commit at most
// entryWriteBudgetMs (DISCOVERY_MS by default) and then answers with its recorded operation; a
// later read repairs the entry if that materialization did not finish.
//
// Response size. Every accepted record fits one task.get response (domain/record-bounds.ts; the
// write refuses one that would not, before it commits), and task.list ends a page before the
// task that would take it past the response bytes or the JSON structure limit, continuing after
// the last task it includes.
//
// Entry directory (D2 option C, #92). The entry holds the mount manifest (cove-workspace.json:
// name, real path, source, read-only flag, state of every mount) and the managed worktrees; it
// has no symlink or directory for a checkout. See workspace-fs/entry.ts for the agent launch
// rules this implies, and for what Cove owns there: an occupant Cove does not own is reported as
// unavailable and never written over.
//
// Write order (relay-protocol §11.3, §11.4):
// 1. The receipt is looked up first; a resend returns the original record without any check.
// 2. Checks that need Git, the filesystem or other store reads run next, outside a transaction.
//    A refusal decided after any await looks the receipt up again first (recordedWrite).
// 3. One store call, receipts.write, rechecks the receipt, checks every database precondition
//    against the current rows (store/sql/workspaces.ts) and commits the change with its receipt.
// 4. Only then the filesystem follows (materialize): the entry is published or its manifest
//    replaced for the new workspace revision, flushed, and only then that revision is recorded
//    as materialized. Every step is idempotent. A manifest update, and a publication that failed
//    or crashed before it took the revision's entitlement or that gave the entitlement back, is
//    repaired by a later attempt, and a read reports the entry as pending until then. A
//    publication that crashed, or whose outcome is uncertain, after it took the entitlement is
//    not repeated: the entry is reported missing until the next change of the workspace (see
//    below). The operation has succeeded by then: what the entry looks like is reported by the
//    task record (entryState), never by a late refusal of an accepted write.
//
// Which attempts may write (materialize). Anyone may update the manifest of Cove's own entry to
// the current revision. Publishing an absent entry is different: every workspace revision carries
// one entitlement to it, committed with the revision (entry_attempted_revision, migration 002).
// Whoever attempts the publication first takes the entitlement, durably and atomically, right
// before publishing (workspaces.claimPublication): the call that committed the change, or, when
// that call died or lost its answer after the commit, the next read. An entry absent while its
// current revision was materialized or its publication already taken was published (or may have
// been) and has disappeared: it stays missing until the next change of the workspace brings a new
// entitlement (D2). This holds also when a publication succeeded but recording it did not. Only a
// publication verified to have left nothing of its own at the entry path gives the entitlement
// back (publishEntry reports `failed` or `occupied`); one that left its claimed directory behind,
// with someone else's manifest in it, keeps it used. A resend answered from its receipt writes
// nothing itself. Nobody writes over an occupant Cove does not own.
//
// A read reports the entry state of the workspace revision it returns: when a change committed
// between reading the record and inspecting the entry, the record is read again (a bounded number
// of times) and the entry is reported pending if the two still disagree.
//
// Removing a mount, archiving a task and removing a repo registration only change records; the
// source directory of a checkout is never written to. What the entry writes may create and remove
// on disk is stated in workspace-fs/entry.ts.

type CreateParams = { operationId: string; title: string; mounts: MountSpec[] };
type RenameParams = {
  operationId: string;
  taskId: string;
  expectedRevision?: number;
  title: string;
};
type ArchiveParams = { operationId: string; taskId: string; expectedRevision?: number };
type MountAddParams = {
  operationId: string;
  taskId: string;
  expectedWorkspaceRevision?: number;
  mount: MountSpec;
};
type MountRemoveParams = {
  operationId: string;
  taskId: string;
  mountId: string;
  expectedWorkspaceRevision?: number;
};
type ListParams = {
  limit: number;
  afterTaskId?: string;
  archived?: "exclude" | "include" | "only";
};

// The filesystem side; tests replace parts of it to fail or interleave writes.
export type WorkspaceFs = {
  realWorkspaceRoot: typeof realWorkspaceRoot;
  pathOccupied: typeof pathOccupied;
  inspectEntry: typeof inspectEntry;
  publishEntry: typeof publishEntry;
  replaceManifest: typeof replaceManifest;
  syncEntry: typeof syncEntry;
  checkoutDirectory: typeof checkoutDirectory;
  realpath: typeof realpath;
};

type EntryState = WorkspaceRecord["entryState"];

// The entry state for one workspace revision; `revision` is null when no revision was read (the
// store failed, or the check ran out of time).
type EntryResult = { state: EntryState; revision: number | null };

type CheckoutVerdict =
  { state: "ready" } | { state: "missing" | "unavailable"; error: DomainError };

// How often a read rereads a record that a concurrent change advanced past its entry check.
const READ_REFETCHES = 2;

// The answer a read gives for a check not finished by its deadline.
const LATE: CheckoutVerdict = {
  state: "unavailable",
  error: domainError("CAPABILITY_UNAVAILABLE"),
};

// One operation observed by any number of requests, each until its own deadline (see the header,
// abandoned work). The operation gets one completion handler, whatever the number of observers; an
// observer that gives up at its deadline is removed, so requests that time out against work that
// never settles leave nothing behind. A rejection settles it with `failed`.
class Shared<T> {
  private outcome: { value: T } | undefined;
  // Observers waiting for the outcome, each removed at its deadline.
  private readonly observers = new Set<(value: T) => void>();
  // Callbacks for the outcome without a deadline: the bookkeeping of whoever started it.
  private readonly settledCallbacks: ((value: T) => void)[] = [];

  constructor(work: Promise<T>, failed: T) {
    work.then(
      (value) => this.settle(value),
      () => this.settle(failed),
    );
  }

  private settle(value: T): void {
    this.outcome = { value };
    for (const callback of this.settledCallbacks.splice(0)) callback(value);
    for (const observer of [...this.observers]) observer(value);
    this.observers.clear();
  }

  // The outcome, or `late` at `deadline` (performance.now() time).
  observe(deadline: number, late: T): Promise<T> {
    if (this.outcome) return Promise.resolve(this.outcome.value);
    const left = deadline - performance.now();
    if (left <= 0) return Promise.resolve(late);
    return new Promise((done) => {
      const finish = (value: T) => {
        cancel();
        this.observers.delete(finish);
        done(value);
      };
      // Not before the deadline (see atDeadline): an answer given up means the work it waited for
      // is past its deadline, which is what makes that work count as abandoned (Places).
      const cancel = atDeadline(deadline, () => finish(late));
      this.observers.add(finish);
    });
  }

  onSettled(callback: (value: T) => void): void {
    if (this.outcome) callback(this.outcome.value);
    else this.settledCallbacks.push(callback);
  }

  get observing(): number {
    return this.observers.size;
  }
}

// The default budget of each step of a write (writeStepBudgetMs) and of its own entry
// materialization after the commit (entryWriteBudgetMs): one discovery's two Git commands at their
// usual timeout.
const DISCOVERY_MS = 2 * GIT_TIMEOUT_MS;

// Runs `callback` once performance.now() has reached `deadline` (never synchronously), and
// returns a function that cancels it. A timer cannot be trusted with a fractional deadline: Node
// keeps its delay in whole milliseconds against a loop clock cached at the start of each turn, so
// it can fire up to about a millisecond before performance.now() reaches the deadline. A callback
// that ran then would give up an answer while the work it gave up on still counts as within its
// deadline (expired, Places' failFast), so the timer is armed again for what is left instead.
function atDeadline(deadline: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout;
  const arm = (): void => {
    const left = deadline - performance.now();
    // setTimeout fires at once for a delay past 2^31 - 1 ms.
    timer = setTimeout(
      () => (deadline - performance.now() > 0 ? arm() : callback()),
      Math.min(Math.max(1, Math.ceil(left)), 2 ** 31 - 1),
    );
  };
  arm();
  return () => clearTimeout(timer);
}

type Holder = { group: object; deadline: number };

type Waiter = {
  deadline: number;
  go: (holder: Holder) => void;
  expire: () => void;
  cancel?: () => void;
};

// A fixed number of places shared by every request of the service (see the header), used for the
// Git slots and the filesystem permits. A request (`group`) holds at most `perGroup` of them, so
// that one request's own fan-out (a large task.list page) queues behind itself instead of taking
// every place; its other work waits, and the work of other requests is not crowded out. Waiters
// are queued per request, and a place that comes free goes to the oldest waiter of the next
// request in turn that is below its own limit. A waiter leaves at its deadline without its work
// starting, also when the place came free after the deadline but before the waiter's timer ran
// (a busy event loop).
//
// With `failFast`, a request finds out at once that nothing will come free in time: when every
// place is held by work whose deadline has passed (abandoned work that has not settled; see the
// header), acquire answers null without queueing. While some place is held by work still within its
// deadline, a waiter waits, since that work will settle or be abandoned soon. Abandoned work
// releases nothing, so when every holder's deadline has passed and no place came free, the
// waiters are answered null then too (watchAbandonment), not at their own deadlines.
class Places {
  private readonly held = new Set<Holder>();
  private readonly heldBy = new Map<object, number>();
  // In turn order: the request served last moves to the end.
  private readonly queues = new Map<object, Waiter[]>();
  // Cancels the pending check of watchAbandonment, if any.
  private abandonmentCheck: (() => void) | null = null;

  constructor(
    private readonly size: number,
    private readonly perGroup: number,
    private readonly failFast: boolean,
  ) {}

  // A held place, or null at the deadline (and at once for failFast, see above).
  acquire(group: object, deadline: number): Promise<Holder | null> {
    const now = performance.now();
    const left = deadline - now;
    if (left <= 0) return Promise.resolve(null);
    if (this.held.size < this.size && this.below(group))
      return Promise.resolve(this.take(group, deadline));
    if (
      this.failFast &&
      this.held.size >= this.size &&
      [...this.held].every((holder) => holder.deadline <= now)
    )
      return Promise.resolve(null);
    return new Promise((done) => {
      const waiter: Waiter = {
        deadline,
        go: (holder) => {
          waiter.cancel?.();
          done(holder);
        },
        expire: () => {
          waiter.cancel?.();
          done(null);
        },
      };
      // At the deadline itself, as dispatch measures it (see atDeadline).
      waiter.cancel = atDeadline(deadline, () => {
        this.drop(group, waiter);
        waiter.expire();
      });
      const queue = this.queues.get(group);
      if (queue) queue.push(waiter);
      else this.queues.set(group, [waiter]);
      this.watchAbandonment();
    });
  }

  release(holder: Holder): void {
    if (!this.held.delete(holder)) return;
    const count = this.heldBy.get(holder.group)! - 1;
    if (count) this.heldBy.set(holder.group, count);
    else this.heldBy.delete(holder.group);
    this.dispatch();
  }

  private below(group: object): boolean {
    return (this.heldBy.get(group) ?? 0) < this.perGroup;
  }

  private take(group: object, deadline: number): Holder {
    const holder = { group, deadline };
    this.held.add(holder);
    this.heldBy.set(group, (this.heldBy.get(group) ?? 0) + 1);
    return holder;
  }

  // Gives free places to waiters in turn (see above).
  private dispatch(): void {
    while (this.held.size < this.size) {
      let next: [object, Waiter[]] | undefined;
      for (const entry of this.queues)
        if (this.below(entry[0])) {
          next = entry;
          break;
        }
      if (!next) return;
      const [group, queue] = next;
      const waiter = queue.shift()!;
      this.queues.delete(group);
      if (queue.length) this.queues.set(group, queue);
      if (waiter.deadline - performance.now() > 0) waiter.go(this.take(group, waiter.deadline));
      else waiter.expire();
      if (!this.queues.size) this.stopWatching();
    }
  }

  private drop(group: object, waiter: Waiter): void {
    const queue = this.queues.get(group);
    if (!queue) return;
    const at = queue.indexOf(waiter);
    if (at >= 0) queue.splice(at, 1);
    if (!queue.length) this.queues.delete(group);
    if (!this.queues.size) this.stopWatching();
  }

  // With failFast, checks the waiters again once the latest deadline of the current holders has
  // passed: if every place is still held, all of it by work past its deadline, nothing will come
  // free in time, so every waiter is answered null at once, as acquire would answer a new request.
  // A place taken meanwhile by work still within its deadline moves the check to that deadline.
  private watchAbandonment(): void {
    if (!this.failFast || this.abandonmentCheck || !this.queues.size) return;
    if (this.held.size < this.size) return;
    let latest = -Infinity;
    for (const holder of this.held) latest = Math.max(latest, holder.deadline);
    this.abandonmentCheck = atDeadline(latest, () => {
      this.abandonmentCheck = null;
      const now = performance.now();
      if (this.held.size >= this.size && [...this.held].every((holder) => holder.deadline <= now)) {
        const waiters = [...this.queues.values()].flat();
        this.queues.clear();
        for (const waiter of waiters) waiter.expire();
      } else this.watchAbandonment();
    });
  }

  private stopWatching(): void {
    this.abandonmentCheck?.();
    this.abandonmentCheck = null;
  }
}

// The handover of a place resumes its waiter in a later job, which a busy event loop can delay
// past the waiter's deadline although the place was granted before it. Work is therefore started
// only after a last check of the deadline, and an expired holder gives its place back at once.
function expired(holder: Holder): boolean {
  return holder.deadline - performance.now() <= 0;
}

// The Git slots: a discovery holds one until it returns, which its deadline bounds. Exported for
// tests.
export class Slots {
  private readonly places: Places;

  constructor(size: number) {
    this.places = new Places(size, size, false);
  }

  // The result of `work`, or `busy` when no slot came free by the deadline.
  async run<T>(group: object, deadline: number, work: () => Promise<T>, busy: T): Promise<T> {
    const holder = await this.places.acquire(group, deadline);
    if (!holder) return busy;
    if (expired(holder)) {
      this.places.release(holder);
      return busy;
    }
    try {
      return await work();
    } finally {
      this.places.release(holder);
    }
  }
}

// The filesystem work the service has started and not yet seen settle (see the header, abandoned
// work). A permit is held until the operation itself settles, however long after its answer was
// given up; a request holds at most half of them at once. Exported for tests.
export class FsPermits {
  private readonly places: Places;

  constructor(size: number) {
    this.places = new Places(size, Math.max(1, Math.ceil(size / 2)), true);
  }

  // Starts `work` once a permit is free and resolves with its promise, wrapped so that it is not
  // adopted; null, with nothing started, when no permit came free by the deadline or none will
  // (failFast). The promise has a rejection handler of its own, so the caller may abandon it.
  async start<T>(
    group: object,
    deadline: number,
    work: () => Promise<T>,
  ): Promise<{ settled: Promise<T> } | null> {
    const holder = await this.places.acquire(group, deadline);
    if (!holder) return null;
    if (expired(holder)) {
      this.places.release(holder);
      return null;
    }
    let started: Promise<T>;
    try {
      started = work();
    } catch (error) {
      started = Promise.reject(error);
    }
    const settled = started.finally(() => this.places.release(holder));
    settled.catch(() => undefined);
    return { settled };
  }
}

// A filesystem probe's answer: its value, or why there is none. `busy`: no permit let it start (a
// capacity refusal); otherwise it failed unexpectedly or did not settle by its deadline.
type Probed<T> = { ok: true; value: T } | { ok: false; busy: boolean };

const NO_ANSWER = { ok: false, busy: false } as const;
const BUSY_PROBE = { ok: false, busy: true } as const;

// One read: its deadline and the checks made so far, so a checkout shared by several tasks of a
// page is checked once. The pass is also the read's turn group for the Git slots.
type ReadPass = { deadline: number; checks: Map<string, Promise<CheckoutVerdict>> };

export type WorkspaceServiceOptions = {
  store: Store;
  receipts: OperationReceipts;
  config: Pick<ConfigService, "workspaceRoot">;
  serverId: string;
  encodeUtf8: (text: string) => Uint8Array;
  now?: () => number;
  newId?: () => string;
  git?: Partial<{ discoverRepository: typeof discoverRepository }>;
  fs?: Partial<WorkspaceFs>;
  // See the header (read budget, abandoned work); defaults 3000 ms, 4 and 16.
  readBudgetMs?: number;
  gitConcurrency?: number;
  fsConcurrency?: number;
  // How long a write waits for its own entry materialization after its commit; DISCOVERY_MS.
  entryWriteBudgetMs?: number;
  // The deadline of each step of a write before its transaction: each filesystem check and each
  // Git discovery (see writeDeadline); DISCOVERY_MS.
  writeStepBudgetMs?: number;
  // The effective RPC response budget (see the header, response size); M0_LIMITS by default.
  responseBytes?: number;
};

// The slug fixed at creation (D1): lower-case ASCII letters and digits of the title joined by
// single dashes, at most 48 characters; `task` when nothing is left (a title in another script).
export function taskSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "task";
}

// The default mount name is the repo's display name (D1) made into one path segment; null when
// nothing usable is left, and the operator must name the mount.
export function defaultMountName(displayName: string): string | null {
  const name = displayName
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return MountNameSchema.safeParse(name).success ? name : null;
}

type CheckoutSpec = Extract<MountSpec, { source: "checkout" }>;

// Worktree mounts are T3b's (see the header).
function checkoutsOnly(specs: MountSpec[]): CheckoutSpec[] | null {
  return specs.every((spec) => spec.source === "checkout") ? (specs as CheckoutSpec[]) : null;
}

export class WorkspaceService {
  private readonly git: { discoverRepository: typeof discoverRepository };
  private readonly fs: WorkspaceFs;
  // Entry materializations per workspace: the one running and at most one waiting for it, so that
  // two writes of one workspace never interleave (an older manifest must never land after a newer
  // one) and repeated requests cannot queue up work (see materialize). One server owns the data
  // directory (single-instance lock), so in-process state is enough.
  private readonly entryWrites = new Map<
    string,
    { running: Shared<EntryResult>; waiting?: Shared<EntryResult> }
  >();
  // Checkout checks in flight, shared by every request (see the header, abandoned work).
  private readonly checksInFlight = new Map<string, Shared<CheckoutVerdict>>();
  private readonly gitSlots: Slots;
  private readonly fsPermits: FsPermits;

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.gitSlots = new Slots(options.gitConcurrency ?? 4);
    this.fsPermits = new FsPermits(options.fsConcurrency ?? 16);
    this.git = { discoverRepository, ...options.git };
    this.fs = {
      realWorkspaceRoot,
      pathOccupied,
      inspectEntry,
      publishEntry,
      replaceManifest,
      syncEntry,
      checkoutDirectory,
      realpath,
      ...options.fs,
    };
  }

  // The requests now waiting for shared work (checkout checks and entry materializations), each
  // until its deadline; for tests and diagnostics (see Shared).
  observerCount(): number {
    let count = 0;
    for (const check of this.checksInFlight.values()) count += check.observing;
    for (const { running, waiting } of this.entryWrites.values())
      count += running.observing + (waiting?.observing ?? 0);
    return count;
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

  private recorded(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
  ): Promise<DatabaseWriteOutcome | null> {
    return recordedWrite(this.context, principalId, method, params);
  }

  private async refuse(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    error: DomainError,
  ): Promise<DatabaseWriteOutcome> {
    return (await this.recorded(principalId, method, params)) ?? { error };
  }

  private write(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    apply: DatabaseWriteApply,
  ): Promise<DatabaseWriteOutcome> {
    return executeDatabaseWrite(this.context, principalId, method, params, apply);
  }

  // A write of the workspace whose own commit is followed by its entry write (see the header).
  private writeCommitted(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    apply: DatabaseWriteApply,
  ): Promise<{ outcome: DatabaseWriteOutcome; committed: boolean }> {
    return executeDatabaseWriteCommitted(this.context, principalId, method, params, apply);
  }

  private readPass(): ReadPass {
    return {
      deadline: performance.now() + (this.options.readBudgetMs ?? 3000),
      checks: new Map(),
    };
  }

  private get responseBytes(): number {
    return this.options.responseBytes ?? M0_LIMITS.rpcResponseBytes;
  }

  // The deadline of one step of a write, from now: every filesystem check and Git discovery a
  // write makes before its transaction gets it.
  private writeDeadline(): number {
    return performance.now() + (this.options.writeStepBudgetMs ?? DISCOVERY_MS);
  }

  // A Git discovery in one of the shared slots, for the request `group` (see the header). A read
  // passes its deadline; a write's discovery gets writeDeadline(). Busy when no slot, or no
  // filesystem permit for one of its probes, let it go on by then.
  private discover(
    path: string,
    group: object,
    deadline = this.writeDeadline(),
  ): ReturnType<typeof discoverRepository> {
    return this.gitSlots.run(
      group,
      deadline,
      () =>
        this.git.discoverRepository(path, {
          deadline,
          probe: (work) => this.fsPermits.start(group, deadline, work),
        }),
      { kind: "busy" },
    );
  }

  // A filesystem probe of the request `group` under a permit that must come free by `deadline`
  // (see Probed). A write passes `answerBy` and gets no answer after it. A read's check passes
  // none: it settles only with the probe, so that the shared check stays in flight while its
  // probe runs and later requests join it rather than start more (each read stops observing it at
  // its own deadline).
  private async probe<T>(
    group: object,
    deadline: number,
    work: () => Promise<T>,
    answerBy?: number,
  ): Promise<Probed<T>> {
    const admitted = await this.fsPermits.start(group, deadline, work);
    if (!admitted) return BUSY_PROBE;
    const answer = admitted.settled.then(
      (value): Probed<T> => ({ ok: true, value }),
      (): Probed<T> => NO_ANSWER,
    );
    return answerBy === undefined
      ? answer
      : new Shared(answer, NO_ANSWER as Probed<T>).observe(answerBy, NO_ANSWER);
  }

  // A write's probe: a permit and an answer by writeDeadline().
  private writeProbe<T>(group: object, work: () => Promise<T>): Promise<Probed<T>> {
    const deadline = this.writeDeadline();
    return this.probe(group, deadline, work, deadline);
  }

  // ---------------------------------------------------------------------------------------------
  // Reads. Each verifies the filesystem: the entry state, and whether every ready binding still
  // exists (a missing one is reported missing, never dropped and never recreated).

  async get(taskId: string): Promise<{ task: TaskRecord } | { error: DomainError }> {
    const pass = this.readPass();
    let stored: StoredTask | null;
    try {
      stored = await this.options.store.call("tasks.get", { taskId });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (!stored) return { error: domainError("TASK_NOT_FOUND") };
    return { task: await this.verified(stored, pass) };
  }

  // Pages in taskId order; archived tasks are left out unless asked for.
  async list(
    params: ListParams,
  ): Promise<{ tasks: TaskRecord[]; nextAfterTaskId?: string } | { error: DomainError }> {
    const pass = this.readPass();
    let rows: StoredTask[];
    try {
      rows = await this.options.store.call("tasks.list", {
        afterTaskId: params.afterTaskId ?? "",
        limit: params.limit,
        archived: params.archived ?? "exclude",
      });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    const verified = await Promise.all(
      rows.slice(0, params.limit).map((stored) => this.verified(stored, pass)),
    );
    // The page ends before the task that would not fit one response (see the header); every
    // record fits on its own, so a page holds at least one.
    const tasks: TaskRecord[] = [];
    let bytes = 0;
    let tokens = 0;
    for (const task of verified) {
      const size = jsonSize(task);
      bytes += size.bytes + (tasks.length ? 1 : 0);
      tokens += size.tokens;
      if (
        tasks.length &&
        (bytes > this.responseBytes - PAGE_RESERVE.bytes ||
          tokens > STRUCTURE_TOKENS - PAGE_RESERVE.tokens)
      )
        break;
      tasks.push(task);
    }
    return rows.length > tasks.length
      ? { tasks, nextAfterTaskId: tasks[tasks.length - 1]!.taskId }
      : { tasks };
  }

  private async verified(first: StoredTask, pass: ReadPass): Promise<TaskRecord> {
    let stored = first;
    let entryState: EntryState;
    // The entry state must be the one of the revision returned (see the header).
    for (let refetches = 0; ; refetches++) {
      const entry = await this.materialize(
        stored.workspaceId,
        pass,
        this.options.readBudgetMs ?? 3000,
      ).observe(pass.deadline, { state: "unavailable", revision: null });
      if (entry.revision === null || entry.revision === stored.record.workspace.revision) {
        entryState = entry.state;
        break;
      }
      let again: StoredTask | null = null;
      if (refetches < READ_REFETCHES) {
        try {
          again = await this.options.store.call("tasks.get", { taskId: stored.record.taskId });
        } catch {
          // Answered with the record already read.
        }
      }
      if (!again) {
        entryState = "pending";
        break;
      }
      stored = again;
    }
    const { record } = stored;
    const workspace = record.workspace;
    // A binding that is not there or no longer the admitted checkout is reported, never dropped
    // and never repaired (S9).
    const mounts = await Promise.all(
      workspace.mounts.map(async (mount) => {
        if (mount.state !== "ready" || mount.source !== "checkout") return mount;
        const check = stored.checkouts[mount.mountId];
        const commonDir = check?.commonDir ?? null;
        const managed = check?.managed ?? false;
        const key = `${managed ? 1 : 0}\0${commonDir ?? ""}\0${mount.path}`;
        let verdict = pass.checks.get(key);
        if (!verdict) {
          // Joins a check of the same checkout that another request is running; nothing is
          // started once the deadline has passed.
          let running = this.checksInFlight.get(key);
          if (!running && pass.deadline - performance.now() > 0) {
            const started = new Shared(
              this.verifyCheckout(mount.path, commonDir, managed, pass, pass.deadline),
              LATE,
            );
            this.checksInFlight.set(key, started);
            started.onSettled(() => {
              if (this.checksInFlight.get(key) === started) this.checksInFlight.delete(key);
            });
            running = started;
          }
          verdict = running ? running.observe(pass.deadline, LATE) : Promise.resolve(LATE);
          pass.checks.set(key, verdict);
        }
        const { state } = await verdict;
        return state === "ready" ? mount : { ...mount, state };
      }),
    );
    return { ...record, workspace: { ...workspace, entryState, mounts } };
  }

  // Whether the checkout recorded at `path` is still the admitted binding (see the header):
  // `commonDir` is the current registration's (null when it is gone) and `managed` whether the
  // path is recorded as a managed worktree now. A refusal names why, for a write to report.
  // `group` is the request's turn for the Git slots and the filesystem permits; `deadline` is the
  // read's, or a write's own for each step.
  private async verifyCheckout(
    path: string,
    commonDir: string | null,
    managed: boolean,
    group: object,
    deadline?: number,
  ): Promise<CheckoutVerdict> {
    if (managed) return { state: "missing", error: domainError("MANAGED_WORKTREE_NOT_MOUNTABLE") };
    if (commonDir === null) return { state: "missing", error: domainError("REPO_NOT_FOUND") };
    // A read's check answers by the read's deadline through its observers; a write's probes have
    // their own (see probe).
    const fsProbe = <T>(work: () => Promise<T>) =>
      deadline === undefined ? this.writeProbe(group, work) : this.probe(group, deadline, work);
    const directory = await fsProbe(() => this.fs.checkoutDirectory(path));
    // Saturation or no answer proves nothing about the path; only the probe's own answer does.
    if (!directory.ok) return { state: "unavailable", error: noAnswer(directory) };
    if (directory.value === "missing")
      return { state: "missing", error: refusalError({ kind: "missing" }) };
    if (directory.value === "unavailable")
      return { state: "unavailable", error: refusalError({ kind: "inaccessible" }) };
    const found = await this.discover(path, group, deadline);
    if (found.kind === "work-tree")
      return found.topLevel === path && found.commonDir === commonDir
        ? { state: "ready" }
        : { state: "missing", error: domainError("INVALID_ARGUMENT") };
    // Git did not answer, the directory could not be read or the check could not start: neither
    // present nor gone.
    if (found.kind === "unavailable" || found.kind === "inaccessible" || found.kind === "busy")
      return { state: "unavailable", error: refusalError(found) };
    // Git refused the directory as a repository; that proves the binding gone only when its
    // metadata is gone too (see the header).
    if (found.kind === "not-repository") {
      const metadata = await fsProbe(() => gitMetadata(path));
      if (!metadata.ok) return { state: "unavailable", error: noAnswer(metadata) };
      if (metadata.value !== "absent")
        return { state: "unavailable", error: refusalError({ kind: "inaccessible" }) };
    }
    return { state: "missing", error: refusalError(found) };
  }

  // The last check of new checkout mounts before their write (see the header). The managed
  // worktree records are checked inside the transaction instead.
  private async recheckCheckouts(mounts: NewMount[], group: object): Promise<DomainError | null> {
    const verdicts = await Promise.all(
      mounts.map((mount) => this.verifyCheckout(mount.path, mount.commonDir, false, group)),
    );
    for (const verdict of verdicts) if (verdict.state !== "ready") return verdict.error;
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Entry directory and manifest.

  // Brings the entry of a workspace up to its current revision where that is allowed (see the
  // header), and returns its state for the revision it read. While one materialization runs, a
  // caller joins the one waiting behind it (creating it if there is none): that one reads the
  // record only after the running one has ended, so it covers every change committed before the
  // caller asked, and the work queued per workspace never exceeds two.
  // The materialization is shared work: each caller observes it until its own deadline. It
  // starts in the turn group of the caller that created it, with `budgetMs` from its start for
  // its permit (a waiting one starts only when the running one has ended).
  private materialize(workspaceId: string, group: object, budgetMs: number): Shared<EntryResult> {
    const current = this.entryWrites.get(workspaceId);
    if (current?.waiting) return current.waiting;
    const once = () => this.materializeOnce(workspaceId, group, budgetMs);
    const work = current
      ? new Promise<EntryResult>((done) => current.running.onSettled(() => done(once())))
      : once();
    const run = new Shared(work, { state: "unavailable", revision: null });
    // Runs before the waiting one starts (its callback was added first): it becomes the running
    // one, and later callers wait behind it.
    run.onSettled(() => {
      const state = this.entryWrites.get(workspaceId);
      if (state?.running !== run) return;
      if (state.waiting) {
        state.running = state.waiting;
        delete state.waiting;
      } else this.entryWrites.delete(workspaceId);
    });
    if (current) current.waiting = run;
    else this.entryWrites.set(workspaceId, { running: run });
    return run;
  }

  // One materialization under a filesystem permit, settling only when it has ended (so that two
  // never interleave); unavailable when no permit let it start or it failed unexpectedly (an
  // entry not verified is never ready).
  private async materializeOnce(
    workspaceId: string,
    group: object,
    budgetMs: number,
  ): Promise<EntryResult> {
    const unavailable: EntryResult = { state: "unavailable", revision: null };
    const admitted = await this.fsPermits.start(group, performance.now() + budgetMs, () =>
      this.materializeNow(workspaceId),
    );
    return admitted ? admitted.settled.catch(() => unavailable) : unavailable;
  }

  // A write's own materialization after its commit, bounded (entryWriteBudgetMs) so that a hung
  // filesystem cannot hold the answer of an accepted write; the entry state is the record's, and
  // a later read repairs what this one did not finish.
  private async materializeAfterWrite(workspaceId: string, group: object): Promise<void> {
    const budget = this.options.entryWriteBudgetMs ?? DISCOVERY_MS;
    await this.materialize(workspaceId, group, budget).observe(performance.now() + budget, {
      state: "unavailable",
      revision: null,
    });
  }

  private async materializeNow(workspaceId: string): Promise<EntryResult> {
    let source: ManifestSource | null;
    try {
      source = await this.options.store.call("workspaces.manifestSource", { workspaceId });
    } catch {
      return { state: "unavailable", revision: null };
    }
    // Deleted meanwhile; nothing removes a workspace in T3a, so this is not expected.
    if (!source) return { state: "unavailable", revision: null };
    const { revision } = source;
    const answer = (state: EntryState): EntryResult => ({ state, revision });
    const manifest = manifestOf(source);
    const found = await this.fs.inspectEntry(source.entryPath, manifest);
    let written: EntryWrite;
    switch (found.kind) {
      case "current":
        written = "written";
        break;
      case "stale":
        written = await this.fs.replaceManifest(source.entryPath, found, manifest);
        break;
      case "absent": {
        // The entitlement of this revision was used (see the header): published once, or
        // possibly (an attempt that crashed or had an uncertain outcome after taking it), and
        // gone since. Not retried; only a change of the workspace recreates it.
        if (
          source.materializedRevision === revision ||
          (source.attemptedRevision !== null && source.attemptedRevision >= revision)
        )
          return answer("missing");
        const claimed = await this.claimPublication(workspaceId, revision);
        // Taken meanwhile by another attempt, or the revision is no longer the current one: the
        // next read reports what that left. Also when the store did not answer: whether the claim
        // committed is unknown, so this attempt publishes nothing.
        if (!claimed) return answer("pending");
        written = await this.fs.publishEntry(source.entryPath, manifest);
        // Verified that nothing of this publication is at the entry path (see publishEntry),
        // so a later attempt may publish it.
        if (written === "failed" || written === "occupied")
          await this.releasePublication(workspaceId, revision);
        break;
      }
      case "foreign":
      case "unavailable":
        return answer("unavailable");
    }
    if (written === "failed") return answer("pending");
    if (written !== "written") return answer("unavailable");
    const recorded = source.materializedRevision === revision;
    if (recorded && found.kind === "current") return answer("ready");
    try {
      // Durable before it is recorded: a recorded revision must survive a host crash. Flushed
      // again when an earlier attempt published the entry but did not get to record it.
      await this.fs.syncEntry(source.entryPath);
    } catch {
      return answer("pending");
    }
    if (recorded) return answer("ready");
    try {
      // False when the workspace changed meanwhile: this revision is no longer the current one,
      // and the newer one still has to be written.
      const marked = await this.options.store.call("workspaces.markMaterialized", {
        workspaceId,
        revision,
      });
      return answer(marked ? "ready" : "pending");
    } catch {
      // Not recorded: the next attempt finds the entry current, flushes and records it.
      return answer("pending");
    }
  }

  // Takes the publication entitlement of `revision`; false when another attempt has it, the
  // revision is no longer current, or the store did not confirm it.
  private async claimPublication(workspaceId: string, revision: number): Promise<boolean> {
    try {
      return await this.options.store.call("workspaces.claimPublication", {
        workspaceId,
        revision,
      });
    } catch {
      return false;
    }
  }

  // Gives it back; when this fails, the revision's entry is reported missing until the next
  // change, which errs toward never recreating an entry.
  private async releasePublication(workspaceId: string, revision: number): Promise<void> {
    try {
      await this.options.store.call("workspaces.releasePublication", { workspaceId, revision });
    } catch {
      // See above.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Mount resolution (before the write).

  // A checkout spec resolved against its registration: its name and the admission check (D2).
  private async resolve(
    spec: CheckoutSpec,
    group: object,
  ): Promise<{ mount: NewMount } | { error: DomainError }> {
    let repo;
    try {
      repo = await this.options.store.call("repos.get", { repoId: spec.repoId });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (!repo) return { error: domainError("REPO_NOT_FOUND") };
    const name = spec.name ?? defaultMountName(repo.record.displayName);
    if (!name) return { error: domainError("INVALID_ARGUMENT") };
    const target = spec.path ?? repo.record.path;
    // A path is interpreted on this host; a relative one has no meaning to the server.
    if (!isAbsolute(target)) return { error: domainError("INVALID_ARGUMENT") };
    // A recorded managed worktree is refused before Git is asked, so the refusal does not depend
    // on its directory still existing (Git could not identify a deleted one).
    const spellings = [target];
    // A path that cannot be resolved is an answer (Git below reports what the path is); a probe
    // that did not start or gave no answer is not, and the write cannot go on without it: the
    // managed-worktree check would miss the real spelling.
    const real = await this.writeProbe(group, () =>
      this.fs.realpath(target).then(
        (resolved): string | null => resolved,
        (): string | null => null,
      ),
    );
    if (!real.ok) return { error: noAnswer(real) };
    if (real.value !== null) spellings.push(real.value);
    let managed: boolean;
    try {
      managed = await this.options.store.call("workspaces.managedWorktree", { paths: spellings });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    if (managed) return { error: domainError("MANAGED_WORKTREE_NOT_MOUNTABLE") };
    const found = await this.discover(target, group);
    if (found.kind !== "work-tree") return { error: refusalError(found) };
    // A working tree of another clone (or of an unregistered one) is not this repo's checkout.
    if (found.commonDir !== repo.commonDir) return { error: domainError("INVALID_ARGUMENT") };
    if (!HostPathSchema.safeParse(found.topLevel).success)
      return { error: domainError("INVALID_ARGUMENT") };
    return {
      mount: {
        mountId: this.newId(),
        name,
        source: "checkout",
        repoId: spec.repoId,
        path: found.topLevel,
        commonDir: found.commonDir,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Writes.

  async create(principalId: string, params: CreateParams): Promise<DatabaseWriteOutcome> {
    const recorded = await this.recorded(principalId, "task.create", params);
    if (recorded) return recorded;
    const refuse = (error: DomainError) => this.refuse(principalId, "task.create", params, error);
    const specs = checkoutsOnly(params.mounts);
    if (!specs) return refuse(domainError("CAPABILITY_UNAVAILABLE"));
    let configured: string;
    try {
      configured = await this.options.config.workspaceRoot();
    } catch (error) {
      return refuse(storeReadError(error));
    }
    // This request's turn group for the Git slots and the filesystem permits.
    const group = {};
    // A task whose entry cannot exist is refused before anything is recorded; so is one whose
    // entry cannot be checked now (see the header, abandoned work).
    const root = await this.writeProbe(group, () => this.fs.realWorkspaceRoot(configured));
    if (!root.ok) return refuse(entryNoAnswer(root));
    if (!root.value) return refuse(domainError("WORKSPACE_ENTRY_UNAVAILABLE"));
    const taskId = this.newId();
    const workspaceId = this.newId();
    const slug = taskSlug(params.title);
    const shortId =
      taskId
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 8)
        .toLowerCase() || "0";
    const entryPath = join(root.value, `${slug}-${shortId}`);
    if (!HostPathSchema.safeParse(entryPath).success)
      return refuse(domainError("INVALID_ARGUMENT"));
    // Something already at the entry path is not Cove's to take over. Checked again by the
    // publication itself, which reports one that appears later as unavailable.
    const occupied = await this.writeProbe(group, () => this.fs.pathOccupied(entryPath));
    if (!occupied.ok) return refuse(entryNoAnswer(occupied));
    if (occupied.value) return refuse(domainError("WORKSPACE_ENTRY_UNAVAILABLE"));
    const mounts: NewMount[] = [];
    for (const spec of specs) {
      const found = await this.resolve(spec, group);
      if ("error" in found) return refuse(found.error);
      if (mounts.some((other) => other.name === found.mount.name))
        return refuse(domainError("MOUNT_NAME_CONFLICT"));
      mounts.push(found.mount);
    }
    const changed = await this.recheckCheckouts(mounts, group);
    if (changed) return refuse(changed);
    const { outcome, committed } = await this.writeCommitted(principalId, "task.create", params, {
      name: "task.create",
      args: {
        taskId,
        workspaceId,
        title: params.title,
        slug,
        entryPath,
        mounts,
        responseBytes: this.responseBytes,
        at: this.now(),
      },
    });
    // An identical request that committed first answers this one with its own record and writes
    // nothing; a read publishes the entry if the call that committed did not get to it.
    if (committed) await this.materializeAfterWrite(workspaceId, group);
    return outcome;
  }

  async rename(principalId: string, params: RenameParams): Promise<DatabaseWriteOutcome> {
    return this.write(principalId, "task.update", params, {
      name: "task.update",
      args: {
        taskId: params.taskId,
        title: params.title,
        at: this.now(),
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
      },
    });
  }

  async setArchived(
    principalId: string,
    params: ArchiveParams,
    archived: boolean,
  ): Promise<DatabaseWriteOutcome> {
    return this.write(principalId, archived ? "task.archive" : "task.unarchive", params, {
      name: "task.archive",
      args: {
        taskId: params.taskId,
        archived,
        at: this.now(),
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
      },
    });
  }

  async addMount(principalId: string, params: MountAddParams): Promise<DatabaseWriteOutcome> {
    const recorded = await this.recorded(principalId, "mount.add", params);
    if (recorded) return recorded;
    const refuse = (error: DomainError) => this.refuse(principalId, "mount.add", params, error);
    const spec = checkoutsOnly([params.mount])?.[0];
    if (!spec) return refuse(domainError("CAPABILITY_UNAVAILABLE"));
    let task: StoredTask | null;
    try {
      task = await this.options.store.call("tasks.get", { taskId: params.taskId });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (!task) return refuse(domainError("TASK_NOT_FOUND"));
    // Advisory; the write checks it again with the current row.
    if (task.record.archived) return refuse(domainError("TASK_ARCHIVED"));
    const group = {};
    const found = await this.resolve(spec, group);
    if ("error" in found) return refuse(found.error);
    const { mount } = found;
    const changed = await this.recheckCheckouts([mount], group);
    if (changed) return refuse(changed);
    const { outcome, committed } = await this.writeCommitted(principalId, "mount.add", params, {
      name: "mount.add",
      args: {
        taskId: params.taskId,
        mount,
        responseBytes: this.responseBytes,
        at: this.now(),
        ...(params.expectedWorkspaceRevision === undefined
          ? {}
          : { expectedWorkspaceRevision: params.expectedWorkspaceRevision }),
      },
    });
    if (committed) await this.materializeAfterWrite(task.workspaceId, group);
    return outcome;
  }

  async removeMount(principalId: string, params: MountRemoveParams): Promise<DatabaseWriteOutcome> {
    const { outcome, committed } = await this.writeCommitted(principalId, "mount.remove", params, {
      name: "mount.remove",
      args: {
        taskId: params.taskId,
        mountId: params.mountId,
        at: this.now(),
        ...(params.expectedWorkspaceRevision === undefined
          ? {}
          : { expectedWorkspaceRevision: params.expectedWorkspaceRevision }),
      },
    });
    // A resend, or a request that found an identical one committed first, writes nothing; the
    // entitlement of the new revision is the commit's, whoever uses it (see the header).
    if (committed) {
      const workspaceId = await this.workspaceOf(params.taskId);
      if (workspaceId) await this.materializeAfterWrite(workspaceId, {});
    }
    return outcome;
  }

  private async workspaceOf(taskId: string): Promise<string | null> {
    try {
      return (await this.options.store.call("tasks.get", { taskId }))?.workspaceId ?? null;
    } catch {
      return null;
    }
  }
}

// The refusal of a check that has no answer (see Probed): BUSY for a capacity refusal, otherwise
// as for a Git query without an answer, GIT_UNAVAILABLE. Neither says anything about the path.
function noAnswer(probed: { busy: boolean }): DomainError {
  const refusal: RepositoryRefusal = { kind: probed.busy ? "busy" : "unavailable" };
  return refusalError(refusal);
}

// The same for the workspace root and the entry path, which are not Git's: an entry that cannot
// be checked is refused like one that cannot exist, never assumed free.
function entryNoAnswer(probed: { busy: boolean }): DomainError {
  return domainError(probed.busy ? "BUSY" : "WORKSPACE_ENTRY_UNAVAILABLE");
}

function manifestOf(source: ManifestSource): Manifest {
  return {
    kind: "cove-workspace",
    version: 1,
    taskId: source.taskId,
    workspaceId: source.workspaceId,
    workspaceRevision: source.revision,
    note: MANIFEST_NOTE,
    mounts: source.mounts.map((mount) => ({
      name: mount.name,
      path: mount.path,
      source: mount.source,
      readOnly: mount.source === "checkout",
      state: mount.state,
    })),
  };
}
