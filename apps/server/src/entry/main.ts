#!/usr/bin/env node
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
import { SESSION_CONTROL_RESERVE } from "../terminal/worker-pipe-session.js";
import { WorkerProcess, type WorkerSpawn } from "../terminal/worker-process.js";
import { LocalRuntimeClock, type LocalTimer } from "../terminal/local-runtime-clock.js";
import { LocalAdmission } from "../transport/local-admission.js";
import { TerminalWebSocket, registerTerminalWebSocket } from "../transport/terminal-websocket.js";
import { encodeUtf8, registerHttpRpc, type LocalCore } from "../transport/http-rpc.js";
import { launchIdentity, LocalRendezvous } from "./local-rendezvous.js";
import {
  localAuthority,
  parseLocalOptions,
  validateLocalOptions,
  type M0LocalOptions,
} from "./m0-local-options.js";

export function createLocalApplication(
  input: M0LocalOptions,
  injected?: {
    identity?: ReturnType<typeof launchIdentity>;
    budgets?: EffectiveBudgets;
    core?: LocalCore;
    monotonic?: () => number;
    timer?: LocalTimer;
    workerSpawn?: WorkerSpawn;
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
  const runtime =
    injected?.core?.runtime ??
    new LocalRuntime(
      pool,
      new RunRegistry(composition),
      encodeUtf8,
      (result) => [...(terminal?.services ?? [])].some((service) => service.handoff(result)),
      { now: clock.now, wallNow: Date.now },
    );
  const receipts = injected?.core ? undefined : new OperationReceipts(composition, encodeUtf8);
  const core: LocalCore = injected?.core ?? {
    runtime,
    operations: new TerminalOperations({ composition, runtime, receipts: receipts!, encodeUtf8 }),
    buildVersion: "0.0.0",
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
    disableRequestLogging: true,
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
    readonly category: "worker" | "listen" | "rendezvous" | "interrupted",
    readonly cleanup: "verified" | "unverifiable",
  ) {
    super("Local entry startup unavailable");
    this.name = "LocalEntryStartupError";
  }
}

export async function startLocalEntry(input: M0LocalOptions, shutdown?: { signal?: AbortSignal }) {
  const local = createLocalApplication(input);
  const rendezvous = new LocalRendezvous(local.options.rendezvousPath);
  const worker = local.createWorker();
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
    return { endpoint, close };
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
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    const controller = new AbortController();
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
      void close().catch(() => {
        process.exitCode = 1;
        process.stderr.write("m0-local cleanup unverifiable\n");
      });
    };
    // Latch signals before parsing or acquiring any startup resources. Keep the
    // handlers through cleanup so a repeated signal cannot bypass retirement.
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
      server = await startLocalEntry(parseLocalOptions(process.argv.slice(2)), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) await close();
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
  })().catch(() => {
    process.exitCode = 1;
    process.stderr.write("m0-local startup unavailable\n");
  });
}
