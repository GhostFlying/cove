import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, test } from "vitest";
import { createClient } from "@cove/client";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createTerminalDecoder, encodeTerminalFrame } from "@cove/protocol/terminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const run = { serverId: "server-1", relayInstanceId: "instance-1", runId: "run-1" };
const connection = { connectionId: "connection-1", generation: 1 };
const geometry = { cols: 80, rows: 24 };
const ref = { run, connection, viewId: "view-1", subscriptionId: "subscription-1" };

function bootstrap(terminal = false, budgets = {}) {
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    serverId: run.serverId,
    relayInstanceId: run.relayInstanceId,
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
  const result = encodeTerminalFrame(kind, encoder.encode(JSON.stringify(metadata)), payload);
  if (!result.ok) throw new Error("bad fixture frame");
  return result.value;
}

function decodeCommand(bytes) {
  const parser = createTerminalDecoder();
  const read = parser.read(bytes);
  expect(read.frames).toHaveLength(1);
  expect(parser.finish().ok).toBe(true);
  return {
    command: JSON.parse(decoder.decode(read.frames[0].metadata)),
    payload: read.frames[0].payload,
  };
}

function view() {
  const focusListeners = new Set();
  const terminalView = {
    initialize: async () => {},
    beginBaseline: async () => {},
    writeBaselineChunk: async () => {},
    finishBaseline: async () => {},
    applyEvent: async () => {},
    measureGrid: () => geometry,
    setAppearance: () => {},
    setVisibility: () => {},
    onInputIntent: () => ({ dispose() {} }),
    onFocusIntent: (listener) => {
      focusListeners.add(listener);
      return { dispose: () => focusListeners.delete(listener) };
    },
    onFailure: () => ({ dispose() {} }),
    dispose: () => {},
  };
  return {
    terminalView,
    focus: (intent) => focusListeners.forEach((listener) => listener(intent)),
  };
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

async function harness() {
  const commands = [];
  let callbacks;
  let request = 0;
  const peer = {
    commands,
    emit(kind, metadata, payload) {
      callbacks.onBinary(frame(kind, metadata, payload));
    },
    result(command, extra = {}) {
      this.emit(2, {
        type: `${command.type}-result`,
        requestId: command.requestId,
        run,
        subscription: ref,
        ...extra,
      });
    },
    event(event) {
      this.emit(3, { type: "run-event", subscription: ref, event });
    },
    baseline() {
      const descriptor = {
        baselineId: "baseline-1",
        run,
        subscription: ref,
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
        checkpointSeq: 0,
        atSeq: 0,
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
        vtBytes: 1,
        tailBytes: 0,
        chunkCount: 1,
      };
      this.emit(3, { type: "baseline-start", run, descriptor });
      this.emit(
        3,
        { type: "baseline-chunk", run, subscription: ref, baselineId: "baseline-1", ordinal: 0 },
        new Uint8Array([65]),
      );
      this.emit(3, {
        type: "baseline-end",
        run,
        subscription: ref,
        baselineId: "baseline-1",
        chunkCount: 1,
        totalBytes: 1,
        atSeq: 0,
      });
    },
  };
  const client = createClient({
    expectedServerId: run.serverId,
    expectedRelayInstanceId: run.relayInstanceId,
    buildVersion: "client-build",
    credentials: () => ({ authorization: "Bearer test", terminalSecret: "a".repeat(43) }),
    codec: {
      encode: (value) => encoder.encode(value),
      decodeFatal: (bytes) => decoder.decode(bytes),
    },
    createOpaqueId: () => `request-${++request}`,
    scheduler: { nowMs: () => 0, setTimer: () => ({ dispose() {} }), yieldTurn: async () => {} },
    http: {
      post(_request, callback) {
        queueMicrotask(() =>
          callback.onResponse({
            status: 200,
            headers: {},
            body: encoder.encode(JSON.stringify(bootstrap())),
          }),
        );
        return { cancel: () => "not-sent" };
      },
    },
    terminal: {
      open(callback) {
        callbacks = callback;
        callback.onOpen({
          send(message) {
            if (typeof message === "string") {
              callback.onText(encoder.encode(JSON.stringify(bootstrap(true))));
              return "handed-off";
            }
            const entry = decodeCommand(message);
            commands.push(entry);
            const { command } = entry;
            if (command.type === "attach") peer.result(command, { mode: "baseline", atSeq: 0 });
            if (command.type === "applied-ack")
              peer.result(command, { appliedSeq: command.appliedSeq });
            if (command.type === "baseline-progress")
              peer.result(command, {
                baselineId: command.baselineId,
                lastParsedOrdinal: command.lastParsedOrdinal,
              });
            return "handed-off";
          },
          close() {},
          dispose() {},
        });
        return { cancel: () => "not-sent" };
      },
    },
  });
  expect((await client.connect()).ok).toBe(true);
  const mounted = view();
  const opened = client.openTerminal({
    run,
    viewId: ref.viewId,
    view: mounted.terminalView,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  const controller = opened.value;
  const attached = controller.attach();
  peer.baseline();
  await settle();
  expect((await attached).ok).toBe(true);
  return { client, controller, peer, mounted };
}

describe("client control authority", () => {
  test("focus result alone cannot grant; ordered matching holder can, newer received epoch revokes", async () => {
    const { controller, peer } = await harness();
    expect(controller.setInputTarget(true, true).ok).toBe(true);
    const pending = controller.requestFocus();
    const command = peer.commands.at(-1).command;
    expect(command.type).toBe("focus");
    peer.result(command, { epoch: 1, atSeq: 1 });
    expect((await pending).ok).toBe(true);
    expect(controller.snapshot().inputReady).toBe(false);
    peer.event({
      type: "control",
      run,
      seq: 1,
      epoch: 1,
      holder: { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId },
      geometry,
    });
    await settle();
    expect(controller.snapshot().inputReady).toBe(true);
    peer.event({ type: "control", run, seq: 2, epoch: 2, holder: null, geometry });
    expect(controller.snapshot().inputReady).toBe(false);
  });

  test("view intent is generation-bound and blur revokes before its reply", async () => {
    const { controller, peer, mounted } = await harness();
    expect(controller.setInputTarget(true, false).ok).toBe(true);
    mounted.focus({
      viewGeneration: controller.snapshot().viewGeneration,
      focusSeq: 1,
      focused: true,
      geometry,
    });
    expect(peer.commands.at(-1).command.type).toBe("focus");
    const focus = peer.commands.at(-1).command;
    peer.event({
      type: "control",
      run,
      seq: 1,
      epoch: 1,
      holder: { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId },
      geometry,
    });
    await settle();
    expect(controller.snapshot().inputReady).toBe(false);
    peer.result(focus, { epoch: 1, atSeq: 1 });
    await settle();
    expect(controller.snapshot().inputReady).toBe(true);
    const blur = controller.blur();
    expect(controller.snapshot().inputReady).toBe(false);
    const command = peer.commands.at(-1).command;
    expect(command.type).toBe("blur");
    peer.result(command, { epoch: 1, atSeq: 2 });
    expect((await blur).ok).toBe(true);
  });
});
