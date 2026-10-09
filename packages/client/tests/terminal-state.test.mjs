import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, test } from "vitest";
import { createClient } from "@cove/client";
import { LOCAL_PATHS, M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createTerminalDecoder, encodeTerminalFrame } from "@cove/protocol/terminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const identity = { serverId: "server-1", relayInstanceId: "instance-1" };
const run = { ...identity, runId: "run-1" };
const connection = { connectionId: "connection-1", generation: 1 };
const grid = { cols: 80, rows: 24 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

function bootstrap(terminal = false) {
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...identity,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "server-build",
    capabilities: [...M0_CAPABILITIES],
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: M0_LIMITS,
    ...(terminal ? { connection } : {}),
  };
}

function frame(kind, metadata, payload = new Uint8Array()) {
  const encoded = encodeTerminalFrame(kind, encoder.encode(JSON.stringify(metadata)), payload);
  if (!encoded.ok) throw new Error("invalid fixture frame");
  return encoded.value;
}

function command(bytes) {
  const parser = createTerminalDecoder();
  const read = parser.read(bytes);
  expect(read.frames).toHaveLength(1);
  expect(parser.finish().ok).toBe(true);
  return JSON.parse(decoder.decode(read.frames[0].metadata));
}

function record(status, target = run) {
  return {
    run: target,
    status,
    geometry: grid,
    controlEpoch: 0,
    controlHolder: null,
    preview: {
      version: null,
      generatedAtMs: null,
      checkedAtMs: null,
      stale: true,
      byteLength: 0,
    },
  };
}

function fixtureView(gates = {}) {
  const calls = [];
  return {
    calls,
    initialize: async (value) => calls.push(["initialize", value.geometry]),
    beginBaseline: async (value) => calls.push(["begin", value.atSeq]),
    writeBaselineChunk: async () => calls.push(["chunk"]),
    finishBaseline: async () => {
      calls.push(["finish"]);
      await gates.finish?.promise;
    },
    applyEvent: async (event) => {
      calls.push(["apply", event.type, event.seq]);
      await gates[event.type]?.promise;
    },
    measureGrid: () => grid,
    setAppearance: () => {},
    setVisibility: () => {},
    onInputIntent: () => ({ dispose() {} }),
    onFocusIntent: () => ({ dispose() {} }),
    onFailure: () => ({ dispose() {} }),
    dispose: () => calls.push(["dispose"]),
  };
}

async function harness({
  credentials,
  scheduler,
  onCommand,
  onRpcCancel,
  view = fixtureView(),
} = {}) {
  let nextId = 0;
  let terminalCallbacks;
  const requests = [];
  const commands = [];
  const peer = {
    emit(kind, metadata, payload) {
      terminalCallbacks.onBinary(frame(kind, metadata, payload));
    },
    close() {
      terminalCallbacks.onClose();
    },
    result(sent, extras = {}) {
      this.emit(2, {
        type: `${sent.type}-result`,
        requestId: sent.requestId,
        run: sent.run,
        ...(sent.subscription ? { subscription: sent.subscription } : {}),
        ...extras,
      });
    },
  };
  const http = {
    post(request, callbacks) {
      if (request.path === LOCAL_PATHS.bootstrap) {
        queueMicrotask(() =>
          callbacks.onResponse({
            status: 200,
            headers: {},
            body: encoder.encode(JSON.stringify(bootstrap())),
          }),
        );
        return { cancel: () => "not-sent" };
      }
      const parsed = JSON.parse(decoder.decode(request.body));
      const entry = { request, callbacks, parsed };
      requests.push(entry);
      return {
        cancel() {
          onRpcCancel?.(entry);
          return "not-sent";
        },
      };
    },
  };
  const terminal = {
    open(callbacks) {
      terminalCallbacks = callbacks;
      callbacks.onOpen({
        send(bytes) {
          if (typeof bytes === "string") {
            callbacks.onText(encoder.encode(JSON.stringify(bootstrap(true))));
          } else {
            const sent = command(bytes);
            commands.push(sent);
            onCommand?.(sent, peer);
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
    expectedServerId: identity.serverId,
    expectedRelayInstanceId: identity.relayInstanceId,
    buildVersion: "client-build",
    credentials:
      credentials ?? (() => ({ authorization: "Bearer fixture", terminalSecret: "a".repeat(43) })),
    codec: {
      encode: (text) => encoder.encode(text),
      decodeFatal: (bytes) => decoder.decode(bytes),
    },
    createOpaqueId: () => `request-${++nextId}`,
    scheduler: scheduler ?? {
      nowMs: () => 0,
      setTimer: () => ({ dispose() {} }),
      yieldTurn: async () => {},
    },
    http,
    terminal,
  });
  expect((await client.connect()).ok).toBe(true);
  return {
    client,
    peer,
    requests,
    commands,
    view,
    respond(index, status) {
      const entry = requests[index];
      entry.callbacks.onResponse({
        status: 200,
        headers: {
          "cove-protocol": String(PROTOCOL_VERSION),
          "cove-server-id": identity.serverId,
          "cove-instance-id": identity.relayInstanceId,
        },
        body: encoder.encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: entry.parsed.id,
            result: { record: record(status) },
          }),
        ),
      });
    },
  };
}

function subscription() {
  return { run, connection, viewId: "view-1", subscriptionId: "subscription-1" };
}

function baseline(peer, ref, currentGeometry = grid) {
  const descriptor = {
    baselineId: "baseline-1",
    run,
    subscription: ref,
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    checkpointSeq: 2,
    atSeq: 3,
    captureGeometry: currentGeometry,
    currentGeometry,
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
  peer.emit(3, { type: "baseline-start", run, descriptor });
  peer.emit(
    3,
    {
      type: "baseline-chunk",
      run,
      subscription: ref,
      baselineId: descriptor.baselineId,
      ordinal: 0,
    },
    new Uint8Array([65]),
  );
  peer.emit(3, {
    type: "baseline-end",
    run,
    subscription: ref,
    baselineId: descriptor.baselineId,
    chunkCount: 1,
    totalBytes: 1,
    atSeq: 3,
  });
}

async function ready(h) {
  const ref = subscription();
  const opened = h.client.openTerminal({
    run,
    viewId: ref.viewId,
    view: h.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  const controller = opened.value;
  const attached = controller.attach();
  baseline(h.peer, ref);
  expect((await attached).ok).toBe(true);
  return { controller, ref };
}

function autoCommands(sent, peer) {
  if (sent.type === "attach")
    peer.result(sent, { subscription: subscription(), mode: "baseline", atSeq: 3 });
  if (sent.type === "recover")
    peer.result(sent, {
      subscription: sent.subscription,
      mode: sent.resume ? "replay" : "baseline",
      atSeq: sent.resume?.appliedSeq ?? 3,
    });
  if (sent.type === "applied-ack") peer.result(sent, { appliedSeq: sent.appliedSeq });
  if (sent.type === "baseline-progress")
    peer.result(sent, { baselineId: sent.baselineId, lastParsedOrdinal: sent.lastParsedOrdinal });
  if (sent.type === "focus") peer.result(sent, { epoch: 1, atSeq: 4 });
}

describe("public terminal state completion", () => {
  test("explicit get evidence is immutable, latest-ordinal and sticky only on proved exit", async () => {
    const h = await harness();
    const controller = h.client.openTerminal({
      run,
      viewId: "view-1",
      view: h.view,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const initial = controller.snapshot();
    expect(initial).toMatchObject({ run, execution: { status: "unverifiable", source: "none" } });
    expect(Object.isFrozen(initial.run)).toBe(true);
    const first = h.client.call("terminal.get", { run });
    await settle();
    expect(h.requests).toHaveLength(1);
    h.respond(0, "live");
    expect((await first).ok).toBe(true);
    expect(controller.snapshot().execution).toEqual({ status: "live", source: "terminal-get" });
    const older = h.client.call("terminal.get", { run });
    const newer = h.client.call("terminal.get", { run });
    await settle();
    h.respond(2, "unverifiable");
    await newer;
    h.respond(1, "live");
    await older;
    expect(controller.snapshot().execution).toEqual({
      status: "unverifiable",
      source: "terminal-get",
    });
    const exited = h.client.call("terminal.get", { run });
    const lateLive = h.client.call("terminal.get", { run });
    await settle();
    h.respond(3, "exited");
    await exited;
    h.respond(4, "live");
    await lateLive;
    expect(controller.snapshot().execution).toEqual({
      status: "exited",
      source: "terminal-get",
      seq: null,
      exitCode: null,
      signal: null,
    });
    h.client.dispose();
    expect(controller.snapshot().execution.status).toBe("exited");
  });

  test("inverted credential dispatch cannot make an older live query latest", async () => {
    const firstCredentials = deferred();
    let calls = 0;
    const h = await harness({
      credentials: () =>
        ++calls === 2
          ? firstCredentials.promise
          : { authorization: "Bearer fixture", terminalSecret: "a".repeat(43) },
    });
    const controller = h.client.openTerminal({
      run,
      viewId: "view-1",
      view: h.view,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const older = h.client.call("terminal.get", { run });
    await settle();
    expect(h.requests).toHaveLength(0);
    const newer = h.client.call("terminal.get", { run });
    await settle();
    expect(h.requests).toHaveLength(1);
    h.respond(0, "unverifiable");
    await newer;
    firstCredentials.resolve({ authorization: "Bearer fixture", terminalSecret: "a".repeat(43) });
    await settle();
    expect(h.requests).toHaveLength(2);
    h.respond(1, "live");
    await older;
    expect(controller.snapshot().execution.status).toBe("unverifiable");
    h.client.dispose();
  });

  test("proved exit installs before an RPC cancel disposer can reenter disposal", async () => {
    let controller;
    let observedDuringCancel;
    const h = await harness({
      onRpcCancel() {
        observedDuringCancel = controller.snapshot().execution;
        controller.dispose();
      },
    });
    controller = h.client.openTerminal({
      run,
      viewId: "view-1",
      view: h.view,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const query = h.client.call("terminal.get", { run });
    await settle();
    h.respond(0, "exited");
    expect((await query).ok).toBe(true);
    expect(observedDuringCancel).toMatchObject({ status: "exited", source: "terminal-get" });
    expect(controller.snapshot()).toMatchObject({
      phase: "disposed",
      execution: { status: "exited", source: "terminal-get" },
    });
    h.client.dispose();
  });

  test("queued exit cannot revoke focus; admitted exit is sticky before parser completion", async () => {
    const outputGate = deferred();
    const exitGate = deferred();
    const h = await harness({
      onCommand: autoCommands,
      view: fixtureView({ output: outputGate, exit: exitGate }),
    });
    const { controller, ref } = await ready(h);
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus(grid);
    expect((await focus).ok).toBe(true);
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: {
        type: "control",
        run,
        seq: 4,
        epoch: 1,
        holder: { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId },
        geometry: grid,
      },
    });
    await settle();
    expect(controller.snapshot().inputReady).toBe(true);
    h.peer.emit(
      3,
      { type: "run-event", subscription: ref, event: { type: "output", run, seq: 5 } },
      new Uint8Array([65]),
    );
    await settle();
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: { type: "exit", run, seq: 6, exitCode: 7, signal: null },
    });
    expect(controller.snapshot().execution.status).toBe("unverifiable");
    expect(controller.snapshot().inputReady).toBe(true);
    outputGate.resolve();
    await settle();
    expect(controller.snapshot().execution).toEqual({
      status: "exited",
      source: "run-event",
      seq: 6,
      exitCode: 7,
      signal: null,
    });
    expect(controller.snapshot().appliedSeq).toBe(5);
    expect(controller.snapshot().inputReady).toBe(false);
    exitGate.reject(new Error("renderer refused exit"));
    await settle();
    expect(controller.snapshot().execution.status).toBe("exited");
    expect(controller.snapshot().appliedSeq).toBe(5);
    h.client.dispose();
  });

  test("baseline geometry appears only after finish and remains detached from view mutation", async () => {
    const finish = deferred();
    const view = fixtureView({ finish });
    let mutationRejected = false;
    view.beginBaseline = async (descriptor) => {
      try {
        descriptor.currentGeometry.cols = 999;
      } catch {
        mutationRejected = true;
      }
    };
    const h = await harness({ onCommand: autoCommands, view });
    const opened = h.client.openTerminal({
      run,
      viewId: "view-1",
      view,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(opened.ok).toBe(true);
    const controller = opened.value;
    const attached = controller.attach();
    baseline(h.peer, subscription(), { cols: 92, rows: 28 });
    await settle();
    expect(controller.snapshot().appliedGeometry).toBeNull();
    expect(controller.snapshot().appliedAuthority).toBeNull();
    finish.resolve();
    expect(await attached).toMatchObject({ ok: true });
    expect(mutationRejected).toBe(true);
    expect(controller.snapshot().appliedGeometry).toEqual({
      geometry: { cols: 92, rows: 28 },
      atSeq: 3,
    });
    expect(controller.snapshot().appliedAuthority).toBeNull();
    h.client.dispose();
  });

  test("control and resize publish only applied facts; received foreign control revokes input first", async () => {
    const foreign = deferred();
    const resize = deferred();
    const view = fixtureView();
    const originalApply = view.applyEvent;
    view.applyEvent = async (event, bytes) => {
      if (event.type === "control" && event.seq === 4) {
        try {
          event.geometry.cols = 999;
        } catch {
          /* A frozen renderer input is also safe. */
        }
      }
      if (event.seq === 5) await foreign.promise;
      if (event.seq === 6) await resize.promise;
      await originalApply(event, bytes);
    };
    const h = await harness({ onCommand: autoCommands, view });
    const { controller, ref } = await ready(h);
    controller.setInputTarget(true, true);
    expect((await controller.requestFocus(grid)).ok).toBe(true);
    const holder = { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId };
    const controlGrid = { cols: 90, rows: 28 };
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: { type: "control", run, seq: 4, epoch: 1, holder, geometry: controlGrid },
    });
    await settle();
    expect(controller.snapshot().appliedGeometry).toEqual({ geometry: controlGrid, atSeq: 4 });
    expect(controller.snapshot().appliedAuthority).toEqual({ epoch: 1, holder, atSeq: 4 });
    expect(Object.isFrozen(controller.snapshot().appliedAuthority.holder.connection)).toBe(true);
    expect(
      Reflect.set(controller.snapshot().appliedAuthority.holder.connection, "generation", 99),
    ).toBe(false);
    expect(controller.snapshot().appliedAuthority.holder.connection.generation).toBe(1);
    expect(controller.snapshot().inputReady).toBe(true);
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: { type: "control", run, seq: 5, epoch: 2, holder: null, geometry: controlGrid },
    });
    await settle();
    expect(controller.snapshot().inputReady).toBe(false);
    expect(controller.snapshot().appliedAuthority).toEqual({ epoch: 1, holder, atSeq: 4 });
    foreign.resolve();
    await settle();
    expect(controller.snapshot().appliedAuthority).toEqual({ epoch: 2, holder: null, atSeq: 5 });
    const resizeGrid = { cols: 100, rows: 30 };
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: { type: "resize", run, seq: 6, geometry: resizeGrid, requiresBaseline: false },
    });
    await settle();
    expect(controller.snapshot().appliedGeometry).toEqual({ geometry: controlGrid, atSeq: 5 });
    resize.resolve();
    await settle();
    expect(controller.snapshot().appliedGeometry).toEqual({ geometry: resizeGrid, atSeq: 6 });
    expect(controller.snapshot().appliedAuthority).toEqual({ epoch: 2, holder: null, atSeq: 5 });
    h.peer.emit(
      3,
      { type: "run-event", subscription: ref, event: { type: "output", run, seq: 7 } },
      new Uint8Array([65]),
    );
    await settle();
    expect(controller.snapshot().appliedSeq).toBe(7);
    expect(controller.snapshot().appliedGeometry.atSeq).toBe(6);
    for (const object of [
      controller.snapshot().run,
      controller.snapshot().appliedGeometry.geometry,
      controller.snapshot().appliedAuthority,
      controller.snapshot().execution,
    ])
      expect(Object.isFrozen(object)).toBe(true);
    h.client.dispose();
  });

  test("same-view empty replay restores only retained applied geometry, never prior authority", async () => {
    const view = fixtureView();
    let heldRecover;
    const h = await harness({
      onCommand(sent, peer) {
        if (sent.type === "recover") heldRecover = sent;
        else autoCommands(sent, peer);
      },
      view,
    });
    const { controller, ref } = await ready(h);
    const controlGrid = { cols: 94, rows: 29 };
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: { type: "control", run, seq: 4, epoch: 1, holder: null, geometry: controlGrid },
    });
    await settle();
    expect(controller.snapshot().appliedGeometry).toEqual({ geometry: controlGrid, atSeq: 4 });
    view.measureGrid = () => controlGrid;
    const recovery = controller.recover("released-view");
    expect(controller.snapshot().appliedGeometry).toBeNull();
    expect(controller.snapshot().appliedAuthority).toBeNull();
    expect(heldRecover).toMatchObject({ resume: { geometry: controlGrid, appliedSeq: 4 } });
    h.peer.result(heldRecover, { mode: "replay", atSeq: 4 });
    expect((await recovery).ok).toBe(true);
    expect(controller.snapshot().appliedGeometry).toEqual({ geometry: controlGrid, atSeq: 4 });
    expect(controller.snapshot().appliedAuthority).toBeNull();
    h.client.dispose();
    expect(controller.snapshot().appliedGeometry).toBeNull();
  });

  test("nested disposal suppresses stale outer state delivery to later listeners", async () => {
    const h = await harness();
    const controller = h.client.openTerminal({
      run,
      viewId: "view-1",
      view: h.view,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const later = [];
    controller.onState((snapshot) => {
      if (snapshot.execution.status === "live") controller.dispose();
    });
    controller.onState((snapshot) => later.push([snapshot.phase, snapshot.execution.status]));
    const query = h.client.call("terminal.get", { run });
    await settle();
    h.respond(0, "live");
    expect((await query).ok).toBe(true);
    expect(later).toEqual([["disposed", "unverifiable"]]);
    h.client.dispose();
  });

  test("ordered exit and ordinary output remain distinct after the same connection loss", async () => {
    for (const type of ["exit", "output"]) {
      const h = await harness({ onCommand: autoCommands });
      const { controller, ref } = await ready(h);
      h.peer.emit(
        3,
        {
          type: "run-event",
          subscription: ref,
          event:
            type === "exit"
              ? { type, run, seq: 4, exitCode: null, signal: "SIGTERM" }
              : { type, run, seq: 4 },
        },
        type === "output" ? new Uint8Array([65]) : undefined,
      );
      await settle();
      expect(controller.snapshot().appliedSeq).toBe(4);
      h.peer.close();
      const state = controller.snapshot();
      expect(state.phase).toBe("unavailable");
      expect(state.run).toEqual(run);
      expect(state.execution.status).toBe(type === "exit" ? "exited" : "unverifiable");
      expect(state.execution).toMatchObject(
        type === "exit"
          ? { source: "run-event", seq: 4, exitCode: null, signal: "SIGTERM" }
          : { status: "unverifiable", source: "none" },
      );
      h.client.dispose();
    }
  });

  test("transport failure downgrades only live evidence and never erases a proved exit", async () => {
    const h = await harness();
    const controller = h.client.openTerminal({
      run,
      viewId: "view-1",
      view: h.view,
      initialAppearance: DEFAULT_APPEARANCE,
    }).value;
    const live = h.client.call("terminal.get", { run });
    await settle();
    h.respond(0, "live");
    await live;
    const failure = h.client.call("terminal.get", { run });
    await settle();
    h.requests[1].callbacks.onFailure({ disposition: "unknown", reason: "transport" });
    expect((await failure).ok).toBe(false);
    expect(controller.snapshot().execution).toEqual({
      status: "unverifiable",
      source: "terminal-get",
    });
    const exited = h.client.call("terminal.get", { run });
    await settle();
    h.respond(2, "exited");
    await exited;
    const laterFailure = h.client.call("terminal.get", { run });
    await settle();
    h.requests[3].callbacks.onFailure({ disposition: "unknown", reason: "transport" });
    await laterFailure;
    expect(controller.snapshot().execution).toMatchObject({
      status: "exited",
      source: "terminal-get",
    });
    h.client.dispose();
  });

  test("requires-baseline resize clears projection without publishing its unapplied grid", async () => {
    const h = await harness({ onCommand: autoCommands });
    const { controller, ref } = await ready(h);
    h.peer.emit(3, {
      type: "run-event",
      subscription: ref,
      event: {
        type: "resize",
        run,
        seq: 4,
        geometry: { cols: 120, rows: 40 },
        requiresBaseline: true,
      },
    });
    await settle();
    expect(controller.snapshot().appliedGeometry).toBeNull();
    expect(controller.snapshot().appliedAuthority).toBeNull();
    expect(controller.snapshot().appliedSeq).toBe(3);
    h.client.dispose();
  });
});
