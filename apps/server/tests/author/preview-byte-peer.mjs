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
import { TerminalSubscriptions } from "../../dist/terminal/terminal-subscriptions.js";

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
export const geometry = { cols: 80, rows: 24 };
export function frame(metadata, payload = new Uint8Array()) {
  const encoded = encodePipeFrame(
    metadata.type === "terminal-event" ? 3 : metadata.type === "error" ? 4 : 2,
    codec.encode(JSON.stringify(metadata)),
    payload,
  );
  if (!encoded.ok) throw new Error("Unframable fixture stimulus");
  return encoded.value;
}
export function decode(bytes, pipe = true) {
  const read = (pipe ? createPipeDecoder() : createTerminalDecoder()).read(bytes);
  if (read.status === "error" || read.frames.length !== 1)
    throw new Error("Invalid observed bytes");
  return {
    metadata: JSON.parse(codec.decode(read.frames[0].metadata)),
    payload: read.frames[0].payload,
  };
}
export function coalesce(...parts) {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
export const pump = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
export function fixture(budgetChanges = {}, policyChanges = {}) {
  let now = 0;
  let wall = 100;
  let serial = 0;
  const budgets = { ...M0_LIMITS, ...budgetChanges };
  const bytes = new RuntimeRetainedBytes(budgets.runtimeBytes, 2 * 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", budgets, bytes);
  const pool = new WorkerPool(composition, 1, budgets.maxRuns);
  const registry = new RunRegistry(composition);
  const pipeWrites = [];
  const connections = [];
  const runtime = new LocalRuntime(
    pool,
    registry,
    codec.encode,
    (result) => connections.some((c) => c.service.handoff(result)),
    {
      now: () => now,
      wallNow: () => wall,
      cadenceMs: 1000,
      staggerMs: 50,
      expiryMs: 500,
      ...policyChanges,
    },
  );
  const session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "author",
    codec,
    now: () => now,
    timeoutMs: 1000,
    identityLimit: 256,
    transport: {
      write: (data, settled) => {
        pipeWrites.push({ data, settled });
        settled();
        return true;
      },
    },
  });
  runtime.addWorker(session);
  session.start();
  session.receive(
    frame({
      type: "ready",
      worker,
      pipeVersion: 2,
      buildVersion: "peer",
      effectiveBudgets: budgets,
    }),
  );
  runtime.reserveRun(run, geometry);
  const latest = () => decode(pipeWrites.at(-1).data).metadata;
  const commands = () =>
    pipeWrites.map((item) => decode(item.data).metadata).filter((m) => m.type !== "hello");
  const reply = (command = latest(), extra = {}) =>
    frame({
      type: "result",
      worker,
      run: command.run,
      requestId: command.requestId,
      commandType: command.type,
      outcome: "accepted",
      ...extra,
    });
  const status = (atSeq = 0, target = run, changes = {}) => ({
    run: target,
    status: "live",
    geometry,
    controlEpoch: 0,
    controlHolder: null,
    receivedSeq: atSeq,
    parsedSeq: atSeq,
    recovery: "ready",
    exitCode: null,
    signal: null,
    ...changes,
  });
  async function toPreview(pending, seq = 0, changes = {}) {
    await pump();
    const command = latest();
    if (command.type !== "status") throw new Error("Expected production status command");
    session.receive(reply(command, { runStatus: status(seq, command.run, changes) }));
    await pump();
    return { pending, command: latest() };
  }
  function transfer(command = latest(), data = new Uint8Array([65]), version = 1, overrides = {}) {
    const common = { run: command.run, previewId: "producer-" + ++serial, version };
    const terminal = (value, payload) =>
      frame({ type: "terminal-event", worker, run: command.run, terminal: value }, payload);
    return {
      start: terminal({
        type: "preview-start",
        ...common,
        atSeq: version,
        geometry,
        generatedAtMs: 20,
        vtBytes: data.length,
        chunkCount: 1,
        ...overrides,
      }),
      chunk: terminal({ type: "preview-chunk", ...common, ordinal: 0 }, data),
      end: terminal({ type: "preview-end", ...common, totalBytes: data.length, atSeq: version }),
      result: reply(command, { previewVersion: version }),
      common,
    };
  }
  async function capture(data = new Uint8Array([65]), version = 1, target = run) {
    const pending = runtime.previews.refresh(target);
    const { command } = await toPreview(pending, version - 1);
    const parts = transfer(command, data, version);
    session.receive(coalesce(parts.start, parts.chunk, parts.end, parts.result));
    const outcome = await pending;
    await pump();
    return outcome;
  }
  function connect(name = "connection", limits = {}) {
    const writes = [];
    let blocked = false;
    const delivery = new TerminalConnectionDelivery(composition, {
      connection: { connectionId: name, generation: 0 },
      encodeUtf8: codec.encode,
      itemLimit: limits.itemLimit ?? 128,
      transport: {
        write: (data, settled) => {
          writes.push({ data, settled });
          return !blocked;
        },
      },
    });
    const service = new TerminalSubscriptions(composition, runtime, delivery, {
      createOpaqueId: () => "opaque",
      now: () => now,
      identityLimit: 32,
      requestLimit: limits.requestLimit ?? 128,
    });
    const connection = {
      delivery,
      service,
      writes,
      block: () => {
        blocked = true;
      },
      drain: () => {
        blocked = false;
        delivery.drain();
      },
      events: () => writes.map((item) => decode(item.data, false)),
      preview: (requestId, knownVersion) =>
        service.handle({
          type: "preview",
          run,
          requestId,
          ...(knownVersion === undefined ? {} : { knownVersion }),
        }),
    };
    connections.push(connection);
    return connection;
  }
  async function dispose() {
    for (const connection of connections) connection.service.close();
    runtime.dispose();
    session.transportReleased();
    await pump();
    for (const connection of connections) connection.delivery.transportReleased();
    await pump();
  }
  return {
    runtime,
    session,
    registry,
    bytes,
    budgets,
    composition,
    pipeWrites,
    latest,
    commands,
    reply,
    status,
    transfer,
    capture,
    connect,
    toPreview,
    clock: (value) => {
      now = value;
    },
    wall: (value) => {
      wall = value;
    },
    dispose,
  };
}
