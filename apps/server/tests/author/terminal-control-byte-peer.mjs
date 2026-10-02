import { M0_LIMITS } from "@cove/protocol/budgets";
import { encodePipeFrame, createPipeDecoder } from "@cove/protocol/pipe";
import { createTerminalDecoder } from "@cove/protocol/terminal";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";
import { TerminalConnectionDelivery } from "../../dist/terminal/terminal-connection-delivery.js";
import { TerminalCommandService } from "../../dist/terminal/terminal-command-service.js";
import { ControlArbiter } from "../../dist/terminal/control-arbiter.js";

export const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
export const run = { serverId: "server", relayInstanceId: "instance", runId: "run" };
export const worker = {
  serverId: "server",
  relayInstanceId: "instance",
  workerId: "worker",
  workerIncarnationId: "birth",
};
export const profile = "pragmatic-logical-grid-v1";
export const encoding = "vt-checkpoint-tail-v1";
export const geometry = { cols: 80, rows: 24 };
export function decode(bytes, pipe = false) {
  const read = (pipe ? createPipeDecoder() : createTerminalDecoder()).read(bytes);
  if (read.status === "error" || read.frames.length !== 1) throw new Error("Invalid fixture write");
  return {
    metadata: JSON.parse(codec.decode(read.frames[0].metadata)),
    payload: read.frames[0].payload,
  };
}
export function frame(metadata, payload = new Uint8Array()) {
  const kind = metadata.type === "terminal-event" ? 3 : metadata.type === "error" ? 4 : 2;
  const encoded = encodePipeFrame(kind, codec.encode(JSON.stringify(metadata)), payload);
  if (!encoded.ok) throw new Error("Invalid peer stimulus");
  return encoded.value;
}
export function coalesce(...frames) {
  const chunk = new Uint8Array(frames.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of frames) {
    chunk.set(item, offset);
    offset += item.length;
  }
  return chunk;
}
export function fixture(changes = {}, limits = {}) {
  const budgets = { ...M0_LIMITS, ...changes };
  const bytes = new RuntimeRetainedBytes(budgets.runtimeBytes, 2 * 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", budgets, bytes);
  const pipeWrites = [];
  const services = [];
  let now = 0;
  let id = 0;
  const pool = new WorkerPool(composition, 1, budgets.maxRuns);
  const registry = new RunRegistry(composition);
  const runtime = new LocalRuntime(pool, registry, codec.encode, (result) =>
    services.some((service) => service.handoff(result)),
  );
  const arbiter = new ControlArbiter(runtime);
  const session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "author",
    codec,
    transport: {
      write: (data, settled) => {
        pipeWrites.push({ data, settled });
        settled();
        return true;
      },
    },
    now: () => now,
    timeoutMs: 1000,
    identityLimit: 256,
  });
  runtime.addWorker(session);
  session.start();
  session.receive(
    frame({
      type: "ready",
      worker,
      pipeVersion: 2,
      effectiveBudgets: budgets,
      buildVersion: "peer",
    }),
  );
  runtime.reserveRun(run, geometry);
  function connect(name = "connection", connectionLimits = {}) {
    const connection = { connectionId: name, generation: 0 };
    const writes = [];
    let blocked = false;
    let onWrite;
    let service;
    const delivery = new TerminalConnectionDelivery(composition, {
      connection,
      encodeUtf8: codec.encode,
      itemLimit: connectionLimits.itemLimit ?? 128,
      transport: {
        write: (data, settled) => {
          writes.push({ data, settled });
          onWrite?.(data);
          return !blocked;
        },
      },
      failed: () => service?.close(),
    });
    service = new TerminalCommandService(composition, runtime, delivery, arbiter, {
      createOpaqueId: connectionLimits.createOpaqueId ?? (() => `id-${++id}`),
      now: () => now,
      identityLimit: connectionLimits.identityLimit ?? limits.identityLimit ?? 32,
      requestLimit: connectionLimits.requestLimit ?? limits.requestLimit ?? 128,
    });
    services.push(service);
    return {
      connection,
      delivery,
      service,
      writes,
      block: () => {
        blocked = true;
      },
      unblock: () => {
        blocked = false;
        delivery.drain();
      },
      onWrite: (callback) => {
        onWrite = callback;
      },
      attach: (requestId, resume) => ({
        type: "attach",
        run,
        requestId,
        connection,
        viewId: "view",
        profile,
        encoding,
        ...(resume === undefined
          ? {}
          : { resume: { appliedSeq: resume, profile, encoding, geometry } }),
      }),
    };
  }
  const latest = () => decode(pipeWrites.at(-1).data, true).metadata;
  function reply(command = latest(), changes = {}) {
    return frame({
      type: "result",
      worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      outcome: "accepted",
      ...changes,
    });
  }
  const event = (subscription, terminal, payload = new Uint8Array()) =>
    frame({ type: "terminal-event", worker, run, subscription, terminal }, payload);
  const output = (subscription, seq, payload = new Uint8Array([65])) =>
    event(subscription, { type: "output", run, seq }, payload);
  async function attach(connection, resume = 0, requestId = "attach") {
    const pending = connection.service.handle(
      connection.attach(requestId, resume === null ? undefined : resume),
    );
    const command = latest();
    session.receive(
      reply(command, { recoveryMode: resume === null ? "baseline" : "replay", atSeq: resume ?? 0 }),
    );
    return await pending;
  }
  async function dispose() {
    for (const service of services) service.close();
    arbiter.dispose();
    runtime.dispose();
    session.transportReleased();
    for (let index = 0; index < 15; index++) await Promise.resolve();
    for (const service of services) service.subscriptions.delivery.transportReleased();
  }
  return {
    arbiter,
    budgets,
    composition,
    bytes,
    runtime,
    session,
    pipeWrites,
    connect,
    latest,
    reply,
    event,
    output,
    attach,
    dispose,
    clock: (value) => {
      now = value;
    },
  };
}
export function baseline(subscription, atSeq, chunks = 1, total = chunks) {
  return {
    baselineId: "baseline",
    run,
    subscription,
    profile,
    encoding,
    checkpointSeq: atSeq,
    atSeq,
    captureGeometry: geometry,
    currentGeometry: geometry,
    coverage: {
      normal: {
        historyLines: 0,
        includedHistoryLines: 0,
        trimmedBefore: false,
        resizeContext: "complete",
      },
      alternate: { included: true, resizeContext: "complete" },
    },
    vtBytes: total,
    tailBytes: 0,
    chunkCount: chunks,
  };
}
