import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { negotiateBootstrap } from "@cove/protocol/bootstrap";
import { createPipeDecoder, validatePipeFrame } from "@cove/protocol/pipe";
import { createTerminalDecoder, validateTerminalFrame } from "@cove/protocol/terminal";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPool } from "../../dist/terminal/worker-pool.js";
import { RunRegistry } from "../../dist/terminal/run-registry.js";
import { LocalRuntime } from "../../dist/terminal/local-runtime.js";
import {
  WorkerPipeSession,
  SESSION_CONTROL_RESERVE,
} from "../../dist/terminal/worker-pipe-session.js";
import { ControlArbiter } from "../../dist/terminal/control-arbiter.js";
import { TerminalCommandService } from "../../dist/terminal/terminal-command-service.js";
import { TerminalConnectionDelivery } from "../../dist/terminal/terminal-connection-delivery.js";
import {
  budgets,
  clock,
  deferred,
  endpointRig,
  record,
  run,
  turns,
  untilTurn,
  utf8,
  worker,
} from "../../../../packages/terminal-worker/tests/independent/current-recovery-ports.mjs";

const clientPackage = new URL("../../../../packages/client/package.json", import.meta.url);
const clientExport = JSON.parse(readFileSync(clientPackage, "utf8")).exports["."].import;
const { createClient } = await import(new URL(clientExport, clientPackage).href);
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export const geometry = { cols: 12, rows: 4 };
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function frames(raw, lane = "pipe", connection) {
  const parsed = (lane === "pipe" ? createPipeDecoder() : createTerminalDecoder()).read(raw);
  assert.notEqual(parsed.status, "error");
  return parsed.frames.map((frame) => {
    const metadata = JSON.parse(decode(frame.metadata));
    assert(
      (lane === "pipe"
        ? validatePipeFrame(frame, metadata)
        : validateTerminalFrame(frame, metadata, connection)
      ).ok,
    );
    return { metadata, payload: frame.payload };
  });
}
export function controlledView() {
  const facts = [];
  const controls = {};
  return {
    facts,
    controls,
    view: {
      async initialize(value) {
        facts.push({ type: "initialize", value });
      },
      async beginBaseline(descriptor) {
        facts.push({ type: "begin", descriptor: structuredClone(descriptor) });
      },
      async writeBaselineChunk(payload) {
        facts.push({ type: "chunk", bytes: payload.length, sha256: hash(payload) });
        await controls.chunk?.promise;
      },
      async finishBaseline() {
        facts.push({ type: "finish" });
        await controls.finish?.promise;
      },
      async applyEvent(event, payload) {
        facts.push({
          type: "event",
          event: structuredClone(event),
          bytes: payload?.length,
          sha256: payload ? hash(payload) : undefined,
        });
        await controls.event?.promise;
      },
      measureGrid: () => geometry,
      setAppearance() {},
      setVisibility() {},
      onInputIntent: () => ({ dispose() {} }),
      onFocusIntent: () => ({ dispose() {} }),
      onFailure: () => ({ dispose() {} }),
      dispose() {
        facts.push({ type: "dispose" });
      },
    },
  };
}

export async function currentWorkerLink(patch = {}) {
  const effective = budgets(patch);
  const time = clock();
  let observationOrdinal = 0;
  let passiveSnapshot = () => ({ localNow: time.now(), diagnosticWall: 1000 + time.now() });
  const capture = (phase, value = {}) =>
    record("consumer-observation", {
      ordinal: ++observationOrdinal,
      ...structuredClone(value),
      phase,
      ...(value.phase ? { eventPhase: value.phase } : {}),
      state: structuredClone(passiveSnapshot()),
    });
  const endpoint = endpointRig(patch, {
    externalHello: true,
    executionObserver: (event) => capture("worker-execution", event),
  });
  const account = new RuntimeRetainedBytes(effective.runtimeBytes, SESSION_CONTROL_RESERVE);
  const leaseEvents = [];
  const live = new Map();
  const originalReserve = account.reserve.bind(account);
  let leaseId = 0;
  account.reserve = (bytes, control = false) => {
    const actual = originalReserve(bytes, control);
    if (!actual) {
      leaseEvents.push({ phase: "denied", bytes, control });
      return actual;
    }
    const id = ++leaseId;
    live.set(id, { id, bytes, control });
    leaseEvents.push({ phase: "acquire", id, bytes, control });
    return {
      bytes,
      release() {
        if (!live.has(id)) return;
        live.delete(id);
        leaseEvents.push({ phase: "release", id, bytes, control });
        actual.release();
      },
    };
  };
  const composition = new RuntimeComposition(
    worker.serverId,
    worker.relayInstanceId,
    effective,
    account,
  );
  const pool = new WorkerPool(composition, 1, effective.maxRuns);
  const registry = new RunRegistry(composition);
  const services = [];
  const runtime = new LocalRuntime(
    pool,
    registry,
    utf8,
    (result) => services.some((service) => service.handoff(result)),
    {
      now: time.now,
      wallNow: () => 1000 + time.now(),
      cadenceMs: 100,
      staggerMs: 5,
      expiryMs: Math.min(50, effective.recoveryDeadlineMs),
      waiterLimit: Math.min(3, effective.pendingWorkerCommands),
      identityLimit: 256,
    },
  );
  let observedPreviewOwner;
  const previewsGetter = Object.getOwnPropertyDescriptor(LocalRuntime.prototype, "previews").get;
  Object.defineProperty(runtime, "previews", {
    get() {
      const actual = previewsGetter.call(this);
      if (!observedPreviewOwner) {
        observedPreviewOwner = actual;
        const originalCommit = actual.cache.commit;
        actual.cache.commit = function (picture, owned) {
          const input = {
            picture,
            ownedVT: {
              bytes: owned.vt.length,
              sha256: hash(owned.vt),
              rawHex: Buffer.from(owned.vt).toString("hex"),
            },
          };
          capture("cache-commit-before", input);
          try {
            const result = originalCommit.call(this, picture, owned);
            capture("cache-commit-returned", { ...input, result });
            return result;
          } catch (error) {
            capture("cache-commit-threw", {
              ...input,
              error: { name: error.name, message: error.message },
            });
            throw error;
          }
        };
      }
      return actual;
    },
  });
  const commands = [];
  const received = [];
  const mutations = [];
  const pendingReads = new Set();
  let mutation;
  let heldEnd;
  let heldMarker;
  let session;
  const receive = (owned) => {
    try {
      for (const frame of frames(owned.raw)) {
        assert(received.length < 512, "bounded byte-link trace");
        received.push({
          metadata: structuredClone(frame.metadata),
          bytes: frame.payload.length,
          sha256: hash(frame.payload),
          rawHex: Buffer.from(owned.raw).toString("hex"),
        });
      }
      capture("worker-receive-before", { rawHex: Buffer.from(owned.raw).toString("hex") });
      const consumed = session.receive(owned.raw);
      capture("worker-receive-returned", { consumed });
      if (!session.closed) assert.equal(consumed, owned.raw.length);
    } finally {
      owned.lease.release();
      pendingReads.delete(owned);
    }
  };
  endpoint.rawReader((raw) => {
    const lease = account.reserve(raw.length);
    assert(lease, "link copy lease acquired before copy");
    const owned = { raw: Uint8Array.from(raw), lease };
    pendingReads.add(owned);
    queueMicrotask(() => {
      const metadata = frames(owned.raw)[0].metadata;
      if (
        mutation?.startsWith("preview-") &&
        metadata.type === "terminal-event" &&
        metadata.terminal.type === "preview-end"
      ) {
        assert(!heldEnd);
        heldEnd = owned;
        return;
      }
      if (
        (mutation === "marker-removed" || mutation === "marker-reordered") &&
        metadata.type === "result" &&
        ["subscribe", "recover"].includes(metadata.commandType)
      ) {
        assert(!heldMarker);
        heldMarker = owned;
        return;
      }
      if (heldEnd && metadata.type === "result" && metadata.commandType === "preview-refresh") {
        const end = heldEnd;
        heldEnd = undefined;
        mutations.push({
          mutation,
          resultHex: Buffer.from(owned.raw).toString("hex"),
          endHex: Buffer.from(end.raw).toString("hex"),
        });
        if (mutation === "preview-coalesced") {
          const joinedLease = account.reserve(owned.raw.length + end.raw.length);
          assert(joinedLease);
          const joined = new Uint8Array(owned.raw.length + end.raw.length);
          joined.set(owned.raw);
          joined.set(end.raw, owned.raw.length);
          owned.lease.release();
          end.lease.release();
          pendingReads.delete(owned);
          pendingReads.delete(end);
          const item = { raw: joined, lease: joinedLease };
          pendingReads.add(item);
          receive(item);
        } else {
          receive(owned);
          receive(end);
        }
        return;
      }
      const baselineEnd =
        metadata.type === "terminal-event" && metadata.terminal.type === "baseline-end";
      receive(owned);
      if (baselineEnd && heldMarker && mutation === "marker-reordered") {
        const item = heldMarker;
        heldMarker = undefined;
        receive(item);
      }
    });
  });
  session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "current-link",
    transport: {
      write(raw, settled) {
        for (const frame of frames(raw)) {
          assert(commands.length < 256);
          commands.push(structuredClone(frame.metadata));
        }
        capture("worker-command-handoff", { rawHex: Buffer.from(raw).toString("hex") });
        return endpoint.input.write(raw, (error) => {
          capture("worker-command-callback-before", {
            error: error ? { name: error.name, message: error.message } : null,
          });
          settled(error ?? undefined);
          session.drain();
          capture("worker-command-callback-after");
        });
      },
    },
    codec: { encode: utf8, decode },
    now: time.now,
    timeoutMs: 1000,
    identityLimit: 4096,
    contactLost: (ref) => registry.contactLost(ref),
  });
  assert(session.start());
  await untilTurn(() => session.ready, "actual worker ready");
  assert(runtime.addWorker(session));
  const target = run("current-consumer");
  assert.deepEqual(runtime.reserveRun(target, geometry), worker);
  const spawned = await runtime.spawn({
    worker,
    run: target,
    requestId: "consumer-spawn",
    operationId: "consumer-spawn-operation",
    geometry,
    appearance: DEFAULT_APPEARANCE,
    effectiveBudgets: effective,
    profile: PROFILE,
    executable: "controlled-byte-writer",
    argv: [],
    cwd: process.cwd(),
  });
  assert.equal(spawned.outcome, "accepted");
  const arbiter = new ControlArbiter(runtime);
  const peers = [];
  const rig = {
    endpoint,
    account,
    composition,
    pool,
    registry,
    runtime,
    worker,
    run: target,
    session,
    arbiter,
    peers,
    commands,
    received,
    mutations,
    time,
    live,
    leaseEvents,
    capture,
    setMutation(value) {
      assert(!heldEnd && !heldMarker);
      mutation = value;
    },
    async emit(bytes) {
      endpoint.native.owners[0].emit(bytes);
      await turns(4);
    },
    async peer(options = {}) {
      const connection = { connectionId: `consumer-${peers.length}`, generation: 1 };
      const uplink = [];
      const downlink = [];
      const pending = [];
      const physical = new Set();
      let callbacks;
      let nextId = 0;
      const delivery = new TerminalConnectionDelivery(composition, {
        connection,
        encodeUtf8: utf8,
        itemLimit: 32,
        transport: {
          write(raw, settled) {
            assert(downlink.length < 512);
            downlink.push(
              ...frames(raw, "terminal", connection).map((frame) => ({
                metadata: structuredClone(frame.metadata),
                bytes: frame.payload.length,
                sha256: hash(frame.payload),
                rawHex: Buffer.from(raw).toString("hex"),
              })),
            );
            const item = { raw, settled };
            physical.add(item);
            capture("terminal-downlink-before", {
              connection,
              rawHex: Buffer.from(raw).toString("hex"),
            });
            callbacks.onBinary(raw);
            if (!options.hold) {
              physical.delete(item);
              settled();
              capture("terminal-downlink-settled", {
                connection,
                rawHex: Buffer.from(raw).toString("hex"),
              });
            }
            return options.writable !== false;
          },
        },
      });
      const service = new TerminalCommandService(composition, runtime, delivery, arbiter, {
        createOpaqueId: () => `consumer-server-${connection.connectionId}-${++nextId}`,
        now: time.now,
        identityLimit: 256,
        requestLimit: 256,
      });
      services.push(service);
      const server = {
        serverId: worker.serverId,
        relayInstanceId: worker.relayInstanceId,
        buildVersion: "current-server",
        effectiveBudgets: effective,
      };
      const client = createClient({
        expectedServerId: worker.serverId,
        expectedRelayInstanceId: worker.relayInstanceId,
        buildVersion: "current-client",
        credentials: () => ({
          authorization: "controlled-fixture",
          terminalSecret: "q".repeat(43),
        }),
        codec: { encode: utf8, decodeFatal: decode },
        createOpaqueId: () => `consumer-client-${connection.connectionId}-${++nextId}`,
        scheduler: {
          nowMs: time.now,
          setTimer(delay, callback) {
            const id = time.setTimeout(callback, delay);
            return { dispose: () => time.clearTimeout(id) };
          },
          yieldTurn: () => turns(1),
        },
        http: {
          post(request, sink) {
            assert.equal(request.path, "/bootstrap");
            const reply = negotiateBootstrap(JSON.parse(decode(request.body)), server);
            assert.equal(reply.type, "cove-bootstrap-result");
            sink.onResponse({ status: 200, headers: {}, body: utf8(JSON.stringify(reply)) });
            return { cancel: () => "handed-off" };
          },
        },
        terminal: {
          open(sink) {
            callbacks = sink;
            sink.onOpen({
              send(message) {
                if (typeof message === "string") {
                  const reply = negotiateBootstrap(JSON.parse(message), server, connection);
                  assert.equal(reply.type, "cove-bootstrap-result");
                  queueMicrotask(() => sink.onText(utf8(JSON.stringify(reply))));
                } else
                  for (const frame of frames(message, "terminal", connection)) {
                    assert(uplink.length < 256);
                    uplink.push({
                      metadata: structuredClone(frame.metadata),
                      bytes: frame.payload.length,
                      sha256: hash(frame.payload),
                      rawHex: Buffer.from(message).toString("hex"),
                      payloadHex: Buffer.from(frame.payload).toString("hex"),
                    });
                    capture("public-handle-before", {
                      connection,
                      command: frame.metadata,
                      payloadHex: Buffer.from(frame.payload).toString("hex"),
                    });
                    const actual = service.handle(frame.metadata, frame.payload);
                    pending.push(actual);
                    actual.then(
                      (result) =>
                        capture("public-handle-returned", {
                          connection,
                          command: frame.metadata,
                          result,
                          returnedUndefined: result === undefined,
                        }),
                      (error) =>
                        capture("public-handle-threw", {
                          connection,
                          command: frame.metadata,
                          error: { name: error.name, message: error.message },
                        }),
                    );
                  }
                return "handed-off";
              },
              close() {
                service.close();
                delivery.close();
                sink.onClose();
              },
              dispose() {},
            });
            return { cancel: () => "handed-off" };
          },
        },
      });
      const peer = {
        client,
        service,
        delivery,
        connection,
        uplink,
        downlink,
        pending,
        physical,
        async terminal(controlled = controlledView()) {
          const opened = client.openTerminal({
            run: target,
            viewId: `consumer-view-${connection.connectionId}`,
            view: controlled.view,
            initialAppearance: DEFAULT_APPEARANCE,
          });
          assert(opened.ok);
          return { controller: opened.value, controlled };
        },
        settle() {
          for (const item of [...physical]) {
            physical.delete(item);
            item.raw = undefined;
            item.settled();
          }
          delivery.drain();
        },
        close() {
          client.dispose();
          service.close();
          delivery.close();
        },
      };
      peers.push(peer);
      assert((await client.connect()).ok);
      return peer;
    },
    async close() {
      for (const peer of peers) {
        peer.close();
        peer.settle();
      }
      await endpoint.close();
      await turns(4);
      for (const item of [...pendingReads]) {
        item.lease.release();
        pendingReads.delete(item);
      }
      heldEnd = undefined;
      heldMarker = undefined;
      runtime.dispose();
      session.transportReleased();
      arbiter.dispose();
      await Promise.all(peers.flatMap((peer) => peer.pending));
      capture("cleanup-arbiter-before-completion", {
        arbiter: arbiter.snapshot(target.runId),
      });
      try {
        await untilTurn(() => {
          const actual = arbiter.snapshot(target.runId);
          return actual.runs === 0 && actual.pending === 0;
        }, "actual disposed control arbiter drain completion");
      } catch (error) {
        capture("cleanup-arbiter-completion-not-exercised", {
          arbiter: arbiter.snapshot(target.runId),
          error: { name: error.name, message: error.message },
        });
        throw error;
      }
      capture("cleanup-before-assertions", {
        arbiter: arbiter.snapshot(target.runId),
      });
      record("consumer-cleanup", {
        account: account.snapshot(),
        owners: [...live.values()],
        leases: leaseEvents,
        worker: endpoint.execution.snapshot(),
        native: endpoint.native.snapshot(),
      });
      assert.equal(account.snapshot().total, 0);
      assert.equal(live.size, 0);
    },
  };
  passiveSnapshot = () => ({
    effective,
    worker,
    run: target,
    localNow: time.now(),
    diagnosticWall: 1000 + time.now(),
    account: account.snapshot(),
    liveLeases: [...live.values()],
    leaseEvents,
    execution: endpoint.execution.snapshot(),
    native: endpoint.native.snapshot(),
    registry: registry.get(target),
    session: session.snapshot(),
    pipe: endpoint.pipe.snapshot(),
    pendingReadCopies: [...pendingReads].map((item) => ({
      bytes: item.raw.length,
      sha256: hash(item.raw),
    })),
    cache: observedPreviewOwner?.cache.snapshot(),
    cacheRecord: observedPreviewOwner?.cache.getRecord(target),
    refresh: observedPreviewOwner?.snapshot(),
    commands,
    received,
    peers: peers.map((peer) => ({
      connection: peer.connection,
      uplink: peer.uplink,
      downlink: peer.downlink,
      service: peer.service.snapshot(),
      delivery: peer.delivery.snapshot(),
      pendingCommands: peer.pending.length,
      physical: [...peer.physical].map((item) => ({
        bytes: item.raw.length,
        sha256: hash(item.raw),
        rawHex: Buffer.from(item.raw).toString("hex"),
      })),
    })),
  });
  return rig;
}
export async function withWorkerLink(exercise, patch) {
  const rig = await currentWorkerLink(patch);
  try {
    await exercise(rig);
  } finally {
    await rig.close();
  }
}
export { deferred, record, turns, untilTurn, utf8 };
