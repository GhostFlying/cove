import type { Migration } from "./migrations.js";
import type { SerializedStoreError } from "./store-errors.js";

// Messages between the store client on the main thread (database.ts) and the store worker
// (store-worker.ts). Everything crossing is structured-clone-safe plain data.
//
//   main                                   worker
//   (instance lock held) ── new Worker(workerData: StoreWorkerData) ──>
//                        <── opened | open-failed      (then the worker exits on failure)
//   call {id, operation, args} ──>                    executes calls one at a time, FIFO,
//                        <── result {id, ok, value | error, timing}   each as one transaction
//   close ──>            (only after every call was answered)
//                        <── closed | close-failed     (the database is closed; worker exits)
//   (worker 'exit' observed) ── releases the instance lock
//
// An `unanswerable` result means the operation ran but its result could not be sent (not
// structured-clone-safe); its effect is unknown to the caller, so the client fails the store.

export type StoreWorkerData = {
  databasePath: string;
  backupDirectory: string;
  migrations: readonly Migration[];
  now: number;
  operationModules: readonly string[];
};

export type StoreRequest =
  { type: "call"; id: number; operation: string; args: unknown } | { type: "close" };

export type StoreResponse =
  | { type: "opened"; schemaVersion: number; backupPath: string | null }
  | { type: "open-failed"; error: SerializedStoreError }
  | { type: "result"; id: number; ok: true; value: unknown; timing: [number, number] }
  | {
      type: "result";
      id: number;
      ok: false;
      error: SerializedStoreError;
      timing: [number, number];
    }
  | { type: "unanswerable"; id: number }
  | { type: "closed" }
  | { type: "close-failed"; error: SerializedStoreError };
