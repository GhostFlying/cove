#!/usr/bin/env node
import Fastify, { LogController } from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { M0_LIMITS, validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import { RuntimeRetainedBytes } from "../terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../terminal/runtime-composition.js";
import { WorkerPool } from "../terminal/worker-pool.js";
import { RunRegistry } from "../terminal/run-registry.js";
import { LocalRuntime } from "../terminal/local-runtime.js";
import { ControlArbiter } from "../terminal/control-arbiter.js";
import { OperationReceipts } from "../operations/operation-receipts.js";
import { TerminalOperations } from "../operations/terminal-operations.js";
import { createRecoveryVerifiers } from "../operations/recovery-verifiers.js";
import { SESSION_CONTROL_RESERVE } from "../terminal/worker-pipe-session.js";
import { WorkerProcess, type WorkerSpawn } from "../terminal/worker-process.js";
import { LocalRuntimeClock, type LocalTimer } from "../terminal/local-runtime-clock.js";
import { LocalAdmission } from "../transport/local-admission.js";
import { TerminalWebSocket, registerTerminalWebSocket } from "../transport/terminal-websocket.js";
import { encodeUtf8, registerHttpRpc, type LocalCore } from "../transport/http-rpc.js";
import { ConfigService, initializeWorkspaceRoot, sqliteConfigState } from "../store/config.js";
import { resolveHome } from "../store/home.js";
import { StoreError, type Store, type StoreOptions } from "../store/database.js";
import { instanceStopCall, recordInstanceStart } from "../store/identity.js";
import { SqliteReceiptBackend } from "../store/operations.js";
import { RunLog } from "../store/runs.js";
import { launchIdentity, LocalRendezvous } from "./local-rendezvous.js";
import { openPersistence, RendezvousConflictError, replaceStaleRendezvous } from "./persistence.js";
import { RecordingRunRegistry } from "./recording-run-registry.js";
// Type only: the instrumentation is constructed by the separate probe entry (d6-probe-main.ts), so
// this executable cannot enable it, whatever its environment.
import type { D6Probe } from "./d6-probe.js";
import {
  localAuthority,
  parseLocalOptions,
  validateLocalOptions,
  type M0LocalOptions,
} from "./m0-local-options.js";

// Test-only seams, passed by test entries that import runServerProcess (for example
// apps/cli/tests/m1/store-fault-server.mjs); the executable at the end of this module passes none,
// so production cannot load test store operations or reach the store from outside.
export type ServerTestHooks = {
  store?: Pick<StoreOptions, "operationModules" | "limits">;
  onStoreOpen?: (store: Store) => void;
};

export function createLocalApplication(
  input: M0LocalOptions,
  injected?: {
    identity?: ReturnType<typeof launchIdentity>;
    budgets?: EffectiveBudgets;
    core?: LocalCore;
    monotonic?: () => number;
    timer?: LocalTimer;
    workerSpawn?: WorkerSpawn;
    // The opened data directory (M1 T1). identity.serverId must be its persistent serverId.
    persistence?: { store: Store; home: string; principalId: string; probe?: D6Probe };
  },
) {
  const options = validateLocalOptions(input);
  const identity = injected?.identity ?? launchIdentity();
  const budgets = validateEffectiveBudgets(injected?.budgets ?? { ...M0_LIMITS });
  if (!budgets || !/^[A-Za-z0-9_-]{43,256}$/.test(identity.secret))
    throw new Error("Invalid local launch binding");
  let terminal: TerminalWebSocket | undefined;
  let worker: WorkerProcess | undefined;
  const clock = new LocalRuntimeClock(
    () => {
      for (const session of core.runtime.pool.sessions()) session.tick();
      core.runtime.tickPreviews();
      for (const service of terminal?.services ?? []) service.tick();
    },
    () => {
      for (const session of core.runtime.pool.sessions()) session.loseContact();
      terminal?.close();
    },
    injected?.timer,
    injected?.monotonic,
  );
  const composition =
    injected?.core?.runtime.composition ??
    new RuntimeComposition(
      identity.serverId,
      identity.relayInstanceId,
      budgets,
      new RuntimeRetainedBytes(
        budgets.runtimeBytes,
        SESSION_CONTROL_RESERVE + budgets.reservedControlBytes,
      ),
    );
  if (
    !composition.owns(identity) ||
    JSON.stringify(composition.budgets) !== JSON.stringify(budgets)
  )
    throw new Error("Local runtime composition mismatch");
  const pool = injected?.core?.runtime.pool ?? new WorkerPool(composition, 1, budgets.maxRuns);
  const persistence = injected?.core ? undefined : injected?.persistence;
  const runs = persistence ? new RunLog(persistence.store) : undefined;
  const runtime =
    injected?.core?.runtime ??
    new LocalRuntime(
      pool,
      runs ? new RecordingRunRegistry(composition, runs) : new RunRegistry(composition),
      encodeUtf8,
      (result) => [...(terminal?.services ?? [])].some((service) => service.handoff(result)),
      { now: clock.now, wallNow: Date.now },
    );
  const receipts = injected?.core
    ? undefined
    : new OperationReceipts(
        composition,
        encodeUtf8,
        persistence ? receiptBackend(persistence, identity.relayInstanceId) : undefined,
      );
  const core: LocalCore = injected?.core ?? {
    runtime,
    operations: new TerminalOperations({
      composition,
      runtime,
      receipts: receipts!,
      encodeUtf8,
      ...(runs ? { runs } : {}),
    }),
    buildVersion: "0.0.0",
    ...(persistence
      ? {
          principalId: persistence.principalId,
          store: persistence.store,
          receipts: receipts!,
          config: new ConfigService({
            home: persistence.home,
            serverId: identity.serverId,
            receipts: receipts!,
            state: persistence.probe
              ? persistence.probe.config(sqliteConfigState(persistence.store))
              : sqliteConfigState(persistence.store),
            encodeUtf8,
          }),
        }
      : {}),
  };
  const arbiter = new ControlArbiter(runtime);
  const admission = new LocalAdmission(
    options,
    identity.secret,
    identity,
    budgets,
    composition.bytes,
  );
  terminal = new TerminalWebSocket(admission, core, arbiter, clock.now, injected?.timer);
  const app = Fastify({
    logger: false,
    bodyLimit: budgets.rpcRequestBytes,
    requestTimeout: 5000,
    // The top-level disableRequestLogging option is deprecated (FSTDEP023).
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Register the plugin before routes; business handlers attach synchronously on upgrade.
  const terminalRoutes = terminal;
  app.register(async (routes) => {
    await routes.register(websocket, { options: { maxPayload: 69648, perMessageDeflate: false } });
    routes.setNotFoundHandler((_request, reply) => reply.code(404).send());
    registerHttpRpc(routes, admission, core);
    registerTerminalWebSocket(routes, terminalRoutes);
  });
  return {
    app,
    admission,
    core,
    clock,
    terminal,
    arbiter,
    identity,
    options,
    runs,
    receipts,
    createWorker: () => {
      if (worker) throw new Error("Local worker already owned");
      worker = new WorkerProcess(
        runtime,
        {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          workerId: randomUUID(),
          workerIncarnationId: randomUUID(),
        },
        clock.now,
        injected?.workerSpawn,
      );
      return worker;
    },
    disposeCore: () => {
      clock.stop();
      terminal?.close();
      arbiter.dispose();
      core.operations.dispose();
      receipts?.dispose();
      runtime.dispose();
    },
  };
}

export class LocalEntryStartupError extends Error {
  constructor(
    readonly category: "store" | "worker" | "listen" | "rendezvous" | "interrupted",
    readonly cleanup: "verified" | "unverifiable",
    // A safe description (no paths or secrets) of a store refusal, such as a data directory in
    // use by another server or a database schema newer than this build.
    readonly detail?: string,
  ) {
    super("Local entry startup unavailable");
    this.name = "LocalEntryStartupError";
  }
}

function receiptBackend(persistence: { store: Store; probe?: D6Probe }, relayInstanceId: string) {
  const sqlite = new SqliteReceiptBackend(persistence.store, relayInstanceId);
  return persistence.probe ? persistence.probe.receipts(sqlite) : sqlite;
}

// Opens the data directory first (M1 T1): the database lock decides whether this process may run
// at all, before a worker, listener or rendezvous exists. Startup verification of the previous
// instance's operations and runs completes before any request can be served.
async function openLocalApplication(
  input: M0LocalOptions,
  probe?: D6Probe,
  hooks?: ServerTestHooks,
) {
  const options = validateLocalOptions(input);
  if (options.home === undefined) return { local: createLocalApplication(options), store: null };
  let persistence;
  try {
    persistence = await openPersistence(options.home, Date.now, hooks?.store);
  } catch (error) {
    throw new LocalEntryStartupError(
      "store",
      "verified",
      error instanceof StoreError ? error.message : undefined,
    );
  }
  const store = persistence.store;
  try {
    const identity = { ...launchIdentity(), serverId: persistence.identity.serverId };
    await recordInstanceStart(store, identity.relayInstanceId, Date.now());
    const local = createLocalApplication(options, {
      identity,
      persistence: {
        store,
        home: persistence.layout.home,
        principalId: persistence.identity.principalId,
        ...(probe ? { probe } : {}),
      },
    });
    try {
      // Method-specific verifiers (operations/recovery-verifiers.ts) prove what they can; the
      // rest become requires_attention. Nothing is executed again.
      await local.receipts?.recoverInterrupted(
        createRecoveryVerifiers({
          store,
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          now: Date.now,
        }),
      );
      await local.runs?.interruptEarlier(identity.relayInstanceId);
      await replaceStaleRendezvous(persistence.layout, options.rendezvousPath, {
        store,
        serverId: identity.serverId,
        relayInstanceId: identity.relayInstanceId,
      });
    } catch (error) {
      local.disposeCore();
      throw error;
    }
    probe?.start(store);
    hooks?.onStoreOpen?.(store);
    return { local, store };
  } catch (error) {
    await store.close().catch(() => undefined);
    if (error instanceof RendezvousConflictError)
      throw new LocalEntryStartupError("rendezvous", "verified", error.message);
    throw new LocalEntryStartupError("store", "verified", "The Cove data directory is unusable");
  }
}

export async function startLocalEntry(
  input: M0LocalOptions,
  // `onStoreFailure` reports a store failure (runServerProcess: the store-failed event and exit
  // status 1). It is called for every failure, also one during a stop that already began.
  shutdown?: { signal?: AbortSignal; onStoreFailure?: () => void },
  // Only the D6 probe entry passes this (d6-probe-main.ts); see d6-probe.ts.
  probe?: D6Probe,
  hooks?: ServerTestHooks,
) {
  const { local, store } = await openLocalApplication(input, probe, hooks);
  const rendezvous = new LocalRendezvous(local.options.rendezvousPath);
  const worker = local.createWorker();
  const instance = local.identity.relayInstanceId;
  // Fail closed (D6 B): a failed store is never restarted, so the server stops serving. The
  // listener is registered as soon as the store exists, so a failure at any later point (startup,
  // serving, or a stop that already began) is reported. `storeFailureReported` is set only after
  // the reporter ran: cleanup may then treat the store's refusal to record the orderly stop as
  // already accounted for (exit status 1; the next start marks this instance's runs interrupted).
  // Without a reporter the failure is a cleanup failure like any other.
  let storeFailureReported = false;
  let storeFailedNow: () => void = () => undefined;
  const storeFailed = new Promise<void>((done) => (storeFailedNow = done));
  store?.onFailure(() => {
    if (shutdown?.onStoreFailure) {
      shutdown.onStoreFailure();
      storeFailureReported = true;
    }
    storeFailedNow();
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      let failed = false;
      try {
        await rendezvous.close();
      } catch {
        failed = true;
      }
      local.terminal.close();
      try {
        await local.app.close();
      } catch {
        failed = true;
      }
      let receipt: Awaited<WorkerProcess["closed"]> | undefined;
      try {
        receipt = await worker.close();
      } catch {
        failed = true;
      } finally {
        try {
          local.disposeCore();
        } catch {
          failed = true;
        }
        // D9: this instance's runs end with the server. Only the worker's own exit report proves
        // that every PTY it owned ended. The store closes last, which releases the data directory
        // lock after the rendezvous is gone. The stop records are the store's final calls: they
        // run after the drain, without the queue limits, so a saturated queue cannot refuse them.
        if (store) {
          try {
            await store.close([
              ...(local.runs
                ? [local.runs.stoppedWithServerCall(instance, receipt?.status === "exited")]
                : []),
              instanceStopCall(instance, Date.now()),
            ]);
          } catch {
            // A failed store was already reported (the store-failed event, exit status 1); its
            // records are left to the next start, which marks this instance's runs interrupted.
            if (!store.failed || !storeFailureReported) failed = true;
          }
        }
      }
      if (failed || receipt?.status !== "exited")
        throw new Error("Local entry cleanup unverifiable");
    })());
  const interrupted = (): void => {
    if (shutdown?.signal?.aborted) throw new LocalEntryStartupError("interrupted", "unverifiable");
  };
  let category: "worker" | "listen" | "rendezvous" = "worker";
  try {
    interrupted();
    local.clock.start();
    worker.start();
    const signal = shutdown?.signal;
    let abort: (() => void) | undefined;
    try {
      await (signal
        ? Promise.race([
            worker.ready,
            new Promise<never>((_resolve, reject) => {
              abort = () => reject(new LocalEntryStartupError("interrupted", "unverifiable"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ])
        : worker.ready);
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
    interrupted();
    category = "listen";
    await local.app.listen({ host: local.options.host, port: local.options.port });
    // Drain an in-flight listen/publication before rollback. Abandoning either
    // promise on a signal could publish a listener/file after cleanup completed.
    interrupted();
    const bound = local.app.server.address();
    if (!bound || typeof bound === "string" || bound.address !== local.options.host)
      throw new Error("Invalid numeric local bind");
    local.admission.bind(bound.port);
    const endpoint = `http://${localAuthority(local.options.host, bound.port)}`;
    category = "rendezvous";
    await rendezvous.publish({ bootstrapVersion: 1, ...local.identity, endpoint });
    interrupted();
    // D9: the live runs an orderly stop would end, read from the store.
    const liveRuns = async () => (store?.isOpen ? ((await local.runs?.live(instance)) ?? []) : []);
    // Resolves when the store worker failed; the caller then stops the server unless a stop already
    // began. `close` cannot record the orderly stop of a failed store.
    return { endpoint, close, liveRuns, storeFailed };
  } catch (error) {
    let cleanup: "verified" | "unverifiable" = "verified";
    try {
      await close();
    } catch {
      cleanup = "unverifiable";
    }
    // Preserve a safe initiating category and a separate ownership outcome,
    // without copying raw exception messages, paths or secret-bearing inputs.
    throw new LocalEntryStartupError(
      error instanceof LocalEntryStartupError ? error.category : category,
      cleanup,
      error instanceof LocalEntryStartupError ? error.detail : undefined,
    );
  }
}

// `cove-server --mode init --home DIR [--workspace-root DIR]` (D7): initializes the data
// directory, the persistent identity and optionally the first workspaceRoot while no server runs.
// It takes the same database lock as a server, so it is refused while one is running.
async function initializeHome(argv: readonly string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || value === undefined || !["--mode", "--home", "--workspace-root"].includes(key))
      throw new Error("Invalid init arguments");
    if (values.has(key)) throw new Error("Invalid init arguments");
    values.set(key, value);
  }
  let persistence;
  try {
    persistence = await openPersistence(resolveHome(values.get("--home")));
  } catch (error) {
    throw new LocalEntryStartupError(
      "store",
      "verified",
      error instanceof StoreError ? error.message : undefined,
    );
  }
  try {
    const workspaceRoot = values.get("--workspace-root");
    // An existing data directory keeps its settings; changing one is `cove config set`.
    if (workspaceRoot !== undefined && !persistence.created)
      throw new LocalEntryStartupError(
        "store",
        "verified",
        "The Cove data directory is already initialized; change workspaceRoot with `cove config set`",
      );
    if (workspaceRoot !== undefined)
      await initializeWorkspaceRoot(persistence.store, workspaceRoot, Date.now());
    const config = await sqliteConfigState(persistence.store).read();
    process.stdout.write(
      `${JSON.stringify({
        home: persistence.layout.home,
        serverId: persistence.identity.serverId,
        created: persistence.created,
        schemaVersion: persistence.store.schemaVersion,
        workspaceRoot: config.workspaceRoot ?? join(persistence.layout.home, "workspace"),
      })}\n`,
    );
  } finally {
    await persistence.store.close();
  }
}

// The server process: `--mode init` or the local server. `probe` is passed only by the D6 probe
// entry.
export function runServerProcess(
  argv: readonly string[],
  probe?: D6Probe,
  hooks?: ServerTestHooks,
): void {
  const fail = (error: unknown, fallback: string): void => {
    process.exitCode = 1;
    process.stderr.write(
      error instanceof LocalEntryStartupError && error.detail
        ? `cove-server: ${error.detail}\n`
        : fallback,
    );
  };
  if (argv[0] === "--mode" && argv[1] === "init") {
    initializeHome(argv).catch((error: unknown) => fail(error, "cove-server init unavailable\n"));
  } else
    void (async () => {
      const controller = new AbortController();
      // Every store failure ends the process with status 1 and one store-failed event, whether it
      // happens while serving or during a stop that already began (the stop records may then be
      // missing). Only the event is deduplicated; the status is latched each time.
      let storeFailureEvent = false;
      const reportStoreFailure = (): void => {
        process.exitCode = 1;
        if (storeFailureEvent) return;
        storeFailureEvent = true;
        process.stderr.write(`${JSON.stringify({ event: "store-failed" })}\n`);
      };
      let server: Awaited<ReturnType<typeof startLocalEntry>> | undefined;
      let closing: Promise<void> | undefined;
      const detach = (): void => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      };
      const close = (): Promise<void> => (closing ??= server!.close().finally(detach));
      const shutdown = (): void => {
        if (controller.signal.aborted) return;
        controller.abort();
        if (!server) return;
        // D9: name the live runs this stop ends before ending them.
        const running = server;
        void (async () => {
          try {
            process.stderr.write(
              `${JSON.stringify({ event: "stopping", liveRuns: await running.liveRuns() })}\n`,
            );
          } catch {
            process.stderr.write("cove-server: the live run list is unavailable\n");
          }
          await close();
        })().catch(() => {
          process.exitCode = 1;
          process.stderr.write("m0-local cleanup unverifiable\n");
        });
      };
      // Latch signals before parsing or acquiring any startup resources. Keep the
      // handlers through cleanup so a repeated signal cannot bypass retirement.
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      try {
        const options = parseLocalOptions(argv);
        server = await startLocalEntry(
          { ...options, home: options.home ?? resolveHome(undefined) },
          { signal: controller.signal, onStoreFailure: reportStoreFailure },
          probe,
          hooks,
        );
        if (controller.signal.aborted) await close();
        const started = server;
        // The failure itself was reported by reportStoreFailure; this only starts the stop. A stop
        // that already began continues on its own.
        void started.storeFailed.then(() => {
          if (controller.signal.aborted) return;
          controller.abort();
          close().catch(() => process.stderr.write("m0-local cleanup unverifiable\n"));
        });
      } catch (error) {
        detach();
        if (
          error instanceof LocalEntryStartupError &&
          error.category === "interrupted" &&
          error.cleanup === "verified"
        )
          return;
        throw error;
      }
    })().catch((error: unknown) => fail(error, "m0-local startup unavailable\n"));
}

// Whether this module is the program node was started with. Compared by real path: an installed
// executable is usually a symlink to this file, and import.meta.url names the real file. An entry
// that cannot be resolved (for example "-" when the program is read from stdin) is not this file;
// this check runs on import, so it must never throw.
function startedAsThisFile(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}

if (startedAsThisFile(process.argv[1])) runServerProcess(process.argv.slice(2));
