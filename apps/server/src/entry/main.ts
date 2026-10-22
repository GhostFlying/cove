#!/usr/bin/env node
import Fastify, { LogController } from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { M0_LIMITS, validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import { AuthService, loadAuthState, type AuthState } from "../auth/service.js";
import { PortSchema } from "@cove/protocol/auth";
import { buildId } from "../build-id.js";
import { ListenerSet, tsnetBinaryPath } from "../network/listeners.js";
import { TsnetNode } from "../network/tsnet.js";
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
import { RawConnectionGate } from "../transport/raw-connections.js";
import { TerminalWebSocket, registerTerminalWebSocket } from "../transport/terminal-websocket.js";
import { encodeUtf8, registerHttpRpc, type LocalCore } from "../transport/http-rpc.js";
import { ConfigService, initializeWorkspaceRoot, sqliteConfigState } from "../store/config.js";
import { homeLayout, resolveHome } from "../store/home.js";
import { SCHEMA_VERSION } from "../store/migrations.js";
import { committedSchemaVersion } from "../store/schema-version.js";
import { StoreError, type Store, type StoreOptions } from "../store/database.js";
import { instanceStopCall, recordInstanceStart } from "../store/identity.js";
import { SqliteReceiptBackend } from "../store/operations.js";
import { RunLog } from "../store/runs.js";
import { describeUnsupportedGit, findGit } from "../git/run.js";
import { launchIdentity, LocalRendezvous } from "./local-rendezvous.js";
import { openPersistence, RendezvousConflictError, replaceStaleRendezvous } from "./persistence.js";
import { RecordingRunRegistry } from "./recording-run-registry.js";
import { EntryConfigService } from "./entry-config.js";
import {
  checkCrashRestartBudget,
  clearCrashStop,
  CrashRestartBudgetError,
  recordCrashStop,
  recordServiceStart,
  ServiceState,
  type StartReason,
} from "./service-state.js";
import type { EntryConfigState } from "../store/config-rules.js";
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
    persistence?: {
      store: Store;
      home: string;
      principalId: string;
      probe?: D6Probe;
      // Device authorization state read at startup (auth/service.ts loadAuthState). Without it
      // the composition accepts the local owner secret only.
      auth?: AuthState;
      // The entry configuration read at startup (m2 T3). Without it entry.get and entry.set
      // report CAPABILITY_UNAVAILABLE.
      entry?: EntryConfigState;
      // Why this instance started (service-state.ts), recorded before the composition is built.
      // Without it server.status has no `service` and server.impact is unavailable.
      lastStart?: StartReason;
    };
    // Where operational log lines go (one JSON object per line); stderr by default.
    log?: (line: string) => void;
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
    buildVersion: buildId(),
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
  // Where operational log lines go (one JSON object per line); stderr by default.
  const log = injected?.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  // Entry configuration (m2 T3). The auth service reads the SSH target through it each time an
  // invitation is created, so an entry.set of sshTarget applies to the next invitation.
  const entry =
    persistence?.entry && receipts
      ? new EntryConfigService({
          store: persistence.store,
          receipts,
          serverId: identity.serverId,
          encodeUtf8,
          initial: persistence.entry,
          ...(options.sshTarget === undefined ? {} : { sshTargetOverride: options.sshTarget }),
        })
      : undefined;
  if (entry && !injected?.core) core.entry = entry;
  if (persistence?.lastStart && !injected?.core)
    core.service = new ServiceState({
      store: persistence.store,
      home: persistence.home,
      relayInstanceId: identity.relayInstanceId,
      manager: options.service ?? "foreground",
      lastStart: persistence.lastStart,
    });
  // Device authorization (m2 T1): verifies credentials for both transports and serves the auth
  // domain and the pairing listener. Its log lines carry device IDs and ports, never a secret.
  const auth =
    persistence?.auth && receipts
      ? new AuthService(
          {
            store: persistence.store,
            receipts,
            serverId: identity.serverId,
            relayInstanceId: identity.relayInstanceId,
            buildVersion: core.buildVersion,
            encodeUtf8,
            localSecret: identity.secret,
            host: options.host,
            ...(options.pairingPort === undefined ? {} : { pairingPort: options.pairingPort }),
            // A getter, read at each invitation: see `entry` above. Without an entry
            // configuration (a test composition) the startup flag alone decides. The option is
            // optional, and the auth service reads an absent target as "none" (ENTRY_UNAVAILABLE);
            // a getter cannot be absent, so it reports undefined instead.
            get sshTarget(): string {
              return (entry ? entry.sshTarget : options.sshTarget) as string;
            },
            log: (event) => {
              try {
                log(JSON.stringify(event));
              } catch {
                // Logging is best effort.
              }
            },
          },
          persistence.auth,
        )
      : undefined;
  if (auth && !injected?.core) core.auth = auth;
  const arbiter = new ControlArbiter(runtime);
  // Worker health transitions are logged (issue #103): which worker, the new state and why.
  // Only the worker identity and the reason names are written, never terminal contents.
  const healthLog = injected?.core
    ? undefined
    : runtime.onWorkerHealth((worker, health) => {
        try {
          log(
            JSON.stringify({
              event: "worker-health",
              workerId: worker.workerId,
              state: health.state,
              reasons: health.reasons,
            }),
          );
        } catch {
          // Logging is best effort; it never affects the worker or its terminals.
        }
      });
  // A persistent store error (#144 item 4) is logged with the operation and SQLite code only:
  // retries stop at it, and background work such as a run cleanup has no one else to tell.
  const storeErrorLog = persistence?.store.onOperationError((operation, code) =>
    log(JSON.stringify({ event: "store-operation-failed", operation, code })),
  );
  const admission = new LocalAdmission(
    options,
    identity.secret,
    identity,
    budgets,
    composition.bytes,
    auth,
  );
  terminal = new TerminalWebSocket(admission, core, arbiter, clock.now, injected?.timer);
  const app = Fastify({
    logger: false,
    bodyLimit: budgets.rpcRequestBytes,
    requestTimeout: 5000,
    // Below the raw gate's header deadline (transport/raw-connections.ts), so an idle kept-alive
    // socket is ended by the HTTP server, which advertises this timeout to the client, rather
    // than cut by the gate while a client may be about to reuse it.
    keepAliveTimeout: 4000,
    // The top-level disableRequestLogging option is deprecated (FSTDEP023).
    logController: new LogController({ disableRequestLogging: true }),
  });
  // Every socket of the business listener, loopback and tsnet-forwarded, passes the raw gate
  // before the HTTP parser (#156).
  new RawConnectionGate().attach(app.server);
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
    auth,
    entry,
    disposeCore: () => {
      healthLog?.dispose();
      storeErrorLog?.();
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
    readonly category: "store" | "worker" | "listen" | "rendezvous" | "interrupted" | "git",
    readonly cleanup: "verified" | "unverifiable",
    // A safe description (no paths or secrets) of a store refusal, such as a data directory in
    // use by another server or a database schema newer than this build.
    readonly detail?: string,
  ) {
    super("Local entry startup unavailable");
    this.name = "LocalEntryStartupError";
  }
}

// A startup port flag collides with a stored port (both name the same port).
class EntryConfigurationError extends Error {
  constructor() {
    super(
      "The business and pairing ports would be the same port; change the entry configuration " +
        "(`cove server entry set`) or the startup flags",
    );
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
  // Cove does not run a Git older than 2.45 (git/run.ts MINIMUM_GIT). Every Git command enforces
  // that by itself, so this check adds no guarantee; it makes an unsupported Git a clear startup
  // failure, before the data directory is opened, instead of GIT_UNAVAILABLE on every request
  // that needs Git. The server's own PATH decides, as for its later commands.
  const git = await findGit();
  if (git.kind !== "supported")
    throw new LocalEntryStartupError("git", "verified", describeUnsupportedGit(git));
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
  const identity = { ...launchIdentity(), serverId: persistence.identity.serverId };
  try {
    await recordInstanceStart(store, identity.relayInstanceId, Date.now());
    const auth = await loadAuthState(store);
    // The fixed ports of the entry configuration (m2 D3), read once: a change applies at the next
    // start. A startup flag overrides the stored value (m0-local-options.ts).
    const entry = await store.call("entry.read", undefined);
    // How and why this instance started (S1, S2): the service manager named by the unit, and the
    // reason derived from the previous instance and the host boot. Recorded once, before
    // anything is served.
    const lastStart = await recordServiceStart(store, {
      home: persistence.layout.home,
      relayInstanceId: identity.relayInstanceId,
      manager: options.service ?? "foreground",
    });
    // Bounded crash restarts under launchd (service-state.ts CRASH_RESTART_BUDGET): checked
    // before recovery or any listener, so a server that crashes while starting stops the loop.
    await checkCrashRestartBudget(store, { manager: options.service ?? "foreground", lastStart });
    await clearCrashStop(persistence.layout.home);
    let configured: M0LocalOptions;
    try {
      configured = validateLocalOptions({
        ...options,
        ...(options.portFromEntryConfig && entry.businessPort !== null
          ? { port: entry.businessPort }
          : {}),
        ...(options.pairingPort === undefined && entry.pairingPort !== null
          ? { pairingPort: entry.pairingPort }
          : {}),
      });
    } catch {
      throw new EntryConfigurationError();
    }
    const local = createLocalApplication(configured, {
      identity,
      persistence: {
        store,
        home: persistence.layout.home,
        principalId: persistence.identity.principalId,
        ...(probe ? { probe } : {}),
        auth,
        entry,
        lastStart,
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
    if (error instanceof CrashRestartBudgetError) {
      // An orderly stop: recorded as one, so that the next start (a person's, or the next login)
      // is not taken for another crash restart. The record is written while this process still
      // holds the data directory, so a start that follows cannot be overtaken by it.
      await recordCrashStop(persistence.layout.home, error.crashRestarts).catch(() => undefined);
      await store
        .close([instanceStopCall(identity.relayInstanceId, Date.now())])
        .catch(() => undefined);
      throw error;
    }
    await store.close().catch(() => undefined);
    if (error instanceof RendezvousConflictError)
      throw new LocalEntryStartupError("rendezvous", "verified", error.message);
    if (error instanceof EntryConfigurationError)
      throw new LocalEntryStartupError("listen", "verified", error.message);
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
  // The entries (network/listeners.ts): loopback business port, pairing listener and tsnet node.
  const log = (event: Record<string, unknown>): void => {
    try {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    } catch {
      // Logging is best effort.
    }
  };
  // The tsnet node is the server.tsnet.* methods' service and the source of the invitations'
  // tsnet entry; the listener set starts and closes it in order with the other entries.
  const tsnet = new TsnetNode();
  local.core.tsnet = tsnet;
  local.auth?.advertiseTsnet((pairingPort) => tsnet.invitationEntry(pairingPort));
  const listeners = new ListenerSet({
    host: local.options.host,
    businessPort: local.options.port,
    business: local.app,
    ...(local.auth ? { pairing: local.auth } : {}),
    tsnetEntry: tsnet,
    tsnet: {
      home: local.options.home ?? "",
      hostname: local.entry?.initial.tsnetHostname ?? null,
      buildVersion: local.core.buildVersion,
      binary: tsnetBinaryPath(),
      log,
    },
    log,
  });
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
  // `orderly` records this instance's stop (instanceStopCall), which tells the next start that this
  // one did not crash (service-state.ts startReason). A startup that failed is not an orderly stop:
  // under launchd the next start must count as a crash restart, or a server failing after the
  // crash restart budget check (worker launch, listen, rendezvous) would be restarted every
  // ThrottleInterval without bound, each start looking like a login. A startup interrupted by a
  // stop signal is an orderly stop and is recorded as one.
  let closing: Promise<void> | undefined;
  const closeWith = (orderly: boolean): Promise<void> =>
    (closing ??= (async () => {
      let failed = false;
      try {
        await rendezvous.close();
      } catch {
        failed = true;
      }
      local.terminal.close();
      if (!(await listeners.close())) failed = true;
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
              ...(orderly ? [instanceStopCall(instance, Date.now())] : []),
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
  const close = (): Promise<void> => closeWith(true);
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
    // Binds the business port, then reopens the pairing listener when open invitations survived a
    // restart (m2 S12) and starts the tsnet entry. A pairing port or tsnet node that cannot start
    // is logged and leaves the business entry serving. Drain an in-flight listen/publication
    // before rollback: abandoning either promise on a signal could publish a listener/file after
    // cleanup completed.
    const businessPort = await listeners.start((port) => local.admission.bind(port));
    interrupted();
    local.entry?.bound({
      businessPort,
      pairingPort: local.options.pairingPort,
      tsnetHostname: local.entry.initial.tsnetHostname,
    });
    const endpoint = `http://${localAuthority(local.options.host, businessPort)}`;
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
      await closeWith(shutdown?.signal?.aborted === true);
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

// `cove-server --mode init --home DIR [--workspace-root DIR] [--business-port N --pairing-port N]`
// (D7): initializes the data directory, the persistent identity and optionally the first
// workspaceRoot while no server runs. It takes the same database lock as a server, so it is
// refused while one is running. The two ports are `cove server install`'s (m2 D3): they fix the
// business and pairing ports that are not configured yet and never replace a configured one;
// changing a port later is `cove server entry set` through the running server.
async function initializeHome(argv: readonly string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (
      !key ||
      value === undefined ||
      !["--mode", "--home", "--workspace-root", "--business-port", "--pairing-port"].includes(key)
    )
      throw new Error("Invalid init arguments");
    if (values.has(key)) throw new Error("Invalid init arguments");
    values.set(key, value);
  }
  const ports = [values.get("--business-port"), values.get("--pairing-port")];
  if (
    ports.filter((port) => port !== undefined).length === 1 ||
    ports.some(
      (port) =>
        port !== undefined &&
        (!/^[1-9][0-9]{3,4}$/.test(port) || !PortSchema.safeParse(Number(port)).success),
    ) ||
    (ports[0] !== undefined && ports[0] === ports[1])
  )
    throw new Error("Invalid init arguments");
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
    const entry =
      ports[0] !== undefined && ports[1] !== undefined
        ? await persistence.store.call("entry.initializePorts", {
            businessPort: Number(ports[0]),
            pairingPort: Number(ports[1]),
            at: Date.now(),
          })
        : await persistence.store.call("entry.read", undefined);
    const config = await sqliteConfigState(persistence.store).read();
    process.stdout.write(
      `${JSON.stringify({
        home: persistence.layout.home,
        serverId: persistence.identity.serverId,
        created: persistence.created,
        schemaVersion: persistence.store.schemaVersion,
        workspaceRoot: config.workspaceRoot ?? join(persistence.layout.home, "workspace"),
        entry: { businessPort: entry.businessPort, pairingPort: entry.pairingPort },
      })}\n`,
    );
  } finally {
    await persistence.store.close();
  }
}

// `cove-server --mode schema --home DIR` (m2 D1): the schema version committed in the data
// directory's database (0 when there is none yet) and the one this build migrates to and accepts.
// `cove server install --activate` runs it with the target build before switching to it. It reads
// the database files without opening them through SQLite (schema-version.ts), so it never changes
// the database and also answers while a server runs.
async function reportSchema(argv: readonly string[]): Promise<void> {
  if (argv.length !== 4 || argv[2] !== "--home" || !argv[3])
    throw new Error("Invalid schema arguments");
  const database = await committedSchemaVersion(homeLayout(resolve(argv[3])).databasePath);
  process.stdout.write(`${JSON.stringify({ database, supported: SCHEMA_VERSION })}\n`);
}

// The server process: `--mode init`, `--mode schema` or the local server. `probe` is passed only by the D6 probe
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
  } else if (argv[0] === "--mode" && argv[1] === "schema") {
    reportSchema(argv).catch((error: unknown) => fail(error, "cove-server schema unavailable\n"));
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
        // Exit status 0, which launchd's KeepAlive does not restart (service-state.ts).
        if (error instanceof CrashRestartBudgetError) {
          process.stderr.write(
            `${JSON.stringify({ event: "crash-restart-budget-exhausted", crashRestarts: error.crashRestarts })}\n` +
              `cove-server: ${error.message}\n`,
          );
          return;
        }
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
