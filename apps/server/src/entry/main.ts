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

export async function startLocalEntry(input: M0LocalOptions) {
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
      const receipt = await worker.close();
      local.disposeCore();
      if (failed || receipt.status !== "exited")
        throw new Error("Local entry cleanup unverifiable");
    })());
  try {
    local.clock.start();
    worker.start();
    await worker.ready;
    await local.app.listen({ host: local.options.host, port: local.options.port });
    const bound = local.app.server.address();
    if (!bound || typeof bound === "string" || bound.address !== local.options.host)
      throw new Error("Invalid numeric local bind");
    local.admission.bind(bound.port);
    const endpoint = `http://${localAuthority(local.options.host, bound.port)}`;
    await rendezvous.publish({ bootstrapVersion: 1, ...local.identity, endpoint });
    return { endpoint, close };
  } catch {
    try {
      await close();
    } catch {
      /* Cleanup uncertainty remains a failed startup. */
    }
    throw new Error("Local entry startup unavailable");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    const server = await startLocalEntry(parseLocalOptions(process.argv.slice(2)));
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close().catch(() => {
        process.exitCode = 1;
        process.stderr.write("m0-local cleanup unverifiable\n");
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })().catch(() => {
    process.exitCode = 1;
    process.stderr.write("m0-local startup unavailable\n");
  });
}
