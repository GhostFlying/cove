import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { negotiateBootstrap } from "@cove/protocol/bootstrap";
import { PROFILE, BASELINE_ENCODING } from "@cove/protocol/profile";
import { domainError } from "@cove/protocol/errors";
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
  carrier,
  clocks,
  codec,
  decodeBytes,
  pipeBytes,
  recordRow,
  turns,
  utf8,
  joinBytes,
} from "./preview-byte-harness.mjs";

const clientPackage = new URL("../../../../packages/client/package.json", import.meta.url);
const publicExport = JSON.parse(readFileSync(clientPackage, "utf8")).exports["."].import;
const { createClient } = await import(new URL(publicExport, clientPackage).href);
const geometry = { cols: 80, rows: 24 };
const vt = utf8("\u001b[32mclient-预览\u001b[0m");
function fixture() {
  const clock = clocks();
  const account = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, SESSION_CONTROL_RESERVE);
  const composition = new RuntimeComposition("qa-server", "qa-instance", M0_LIMITS, account);
  const pool = new WorkerPool(composition, 1, 128);
  const registry = new RunRegistry(composition);
  const services = [];
  const runtime = new LocalRuntime(
    pool,
    registry,
    utf8,
    (result) => services.some((s) => s.handoff(result)),
    {
      now: clock.now,
      wallNow: clock.wallNow,
      cadenceMs: 100,
      staggerMs: 5,
      expiryMs: 50,
      waiterLimit: 3,
      identityLimit: 256,
    },
  );
  const worker = {
    serverId: "qa-server",
    relayInstanceId: "qa-instance",
    workerId: "worker",
    workerIncarnationId: "incarnation",
  };
  const pipeReads = [];
  const ledgerSamples = [];
  const workerPort = carrier();
  const session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "qa",
    transport: workerPort,
    codec,
    now: clock.now,
    timeoutMs: 1000,
    identityLimit: 4096,
    contactLost: (ref) => registry.contactLost(ref),
  });
  assert.equal(session.start(), true);
  session.receive(
    pipeBytes({
      type: "ready",
      worker,
      pipeVersion: 2,
      buildVersion: "qa",
      effectiveBudgets: M0_LIMITS,
    }),
  );
  assert.ok(runtime.addWorker(session));
  const run = { serverId: "qa-server", relayInstanceId: "qa-instance", runId: "run" };
  assert.ok(runtime.reserveRun(run, geometry));
  let authority = { controlEpoch: 0, controlHolder: null };
  const status = (seq) => ({
    run,
    status: "live",
    geometry,
    ...authority,
    receivedSeq: seq,
    parsedSeq: seq,
    recovery: "ready",
    exitCode: null,
    signal: null,
  });
  registry.observe(worker, status(1));
  const arbiter = new ControlArbiter(runtime);
  const peers = [];
  const f = {
    clock,
    account,
    composition,
    pool,
    registry,
    runtime,
    worker,
    workerPort,
    session,
    run,
    status,
    arbiter,
    peers,
    setAuthority(controlEpoch, controlHolder) {
      authority = { controlEpoch, controlHolder };
    },
    commands() {
      return workerPort
        .decoded()
        .map((frame) => frame.metadata)
        .filter((m) => m.type !== "hello");
    },
    latest(type) {
      return f
        .commands()
        .filter((m) => m.type === type)
        .at(-1);
    },
    result(command, fields = {}) {
      return {
        type: "result",
        worker,
        run: command.run,
        requestId: command.requestId,
        commandType: command.type,
        outcome: "accepted",
        ...fields,
      };
    },
    send(metadata, payload) {
      const bytes = pipeBytes(metadata, payload);
      pipeReads.push(Buffer.from(bytes).toString("base64"));
      ledgerSamples.push(account.snapshot());
      session.receive(bytes);
      ledgerSamples.push(account.snapshot());
    },
    async statusReply(seq) {
      await turns();
      const command = f.latest("status");
      assert.ok(command);
      f.send(f.result(command, { runStatus: status(seq) }));
      await turns();
    },
    async transfer(seq = 1, payload = vt, defect) {
      const command = f.latest("preview-refresh");
      assert.ok(command);
      const common = { run, previewId: "worker-preview-" + command.requestId, version: seq };
      const events = [
        {
          type: "preview-start",
          ...common,
          atSeq: seq,
          geometry,
          generatedAtMs: 900,
          vtBytes: payload.length,
          chunkCount: 1,
        },
        { type: "preview-chunk", ...common, ordinal: 0 },
        { type: "preview-end", ...common, totalBytes: payload.length, atSeq: seq },
      ];
      for (let i = 0; i < events.length; i++)
        if (defect !== "missing-end" || i !== 2)
          f.send(
            { type: "terminal-event", worker, run, terminal: events[i] },
            i === 1 ? payload : undefined,
          );
      if (defect !== "held-result") f.send(f.result(command, { previewVersion: seq }));
      await turns();
    },
    async seed(seq = 1) {
      const pending = runtime.previews.refresh(run);
      await f.statusReply(seq);
      await f.transfer(seq);
      assert.equal((await pending).ok, true);
      await turns();
    },
    peer(options = {}) {
      const connection = { connectionId: "client-connection-" + peers.length, generation: 1 };
      let callbacks;
      let id = 0;
      const uplink = [];
      const port = carrier({ hold: options.hold, writable: options.writable });
      const delivery = new TerminalConnectionDelivery(composition, {
        connection,
        transport: port,
        encodeUtf8: utf8,
        itemLimit: 32,
      });
      const service = new TerminalCommandService(composition, runtime, delivery, arbiter, {
        createOpaqueId: () => "server-id" + ++id,
        now: clock.now,
        identityLimit: 256,
        requestLimit: 256,
      });
      services.push(service);
      const pendingServices = [];
      const serverInfo = {
        serverId: "qa-server",
        relayInstanceId: "qa-instance",
        buildVersion: "qa",
        effectiveBudgets: M0_LIMITS,
      };
      port.write = (bytes, callback) => {
        const entry = { bytes: new Uint8Array(bytes), callback };
        port.writes.push(entry);
        if (!options.manual && callbacks) {
          if (options.split) {
            const fragments = [bytes.slice(0, 7), bytes.slice(7)];
            entry.transportFragments = fragments.map((b) => b.length);
            callbacks.onBinary(joinBytes(fragments));
          } else callbacks.onBinary(new Uint8Array(bytes));
        }
        options.onWrite?.(entry, service, delivery, callbacks);
        if (!options.hold) callback();
        return options.writable !== false;
      };
      const client = createClient({
        expectedServerId: "qa-server",
        expectedRelayInstanceId: "qa-instance",
        buildVersion: "qa-client",
        credentials: () => ({ authorization: "qa-authorization", terminalSecret: "q".repeat(43) }),
        codec: { encode: utf8, decodeFatal: codec.decode },
        createOpaqueId: () => "client-id" + ++id,
        scheduler: clock,
        http: {
          post(request, sink) {
            assert.equal(request.path, "/bootstrap");
            const reply = negotiateBootstrap(JSON.parse(codec.decode(request.body)), serverInfo);
            assert.equal(reply.type, "cove-bootstrap-result");
            sink.onResponse({ status: 200, headers: {}, body: utf8(JSON.stringify(reply)) });
            return { cancel: () => "handed-off" };
          },
        },
        terminal: {
          open(sink) {
            callbacks = sink;
            const native = {
              send(message) {
                if (typeof message === "string") {
                  const reply = negotiateBootstrap(JSON.parse(message), serverInfo, connection);
                  queueMicrotask(() => sink.onText(utf8(JSON.stringify(reply))));
                } else {
                  for (const frame of decodeBytes(message, "terminal")) {
                    uplink.push(frame);
                    pendingServices.push(
                      service.handle(frame.metadata, new Uint8Array(frame.payload)),
                    );
                  }
                }
                return "handed-off";
              },
              close() {
                service.close();
                delivery.close();
                sink.onClose();
              },
              dispose() {},
            };
            sink.onOpen(native);
            return { cancel: () => "handed-off" };
          },
        },
      });
      const peer = {
        client,
        service,
        delivery,
        port,
        uplink,
        pendingServices,
        callbacks: () => callbacks,
        close() {
          service.close();
          delivery.close();
          callbacks?.onClose();
        },
        flush() {
          for (const entry of port.writes) callbacks.onBinary(new Uint8Array(entry.bytes));
        },
      };
      peers.push(peer);
      return peer;
    },
    effects() {
      return {
        rawPipeReadsBase64: pipeReads,
        ledgerSamples,
        observedPeakTotal: Math.max(0, ...ledgerSamples.map((s) => s.total)),
        externalBytesBase64: peers.map((p) =>
          p.port.writes.map((w) => Buffer.from(w.bytes).toString("base64")),
        ),
        commands: f.commands(),
        ledger: account.snapshot(),
        cache: runtime.previews.cache.getRecord(run),
        peers: peers.map((p) => ({
          uplink: p.uplink,
          downlink: p.port.decoded("terminal"),
          delivery: p.delivery.snapshot(),
          client: p.client.snapshot(),
        })),
      };
    },
    async dispose() {
      for (const peer of peers) {
        peer.client.dispose();
        peer.service.close();
        peer.delivery.close();
        peer.port.settle();
        peer.delivery.transportReleased();
      }
      arbiter.dispose();
      runtime.dispose();
      session.loseContact();
      session.transportReleased();
      registry.dispose();
      pool.dispose();
      await turns();
      assert.equal(account.snapshot().total, 0);
    },
  };
  return f;
}
async function connected(f, options) {
  const peer = f.peer(options);
  assert.equal((await peer.client.connect()).ok, true);
  return peer;
}
function noEffects(f) {
  assert.ok(f.commands().every((m) => ["status", "preview-refresh"].includes(m.type)));
  for (const peer of f.peers) assert.ok(peer.uplink.every((m) => m.metadata.type === "preview"));
}
async function rows(prefix, definitions) {
  const failures = [];
  for (const [suffix, run] of definitions) {
    const id = prefix + "/" + suffix;
    const f = fixture();
    let effects;
    try {
      await run(f);
      effects = f.effects();
      await f.dispose();
      recordRow(id, "passed", { ...effects, finalLedger: f.account.snapshot() });
    } catch (error) {
      effects ??= f.effects();
      try {
        await f.dispose();
      } catch (cleanup) {
        effects.cleanupFailure = String(cleanup);
      }
      recordRow(id, "failed", { ...effects, error: String(error), stack: error.stack });
      failures.push(id + ": " + error.message);
    }
  }
  assert.deepEqual(failures, [], "independent compiled-client rows failed");
}
async function transferOutcome(f, peer, knownVersion, seq = 1, defect) {
  const pending = peer.client.getPreview(f.run, knownVersion);
  await f.statusReply(seq);
  if (f.latest("preview-refresh") && f.runtime.previews.snapshot().active)
    await f.transfer(seq, vt, defect);
  return pending;
}
function exact(outcome) {
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "transfer");
  assert.deepEqual(Array.from(outcome.bytes), Array.from(vt));
  assert.deepEqual(outcome.geometry, geometry);
  assert.equal(outcome.atSeq, outcome.version);
}

test("CC-01 compiled client receives server preview without subscription", async () => {
  await rows("CC-01", [
    [
      "V1",
      async (f) => {
        const p = await connected(f);
        exact(await transferOutcome(f, p));
        noEffects(f);
      },
    ],
    [
      "M1",
      async (f) => {
        const p = await connected(f, { split: true });
        exact(await transferOutcome(f, p));
        noEffects(f);
      },
    ],
    [
      "M2",
      async (f) => {
        const p = await connected(f);
        let settled = false;
        const pending = p.client.getPreview(f.run).then((result) => {
          settled = true;
          return result;
        });
        await f.statusReply(1);
        await f.transfer(1, vt, "held-result");
        assert.equal(settled, false);
        const command = f.latest("preview-refresh");
        f.send(f.result(command, { previewVersion: 1 }));
        exact(await pending);
        noEffects(f);
      },
    ],
  ]);
});

test("CC-02 compiled client receives valid unchanged and changed outcomes", async () => {
  const defs = [];
  for (const id of ["V1", "V2", "M1", "M2", "M3"])
    defs.push([
      id,
      async (f) => {
        const p = await connected(f);
        if (id === "M2") {
          const pending = p.client.getPreview(f.run, 1);
          await f.statusReply(1);
          assert.equal(f.latest("preview-refresh").knownVersion, undefined);
          await f.transfer();
          exact(await pending);
          noEffects(f);
          return;
        }
        if (id === "M3") {
          const promise = p.service.handle({
            type: "preview",
            requestId: "shared-external",
            run: f.run,
          });
          await turns();
          const duplicate = await p.service.handle({
            type: "preview",
            requestId: "shared-external",
            run: f.run,
          });
          assert.equal(duplicate.type, "error");
          assert.equal(duplicate.error.kind, "COUNTER_EXHAUSTED");
          p.close();
          await promise;
          return;
        }
        await f.seed(2);
        const pending = p.client.getPreview(f.run, id === "V1" ? 2 : 1);
        await f.statusReply(2);
        const outcome = await pending;
        if (id === "V1") {
          assert.deepEqual(outcome, { ok: true, status: "unchanged", version: 2 });
          assert.equal(p.port.decoded("terminal").length, 1);
        } else {
          exact(outcome);
          if (id === "M1") {
            await turns();
            const next = p.client.getPreview(f.run, 1);
            await f.statusReply(2);
            exact(await next);
            const ids = p.port
              .decoded("terminal")
              .filter((e) => e.metadata.type === "preview-start")
              .map((e) => e.metadata.previewId);
            assert.equal(ids.length, 2);
            assert.equal(new Set(ids).size, 2);
          }
        }
        noEffects(f);
      },
    ]);
  await rows("CC-02", defs);
});

test("CC-03 compiled client preserves uncertain preview boundaries", async () => {
  const defs = [];
  for (const id of ["V1", "M1", "M2", "M3", "M4", "M5"])
    defs.push([
      id,
      async (f) => {
        const p = await connected(f, id === "M4" ? { hold: true, manual: true } : undefined);
        if (id === "V1") {
          exact(await transferOutcome(f, p));
          return;
        }
        if (id === "M5") {
          exact(await transferOutcome(f, p));
          await turns();
          const late = p.port.writes.map((entry) => entry.bytes);
          const pending = p.client.getPreview(f.run, 0);
          for (const bytes of late) p.callbacks().onBinary(new Uint8Array(bytes));
          await f.statusReply(1);
          exact(await pending);
          return;
        }
        const pending = p.client.getPreview(f.run);
        await f.statusReply(1);
        if (id === "M1") await f.transfer(1, vt, "missing-end");
        if (id === "M2") {
          const command = f.latest("preview-refresh");
          f.send({
            type: "error",
            worker: f.worker,
            run: f.run,
            requestId: command.requestId,
            commandType: command.type,
            error: domainError("RECOVERY_UNAVAILABLE"),
          });
        }
        if (id === "M3") {
          f.clock.set(50);
          f.runtime.tickPreviews();
          await turns();
        }
        if (id === "M4") {
          await f.transfer();
          const debt = p.delivery.snapshot().physicalBytes;
          assert.ok(debt > 0);
          p.close();
          assert.equal(p.delivery.snapshot().physicalBytes, debt);
        }
        const outcome = await pending;
        assert.equal(outcome.ok, false);
        assert.ok(!("bytes" in outcome));
        if (id === "M3") {
          await f.transfer();
          assert.equal(p.client.snapshot().status, "connected");
        }
        if (id === "M4") {
          const status = p.client.snapshot().status;
          p.flush();
          assert.equal(p.client.snapshot().status, status);
          p.port.settle();
          assert.equal(p.delivery.snapshot().physicalBytes, 0);
        }
      },
    ]);
  await rows("CC-03", defs);
});

test("CC-04 preview isolation preserves active controller and peer", async () => {
  const defs = [];
  for (const id of ["V1", "M1", "M2", "M3", "M4"])
    defs.push([
      id,
      async (f) => {
        const a = await connected(f);
        const b = await connected(f, { hold: id !== "V1", writable: id !== "M2" });
        const view = {
          initialize: async () => {},
          beginBaseline: async () => {},
          writeBaselineChunk: async () => {},
          finishBaseline: async () => {},
          applyEvent: async () => {},
          measureGrid: () => geometry,
          setAppearance() {},
          setVisibility() {},
          onInputIntent: () => ({ dispose() {} }),
          onFocusIntent: () => ({ dispose() {} }),
          onFailure: () => ({ dispose() {} }),
          dispose() {},
        };
        const opened = a.client.openTerminal({
          run: f.run,
          viewId: "view",
          view,
          initialAppearance: { palette: [] },
        });
        assert.equal(opened.ok, true);
        const controller = opened.value;
        const attach = controller.attach();
        await turns();
        const subscribe = f.latest("subscribe");
        assert.ok(subscribe);
        f.send(f.result(subscribe, { recoveryMode: "baseline", atSeq: 1 }));
        await turns();
        const subscription = subscribe.subscription;
        const descriptor = {
          baselineId: "controller-baseline",
          run: f.run,
          subscription,
          profile: PROFILE,
          encoding: BASELINE_ENCODING,
          checkpointSeq: 1,
          atSeq: 1,
          captureGeometry: geometry,
          currentGeometry: geometry,
          control: { epoch: 0, holder: null },
          coverage: {
            normal: {
              historyLines: 0,
              includedHistoryLines: 0,
              trimmedBefore: false,
              resizeContext: "complete",
            },
            alternate: { included: true, resizeContext: "complete" },
          },
          vtBytes: 1,
          tailBytes: 0,
          chunkCount: 1,
        };
        for (const [terminal, payload] of [
          [{ type: "baseline-start", run: f.run, descriptor }, undefined],
          [
            {
              type: "baseline-chunk",
              run: f.run,
              baselineId: descriptor.baselineId,
              subscription,
              ordinal: 0,
            },
            utf8("A"),
          ],
          [
            {
              type: "baseline-end",
              run: f.run,
              baselineId: descriptor.baselineId,
              subscription,
              chunkCount: 1,
              totalBytes: 1,
              atSeq: 1,
            },
            undefined,
          ],
        ]) {
          f.send(
            { type: "terminal-event", worker: f.worker, run: f.run, subscription, terminal },
            payload,
          );
          await turns();
          for (const command of f
            .commands()
            .filter((m) => ["baseline-progress", "applied-ack"].includes(m.type))) {
            if (!f.progressReplies) f.progressReplies = new Set();
            if (!f.progressReplies.has(command.requestId)) {
              f.progressReplies.add(command.requestId);
              f.send(f.result(command));
            }
          }
        }
        assert.equal((await attach).ok, true);
        controller.setInputTarget(true, true);
        const focus = controller.requestFocus();
        await f.statusReply(1);
        const set = f.latest("set-control");
        assert.ok(set);
        f.send({
          type: "terminal-event",
          worker: f.worker,
          run: f.run,
          subscription,
          terminal: {
            type: "control",
            run: f.run,
            seq: 2,
            epoch: set.nextEpoch,
            holder: set.holder,
            geometry,
          },
        });
        f.send(f.result(set, { atSeq: 2 }));
        assert.equal((await focus).ok, true);
        await turns();
        for (const command of f
          .commands()
          .filter((m) => m.type === "applied-ack" && !f.progressReplies.has(m.requestId))) {
          f.progressReplies.add(command.requestId);
          f.send(f.result(command));
        }
        await turns();
        assert.equal(controller.snapshot().inputReady, true);
        const controllerBefore = controller.snapshot();
        f.setAuthority(set.nextEpoch, set.holder);
        const installed = { subscription };
        const before = a.service.snapshot(installed.subscription.subscriptionId).route;
        const pending = b.client.getPreview(f.run);
        await f.statusReply(2);
        await f.transfer(2);
        if (id === "M2") {
          assert.equal(b.port.writes.length, 1);
          for (let drain = 0; drain < 4 && b.delivery.snapshot().queued; drain++)
            b.delivery.drain();
        }
        exact(await pending);
        const after = a.service.snapshot(installed.subscription.subscriptionId).route;
        assert.deepEqual(after, before);
        assert.equal(f.commands().filter((m) => m.type === "set-control").length, 1);
        assert.equal(f.commands().filter((m) => m.type === "stop").length, 0);
        assert.deepEqual(controller.snapshot(), controllerBefore);
        const other = { ...f.run, runId: "healthy-other" };
        assert.ok(f.runtime.reserveRun(other, geometry));
        const command = {
          type: "status",
          worker: f.worker,
          run: other,
          requestId: "healthy-other-status",
        };
        const healthy = f.runtime.getStatus(command);
        f.send(f.result(command, { runStatus: { ...f.status(1), run: other } }));
        assert.equal((await healthy).outcome, "accepted");
        if (id === "M2") {
          const input = controller.sendInput({ source: "keyboard", bytes: utf8("x") });
          await turns();
          const command = f.latest("input");
          assert.ok(command);
          f.send(f.result(command, { inputSeq: command.inputSeq, writtenBytes: 1 }));
          await turns();
          assert.equal((await input).ok, true);
        }
        if (id !== "V1") {
          const physical = b.delivery.snapshot().physicalBytes;
          b.close();
          assert.ok(physical > 0);
          assert.equal(b.delivery.snapshot().physicalBytes, physical);
          if (id === "M4") {
            const original = b.port.writes[0].callback;
            b.port.writes[0].callback = () => {
              b.close();
              b.close();
              original();
            };
          }
          b.port.settle();
          const total = f.account.snapshot().total;
          b.port.settle();
          assert.equal(f.account.snapshot().total, total);
          assert.deepEqual(a.service.snapshot(installed.subscription.subscriptionId).route, before);
        }
        if (id === "M3") {
          assert.equal(
            a.uplink.find((e) => e.metadata.type === "attach").metadata.requestId,
            b.uplink.find((e) => e.metadata.type === "preview").metadata.requestId,
          );
        }
      },
    ]);
  await rows("CC-04", defs);
});
