import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import { M0_LIMITS, validateEffectiveBudgets } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import { createPipeDecoder, encodePipeFrame, PIPE_VERSION } from "@cove/protocol/pipe";
import { createTerminalDecoder, HEADER_BYTES } from "@cove/protocol/terminal";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import {
  WorkerPipeSession,
  SESSION_CONTROL_RESERVE,
} from "../../dist/terminal/worker-pipe-session.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import { TerminalConnectionDelivery } from "../../dist/terminal/terminal-connection-delivery.js";
import { TerminalSubscriptions } from "../../dist/terminal/terminal-subscriptions.js";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });
export const ids = { serverId: "ind-server", relayInstanceId: "ind-relay" };
export const run = { ...ids, runId: "ind-run" };
export const worker = { ...ids, workerId: "ind-worker", workerIncarnationId: "ind-birth" };
export const geometry = { cols: 80, rows: 24 };
export const resume = (appliedSeq) => ({
  appliedSeq,
  profile: PROFILE,
  encoding: BASELINE_ENCODING,
  geometry,
});
export const bytes = (text) => encoder.encode(text);

export function decodeFrames(encoded, pipe = false) {
  const parser = pipe ? createPipeDecoder() : createTerminalDecoder();
  const read = parser.read(encoded);
  assert.equal(read.status, "need-input");
  assert.equal(parser.finish().ok, true);
  return read.frames.map((frame) => {
    const metadata = JSON.parse(decoder.decode(frame.metadata));
    const encodedBytes = HEADER_BYTES + frame.metadata.byteLength + frame.payload.byteLength;
    assert.equal(frame.metadata.byteLength, bytes(JSON.stringify(metadata)).byteLength);
    return { metadata, payload: frame.payload, encodedBytes, kind: frame.kind };
  });
}

export function pipeFrame(metadata, payload = new Uint8Array()) {
  const kind = metadata.type === "terminal-event" ? 3 : metadata.type === "error" ? 4 : 2;
  const framed = encodePipeFrame(kind, bytes(JSON.stringify(metadata)), payload);
  assert.equal(framed.ok, true);
  return framed.value;
}

export function concatenate(...chunks) {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export function carrier({ hold = false, writable = true, onWrite } = {}) {
  const writes = [];
  return {
    writes,
    hold,
    writable,
    onWrite,
    write(encoded, settled) {
      const entry = { encoded, settled, frames: decodeFrames(encoded), released: false };
      writes.push(entry);
      this.onWrite?.(entry);
      if (!this.hold) {
        entry.released = true;
        settled();
      }
      return this.writable;
    },
    release(index, error) {
      const entry = writes[index];
      entry.released = true;
      entry.settled(error);
    },
    trace() {
      return writes.flatMap((entry) => entry.frames);
    },
  };
}

export async function turns(count = 24) {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function assertMarkerBefore(trace, requestId, predicate) {
  const marker = trace.findIndex(
    ({ metadata }) =>
      (metadata.type === "attach-result" || metadata.type === "recover-result") &&
      metadata.requestId === requestId,
  );
  assert(marker >= 0, "missing accepted marker");
  const deliveries = trace
    .map((frame, index) => ({ ...frame, index }))
    .filter(({ metadata }) => predicate(metadata));
  assert(deliveries.length > 0, "missing discriminating delivery");
  assert(
    deliveries.every(({ index }) => index > marker),
    "delivery crossed accepted marker",
  );
}

export function assertExactCreditReturn(before, after, eligible) {
  assert.equal(
    before - after,
    eligible.reduce((total, frame) => total + frame.encodedBytes, 0),
    "credit exceeds parsed external boundaries",
  );
}

export function assertOwnedTrace(trace, subscription) {
  for (const { metadata } of trace) {
    const ref = metadata.subscription ?? metadata.descriptor?.subscription;
    if (ref) assert.deepEqual(ref, subscription, "foreign full-ref delivery");
  }
}

export function descriptor(
  subscription,
  { atSeq = 3, sizes = [3, 2], baselineId = "ind-baseline" } = {},
) {
  return {
    baselineId,
    run: subscription.run,
    subscription,
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
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
    vtBytes: sizes.reduce((sum, size) => sum + size, 0),
    tailBytes: 0,
    chunkCount: sizes.length,
  };
}

export function baseline(subscription, options = {}) {
  const data = descriptor(subscription, options);
  const sizes = options.sizes ?? [3, 2];
  return [
    { terminal: { type: "baseline-start", run: subscription.run, descriptor: data } },
    ...sizes.map((size, ordinal) => ({
      terminal: {
        type: "baseline-chunk",
        run: subscription.run,
        subscription,
        baselineId: data.baselineId,
        ordinal,
      },
      payload: new Uint8Array(size).fill(65 + ordinal),
    })),
    {
      terminal: {
        type: "baseline-end",
        run: subscription.run,
        subscription,
        baselineId: data.baselineId,
        chunkCount: sizes.length,
        totalBytes: data.vtBytes,
        atSeq: data.atSeq,
      },
    },
  ];
}

export function fixture({
  budgets: changes = {},
  identityLimit = 32,
  requestLimit = 256,
  itemLimit = 64,
  createOpaqueId,
  transport = carrier(),
  connection = { connectionId: "ind-connection", generation: 1 },
} = {}) {
  const budgets = validateEffectiveBudgets({ ...M0_LIMITS, ...changes });
  assert(budgets);
  const account = new RuntimeRetainedBytes(
    Math.min(budgets.runtimeBytes, 16 * 1024 * 1024),
    SESSION_CONTROL_RESERVE,
  );
  const composition = new RuntimeComposition(ids.serverId, ids.relayInstanceId, budgets, account);
  let now = 0;
  let nextId = 0;
  const commands = [];
  const services = [];
  const session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "ind-build",
    transport: {
      write(encoded, settled) {
        commands.push(...decodeFrames(encoded, true).map(({ metadata }) => metadata));
        settled();
        return true;
      },
    },
    codec: { encode: bytes, decode: (encoded) => decoder.decode(encoded) },
    now: () => now,
    timeoutMs: 30_000,
    identityLimit: 4096,
  });
  const pool = new WorkerPool(composition, 1, 16);
  const registry = new RunRegistry(composition);
  const runtime = new LocalRuntime(pool, registry, bytes, (result) =>
    services.some((service) => service.handoff(result)),
  );
  assert(runtime.addWorker(session));
  assert(session.start());
  session.receive(
    pipeFrame({
      type: "ready",
      worker,
      pipeVersion: PIPE_VERSION,
      effectiveBudgets: budgets,
      buildVersion: "ind-worker-build",
    }),
  );
  assert(session.ready);
  assert.deepEqual(runtime.reserveRun(run, geometry), worker);
  function addConnection(nextConnection, nextTransport = carrier(), limits = {}) {
    const delivery = new TerminalConnectionDelivery(composition, {
      connection: nextConnection,
      transport: nextTransport,
      encodeUtf8: bytes,
      itemLimit,
    });
    const service = new TerminalSubscriptions(composition, runtime, delivery, {
      createOpaqueId: createOpaqueId ?? (() => `ind-id-${++nextId}`),
      now: () => now,
      identityLimit: limits.identityLimit ?? identityLimit,
      requestLimit: limits.requestLimit ?? requestLimit,
    });
    services.push(service);
    return { service, delivery, transport: nextTransport, connection: nextConnection };
  }
  const primary = addConnection(connection, transport);
  const rig = {
    ...primary,
    composition,
    account,
    runtime,
    session,
    commands,
    addConnection,
    requestId: () => `ind-request-${++nextId}`,
    lastCommand(type) {
      const found = commands.findLast((command) => command.type === type);
      assert(found, `missing ${type}`);
      return found;
    },
    attachCommand({ offered = resume(3), viewId = "ind-view", ...rest } = {}) {
      return {
        type: "attach",
        requestId: this.requestId(),
        run,
        connection,
        viewId,
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
        ...(offered ? { resume: offered } : {}),
        ...rest,
      };
    },
    routeCommand(type, subscription, extra = {}) {
      return { type, requestId: this.requestId(), run: subscription.run, subscription, ...extra };
    },
    result(command, fields = {}) {
      return {
        type: "result",
        worker: command.worker,
        run: command.run,
        requestId: command.requestId,
        commandType: command.type,
        outcome: "accepted",
        ...fields,
      };
    },
    event(subscription, terminal, payload = new Uint8Array()) {
      return pipeFrame(
        { type: "terminal-event", worker, run: subscription.run, subscription, terminal },
        payload,
      );
    },
    output(subscription, seq, text = "x") {
      return this.event(subscription, { type: "output", run: subscription.run, seq }, bytes(text));
    },
    accept(command, fields = {}, events = []) {
      this.session.receive(concatenate(pipeFrame(this.result(command, fields)), ...events));
    },
    emitBaseline(subscription, options) {
      for (const item of baseline(subscription, options))
        this.session.receive(this.event(subscription, item.terminal, item.payload));
    },
    advance(ms) {
      now += ms;
    },
    async stop() {
      for (const service of services) service.close();
      runtime.dispose();
      session.transportReleased();
      for (const service of services) service.delivery.transportReleased();
      await turns();
      assert.equal(account.snapshot().total, 0, "fixture leaked managed ownership");
    },
  };
  return rig;
}

export async function attach(rig, { mode = "replay", atSeq = 3, ...options } = {}) {
  const command = rig.attachCommand(options);
  const promise = rig.service.handle(command);
  const pipe = rig.lastCommand("subscribe");
  rig.accept(pipe, { recoveryMode: mode, atSeq });
  const reply = await promise;
  assert.equal(reply.type, "attach-result");
  await turns();
  return { command, pipe, reply, subscription: reply.subscription };
}
