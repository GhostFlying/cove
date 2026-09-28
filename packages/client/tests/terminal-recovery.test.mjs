import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, test } from "vitest";
import { createClient } from "@cove/client";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createTerminalDecoder, encodeTerminalFrame } from "@cove/protocol/terminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ids = { serverId: "server-1", relayInstanceId: "instance-1" };
const run = { ...ids, runId: "run-1" };
const connection = { connectionId: "connection-1", generation: 1 };
const geometry = { cols: 80, rows: 24 };

function bootstrap(terminal = false, budgets = {}) {
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...ids,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "server-build",
    capabilities: [...M0_CAPABILITIES],
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: { ...M0_LIMITS, ...budgets },
    ...(terminal ? { connection } : {}),
  };
}

function frame(kind, metadata, payload = new Uint8Array()) {
  const encoded = encodeTerminalFrame(kind, encoder.encode(JSON.stringify(metadata)), payload);
  if (!encoded.ok) throw new Error("bad fixture frame");
  return encoded.value;
}

function readCommand(bytes) {
  const parser = createTerminalDecoder();
  const read = parser.read(bytes);
  expect(read.frames).toHaveLength(1);
  expect(parser.finish().ok).toBe(true);
  return JSON.parse(decoder.decode(read.frames[0].metadata));
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function clock() {
  let now = 0;
  const timers = new Set();
  return {
    nowMs: () => now,
    setTimer(delay, callback) {
      const timer = { deadline: now + delay, callback };
      timers.add(timer);
      return { dispose: () => timers.delete(timer) };
    },
    yieldTurn: async () => {},
    advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.deadline <= now && timers.delete(timer)) timer.callback();
      }
    },
  };
}

function view({ chunkGate, eventGate } = {}) {
  const facts = [];
  const listeners = new Set();
  const terminalView = {
    initialize: async (input) => {
      facts.push(["initialize", input.viewGeneration]);
    },
    beginBaseline: async (descriptor) => {
      facts.push(["begin", descriptor.atSeq]);
    },
    writeBaselineChunk: async (bytes) => {
      facts.push(["chunk", [...bytes]]);
      if (chunkGate) await chunkGate.promise;
    },
    finishBaseline: async () => {
      facts.push(["finish"]);
    },
    applyEvent: async (event, payload) => {
      facts.push(["event", event.seq, [...payload]]);
      if (eventGate) await eventGate.promise;
    },
    measureGrid: () => geometry,
    setAppearance: () => {},
    setVisibility: () => {},
    onInputIntent: () => ({ dispose() {} }),
    onFocusIntent: () => ({ dispose() {} }),
    onFailure: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: () => {
      facts.push(["dispose"]);
    },
  };
  return {
    terminalView,
    facts,
    fail: (error) => {
      for (const listener of [...listeners]) listener(error);
    },
  };
}

async function settle() {
  for (let index = 0; index < 15; index++) await Promise.resolve();
}

async function harness(onCommand = () => {}, schedulerOverride, budgets = {}, codecOverride) {
  let callbacks;
  let request = 0;
  const commands = [];
  const sentFrames = [];
  const peer = {
    emit(kind, metadata, payload) {
      callbacks.onBinary(frame(kind, metadata, payload));
    },
    raw(bytes) {
      callbacks.onBinary(bytes);
    },
    close() {
      callbacks.onClose();
    },
    commands,
    sentFrames,
    onCommand,
  };
  const http = {
    post(_request, cb) {
      queueMicrotask(() =>
        cb.onResponse({
          status: 200,
          headers: {},
          body: encoder.encode(JSON.stringify(bootstrap(false, budgets))),
        }),
      );
      return { cancel: () => "not-sent" };
    },
  };
  const terminal = {
    open(cb) {
      callbacks = cb;
      cb.onOpen({
        send(message) {
          if (typeof message === "string")
            cb.onText(encoder.encode(JSON.stringify(bootstrap(true, budgets))));
          else {
            const command = readCommand(message);
            commands.push(command);
            sentFrames.push({ command, bytes: message.byteLength });
            const disposition = peer.onCommand(command, peer);
            return disposition ?? "handed-off";
          }
          return "handed-off";
        },
        close() {},
        dispose() {},
      });
      return { cancel: () => "not-sent" };
    },
  };
  const client = createClient({
    expectedServerId: ids.serverId,
    expectedRelayInstanceId: ids.relayInstanceId,
    buildVersion: "client-build",
    credentials: () => ({
      authorization: "Bearer test",
      terminalSecret: "a".repeat(43),
    }),
    codec: codecOverride ?? {
      encode: (value) => encoder.encode(value),
      decodeFatal: (bytes) => decoder.decode(bytes),
    },
    createOpaqueId: () => `request-${++request}`,
    scheduler: schedulerOverride ?? {
      nowMs: () => 0,
      setTimer: () => ({ dispose() {} }),
      yieldTurn: async () => {},
    },
    http,
    terminal,
  });
  expect((await client.connect()).ok).toBe(true);
  return { client, peer };
}

function subscription(viewId, subscriptionId = `subscription-${viewId}`) {
  return { run, connection, viewId, subscriptionId };
}

function paddedId(prefix, index, length) {
  const stem = `${prefix}${index}-`;
  return stem + "x".repeat(length - stem.length);
}

function descriptor(ref, atSeq = 3) {
  return {
    baselineId: `baseline-${ref.viewId}`,
    run,
    subscription: ref,
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    checkpointSeq: 2,
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
    vtBytes: 3,
    tailBytes: 2,
    chunkCount: 2,
  };
}

function baseline(peer, ref) {
  const data = descriptor(ref);
  peer.emit(3, { type: "baseline-start", run, descriptor: data });
  peer.emit(
    3,
    { type: "baseline-chunk", run, subscription: ref, baselineId: data.baselineId, ordinal: 0 },
    new Uint8Array([27, 91, 72]),
  );
  peer.emit(
    3,
    { type: "baseline-chunk", run, subscription: ref, baselineId: data.baselineId, ordinal: 1 },
    new Uint8Array([27, 91]),
  );
  peer.emit(3, {
    type: "baseline-end",
    run,
    subscription: ref,
    baselineId: data.baselineId,
    chunkCount: 2,
    totalBytes: 5,
    atSeq: 3,
  });
}

function baselineTo(peer, ref, atSeq) {
  const data = descriptor(ref, atSeq);
  peer.emit(3, { type: "baseline-start", run, descriptor: data });
  peer.emit(
    3,
    { type: "baseline-chunk", run, subscription: ref, baselineId: data.baselineId, ordinal: 0 },
    new Uint8Array([27, 91, 72]),
  );
  peer.emit(
    3,
    { type: "baseline-chunk", run, subscription: ref, baselineId: data.baselineId, ordinal: 1 },
    new Uint8Array([27, 91]),
  );
  peer.emit(3, {
    type: "baseline-end",
    run,
    subscription: ref,
    baselineId: data.baselineId,
    chunkCount: 2,
    totalBytes: 5,
    atSeq,
  });
}

async function baselineStepped(peer, ref) {
  const data = descriptor(ref);
  peer.emit(3, { type: "baseline-start", run, descriptor: data });
  await settle();
  for (const [ordinal, bytes] of [
    [0, new Uint8Array([27, 91, 72])],
    [1, new Uint8Array([27, 91])],
  ]) {
    peer.emit(
      3,
      { type: "baseline-chunk", run, subscription: ref, baselineId: data.baselineId, ordinal },
      bytes,
    );
    await settle();
  }
  peer.emit(3, {
    type: "baseline-end",
    run,
    subscription: ref,
    baselineId: data.baselineId,
    chunkCount: 2,
    totalBytes: 5,
    atSeq: 3,
  });
}

function reply(command, peer, ref, mode = "baseline", atSeq = 3) {
  peer.emit(2, {
    type: `${command.type}-result`,
    requestId: command.requestId,
    run,
    subscription: ref,
    mode,
    atSeq,
  });
}

function settleControl(command, peer) {
  if (command.type === "applied-ack")
    peer.emit(2, {
      type: "applied-ack-result",
      requestId: command.requestId,
      run,
      subscription: command.subscription,
      appliedSeq: command.appliedSeq,
    });
  if (command.type === "baseline-progress")
    peer.emit(2, {
      type: "baseline-progress-result",
      requestId: command.requestId,
      run,
      subscription: command.subscription,
      baselineId: command.baselineId,
      lastParsedOrdinal: command.lastParsedOrdinal,
    });
}

describe("public terminal subscription and recovery", () => {
  test("fatal failure during listener registration cannot initialize a renderer", async () => {
    const rendered = view();
    let disposed = 0;
    rendered.terminalView.onFailure = (listener) => {
      listener(domainError("RECOVERY_UNAVAILABLE"));
      return {
        dispose() {
          disposed++;
        },
      };
    };
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const pending = controller.attach();
    peer.emit(3, { type: "baseline-start", run, descriptor: descriptor(subscription("view-1")) });
    expect((await pending).ok).toBe(false);
    await settle();
    expect(disposed).toBe(1);
    expect(
      rendered.facts.filter((fact) => ["initialize", "begin", "chunk", "finish"].includes(fact[0])),
    ).toEqual([]);
    expect(
      peer.commands.filter(
        (command) => command.type === "applied-ack" || command.type === "baseline-progress",
      ),
    ).toEqual([]);
    controller.dispose();
    client.dispose();
  });

  test("advisory failure during listener registration still permits baseline", async () => {
    const rendered = view();
    rendered.terminalView.onFailure = (listener) => {
      listener(domainError("INPUT_REJECTED"));
      return { dispose() {} };
    };
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const pending = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await pending).ok).toBe(true);
    expect(rendered.facts.filter((fact) => fact[0] === "initialize")).toHaveLength(1);
    controller.dispose();
    client.dispose();
  });

  test("old listener disposal reentry cannot register or initialize stale recovery", async () => {
    const rendered = view();
    let controller;
    let retireOnDispose = false;
    let disposals = 0;
    rendered.terminalView.onFailure = () => ({
      dispose() {
        disposals++;
        if (retireOnDispose) controller.dispose();
      },
    });
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const pending = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await pending).ok).toBe(true);
    retireOnDispose = true;
    const recovered = await controller.recover("expired");
    expect(recovered.ok).toBe(false);
    expect(controller.snapshot().phase).toBe("disposed");
    expect(peer.commands.filter((command) => command.type === "recover")).toEqual([]);
    expect(rendered.facts.filter((fact) => fact[0] === "initialize")).toHaveLength(1);
    expect(disposals).toBe(1);
    client.dispose();
  });
  test("consumes rejected and hostile observer thenables without waiting for them", async () => {
    const unhandled = [];
    const catchUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", catchUnhandled);
    let client;
    try {
      const setup = await harness((command, peer) => {
        if (command.type === "attach") reply(command, peer, subscription("view-1"));
        else settleControl(command, peer);
      });
      client = setup.client;
      const controller = client.openTerminal({
        run,
        viewId: "view-1",
        view: view().terminalView,
        initialAppearance: DEFAULT_APPEARANCE,
      }).value;
      controller.onState(() => Promise.reject(new Error("native rejection")));
      controller.onState(() => ({
        then(_resolve, reject) {
          reject(new Error("thenable rejection"));
          return Promise.reject(new Error("derived rejection"));
        },
      }));
      controller.onState(() =>
        Object.defineProperty({}, "then", {
          get() {
            throw new Error("then getter");
          },
        }),
      );
      controller.onState(() => new Promise(() => {}));
      controller.onState(() => {
        throw new Error("sync observer");
      });
      const attached = controller.attach();
      baseline(setup.peer, subscription("view-1"));
      expect((await attached).ok).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      controller.dispose();
    } finally {
      client?.dispose();
      process.off("unhandledRejection", catchUnhandled);
    }
  });
  test("revokes old connection before synchronous unavailable listeners can reenter", async () => {
    const rendered = view();
    let attachSerial = 0;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach")
        reply(command, peer, subscription("view-1", `subscription-${++attachSerial}`));
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const first = controller.attach();
    baseline(peer, subscription("view-1", "subscription-1"));
    expect((await first).ok).toBe(true);
    let reentered;
    controller.onState((snapshot) => {
      if (snapshot.phase !== "unavailable" || reentered) return;
      reentered = {
        attach: controller.attach(),
        open: client.openTerminal({
          run,
          viewId: "second",
          view: view().terminalView,
          initialAppearance: DEFAULT_APPEARANCE,
        }),
        reconnect: client.reconnect(),
      };
    });
    const before = peer.commands.length;
    peer.close();
    expect(peer.commands).toHaveLength(before);
    expect(await reentered.attach).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
    expect(reentered.open).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
    expect(await reentered.reconnect).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    expect(client.snapshot().status).toBe("unverifiable");
    expect((await client.reconnect()).ok).toBe(true);
    const second = controller.attach();
    baseline(peer, subscription("view-1", "subscription-2"));
    expect((await second).ok).toBe(true);
    controller.dispose();
    client.dispose();
  });

  test("accepted and unknown no-ref attach failures fence before unavailable observers", async () => {
    for (const initial of ["accepted", "unknown"]) {
      let mode = initial;
      const rendered = view();
      const { client, peer } = await harness((command, peer) => {
        if (command.type === "attach") {
          if (mode === "accepted")
            peer.emit(4, {
              type: "error",
              requestId: command.requestId,
              run,
              commandType: "attach",
              error: domainError("BUSY", "accepted"),
            });
          else if (mode === "unknown") return "unknown";
          else reply(command, peer, subscription("view-1"));
        } else settleControl(command, peer);
      });
      const controller = client.openTerminal({
        run,
        viewId: "view-1",
        view: rendered.terminalView,
        initialAppearance: DEFAULT_APPEARANCE,
      }).value;
      let reentered;
      controller.onState((snapshot) => {
        if (snapshot.phase !== "unavailable" || reentered) return;
        reentered = {
          attach: controller.attach(),
          open: client.openTerminal({
            run,
            viewId: "nested",
            view: view().terminalView,
            initialAppearance: DEFAULT_APPEARANCE,
          }),
        };
      });
      const failed = await controller.attach();
      expect(failed.ok).toBe(false);
      expect(peer.commands.filter((command) => command.type === "attach")).toHaveLength(1);
      expect(await reentered.attach).toMatchObject({
        ok: false,
        error: { reason: "invalid-state" },
      });
      expect(reentered.open).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
      expect(client.snapshot().status).toBe("unverifiable");
      mode = "success";
      expect((await client.reconnect()).ok).toBe(true);
      const next = controller.attach();
      baseline(peer, subscription("view-1"));
      expect((await next).ok).toBe(true);
      controller.dispose();
      client.dispose();
    }
  });

  test("accepted no-ref retirement fences before operation-timer disposal reentry", async () => {
    let controller;
    let client;
    let reentered;
    const scheduler = {
      nowMs: () => 0,
      setTimer(delay) {
        return {
          dispose() {
            if (delay !== M0_LIMITS.recoveryDeadlineMs || !controller || reentered) return;
            reentered = {
              status: client.snapshot().status,
              attach: controller.attach(),
              open: client.openTerminal({
                run,
                viewId: "nested",
                view: view().terminalView,
                initialAppearance: DEFAULT_APPEARANCE,
              }),
            };
          },
        };
      },
      yieldTurn: async () => {},
    };
    const setup = await harness((command, peer) => {
      if (command.type === "attach")
        peer.emit(4, {
          type: "error",
          requestId: command.requestId,
          run,
          commandType: "attach",
          error: domainError("BUSY", "accepted"),
        });
    }, scheduler);
    client = setup.client;
    controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    expect((await controller.attach()).ok).toBe(false);
    expect(setup.peer.commands.filter((command) => command.type === "attach")).toHaveLength(1);
    expect(reentered.status).toBe("unverifiable");
    expect((await reentered.attach).ok).toBe(false);
    expect(reentered.open).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
    controller.dispose();
    client.dispose();
  });

  test("accepted result with a retired ref fences before unavailable publication", async () => {
    const ref = subscription("view-1");
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, ref);
      else if (command.type === "detach")
        peer.emit(2, {
          type: "detach-result",
          requestId: command.requestId,
          run,
          subscription: ref,
          detached: true,
        });
      else settleControl(command, peer);
    });
    const first = client.openTerminal({
      run,
      viewId: "view-1",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const firstAttach = first.attach();
    baseline(peer, ref);
    expect((await firstAttach).ok).toBe(true);
    expect((await first.detach()).ok).toBe(true);
    first.dispose();
    const second = client.openTerminal({
      run,
      viewId: "view-1",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    let reentered;
    second.onState((snapshot) => {
      if (snapshot.phase !== "unavailable" || reentered) return;
      reentered = {
        attach: second.attach(),
        open: client.openTerminal({
          run,
          viewId: "nested",
          view: view().terminalView,
          initialAppearance: DEFAULT_APPEARANCE,
        }),
      };
    });
    expect((await second.attach()).ok).toBe(false);
    expect(peer.commands.filter((command) => command.type === "attach")).toHaveLength(2);
    expect(await reentered.attach).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
    expect(reentered.open).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
    expect(client.snapshot().status).toBe("unverifiable");
    second.dispose();
    client.dispose();
  });

  test("guards nested reconnect and dispose notifications before adapter cleanup", async () => {
    const rendered = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    const nested = [];
    controller.onState((snapshot) => {
      if (snapshot.phase === "unavailable") {
        nested.push({
          open: client.openTerminal({
            run,
            viewId: "nested",
            view: view().terminalView,
            initialAppearance: DEFAULT_APPEARANCE,
          }),
          reconnect: client.reconnect(),
        });
      }
    });
    const before = peer.commands.length;
    expect((await client.reconnect()).ok).toBe(true);
    expect(peer.commands).toHaveLength(before);
    expect(nested).toHaveLength(1);
    expect(nested[0].open).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
    expect(await nested[0].reconnect).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
    });
    client.dispose();
    expect(nested).toHaveLength(2);
    expect(nested[1].open).toMatchObject({ ok: false, error: { reason: "disposed" } });
    expect(await nested[1].reconnect).toMatchObject({ ok: false, error: { reason: "disposed" } });
  });

  test("same-stack local capacity refusal cannot retire a healthy connection", async () => {
    const refs = new Map();
    const { client, peer } = await harness(
      (command, peer) => {
        if (command.type === "attach") reply(command, peer, refs.get(command.viewId));
        else if (command.type !== "detach") settleControl(command, peer);
      },
      undefined,
      {
        subscriptionCreditBytes: 69_648,
        outboundConnectionBytes: 69_648,
        reservedControlBytes: 4_112,
      },
    );
    refs.set("healthy", subscription("healthy"));
    const healthy = client.openTerminal({
      run,
      viewId: "healthy",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const healthyAttach = healthy.attach();
    baseline(peer, refs.get("healthy"));
    expect((await healthyAttach).ok).toBe(true);
    await settle();

    let rejected;
    for (let index = 0; index < 255; index++) {
      const viewId = paddedId("v", index, 100);
      refs.set(viewId, subscription(viewId, paddedId("s", index, 128)));
      const controller = client.openTerminal({
        run,
        viewId,
        view: view().terminalView,
        initialAppearance: DEFAULT_APPEARANCE,
      }).value;
      const before = peer.commands.length;
      const pending = controller.attach();
      if (peer.commands.length === before) {
        rejected = { controller, pending };
        break;
      }
      baseline(peer, refs.get(viewId));
      expect((await pending).ok).toBe(true);
      void controller.detach(); // Hold public detach commands to exhaust the negotiated outbound cap.
      controller.dispose();
    }
    expect(rejected).toBeDefined();
    expect(peer.sentFrames.filter(({ command }) => command.type === "detach").length).toBeLessThan(
      256,
    );
    const before = peer.commands.length;
    const immediateDetach = rejected.controller.detach();
    expect(peer.commands).toHaveLength(before);
    expect(await rejected.pending).toMatchObject({ ok: false, error: { reason: "capacity" } });
    expect((await immediateDetach).ok).toBe(true);
    expect(client.snapshot().status).toBe("connected");

    const disposeViewId = paddedId("d", 0, 100);
    refs.set(disposeViewId, subscription(disposeViewId, paddedId("z", 0, 128)));
    const disposed = client.openTerminal({
      run,
      viewId: disposeViewId,
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const disposedPending = disposed.attach();
    expect(peer.commands).toHaveLength(before);
    disposed.dispose();
    expect((await disposedPending).ok).toBe(false);
    expect(client.snapshot().status).toBe("connected");

    for (const command of peer.commands.filter((item) => item.type === "detach"))
      peer.emit(2, {
        type: "detach-result",
        requestId: command.requestId,
        run,
        subscription: command.subscription,
        detached: true,
      });
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: refs.get("healthy"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(healthy.snapshot().appliedSeq).toBe(4);
    healthy.dispose();
    rejected.controller.dispose();
    client.dispose();
  });

  test("same-stack encode refusal is definite without a socket send", async () => {
    const codec = {
      encode: (value) => {
        if (value.includes('"type":"attach"') && value.includes('"viewId":"reject"'))
          throw new Error("local encoder refusal");
        return encoder.encode(value);
      },
      decodeFatal: (bytes) => decoder.decode(bytes),
    };
    const { client, peer } = await harness(
      (command, peer) => {
        if (command.type === "attach") reply(command, peer, subscription(command.viewId));
        else settleControl(command, peer);
      },
      undefined,
      {},
      codec,
    );
    const healthy = client.openTerminal({
      run,
      viewId: "healthy",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const hp = healthy.attach();
    baseline(peer, subscription("healthy"));
    expect((await hp).ok).toBe(true);
    const rejected = client.openTerminal({
      run,
      viewId: "reject",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const before = peer.commands.length;
    const pending = rejected.attach();
    rejected.dispose();
    expect(peer.commands).toHaveLength(before);
    expect(await pending).toMatchObject({ ok: false, error: { reason: "invalid-request" } });
    expect(client.snapshot().status).toBe("connected");
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("healthy"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(healthy.snapshot().appliedSeq).toBe(4);
    healthy.dispose();
    client.dispose();
  });

  test("keeps a healthy route after definite attach rejection but retires unknown acceptance", async () => {
    const first = view();
    let secondMode = "not-sent";
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach" && command.viewId === "a")
        reply(command, peer, subscription("a"));
      if (command.type === "attach" && command.viewId === "b") {
        if (secondMode === "not-sent") return "not-sent";
        peer.emit(4, {
          type: "error",
          requestId: command.requestId,
          run,
          commandType: "attach",
          error: domainError("BUSY", secondMode),
        });
        return secondMode === "accepted" ? "not-sent" : "unknown";
      } else settleControl(command, peer);
    });
    const a = client.openTerminal({
      run,
      viewId: "a",
      view: first.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const b = client.openTerminal({
      run,
      viewId: "b",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const ap = a.attach();
    baseline(peer, subscription("a"));
    expect((await ap).ok).toBe(true);
    expect((await b.attach()).ok).toBe(false);
    expect(client.snapshot().status).toBe("connected");
    secondMode = "not-accepted";
    expect((await b.attach()).ok).toBe(false);
    expect(client.snapshot().status).toBe("connected");
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("a"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(a.snapshot().appliedSeq).toBe(4);
    secondMode = "accepted";
    expect((await b.attach()).ok).toBe(false);
    expect(client.snapshot().status).toBe("unverifiable");
    a.dispose();
    b.dispose();
    client.dispose();
  });

  test("does not downgrade an inline accepted attach result after adapter throws", async () => {
    const rendered = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") {
        reply(command, peer, subscription("view-1"));
        throw new Error("late adapter contradiction");
      }
      settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    expect(client.snapshot().status).toBe("connected");
    controller.dispose();
    client.dispose();
  });
  test("offers no replay and waits for old view work before a fresh baseline", async () => {
    const gate = deferred();
    const rendered = view({ eventGate: gate });
    let recovery;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else if (command.type === "recover") recovery = command;
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(controller.snapshot().activeParseBytes).toBeGreaterThan(0);
    const pending = controller.recover("expired");
    expect(recovery).not.toHaveProperty("resume");
    reply(recovery, peer, subscription("view-1"), "baseline", 4);
    baselineTo(peer, subscription("view-1"), 4);
    await settle();
    expect(rendered.facts.filter((fact) => fact[0] === "initialize")).toHaveLength(1);
    gate.resolve();
    expect(await pending).toMatchObject({ ok: true, value: { atSeq: 4 } });
    expect(rendered.facts.filter((fact) => fact[0] === "initialize")).toHaveLength(2);
    expect(
      peer.commands
        .filter((command) => command.type === "applied-ack")
        .map((command) => command.appliedSeq),
    ).toEqual([3, 4]);
    controller.dispose();
    client.dispose();
  });

  test("drops a precomputed replay offer when measuring the view starts parse work", async () => {
    const gate = deferred();
    const rendered = view({ eventGate: gate });
    let recovery;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else if (command.type === "recover") recovery = command;
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    await settle();
    rendered.terminalView.measureGrid = () => {
      peer.emit(
        3,
        {
          type: "run-event",
          subscription: subscription("view-1"),
          event: { type: "output", run, seq: 4 },
        },
        new Uint8Array([65]),
      );
      return geometry;
    };
    const pending = controller.recover("expired");
    expect(recovery).not.toHaveProperty("resume");
    controller.dispose();
    gate.resolve();
    expect((await pending).ok).toBe(false);
    client.dispose();
  });

  test("rejects a lower no-resume result while preserving the proven cursor", async () => {
    const rendered = view();
    let recovery;
    let attaches = 0;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") {
        attaches++;
        reply(
          command,
          peer,
          subscription("view-1", `subscription-${attaches}`),
          "baseline",
          attaches === 1 ? 3 : 4,
        );
      } else if (command.type === "recover") recovery = command;
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const first = controller.attach();
    baseline(peer, subscription("view-1", "subscription-1"));
    expect((await first).ok).toBe(true);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1", "subscription-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(controller.snapshot().appliedSeq).toBe(4);
    const beforeInitialize = rendered.facts.filter((fact) => fact[0] === "initialize").length;
    const pending = controller.recover("gap");
    expect(recovery).not.toHaveProperty("resume");
    reply(recovery, peer, subscription("view-1", "subscription-1"), "baseline", 3);
    expect(await pending).toMatchObject({ ok: false, error: { reason: "invalid-response" } });
    expect(controller.snapshot().appliedSeq).toBe(4);
    expect(rendered.facts.filter((fact) => fact[0] === "initialize")).toHaveLength(
      beforeInitialize,
    );
    expect(
      peer.commands.filter((command) => command.type === "detach").at(-1).subscription,
    ).toEqual(subscription("view-1", "subscription-1"));
    const second = controller.attach();
    baselineTo(peer, subscription("view-1", "subscription-2"), 4);
    expect(await second).toMatchObject({ ok: true, value: { atSeq: 4 } });
    controller.dispose();
    client.dispose();
  });
  test("owns run and subscription identity apart from caller, ready, snapshot and view", async () => {
    const callerRun = { ...run };
    const rendered = view();
    let viewMutation;
    const originalBegin = rendered.terminalView.beginBaseline;
    rendered.terminalView.beginBaseline = async (incoming) => {
      viewMutation = Reflect.set(incoming.subscription.connection, "connectionId", "changed");
      await originalBegin(incoming);
    };
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run: callerRun,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    callerRun.runId = "changed";
    const attached = controller.attach();
    expect(peer.commands.find((command) => command.type === "attach").run).toEqual(run);
    baseline(peer, subscription("view-1"));
    const ready = await attached;
    expect(ready.ok).toBe(true);
    expect(viewMutation).toBe(false);
    const snap = controller.snapshot();
    expect(ready.value.subscription).not.toBe(snap.subscription);
    expect(Reflect.set(ready.value.subscription, "subscriptionId", "changed")).toBe(false);
    expect(Reflect.set(snap.subscription.run, "runId", "changed")).toBe(false);
    expect(Reflect.set(snap.subscription.connection, "connectionId", "changed")).toBe(false);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(controller.snapshot().appliedSeq).toBe(4);
    expect(
      peer.commands.filter((command) => command.type === "applied-ack").at(-1).subscription,
    ).toEqual(subscription("view-1"));
    controller.dispose();
    client.dispose();
  });
  test("admits a legal full payload within the negotiated aggregate sum", async () => {
    const gate = deferred();
    const rendered = view({ eventGate: gate });
    const { client, peer } = await harness(
      (command, peer) => {
        if (command.type === "attach") reply(command, peer, subscription("view-1"));
        else settleControl(command, peer);
      },
      undefined,
      {
        subscriptionCreditBytes: 262_144,
        outboundConnectionBytes: 262_144,
        reservedControlBytes: 65_536,
      },
    );
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    await settle();
    const ackBefore = peer.commands.filter((command) => command.type === "applied-ack").length;
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array(65_536),
    );
    await settle();
    expect(rendered.facts.filter((fact) => fact[0] === "event")).toHaveLength(1);
    expect(controller.snapshot().phase).toBe("ready");
    expect(peer.commands.filter((command) => command.type === "applied-ack")).toHaveLength(
      ackBefore,
    );
    gate.resolve();
    await settle();
    expect(
      peer.commands.filter((command) => command.type === "applied-ack").at(-1).appliedSeq,
    ).toBe(4);
    controller.dispose();
    client.dispose();
  });

  test("charges a held parse and the next frame against one connection ingress cap", async () => {
    const gate = deferred();
    const first = view({ eventGate: gate });
    const second = view();
    const { client, peer } = await harness(
      (command, peer) => {
        if (command.type === "attach") reply(command, peer, subscription(command.viewId));
        else settleControl(command, peer);
      },
      undefined,
      { outboundConnectionBytes: 262_144, reservedControlBytes: 65_536 },
    );
    const a = client.openTerminal({
      run,
      viewId: "a",
      view: first.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const b = client.openTerminal({
      run,
      viewId: "b",
      view: second.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const ap = a.attach();
    const bp = b.attach();
    baseline(peer, subscription("a"));
    baseline(peer, subscription("b"));
    expect((await ap).ok).toBe(true);
    expect((await bp).ok).toBe(true);
    const event = (viewId) => ({
      type: "run-event",
      subscription: subscription(viewId),
      event: { type: "output", run, seq: 4 },
    });
    peer.emit(3, event("a"), new Uint8Array(65_000));
    await settle();
    expect(a.snapshot().activeParseBytes).toBeGreaterThan(65_000);
    peer.emit(3, event("b"), new Uint8Array(65_000));
    await settle();
    expect(second.facts.filter((fact) => fact[0] === "event")).toHaveLength(0);
    expect(b.snapshot().phase).toBe("unavailable");
    expect(client.snapshot().status).toBe("connected");
    gate.resolve();
    await settle();
    expect(a.snapshot().activeParseBytes).toBe(0);
    a.dispose();
    b.dispose();
    client.dispose();
  });

  test("counts active parse items with queued items before admitting post-N events", async () => {
    const gate = deferred();
    const rendered = view({ eventGate: gate });
    const { client, peer } = await harness(
      (command, peer) => {
        if (command.type === "attach") reply(command, peer, subscription("view-1"));
        else settleControl(command, peer);
      },
      undefined,
      { postNEvents: 2 },
    );
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    await baselineStepped(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    for (const seq of [4, 5, 6])
      peer.emit(
        3,
        {
          type: "run-event",
          subscription: subscription("view-1"),
          event: { type: "output", run, seq },
        },
        new Uint8Array([seq]),
      );
    await settle();
    expect(rendered.facts.filter((fact) => fact[0] === "event").map((fact) => fact[1])).toEqual([
      4,
    ]);
    expect(controller.snapshot().phase).toBe("unavailable");
    expect(controller.snapshot().activeParseBytes).toBeGreaterThan(0);
    gate.resolve();
    await settle();
    expect(controller.snapshot().activeParseBytes).toBe(0);
    controller.dispose();
    client.dispose();
  });

  test("keeps retired parse debt until settlement and admits a fitting healthy route", async () => {
    const gate = deferred();
    const first = view({ eventGate: gate });
    const second = view();
    const { client, peer } = await harness(
      (command, peer) => {
        if (command.type === "attach") reply(command, peer, subscription(command.viewId));
        else settleControl(command, peer);
      },
      undefined,
      { outboundConnectionBytes: 262_144, reservedControlBytes: 65_536 },
    );
    const a = client.openTerminal({
      run,
      viewId: "a",
      view: first.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const ap = a.attach();
    baseline(peer, subscription("a"));
    expect((await ap).ok).toBe(true);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("a"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array(65_000),
    );
    await settle();
    a.dispose();
    const b = client.openTerminal({
      run,
      viewId: "b",
      view: second.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const bp = b.attach();
    baseline(peer, subscription("b"));
    expect((await bp).ok).toBe(true);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("b"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array(65_000),
    );
    await settle();
    expect(second.facts.filter((fact) => fact[0] === "event")).toHaveLength(0);
    gate.resolve();
    await settle();
    expect(a.snapshot().activeParseBytes).toBe(0);
    const c = client.openTerminal({
      run,
      viewId: "c",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const cp = c.attach();
    baseline(peer, subscription("c"));
    expect((await cp).ok).toBe(true);
    const smaller = new Uint8Array(32_000);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("c"),
        event: { type: "output", run, seq: 4 },
      },
      smaller,
    );
    await settle();
    expect(c.snapshot().appliedSeq).toBe(4);
    b.dispose();
    c.dispose();
    client.dispose();
  });

  test("waits for parse before progress and final ACK, preserving VT bytes", async () => {
    const gate = deferred();
    const rendered = view({ chunkGate: gate });
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    const opened = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(opened.ok).toBe(true);
    const attached = opened.value.attach();
    baseline(peer, subscription("view-1"));
    await settle();
    expect(rendered.facts).toContainEqual(["chunk", [27, 91, 72]]);
    expect(peer.commands.filter((command) => command.type === "applied-ack")).toHaveLength(0);
    expect(peer.commands.filter((command) => command.type === "baseline-progress")).toHaveLength(0);
    gate.resolve();
    expect(await attached).toMatchObject({ ok: true, value: { atSeq: 3 } });
    expect(peer.commands.filter((command) => command.type === "baseline-progress")).toHaveLength(2);
    expect(peer.commands.filter((command) => command.type === "applied-ack")).toMatchObject([
      { appliedSeq: 3 },
    ]);
    expect(new Set(peer.commands.map((command) => command.type))).toEqual(
      new Set(["attach", "baseline-progress", "applied-ack"]),
    );
    client.dispose();
  });

  test("routes same-run different refs independently and never ACKs an unregistered ref", async () => {
    const first = view();
    const second = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription(command.viewId));
      else settleControl(command, peer);
    });
    const a = client.openTerminal({
      run,
      viewId: "a",
      view: first.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const b = client.openTerminal({
      run,
      viewId: "b",
      view: second.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const ap = a.attach();
    const bp = b.attach();
    baseline(peer, subscription("a"));
    baseline(peer, subscription("b"));
    expect((await ap).ok).toBe(true);
    expect((await bp).ok).toBe(true);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("a"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([0, 255, 27, 91]),
    );
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("unknown"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([88]),
    );
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("a", "stale-a"),
        event: { type: "output", run, seq: 5 },
      },
      new Uint8Array([89]),
    );
    await settle();
    expect(first.facts).toContainEqual(["event", 4, [0, 255, 27, 91]]);
    expect(second.facts.filter((fact) => fact[0] === "event")).toHaveLength(0);
    expect(
      peer.commands
        .filter((command) => command.type === "applied-ack")
        .map((command) => [command.subscription.viewId, command.appliedSeq]),
    ).toContainEqual(["a", 4]);
    a.dispose();
    b.dispose();
    client.dispose();
  });

  test("same-ref recover drops pre-marker deliveries and replays only after marker", async () => {
    const rendered = view();
    let recoverCommand;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else if (command.type === "recover") recoverCommand = command;
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    const pending = controller.recover("expired");
    expect(recoverCommand.resume.appliedSeq).toBe(3);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    await settle();
    expect(rendered.facts.filter((fact) => fact[0] === "event")).toHaveLength(0);
    reply(recoverCommand, peer, subscription("view-1"), "replay", 4);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([66]),
    );
    expect(await pending).toMatchObject({ ok: true, value: { atSeq: 4 } });
    expect(rendered.facts.filter((fact) => fact[0] === "event")).toEqual([["event", 4, [66]]]);
    controller.dispose();
    client.dispose();
  });

  test("replacement fences a pending old parser and rejects its late ACK", async () => {
    const gate = deferred();
    const oldView = view({ chunkGate: gate });
    const newView = view();
    let attachCount = 0;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") {
        attachCount++;
        reply(command, peer, subscription("view-1", `subscription-${attachCount}`));
      } else if (command.type === "detach")
        peer.emit(2, {
          type: "detach-result",
          requestId: command.requestId,
          run,
          subscription: command.subscription,
          detached: true,
        });
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: oldView.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const oldAttach = controller.attach();
    baseline(peer, subscription("view-1", "subscription-1"));
    await settle();
    const replacement = controller.replaceView(newView.terminalView);
    baseline(peer, subscription("view-1", "subscription-2"));
    expect((await oldAttach).ok).toBe(false);
    expect(await replacement).toMatchObject({
      ok: true,
      value: {
        subscription: { subscriptionId: "subscription-2" },
        atSeq: 3,
      },
    });
    const acksBefore = peer.commands.filter((command) => command.type === "applied-ack").length;
    gate.resolve();
    await settle();
    expect(peer.commands.filter((command) => command.type === "applied-ack")).toHaveLength(
      acksBefore,
    );
    expect(oldView.facts).toContainEqual(["dispose"]);
    controller.dispose();
    client.dispose();
  });

  test("a gap starts one bounded baseline recovery and does not ACK the skipped fact", async () => {
    const rendered = view();
    let recover;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else if (command.type === "recover") recover = command;
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 5 },
      },
      new Uint8Array([88]),
    );
    await settle();
    expect(recover).toMatchObject({ type: "recover", reason: "gap" });
    expect(recover).not.toHaveProperty("resume");
    expect(rendered.facts.filter((fact) => fact[0] === "event")).toHaveLength(0);
    expect(
      peer.commands.filter((command) => command.type === "applied-ack" && command.appliedSeq === 5),
    ).toHaveLength(0);
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 5 },
      },
      new Uint8Array([89]),
    );
    await settle();
    expect(peer.commands.filter((command) => command.type === "recover")).toHaveLength(1);
    controller.dispose();
    client.dispose();
  });

  test("advisory input rejection preserves the model while fatal view failure retires only its route", async () => {
    const first = view();
    const second = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription(command.viewId));
      else settleControl(command, peer);
    });
    const a = client.openTerminal({
      run,
      viewId: "a",
      view: first.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const b = client.openTerminal({
      run,
      viewId: "b",
      view: second.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const ap = a.attach();
    const bp = b.attach();
    baseline(peer, subscription("a"));
    baseline(peer, subscription("b"));
    expect((await ap).ok).toBe(true);
    expect((await bp).ok).toBe(true);
    first.fail(domainError("INPUT_REJECTED"));
    expect(a.snapshot().phase).toBe("ready");
    first.fail(domainError("RECOVERY_UNAVAILABLE"));
    expect(a.snapshot().phase).toBe("unavailable");
    expect(b.snapshot().phase).toBe("ready");
    peer.emit(
      3,
      {
        type: "run-event",
        subscription: subscription("b"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([66]),
    );
    await settle();
    expect(second.facts).toContainEqual(["event", 4, [66]]);
    a.dispose();
    b.dispose();
    client.dispose();
  });

  test("a coalesced binary message invalidates the connection without parsing either fact", async () => {
    const rendered = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    const fact = frame(
      3,
      {
        type: "run-event",
        subscription: subscription("view-1"),
        event: { type: "output", run, seq: 4 },
      },
      new Uint8Array([65]),
    );
    const coalesced = new Uint8Array(fact.length * 2);
    coalesced.set(fact);
    coalesced.set(fact, fact.length);
    peer.raw(coalesced);
    await settle();
    expect(client.snapshot().status).toBe("incompatible");
    expect(controller.snapshot().phase).toBe("unavailable");
    expect(rendered.facts.filter((item) => item[0] === "event")).toHaveLength(0);
    controller.dispose();
    client.dispose();
  });

  test("a synchronous ACK error cannot resolve attach as ready", async () => {
    const rendered = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else if (command.type === "applied-ack")
        peer.emit(4, {
          type: "error",
          requestId: command.requestId,
          run,
          commandType: "applied-ack",
          error: domainError("RECOVERY_UNAVAILABLE"),
        });
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect(await attached).toMatchObject({ ok: false, error: { kind: "RECOVERY_UNAVAILABLE" } });
    expect(controller.snapshot().phase).toBe("unavailable");
    controller.dispose();
    client.dispose();
  });

  test("detaching before an in-flight attach reveals its ref retires the connection", async () => {
    const rendered = view();
    const { client, peer } = await harness();
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    expect(peer.commands.filter((command) => command.type === "attach")).toHaveLength(1);
    expect((await controller.detach()).ok).toBe(true);
    expect((await attached).ok).toBe(false);
    expect(client.snapshot().status).toBe("unverifiable");
    expect(peer.commands.filter((command) => command.type === "detach")).toHaveLength(0);
    controller.dispose();
    client.dispose();
  });

  test("recover deadline retires the old ref without retry and permits explicit new attach", async () => {
    const scheduler = clock();
    const rendered = view();
    let attachCount = 0;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") {
        attachCount++;
        reply(command, peer, subscription("view-1", `subscription-${attachCount}`));
      } else if (command.type !== "recover") settleControl(command, peer);
    }, scheduler);
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const first = controller.attach();
    baseline(peer, subscription("view-1", "subscription-1"));
    expect((await first).ok).toBe(true);
    const pending = controller.recover("expired");
    scheduler.advance(M0_LIMITS.recoveryDeadlineMs);
    expect((await pending).ok).toBe(false);
    expect(controller.snapshot().phase).toBe("unavailable");
    expect(peer.commands.filter((command) => command.type === "recover")).toHaveLength(1);
    const next = controller.attach();
    baseline(peer, subscription("view-1", "subscription-2"));
    expect(await next).toMatchObject({
      ok: true,
      value: {
        subscription: { subscriptionId: "subscription-2" },
      },
    });
    controller.dispose();
    client.dispose();
  });

  test("a controller consumes a negotiated slot until disposal", async () => {
    const { client } = await harness();
    const controllers = Array.from({ length: M0_LIMITS.subscriptionsPerConnection }, (_, index) => {
      const opened = client.openTerminal({
        run,
        viewId: `view-${index}`,
        view: view().terminalView,
        initialAppearance: DEFAULT_APPEARANCE,
      });
      expect(opened.ok).toBe(true);
      return opened.value;
    });
    expect(
      client.openTerminal({
        run,
        viewId: "overflow",
        view: view().terminalView,
        initialAppearance: DEFAULT_APPEARANCE,
      }),
    ).toMatchObject({ ok: false, error: { reason: "capacity" } });
    controllers[0].dispose();
    const replacement = client.openTerminal({
      run,
      viewId: "replacement",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(replacement.ok).toBe(true);
    replacement.value.dispose();
    for (const controller of controllers) controller.dispose();
    client.dispose();
  });

  test("streams the full legal VT and tail baseline through parsed progress", async () => {
    const rendered = view();
    let parsed = 0;
    rendered.terminalView.writeBaselineChunk = async (bytes) => {
      parsed += bytes.byteLength;
    };
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"), "baseline", 3);
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    const ref = subscription("view-1");
    const metadata = {
      ...descriptor(ref),
      vtBytes: M0_LIMITS.baselineVtBytes,
      tailBytes: M0_LIMITS.baselineTailBytes,
      chunkCount: 129,
    };
    peer.emit(3, { type: "baseline-start", run, descriptor: metadata });
    const payload = new Uint8Array(65_536);
    for (let ordinal = 0; ordinal < 129; ordinal++) {
      peer.emit(
        3,
        {
          type: "baseline-chunk",
          run,
          subscription: ref,
          baselineId: metadata.baselineId,
          ordinal,
        },
        payload,
      );
      await settle();
    }
    expect(parsed).toBe(M0_LIMITS.baselineVtBytes + M0_LIMITS.baselineTailBytes);
    expect(peer.commands.filter((command) => command.type === "applied-ack")).toHaveLength(0);
    peer.emit(3, {
      type: "baseline-end",
      run,
      subscription: ref,
      baselineId: metadata.baselineId,
      chunkCount: 129,
      totalBytes: parsed,
      atSeq: 3,
    });
    expect(await attached).toMatchObject({ ok: true, value: { atSeq: 3 } });
    expect(peer.commands.filter((command) => command.type === "baseline-progress")).toHaveLength(
      129,
    );
    expect(peer.commands.filter((command) => command.type === "applied-ack")).toMatchObject([
      { appliedSeq: 3 },
    ]);
    controller.dispose();
    client.dispose();
  });

  test("a reentrant observer may dispose before attach sends a marker", async () => {
    const { client, peer } = await harness();
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    controller.onState((snapshot) => {
      if (snapshot.phase === "await-marker") controller.dispose();
    });
    expect(await controller.attach()).toMatchObject({ ok: false, error: { reason: "disposed" } });
    expect(peer.commands.filter((command) => command.type === "attach")).toHaveLength(0);
    client.dispose();
  });

  test("empty retained replay commits without resetting the view", async () => {
    const rendered = view();
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") reply(command, peer, subscription("view-1"));
      else if (command.type === "recover")
        reply(command, peer, subscription("view-1"), "replay", 3);
      else settleControl(command, peer);
    });
    const controller = client.openTerminal({
      run,
      viewId: "view-1",
      view: rendered.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const attached = controller.attach();
    baseline(peer, subscription("view-1"));
    expect((await attached).ok).toBe(true);
    const before = rendered.facts.filter((fact) => fact[0] === "initialize").length;
    expect(await controller.recover("expired")).toMatchObject({ ok: true, value: { atSeq: 3 } });
    expect(rendered.facts.filter((fact) => fact[0] === "initialize")).toHaveLength(before);
    expect(controller.snapshot().phase).toBe("ready");
    controller.dispose();
    client.dispose();
  });

  test("retired ref cap is shared by all controllers on the connection", async () => {
    let serial = 0;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") {
        serial++;
        reply(command, peer, subscription(command.viewId, `subscription-${serial}`));
      } else if (command.type === "detach")
        peer.emit(2, {
          type: "detach-result",
          requestId: command.requestId,
          run,
          subscription: command.subscription,
          detached: true,
        });
      else settleControl(command, peer);
    });
    const first = client.openTerminal({
      run,
      viewId: "first",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const second = client.openTerminal({
      run,
      viewId: "second",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    for (let index = 0; index < 256; index++) {
      const attached = first.attach();
      baseline(peer, subscription("first", `subscription-${index + 1}`));
      expect((await attached).ok).toBe(true);
      expect((await first.detach()).ok).toBe(true);
    }
    expect(await second.attach()).toMatchObject({
      ok: false,
      error: { kind: "COUNTER_EXHAUSTED" },
    });
    expect(peer.commands.filter((command) => command.type === "attach")).toHaveLength(256);
    first.dispose();
    second.dispose();
    client.dispose();
  });
  test("two active refs cannot overflow the last tombstone slot", async () => {
    let serial = 0;
    const { client, peer } = await harness((command, peer) => {
      if (command.type === "attach") {
        serial++;
        reply(command, peer, subscription(command.viewId, `subscription-${serial}`));
      } else if (command.type === "detach")
        peer.emit(2, {
          type: "detach-result",
          requestId: command.requestId,
          run,
          subscription: command.subscription,
          detached: true,
        });
      else settleControl(command, peer);
    });
    const a = client.openTerminal({
      run,
      viewId: "a",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const b = client.openTerminal({
      run,
      viewId: "b",
      view: view().terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    for (let index = 0; index < 255; index++) {
      const attached = a.attach();
      baseline(peer, subscription("a", `subscription-${index + 1}`));
      expect((await attached).ok).toBe(true);
      expect((await a.detach()).ok).toBe(true);
    }
    const ap = a.attach();
    const bp = b.attach();
    baseline(peer, subscription("a", "subscription-256"));
    baseline(peer, subscription("b", "subscription-257"));
    expect((await ap).ok).toBe(true);
    expect((await bp).ok).toBe(true);
    expect((await a.detach()).ok).toBe(true);
    expect((await b.detach()).ok).toBe(true);
    expect(client.snapshot().status).toBe("unverifiable");
    a.dispose();
    b.dispose();
    client.dispose();
  });
});
