import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { domainError } from "@cove/protocol/errors";
import type { OperationReceiptKey, OperationRecord, StoredReceipt } from "@cove/protocol/rpc";
import type { DurableReceiptBackend } from "../operations/operation-receipts.js";
import {
  checkedReceiptRecord,
  type DatabaseWriteOutcome,
  type DatabaseWriteRequest,
  type ReceiptLimits,
} from "../operations/receipt-records.js";
import type { ConfigReader } from "../store/config.js";
import { nextConfig, type ConfigState } from "../store/config-rules.js";
import type { Store } from "../store/database.js";

// Instrumentation for the D6 latency probe (docs/milestones/m1.md D6;
// apps/cli/tests/m1/d6-latency-probe.mjs).
// Only the separate probe entry (d6-probe-main.ts, not a package executable) constructs it; the
// normal cove-server entry imports no part of it, so neither its environment nor a signal can
// switch a normal server to the non-durable memory backend.
//
// It records, on the runtime main thread:
// - the execution interval of every store call (one transaction each), measured where the store
//   executes it (the store worker) with performance.timeOrigin + performance.now(), which agrees
//   across threads, and in the control phase the interval of each in-memory write unit in its
//   place;
// - event-loop delay (monitorEventLoopDelay), sampled every 100 ms as max and p99;
// - the write mode: `sqlite` (the real store) or `memory`, the control phase, in which receipts and
//   configuration are kept in memory on the main thread, so a write takes the same RPC,
//   validation, receipt and response path without a store call or SQLite transaction.
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

const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

class MemoryReceipts implements DurableReceiptBackend {
  private readonly receipts = new Map<string, StoredReceipt>();
  constructor(
    // The control phase's configuration: loaded from the store once, then read and replaced
    // synchronously inside each write unit, so concurrent writes cannot lose an update.
    private readonly config: {
      ready(): Promise<void>;
      current(): ConfigState;
      set(state: ConfigState): void;
    },
    private readonly timed: <T>(fn: () => T) => T,
  ) {}
  async get(key: OperationReceiptKey): Promise<StoredReceipt | null> {
    return this.receipts.get(keyOf(key)) ?? null;
  }
  async insert(receipt: StoredReceipt): Promise<boolean> {
    const key = keyOf(receipt.key);
    if (this.receipts.has(key)) return false;
    this.receipts.set(key, receipt);
    return true;
  }
  async replace(
    key: OperationReceiptKey,
    expectedRevision: number,
    record: OperationRecord,
  ): Promise<boolean> {
    const stored = this.receipts.get(keyOf(key));
    if (!stored || stored.record.revision !== expectedRevision) return false;
    this.receipts.set(keyOf(key), { ...stored, record });
    return true;
  }
  async unfinished(): Promise<StoredReceipt[]> {
    return [];
  }
  // The in-memory counterpart of receipts.write (store/sql/receipts.ts) for config.set: the same
  // receipt recheck, the same configuration rule and the same records, as one synchronous unit.
  async write(request: DatabaseWriteRequest, limits: ReceiptLimits): Promise<DatabaseWriteOutcome> {
    await this.config.ready();
    return this.timed(() => {
      const existing = this.receipts.get(keyOf(request.key));
      if (existing)
        return existing.canonicalIntent === request.canonicalIntent
          ? { operation: existing.record }
          : { error: domainError("OPERATION_ID_CONFLICT") };
      if (request.apply.name !== "config.set")
        return { error: domainError("CAPABILITY_UNAVAILABLE") };
      const applied = nextConfig(this.config.current(), request.apply.args);
      if ("error" in applied) return applied;
      const accepted = checkedReceiptRecord(
        request.key,
        {
          operationId: request.key.operationId,
          method: request.method,
          revision: 0,
          state: "accepted",
        },
        limits,
        encodeUtf8,
      );
      const succeeded =
        accepted &&
        checkedReceiptRecord(
          request.key,
          { ...accepted, revision: 1, state: "succeeded", result: applied.result },
          limits,
          encodeUtf8,
        );
      if (!succeeded) return { error: domainError("BUSY") };
      this.receipts.set(keyOf(request.key), {
        key: { ...request.key },
        canonicalIntent: request.canonicalIntent,
        record: succeeded,
      });
      this.config.set(applied.next);
      return { operation: succeeded };
    });
  }
}

export class D6Probe {
  private mode: Mode = "sqlite";
  private readonly transactions: number[] = [];
  // The control phase's write units (apply + receipt), timed like transactions.
  private readonly memoryWrites: number[] = [];
  private readonly samples: number[] = [];
  private readonly switches: [number, Mode][] = [];
  private sqliteConfig: ConfigReader | undefined;
  private memoryConfig: ConfigState | undefined;
  private loading: Promise<void> | undefined;
  private readonly memoryReceipts = new MemoryReceipts(
    {
      ready: () => this.loadControlConfig(),
      current: () => ({ ...this.memoryConfig! }),
      set: (state) => {
        this.memoryConfig = { ...state };
      },
    },
    (fn) => {
      const start = D6Probe.now();
      try {
        return fn();
      } finally {
        this.memoryWrites.push(start, D6Probe.now());
      }
    },
  );

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
      // Load the control configuration now, in the gap before the control phase: the read is a
      // store transaction, and one inside the phase would count as SQLite work there. It queues
      // behind any write still in the store, so it sees what the write phase left. A failure is
      // reported to the first control write, which awaits the same promise.
      if (mode === "memory") this.loadControlConfig().catch(() => {});
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

  // The control phase starts from the configuration the store holds.
  private loadControlConfig(): Promise<void> {
    const sqlite = this.sqliteConfig;
    if (!sqlite) return Promise.reject(new Error("D6 probe configuration is not attached"));
    return (this.loading ??= sqlite.read().then((state) => {
      this.memoryConfig ??= { ...state };
    }));
  }

  receipts(sqlite: DurableReceiptBackend): DurableReceiptBackend {
    const current = () => (this.mode === "sqlite" ? sqlite : this.memoryReceipts);
    return {
      get: (key) => current().get(key),
      insert: (receipt) => current().insert(receipt),
      replace: (key, revision, record) => current().replace(key, revision, record),
      unfinished: () => sqlite.unfinished(),
      write: (request, limits) => current().write(request, limits),
    };
  }

  config(sqlite: ConfigReader): ConfigReader {
    this.sqliteConfig = sqlite;
    return {
      read: async () => {
        if (this.mode === "sqlite") return sqlite.read();
        await this.loadControlConfig();
        return { ...this.memoryConfig! };
      },
    };
  }
}
