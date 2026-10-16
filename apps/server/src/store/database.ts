import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { busy } from "./connection.js";
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from "./migrations.js";
import type { StoreArgs, StoreOperationName, StoreResult } from "./sql/registry.js";
import {
  reviveStoreError,
  StoreError,
  StoreOperationError,
  StoreUnavailableError,
  type StoreErrorCategory,
} from "./store-errors.js";
import type { StoreRequest, StoreResponse, StoreWorkerData } from "./store-protocol.js";

export { StoreError, type StoreErrorCategory };

// Observes the execution interval of every store call (D6 probe). The interval is measured in the
// store worker with performance.timeOrigin + performance.now(), which agrees across the threads of
// one process, so it correlates with timestamps taken on the main thread and by clients.
export type TransactionObserver = (startMs: number, endMs: number) => void;

export type StoreLimits = {
  // Calls handed to the worker and not yet answered. If the worker fails, these are uncertain.
  inFlight: number;
  // Calls waiting on the main thread, never handed to the worker. If the worker fails, these are
  // known not to have executed.
  queued: number;
};

export const DEFAULT_STORE_LIMITS: StoreLimits = Object.freeze({ inFlight: 16, queued: 1024 });

export type StoreOptions = {
  databasePath: string;
  // The instance lock file; defaults to `cove.lock` beside the database.
  lockPath?: string;
  backupDirectory: string;
  now?: () => number;
  migrations?: readonly Migration[];
  // File URLs of modules whose `operations` are added to the built-in ones (tests).
  operationModules?: readonly string[];
  limits?: StoreLimits;
};

type Call = {
  id: number;
  operation: string;
  args: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

// The worker entry, beside this module in the compiled output (dist/store/store-worker.js). It is
// resolved from this module's own URL, so it does not depend on the working directory or on the
// path the server was started through (a symlinked bin resolves to the real file).
const WORKER_ENTRY = new URL("./store-worker.js", import.meta.url);

// The server's database (D5, D6 B). Callers run complete business operations by name
// (store/sql/registry.ts); each call is one transaction executed by a dedicated worker thread
// (store-worker.ts), so a business operation is never split across calls, never spans an await
// and never blocks the runtime main thread.
//
// Threads and locks. The main thread holds the instance lock (`cove.lock`); the worker holds the
// database connection.
// - The newer-schema refusal must leave a newer build's files byte-for-byte unchanged, so the
//   committed version is read from the files before SQLite opens them (schema-version.ts; opening
//   could checkpoint a newer build's WAL on close). Without a lock, a newer server could commit
//   into the WAL between that read and the open. The database's own lock cannot be taken without
//   SQLite reading (and later possibly checkpointing) the WAL, so every server first takes an
//   exclusive lock on a separate SQLite file: an open BEGIN EXCLUSIVE transaction, never
//   committed, so the lock file is never written after creation. The worker, which runs the
//   preflight, is only started once the lock is held.
// - The lock stays on the main thread because a worker thread's connections are closed when the
//   thread dies (better-sqlite3 closes them on thread teardown) while the process keeps running.
//   A lock in the worker would let a second server start beside this one after a store crash,
//   while this process still serves terminals. On the main thread it lasts until this process
//   released it explicitly, after the worker exited, or until the process ends (a crash), when
//   the operating system releases it.
// - Never open a second connection to either file from this process: POSIX advisory locks belong
//   to the process, and closing any other connection to the file would drop the lock. The lock
//   file is opened only here and the database only in the worker.
//
// Calls. A call waits in a bounded queue on the main thread, then is handed to the worker; at most
// `limits.inFlight` are handed over at a time. Calls are handed over and executed in the order
// they were made. A full queue refuses the call (busy, not sent).
//
// Failure (fail closed). An uncaught exception in the worker, its unexpected exit, or a message
// that cannot be delivered fails the store for good; it is never restarted, because the outcome
// of the calls in flight is unknown and repeating them could apply a write twice. In-flight calls
// reject as `unknown`, queued and later calls as `not-sent` (store-errors.ts). Failure listeners
// (onFailure) are told once, and the server stops (entry/main.ts). The lock is still held until
// close().
//
// Shutdown. close() stops accepting calls, waits until every queued and in-flight call was
// answered, asks the worker to close the database (which checkpoints the WAL), waits for the
// worker thread to exit, and only then releases the instance lock.
export class Store {
  private observer: TransactionObserver | undefined;
  private state: "open" | "closing" | "closed" | "failed" = "open";
  private readonly queue: Call[] = [];
  private readonly inFlight = new Map<number, Call>();
  private nextId = 0;
  private readonly failureListeners: (() => void)[] = [];
  private drained: (() => void) | undefined;
  private closeAnswer: ((ok: boolean) => void) | undefined;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly lock: Database.Database,
    private readonly worker: Worker,
    private readonly exited: Promise<number>,
    private readonly limits: StoreLimits,
    readonly path: string,
    readonly schemaVersion: number,
    readonly backupPath: string | null,
  ) {
    worker.on("message", (message: StoreResponse) => this.receive(message));
    worker.on("error", () => this.fail());
    worker.on("messageerror", () => this.fail());
    void exited.then(() => {
      // The only expected exit follows the worker's answer to close.
      if (this.state !== "closed") this.fail();
      this.closeAnswer?.(false);
    });
  }

  static async open(options: StoreOptions): Promise<Store> {
    const limits = options.limits ?? DEFAULT_STORE_LIMITS;
    if (
      !Number.isSafeInteger(limits.inFlight) ||
      !Number.isSafeInteger(limits.queued) ||
      limits.inFlight < 1 ||
      limits.queued < 0
    )
      throw new Error("Invalid store limits");
    const lock = lockInstance(options.lockPath ?? join(dirname(options.databasePath), "cove.lock"));
    let worker: Worker;
    try {
      worker = new Worker(WORKER_ENTRY, {
        // Not the process's own flags: options meant for the main entry (such as
        // --input-type for an evaluated script) can make a file entry fail to start.
        execArgv: [],
        workerData: {
          databasePath: options.databasePath,
          backupDirectory: options.backupDirectory,
          migrations: (options.migrations ?? MIGRATIONS).map((migration) => ({ ...migration })),
          now: (options.now ?? Date.now)(),
          operationModules: [...(options.operationModules ?? [])],
        } satisfies StoreWorkerData,
      });
    } catch {
      lock.close();
      throw new StoreError("unavailable", "The Cove database worker cannot be started");
    }
    const exited = new Promise<number>((done) => worker.once("exit", done));
    const opened = await new Promise<StoreResponse | null>((done) => {
      worker.once("message", done);
      worker.once("error", () => done(null));
      void exited.then(() => done(null));
    });
    if (opened?.type === "opened") {
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      return new Store(
        lock,
        worker,
        exited,
        limits,
        options.databasePath,
        opened.schemaVersion,
        opened.backupPath,
      );
    }
    // The worker closed whatever it opened; the lock is released after it exited.
    await worker.terminate().catch(() => undefined);
    await exited;
    lock.close();
    const error = opened?.type === "open-failed" ? reviveStoreError(opened.error) : null;
    if (error instanceof StoreError) throw error;
    throw new StoreError("unavailable", "The Cove database cannot be opened");
  }

  observe(observer: TransactionObserver | undefined): void {
    this.observer = observer;
  }

  // Called once when the store fails (immediately if it already has).
  onFailure(listener: () => void): void {
    if (this.state === "failed") queueMicrotask(listener);
    else this.failureListeners.push(listener);
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get failed(): boolean {
    return this.state === "failed";
  }

  private currentState(): Store["state"] {
    return this.state;
  }

  // Runs one business operation as one transaction in the store worker.
  call<N extends StoreOperationName>(name: N, args: StoreArgs<N>): Promise<StoreResult<N>>;
  call(name: string, args?: unknown): Promise<unknown>;
  call(name: string, args?: unknown): Promise<unknown> {
    if (this.state !== "open")
      return Promise.reject(
        new StoreUnavailableError(this.state === "failed" ? "failed" : "closed", "not-sent"),
      );
    if (this.queue.length >= this.limits.queued && this.inFlight.size >= this.limits.inFlight)
      return Promise.reject(new StoreUnavailableError("busy", "not-sent"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, operation: name, args, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (
      (this.state === "open" || this.state === "closing") &&
      this.inFlight.size < this.limits.inFlight &&
      this.queue.length > 0
    ) {
      const call = this.queue.shift()!;
      const request: StoreRequest = {
        type: "call",
        id: call.id,
        operation: call.operation,
        args: call.args,
      };
      try {
        this.worker.postMessage(request);
      } catch {
        // The arguments cannot be cloned: nothing was sent.
        call.reject(new StoreOperationError(null, "The store call arguments cannot be sent"));
        continue;
      }
      this.inFlight.set(call.id, call);
    }
    if (this.queue.length === 0 && this.inFlight.size === 0) this.drained?.();
  }

  private receive(message: StoreResponse): void {
    if (message.type === "closed" || message.type === "close-failed") {
      // Set before the worker's exit is observed, which then is the expected one.
      if (message.type === "closed" && this.state === "closing") this.state = "closed";
      this.closeAnswer?.(message.type === "closed");
      return;
    }
    if (message.type !== "result" && message.type !== "unanswerable") return;
    const call = this.inFlight.get(message.id);
    // A late answer after a failure was already reported as unknown.
    if (!call || this.state === "failed") return;
    if (message.type === "unanswerable") {
      this.fail();
      return;
    }
    this.inFlight.delete(message.id);
    this.observer?.(message.timing[0], message.timing[1]);
    if (message.ok) call.resolve(message.value);
    else call.reject(reviveStoreError(message.error));
    this.pump();
  }

  private fail(): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    for (const call of this.inFlight.values())
      call.reject(new StoreUnavailableError("failed", "unknown"));
    this.inFlight.clear();
    for (const call of this.queue.splice(0))
      call.reject(new StoreUnavailableError("failed", "not-sent"));
    // Make sure a worker that is still running cannot execute anything more.
    void this.worker.terminate().catch(() => undefined);
    this.drained?.();
    for (const listener of this.failureListeners.splice(0)) listener();
  }

  // Drains, closes the database in the worker, waits for the worker to exit, then releases the
  // instance lock. Rejects when the database could not be closed cleanly (the store failed before
  // or during the close); the lock is released in every case.
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }

  private async shutdown(): Promise<void> {
    let clean = false;
    if (this.state === "open") {
      this.state = "closing";
      if (this.queue.length > 0 || this.inFlight.size > 0)
        await new Promise<void>((done) => {
          this.drained = done;
        });
      if (this.state === "closing") {
        const answered = new Promise<boolean>((done) => {
          this.closeAnswer = done;
        });
        this.worker.postMessage({ type: "close" } satisfies StoreRequest);
        // Read through a method: the state changed while this function awaited.
        clean = (await answered) && this.currentState() === "closed";
      }
    }
    if (!clean) await this.worker.terminate().catch(() => undefined);
    await this.exited;
    // Released last: the database is closed (and checkpointed), and the thread that held it is
    // gone, before another server can start.
    this.lock.close();
    if (!clean) {
      this.state = "failed";
      throw new StoreUnavailableError("failed", "unknown");
    }
  }
}

// Takes the instance lock or fails with in-use (see the class comment).
function lockInstance(path: string): Database.Database {
  let lock: Database.Database | undefined;
  try {
    lock = new Database(path, { timeout: 0 });
    // No rollback journal file: an exclusive transaction otherwise creates `cove.lock-journal`.
    lock.pragma("journal_mode = MEMORY");
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock?.close();
    throw busy(error)
      ? new StoreError("in-use", "The Cove data directory is in use by another server")
      : new StoreError("unavailable", "The Cove data directory lock cannot be taken");
  }
}

export { SCHEMA_VERSION };
