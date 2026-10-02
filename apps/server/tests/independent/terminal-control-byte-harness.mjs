import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { M0_LIMITS, validateEffectiveBudgets } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, PROFILE, DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { PIPE_VERSION } from "@cove/protocol/pipe";
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
import { TerminalCommandService } from "../../dist/terminal/terminal-command-service.js";
import { ControlArbiter } from "../../dist/terminal/control-arbiter.js";
import {
  baseline,
  bytes,
  carrier,
  concatenate,
  decodeFrames,
  deferred,
  geometry,
  ids,
  pipeFrame,
  resume,
  run,
  turns,
  worker,
} from "./subscription-byte-harness.mjs";

export { bytes, carrier, decodeFrames, deferred, geometry, ids, resume, run, turns, worker };
export const binary = Uint8Array.from([0, 1, 65, 27, 91, 54, 110, 10, 255]);
export const holder = (ref) => ({
  connection: ref.connection,
  viewId: ref.viewId,
  subscriptionId: ref.subscriptionId,
});
export function readyOracle({ installed, applied, grant, fact, inputReady, inputWrites }) {
  const ready =
    installed &&
    applied >= grant.atSeq &&
    fact.epoch === grant.epoch &&
    JSON.stringify(fact.holder) === JSON.stringify(grant.holder);
  assert.equal(inputReady, ready, "premature readiness");
  if (!ready) assert.equal(inputWrites, 0, "premature input");
}
export function releaseOracle(command, current) {
  assert.deepEqual(command.owner, current.holder, "foreign release holder");
  assert.equal(command.expectedEpoch, current.epoch, "obsolete release epoch");
  assert.equal(command.nextEpoch, current.epoch, "release advances epoch");
  assert.deepEqual(command.geometry, current.geometry, "release loses last grid");
  assert.equal(command.holder, null);
}
export function onceOracle(writes, identity) {
  assert.equal(writes.filter((x) => x.identity === identity).length, 1, "input replay");
}
export function grantOracle(result, command, minimumSeq) {
  assert.equal(result.type, "focus-result");
  assert.equal(result.requestId, command.requestId);
  assert.equal(result.epoch, command.nextEpoch);
  assert(Number.isSafeInteger(result.atSeq) && result.atSeq >= minimumSeq, "missing grant atSeq");
}
export function backingOracle({ retained, backing, physicallyReleased }) {
  if (!physicallyReleased) assert(retained >= backing + 256, "premature backing release");
}

export function controlFixture({
  budgets: changes = {},
  requestLimit = 512,
  identityLimit = 64,
  pipeHold = false,
  pipeWritable = true,
  createOpaqueId,
} = {}) {
  const budgets = validateEffectiveBudgets({ ...M0_LIMITS, ...changes });
  assert(budgets);
  const account = new RuntimeRetainedBytes(
    Math.min(budgets.runtimeBytes, 16 * 1024 * 1024),
    SESSION_CONTROL_RESERVE,
  );
  const composition = new RuntimeComposition(ids.serverId, ids.relayInstanceId, budgets, account);
  let now = 0,
    nextId = 0;
  const commands = [],
    pipeWrites = [],
    connections = [],
    clients = [];
  const processedAcks = new Set();
  const session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "b2-independent",
    transport: {
      write(encoded, settled) {
        const frames = decodeFrames(encoded, true);
        commands.push(...frames.map((x) => x.metadata));
        pipeWrites.push({ encoded, frames, settled, released: !pipeHold });
        if (!pipeHold) settled();
        return pipeWritable;
      },
    },
    codec: { encode: bytes, decode: (b) => new TextDecoder("utf-8", { fatal: true }).decode(b) },
    now: () => now,
    timeoutMs: 30_000,
    identityLimit: 4096,
  });
  const pool = new WorkerPool(composition, 1, 16),
    registry = new RunRegistry(composition);
  const runtime = new LocalRuntime(pool, registry, bytes, (result) =>
    connections.some((c) => c.service.handoff(result)),
  );
  assert(runtime.addWorker(session));
  assert(session.start());
  session.receive(
    pipeFrame({
      type: "ready",
      worker,
      pipeVersion: PIPE_VERSION,
      effectiveBudgets: budgets,
      buildVersion: "independent-byte-worker",
    }),
  );
  assert(session.ready);
  assert.deepEqual(runtime.reserveRun(run, geometry), worker);
  const arbiter = new ControlArbiter(runtime);
  const rig = {
    account,
    composition,
    runtime,
    session,
    arbiter,
    commands,
    pipeWrites,
    connections,
    clients,
    processedAcks,
    requestId: () => `b2-ind-${++nextId}`,
    addConnection(
      connection = { connectionId: `b2-connection-${connections.length}`, generation: 1 },
      transport = carrier(),
      limits = {},
    ) {
      const delivery = new TerminalConnectionDelivery(composition, {
        connection,
        transport,
        encodeUtf8: bytes,
        itemLimit: 128,
      });
      const service = new TerminalCommandService(composition, runtime, delivery, arbiter, {
        createOpaqueId: createOpaqueId ?? (() => `b2-owned-${++nextId}`),
        now: () => now,
        requestLimit: limits.requestLimit ?? requestLimit,
        identityLimit: limits.identityLimit ?? identityLimit,
      });
      const c = { connection, service, delivery, transport };
      connections.push(c);
      return c;
    },
    command(type, ref, extra = {}) {
      return { type, requestId: this.requestId(), run: ref.run, subscription: ref, ...extra };
    },
    last(type) {
      const c = commands.findLast((x) => x.type === type);
      assert(c, `missing ${type}`);
      return c;
    },
    count(type) {
      return commands.filter((x) => x.type === type).length;
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
    accept(command, fields = {}, events = []) {
      session.receive(concatenate(pipeFrame(this.result(command, fields)), ...events));
    },
    status(
      command = this.last("status"),
      { epoch = 5, atSeq = 10, currentHolder = null, grid = geometry } = {},
    ) {
      this.accept(command, {
        runStatus: {
          run,
          status: "live",
          geometry: grid,
          controlEpoch: epoch,
          controlHolder: currentHolder,
          receivedSeq: atSeq,
          parsedSeq: atSeq,
          recovery: "ready",
          exitCode: null,
          signal: null,
        },
      });
    },
    event(ref, terminal, payload = new Uint8Array()) {
      return pipeFrame(
        { type: "terminal-event", worker, run, subscription: ref, terminal },
        payload,
      );
    },
    control(ref, epoch, seq, grid = geometry, currentHolder = holder(ref)) {
      const encoded = this.event(ref, {
        type: "control",
        run,
        seq,
        epoch,
        holder: currentHolder,
        geometry: grid,
      });
      session.receive(encoded);
      return encoded;
    },
    async attach(
      c = connections[0],
      { mode = "replay", atSeq = 10, appliedSeq = atSeq, viewId = `b2-view-${nextId}` } = {},
    ) {
      const command = {
        type: "attach",
        requestId: this.requestId(),
        run,
        connection: c.connection,
        viewId,
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
        ...(mode === "replay" ? { resume: resume(appliedSeq) } : {}),
      };
      const pending = c.service.handle(command);
      await turns();
      const pipe = this.last("subscribe");
      this.accept(pipe, { recoveryMode: mode, atSeq });
      const reply = await pending;
      assert.equal(reply.type, "attach-result");
      await turns();
      return reply.subscription;
    },
    emitBaseline(ref, options = { atSeq: 10 }) {
      for (const item of baseline(ref, options))
        session.receive(this.event(ref, item.terminal, item.payload));
    },
    async ack(c, ref, seq) {
      const pending = c.service.handle(this.command("applied-ack", ref, { appliedSeq: seq }));
      await turns();
      this.accept(this.last("applied-ack"));
      return await pending;
    },
    async focus(
      c,
      ref,
      { focusSeq = 1, grid = geometry, atSeq = 11, initialEpoch = 5, appearance } = {},
    ) {
      const start = commands.length;
      const external = this.command("focus", ref, {
        focusSeq,
        geometry: grid,
        ...(appearance ? { appearance } : {}),
      });
      const pending = c.service.handle(external);
      await turns();
      const status = commands.slice(start).find((x) => x.type === "status");
      if (status) {
        this.status(status, { epoch: initialEpoch });
        await turns();
      }
      const pipe = commands.slice(start).find((x) => x.type === "set-control");
      assert(pipe, "focus dispatch missing");
      this.accept(pipe, { atSeq });
      const reply = await pending;
      await turns();
      return { external, pipe, reply };
    },
    inputFrames() {
      return pipeWrites.flatMap((w) => w.frames).filter((x) => x.metadata.type === "input");
    },
    setPipeWritable(value) {
      pipeWritable = value;
    },
    advance(ms) {
      now += ms;
      session.tick();
      for (const c of connections) c.service.tick();
      arbiter.tick();
    },
    async stop() {
      for (const client of clients) client.dispose();
      for (const c of connections) c.service.close();
      arbiter.dispose();
      runtime.dispose();
      session.transportReleased();
      for (const c of connections) c.delivery.transportReleased();
      await turns(100);
      assert.equal(account.snapshot().total, 0, "independent rig retained task ownership");
    },
  };
  rig.primary = rig.addConnection();
  return rig;
}
export async function withControl(exercise, options) {
  const rig = controlFixture(options);
  try {
    await exercise(rig);
  } finally {
    await rig.stop();
  }
}

export function controlledView() {
  const applied = [],
    controls = {},
    listeners = {},
    notices = [];
  const view = {
    initialize: async () => {},
    beginBaseline: async () => {},
    async writeBaselineChunk() {
      await controls.chunk?.promise;
    },
    async finishBaseline() {
      await controls.finish?.promise;
    },
    async applyEvent(event) {
      applied.push(event);
      await controls.event?.promise;
    },
    measureGrid: () => geometry,
    setAppearance() {},
    setVisibility() {},
    onInputIntent(fn) {
      listeners.input = fn;
      return {
        dispose() {
          delete listeners.input;
        },
      };
    },
    onFocusIntent(fn) {
      listeners.focus = fn;
      return {
        dispose() {
          delete listeners.focus;
        },
      };
    },
    onFailure: () => ({ dispose() {} }),
    dispose() {
      for (const gate of Object.values(controls)) gate.resolve();
    },
  };
  return { view, applied, controls, listeners, notices };
}
export async function connectConsumer(rig, c = rig.primary) {
  const manifestUrl = new URL("../../../../packages/client/package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  const { createClient } = await import(new URL(manifest.exports["."].import, manifestUrl).href);
  let callbacks,
    id = 0;
  const uplink = [],
    processed = rig.processedAcks;
  const bootstrap = (terminal) => ({
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...ids,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "b2-independent",
    capabilities: [...M0_CAPABILITIES],
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: rig.composition.budgets,
    ...(terminal ? { connection: c.connection } : {}),
  });
  c.transport.onWrite = (entry) => callbacks.onBinary(entry.encoded);
  const client = createClient({
    expectedServerId: ids.serverId,
    expectedRelayInstanceId: ids.relayInstanceId,
    buildVersion: "b2-client",
    credentials: () => ({ authorization: "Bearer independent", terminalSecret: "z".repeat(43) }),
    codec: {
      encode: bytes,
      decodeFatal: (b) => new TextDecoder("utf-8", { fatal: true }).decode(b),
    },
    createOpaqueId: () => `b2-client-${c.connection.connectionId}-${++id}`,
    scheduler: { nowMs: () => 0, setTimer: () => ({ dispose() {} }), yieldTurn: async () => {} },
    http: {
      post(_request, sink) {
        queueMicrotask(() =>
          sink.onResponse({
            status: 200,
            headers: {},
            body: bytes(JSON.stringify(bootstrap(false))),
          }),
        );
        return { cancel: () => "not-sent" };
      },
    },
    terminal: {
      open(sink) {
        callbacks = sink;
        sink.onOpen({
          send(message) {
            if (typeof message === "string") sink.onText(bytes(JSON.stringify(bootstrap(true))));
            else
              for (const frame of decodeFrames(message)) {
                uplink.push(frame);
                void c.service.handle(frame.metadata, frame.payload);
              }
            return "handed-off";
          },
          close() {},
          dispose() {},
        });
        return { cancel: () => "not-sent" };
      },
    },
  });
  rig.clients.push(client);
  assert((await client.connect()).ok);
  const controlled = controlledView();
  const opened = client.openTerminal({
    run,
    viewId: `consumer-${c.connection.connectionId}`,
    view: controlled.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  assert(opened.ok);
  const controller = opened.value;
  return {
    client,
    controller,
    controlled,
    uplink,
    c,
    async drainAcks() {
      for (let pass = 0; pass < 12; pass++) {
        await turns();
        const pending = rig.commands.filter(
          (x) =>
            ["baseline-progress", "applied-ack"].includes(x.type) && !processed.has(x.requestId),
        );
        if (!pending.length) return;
        for (const x of pending) {
          processed.add(x.requestId);
          rig.accept(x);
        }
      }
      throw new Error("client ACK mechanics did not settle");
    },
    async baseline() {
      const pending = controller.attach();
      await turns();
      const pipe = rig.last("subscribe");
      rig.accept(pipe, { recoveryMode: "baseline", atSeq: 10 });
      rig.emitBaseline(pipe.subscription);
      await this.drainAcks();
      assert((await pending).ok);
      await turns();
      return pipe.subscription;
    },
    async focus({ grid = geometry, atSeq = 11, apply = true } = {}) {
      controller.setInputTarget(true, true);
      const start = rig.commands.length;
      const pending = controller.requestFocus(grid);
      await turns();
      const status = rig.commands.slice(start).find((x) => x.type === "status");
      if (status) {
        rig.status(status);
        await turns();
      }
      const pipe = rig.commands.slice(start).find((x) => x.type === "set-control");
      assert(pipe);
      rig.accept(pipe, { atSeq });
      const reply = await pending;
      if (apply) {
        rig.control(this.ref, pipe.nextEpoch, atSeq, grid);
        await this.drainAcks();
      }
      return { pending, reply, pipe };
    },
    set ref(value) {
      this._ref = value;
    },
    get ref() {
      return this._ref;
    },
  };
}
