import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { OperationReceiptKey, OperationRecord, StoredReceipt } from "@cove/protocol/rpc";
import type { DurableReceiptBackend } from "../operations/operation-receipts.js";
import { memoryConfigState, type ConfigBackend } from "../store/config.js";
import type { Store } from "../store/database.js";

// Instrumentation for the D6 latency probe (docs/milestones/m1.md D6;
// apps/cli/tests/m1/d6-latency-probe.mjs).
// Only the separate probe entry (d6-probe-main.ts, not a package executable) constructs it; the
// normal cove-server entry imports no part of it, so neither its environment nor a signal can
// switch a normal server to the non-durable memory backend.
//
// It records, on the runtime main thread:
// - the synchronous execution interval of every outermost store transaction, and in the control
//   phase the interval of each in-memory write unit in its place;
// - event-loop delay (monitorEventLoopDelay), sampled every 100 ms as max and p99;
// - the write mode: `sqlite` (the real store) or `memory`, the control phase, in which receipts and
//   configuration are kept in memory, so a write takes the same RPC, validation, receipt and
//   response path without a synchronous SQLite transaction.
// SIGUSR1 selects `sqlite`, SIGUSR2 selects `memory` (a SIGUSR1 listener replaces Node's default of
// opening the inspector, which a probe server does not need). Everything is written to
// `<dir>/server-<pid>.json` when the process exits.
//
// The probe needs a data directory of its own: memory-mode writes are not persisted, so the
// database and the receipts a client saw diverge after a control phase.

type Mode = "sqlite" | "memory";

const SAMPLE_MS = 100;
const RESOLUTION_MS = 2;

function keyOf(key: OperationReceiptKey): string {
  return JSON.stringify([key.serverId, key.principalId, key.operationId]);
}

class MemoryReceipts implements DurableReceiptBackend {
  private readonly receipts = new Map<string, StoredReceipt>();
  get(key: OperationReceiptKey): StoredReceipt | null {
    return this.receipts.get(keyOf(key)) ?? null;
  }
  insert(receipt: StoredReceipt): boolean {
    const key = keyOf(receipt.key);
    if (this.receipts.has(key)) return false;
    this.receipts.set(key, receipt);
    return true;
  }
  replace(key: OperationReceiptKey, expectedRevision: number, record: OperationRecord): boolean {
    const stored = this.receipts.get(keyOf(key));
    if (!stored || stored.record.revision !== expectedRevision) return false;
    this.receipts.set(keyOf(key), { ...stored, record });
    return true;
  }
  unfinished(): StoredReceipt[] {
    return [];
  }
  atomic<T>(fn: () => T): T {
    return fn();
  }
}

export class D6Probe {
  private mode: Mode = "sqlite";
  private readonly transactions: number[] = [];
  // The control phase's write units (apply + receipt), timed like transactions.
  private readonly memoryWrites: number[] = [];
  private readonly samples: number[] = [];
  private readonly switches: [number, Mode][] = [];
  private readonly memoryReceipts = new MemoryReceipts();
  private memoryConfig: ConfigBackend | undefined;

  constructor(private readonly directory: string) {}

  private static now(): number {
    return performance.timeOrigin + performance.now();
  }

  start(store: Store): void {
    store.observe((start, end) => this.transactions.push(start, end));
    const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    delay.enable();
    // The histogram records each timer interval including the resolution itself; the excess over
    // the resolution is the delay.
    const excess = (nanoseconds: number) => Math.max(0, nanoseconds / 1e6 - RESOLUTION_MS);
    setInterval(() => {
      this.samples.push(D6Probe.now(), excess(delay.max), excess(delay.percentile(99)));
      delay.reset();
    }, SAMPLE_MS).unref();
    const select = (mode: Mode) => () => {
      this.mode = mode;
      this.switches.push([D6Probe.now(), mode]);
    };
    process.on("SIGUSR1", select("sqlite"));
    process.on("SIGUSR2", select("memory"));
    process.on("exit", () => {
      writeFileSync(
        join(this.directory, `server-${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          transactions: this.transactions,
          memoryWrites: this.memoryWrites,
          samples: this.samples,
          switches: this.switches,
        }),
      );
    });
  }

  receipts(sqlite: DurableReceiptBackend): DurableReceiptBackend {
    const current = () => (this.mode === "sqlite" ? sqlite : this.memoryReceipts);
    return {
      get: (key) => current().get(key),
      insert: (receipt) => current().insert(receipt),
      replace: (key, revision, record) => current().replace(key, revision, record),
      unfinished: () => sqlite.unfinished(),
      atomic: (fn) => current().atomic(fn),
    };
  }

  config(sqlite: ConfigBackend): ConfigBackend {
    const current = () => {
      if (this.mode === "sqlite") return sqlite;
      return (this.memoryConfig ??= memoryConfigState(sqlite.read()));
    };
    return {
      read: () => current().read(),
      write: (next, at) => current().write(next, at),
      transaction: (fn) => {
        if (this.mode === "sqlite") return sqlite.transaction(fn);
        const start = D6Probe.now();
        try {
          return current().transaction(fn);
        } finally {
          this.memoryWrites.push(start, D6Probe.now());
        }
      },
    };
  }
}
