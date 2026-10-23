import { parentPort, workerData } from "node:worker_threads";
import { openConnection } from "./connection.js";
import { execute, loadAfterCommitHooks, loadOperations } from "./executor.js";
import { serializeStoreError } from "./store-errors.js";
import type { StoreRequest, StoreResponse, StoreWorkerData } from "./store-protocol.js";
import { BusinessJournal } from "./business-journal.js";

// The store worker thread (D6 B): the only place the server's database connection exists. It is
// started by Store.open (database.ts) after the main thread took the instance lock, and it runs
// the schema preflight, the open, the migrations and every business operation.
//
// Calls are executed one at a time in arrival order, each synchronously as one transaction, so
// a business operation never interleaves with another and the order of effects is the order of
// calls. A transaction never spans a message.
//
// When this thread dies for any reason (an uncaught exception, termination, process.exit),
// better-sqlite3 closes its connection on thread teardown: an open transaction rolls back and the
// database lock is released while the process keeps running. That is why the instance lock lives
// on the main thread, which releases it only after it observed this thread's exit.

const port = parentPort;
if (!port) throw new Error("The store worker must run in a worker thread");
const data = workerData as StoreWorkerData;

function post(message: StoreResponse): void {
  port!.postMessage(message);
}

async function main(): Promise<void> {
  let opened;
  let operations;
  let hooks;
  try {
    operations = await loadOperations(data.operationModules);
    hooks = await loadAfterCommitHooks(data.operationModules);
    opened = await openConnection(data);
  } catch (error) {
    post({ type: "open-failed", error: serializeStoreError(error) });
    port!.close();
    return;
  }
  const db = opened.db;
  const journal = new BusinessJournal(db, data.defaultWorkspaceRoot);
  port!.on("message", (request: StoreRequest) => {
    if (request.type === "close") {
      // The client sends close only after every call was answered.
      try {
        db.close();
        post({ type: "closed" });
      } catch (error) {
        post({ type: "close-failed", error: serializeStoreError(error) });
      }
      port!.close();
      return;
    }
    const result = execute(db, operations, request.operation, request.args, journal);
    if (result.ok) for (const hook of hooks) result.value = hook(request.operation, result.value);
    try {
      post({ type: "result", id: request.id, ...result });
    } catch {
      // The operation ran (and may have committed), but its result cannot be sent.
      post({ type: "unanswerable", id: request.id });
    }
  });
  post({ type: "opened", schemaVersion: opened.schemaVersion, backupPath: opened.backupPath });
}

void main();
