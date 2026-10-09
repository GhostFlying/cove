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

function view(onApply, onBeginBaseline) {
  const focusListeners = new Set();
  const inputListeners = new Set();
  const failureListeners = new Set();
  const capturedInputListeners = [];
  const applied = [];
  let disposed = 0;
  const terminalView = {
    initialize: async () => {},
    beginBaseline: async (descriptor) => {
      onBeginBaseline?.(descriptor);
    },
    writeBaselineChunk: async () => {},
    finishBaseline: async () => {},
    applyEvent: async (event) => {
      applied.push(event);
      onApply?.(event);
    },
    measureGrid: () => geometry,
    setAppearance: () => {},
    setVisibility: () => {},
    onInputIntent: (listener) => {
      inputListeners.add(listener);
      capturedInputListeners.push(listener);
      return { dispose: () => inputListeners.delete(listener) };
    },
    onFocusIntent: (listener) => {
      focusListeners.add(listener);
      return { dispose: () => focusListeners.delete(listener) };
    },
    onFailure: (listener) => {
      failureListeners.add(listener);
      return { dispose: () => failureListeners.delete(listener) };
    },
    dispose: () => {
      disposed++;
    },
  };
  return {
    terminalView,
    focus: (intent) => focusListeners.forEach((listener) => listener(intent)),
    input: (intent) => inputListeners.forEach((listener) => listener(intent)),
    fail: (error) => failureListeners.forEach((listener) => listener(error)),
    staleInput: (intent) => capturedInputListeners[0]?.(intent),
    applied,
    get disposed() {
      return disposed;
    },
  };
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function clock() {
  let now = 0;
  let expireNextSet = false;
  let timerSets = 0;
  let synchronousExpirations = 0;
  const timers = new Set();
  return {
    nowMs: () => now,
    setTimer(delay, callback) {
      timerSets++;
      const timer = { deadline: now + delay, callback };
      timers.add(timer);
      if (expireNextSet) {
        expireNextSet = false;
        timers.delete(timer);
        synchronousExpirations++;
        callback();
      }
      return { dispose: () => timers.delete(timer) };
    },
    yieldTurn: async () => {},
    advance(ms) {
      now += ms;
      for (const timer of [...timers])
        if (timer.deadline <= now && timers.delete(timer)) timer.callback();
    },
    expireNextSet() {
      expireNextSet = true;
    },
    get timerSets() {
      return timerSets;
    },
    get synchronousExpirations() {
      return synchronousExpirations;
    },
  };
}

async function harness({
  budgets = {},
  scheduler,
  onCommand,
  onApply,
  onBeginBaseline,
  autoOpen = true,
  holdAcks = false,
} = {}) {
  const commands = [];
  const heldAcks = [];
  let currentRef = ref;
  let callbacks;
  let request = 0;
  const peer = {
    commands,
    // With holdAcks, applied-ack replies wait here, modelling an ack still in flight.
    releaseAck() {
      const command = heldAcks.shift();
      if (command) this.result(command, { appliedSeq: command.appliedSeq });
      return command;
    },
    get currentRef() {
      return currentRef;
    },
    close() {
      callbacks.onClose();
    },
    emit(kind, metadata, payload) {
      callbacks.onBinary(frame(kind, metadata, payload));
    },
    result(command, extra = {}) {
      this.emit(2, {
        type: `${command.type}-result`,
        requestId: command.requestId,
        run,
        subscription: currentRef,
        ...extra,
      });
    },
    event(event) {
      this.emit(3, { type: "run-event", subscription: currentRef, event });
    },
    baseline(
      atSeq = 0,
      { baselineId = "baseline-1", grid = geometry, control = { epoch: 0, holder: null } } = {},
    ) {
      const descriptor = {
        baselineId,
        run,
        subscription: currentRef,
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
        checkpointSeq: atSeq,
        atSeq,
        captureGeometry: grid,
        currentGeometry: grid,
        control,
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
        {
          type: "baseline-chunk",
          run,
          subscription: currentRef,
          baselineId,
          ordinal: 0,
        },
        new Uint8Array([65]),
      );
      this.emit(3, {
        type: "baseline-end",
        run,
        subscription: currentRef,
        baselineId,
        chunkCount: 1,
        totalBytes: 1,
        atSeq,
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
    scheduler: scheduler ?? {
      nowMs: () => 0,
      setTimer: () => ({ dispose() {} }),
      yieldTurn: async () => {},
    },
    http: {
      post(_request, callback) {
        queueMicrotask(() =>
          callback.onResponse({
            status: 200,
            headers: {},
            body: encoder.encode(JSON.stringify(bootstrap(false, budgets))),
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
              callback.onText(encoder.encode(JSON.stringify(bootstrap(true, budgets))));
              return "handed-off";
            }
            const entry = decodeCommand(message);
            commands.push(entry);
            const { command } = entry;
            if (
              command.type === "attach" &&
              commands.filter(({ command: item }) => item.type === "attach").length > 1
            )
              currentRef = { ...ref, subscriptionId: "subscription-2" };
            const disposition = onCommand?.(entry, peer);
            if (command.type === "attach")
              peer.result(command, { mode: "baseline", atSeq: currentRef === ref ? 0 : 1 });
            if (command.type === "applied-ack") {
              if (holdAcks) heldAcks.push(command);
              else peer.result(command, { appliedSeq: command.appliedSeq });
            }
            if (command.type === "baseline-progress")
              peer.result(command, {
                baselineId: command.baselineId,
                lastParsedOrdinal: command.lastParsedOrdinal,
              });
            return disposition ?? "handed-off";
          },
          close() {},
          dispose() {},
        });
        return { cancel: () => "not-sent" };
      },
    },
  });
  expect((await client.connect()).ok).toBe(true);
  const mounted = view(onApply, onBeginBaseline);
  if (!autoOpen) return { client, peer, mounted };
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

async function grant(controller, peer) {
  controller.setInputTarget(true, true);
  const pending = controller.requestFocus();
  const command = peer.commands.at(-1).command;
  peer.result(command, { epoch: 1, atSeq: 1 });
  expect((await pending).ok).toBe(true);
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
}

describe("client control authority", () => {
  test("compiled public open rejects every incomplete view before reserving or sending", async () => {
    const { client, peer, mounted } = await harness({ autoOpen: false });
    const ports = [
      "initialize",
      "beginBaseline",
      "writeBaselineChunk",
      "finishBaseline",
      "applyEvent",
      "measureGrid",
      "setAppearance",
      "setVisibility",
      "onInputIntent",
      "onFocusIntent",
      "onFailure",
      "dispose",
    ];
    for (const port of ports) {
      for (const absent of [true, false]) {
        const candidate = { ...mounted.terminalView };
        if (absent) delete candidate[port];
        else candidate[port] = 7;
        const opened = client.openTerminal({
          run,
          viewId: ref.viewId,
          view: candidate,
          initialAppearance: DEFAULT_APPEARANCE,
        });
        expect(opened).toMatchObject({
          ok: false,
          error: { category: "local", reason: "invalid-request" },
        });
        expect(peer.commands).toHaveLength(0);
        expect(mounted.disposed).toBe(0);
      }
    }
    const throwing = { ...mounted.terminalView };
    Object.defineProperty(throwing, "onInputIntent", {
      get() {
        throw new Error("accessor");
      },
    });
    expect(
      client.openTerminal({
        run,
        viewId: ref.viewId,
        view: throwing,
        initialAppearance: DEFAULT_APPEARANCE,
      }),
    ).toMatchObject({ ok: false, error: { category: "local", reason: "invalid-request" } });
    expect(peer.commands).toHaveLength(0);
    const valid = client.openTerminal({
      run,
      viewId: ref.viewId,
      view: mounted.terminalView,
      initialAppearance: DEFAULT_APPEARANCE,
    });
    expect(valid.ok).toBe(true);
    const attached = valid.value.attach();
    peer.baseline();
    await settle();
    expect((await attached).ok).toBe(true);
  });

  test("invalid replacement preserves the granted old view; complete replacement fences it", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const prior = controller.snapshot();
    const commandCount = peer.commands.length;
    const incomplete = { ...view().terminalView, onInputIntent: undefined };
    const refused = await controller.replaceView(incomplete);
    expect(refused).toMatchObject({
      ok: false,
      error: { category: "local", reason: "invalid-request" },
    });
    expect(controller.snapshot()).toEqual(prior);
    expect(peer.commands).toHaveLength(commandCount);
    expect(mounted.disposed).toBe(0);
    const throwing = { ...view().terminalView };
    Object.defineProperty(throwing, "onFocusIntent", {
      get() {
        throw new Error("accessor");
      },
    });
    expect(await controller.replaceView(throwing)).toMatchObject({
      ok: false,
      error: { category: "local", reason: "invalid-request" },
    });
    expect(controller.snapshot()).toEqual(prior);
    expect(peer.commands).toHaveLength(commandCount);
    mounted.input({
      viewGeneration: prior.viewGeneration,
      source: "keyboard",
      bytes: new Uint8Array([65]),
    });
    await settle();
    const input = peer.commands.at(-1).command;
    expect(input.type).toBe("input");
    peer.result(input, { epoch: 1, inputSeq: input.inputSeq, status: "written", writtenBytes: 1 });
    await settle();
    const replacement = view();
    const pending = controller.replaceView(replacement.terminalView);
    peer.baseline(1);
    await settle();
    expect((await pending).ok).toBe(true);
    expect(mounted.disposed).toBe(1);
    const count = peer.commands.length;
    mounted.focus({ viewGeneration: prior.viewGeneration, focusSeq: 2, focused: true, geometry });
    expect(peer.commands).toHaveLength(count);
    expect(controller.snapshot().inputReady).toBe(false);
  });

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

  test("wrong holder never grants and target loss sends only the held epoch blur", async () => {
    const { controller, peer } = await harness();
    controller.setVisibility(true);
    expect(peer.commands.filter(({ command }) => command.type === "focus")).toHaveLength(0);
    controller.setInputTarget(true, true);
    const pending = controller.requestFocus();
    const focus = peer.commands.at(-1).command;
    peer.result(focus, { epoch: 1, atSeq: 1 });
    expect((await pending).ok).toBe(true);
    peer.event({
      type: "control",
      run,
      seq: 1,
      epoch: 1,
      holder: { connection, viewId: ref.viewId, subscriptionId: "other" },
      geometry,
    });
    await settle();
    expect(controller.snapshot().inputReady).toBe(false);
    expect(peer.commands.filter(({ command }) => command.type === "blur")).toHaveLength(0);
    controller.setInputTarget(false, false);
    expect(peer.commands.filter(({ command }) => command.type === "blur")).toHaveLength(0);
  });

  test("target loss revokes a real grant before blur and does not refocus on visibility", async () => {
    const { controller, peer } = await harness();
    await grant(controller, peer);
    controller.setInputTarget(false, false);
    expect(controller.snapshot().inputReady).toBe(false);
    const blur = peer.commands.at(-1).command;
    expect(blur.type).toBe("blur");
    expect(blur.epoch).toBe(1);
    controller.setVisibility(true);
    expect(peer.commands.filter(({ command }) => command.type === "focus")).toHaveLength(1);
    peer.result(blur, { epoch: 1, atSeq: 2 });
    await settle();
    expect(controller.snapshot().inputReady).toBe(false);
  });

  test("renderer mutation cannot forge an applied holder or cursor", async () => {
    const { controller, peer } = await harness({
      onApply(event) {
        if (event.type === "control") {
          event.holder = { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId };
          event.seq = 100;
        }
      },
    });
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus();
    const command = peer.commands.at(-1).command;
    peer.result(command, { epoch: 1, atSeq: 1 });
    await focus;
    peer.event({ type: "control", run, seq: 1, epoch: 1, holder: null, geometry });
    await settle();
    expect(controller.snapshot().appliedSeq).toBe(1);
    expect(controller.snapshot().inputReady).toBe(false);
  });

  test("blur before a handed-off focus result releases only the late accepted epoch", async () => {
    const { controller, peer } = await harness();
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus();
    const requested = peer.commands.at(-1).command;
    const localBlur = await controller.blur();
    expect(localBlur).toEqual({ ok: true, value: undefined });
    peer.result(requested, { epoch: 1, atSeq: 1 });
    expect((await focus).ok).toBe(false);
    const cleanup = peer.commands.at(-1).command;
    expect(cleanup).toMatchObject({ type: "blur", epoch: 1, subscription: ref });
    peer.result(cleanup, { epoch: 1, atSeq: 2 });
    await settle();
    expect(controller.snapshot().inputReady).toBe(false);
  });

  test("resize and appearance remain proposals until ordered server facts apply", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const nextGeometry = { cols: 90, rows: 25 };
    const resize = controller.requestResize(nextGeometry);
    const resizeCommand = peer.commands.at(-1).command;
    expect(resizeCommand).toMatchObject({ type: "resize", epoch: 1, geometry: nextGeometry });
    expect(mounted.applied.filter((event) => event.type === "resize")).toHaveLength(0);
    peer.result(resizeCommand, { epoch: 1, atSeq: 2 });
    expect((await resize).ok).toBe(true);
    expect(mounted.applied.filter((event) => event.type === "resize")).toHaveLength(0);
    peer.event({ type: "resize", run, seq: 2, geometry: nextGeometry, requiresBaseline: false });
    await settle();
    expect(mounted.applied.filter((event) => event.type === "resize")).toHaveLength(1);
    const appearance = { ...DEFAULT_APPEARANCE, background: "1111/2222/3333" };
    const update = controller.updateAppearance(appearance);
    const appearanceCommand = peer.commands.at(-1).command;
    peer.result(appearanceCommand, { epoch: 1, atSeq: 3 });
    expect((await update).ok).toBe(true);
    expect(mounted.applied.filter((event) => event.type === "appearance")).toHaveLength(0);
    peer.event({ type: "appearance", run, seq: 3, appearance });
    await settle();
    expect(mounted.applied.filter((event) => event.type === "appearance")).toHaveLength(1);
  });

  test("same-ref baseline recovery does not manufacture a holder or focus loop", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const previous = controller.snapshot().subscription;
    const pending = controller.recover("gap");
    const command = peer.commands.at(-1).command;
    expect(command.type).toBe("recover");
    peer.result(command, { mode: "baseline", atSeq: 1 });
    peer.baseline(1);
    await settle();
    expect((await pending).ok).toBe(true);
    expect(controller.snapshot().subscription).toEqual(previous);
    expect(controller.snapshot().inputReady).toBe(false);
    expect(peer.commands.filter(({ command: item }) => item.type === "focus")).toHaveLength(1);
    const denied = await controller.sendInput({ source: "keyboard", bytes: new Uint8Array([65]) });
    expect(denied).toMatchObject({ ok: false, value: { notSentBytes: 1 } });
    mounted.focus({
      viewGeneration: controller.snapshot().viewGeneration,
      focusSeq: 1,
      focused: true,
      geometry,
    });
    expect(peer.commands.filter(({ command: item }) => item.type === "focus")).toHaveLength(2);
  });

  describe("a focus that resizes the PTY and the baseline recovery it triggers", () => {
    const larger = { cols: 100, rows: 30 };
    const self = { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId };
    const other = { connection, viewId: "view-2", subscriptionId: "subscription-9" };
    const focusCount = (peer) =>
      peer.commands.filter(({ command }) => command.type === "focus").length;

    // The worker emits the grid change as a resize that requires a baseline, then the grant.
    function grantFacts(peer) {
      peer.event({ type: "resize", run, seq: 1, geometry: larger, requiresBaseline: true });
      peer.event({ type: "control", run, seq: 2, epoch: 1, holder: self, geometry: larger });
    }

    async function recoverWith(peer, control, atSeq = 2) {
      await settle();
      const recover = peer.commands.findLast(({ command }) => command.type === "recover").command;
      expect(recover).toMatchObject({ reason: "resize-context" });
      peer.result(recover, { mode: "baseline", atSeq });
      peer.baseline(atSeq, { baselineId: "baseline-2", grid: larger, control });
      await settle();
    }

    test("the baseline's matching authority reinstates the grant and input sent after focus succeeds", async () => {
      const { controller, peer } = await harness();
      controller.setInputTarget(true, true);
      let resolved = false;
      const pending = controller.requestFocus(larger).then((outcome) => {
        resolved = true;
        return outcome;
      });
      const focus = peer.commands.at(-1).command;
      peer.result(focus, { epoch: 1, atSeq: 2 });
      grantFacts(peer);
      await settle();
      // The focus waits for the recovery its own resize triggered rather than resolving into it.
      expect(resolved).toBe(false);
      expect(controller.snapshot().phase).not.toBe("ready");
      // Input staged during the recovery is still cancelled, as for every recovery.
      expect(
        await controller.sendInput({ source: "keyboard", bytes: encoder.encode("early") }),
      ).toMatchObject({
        ok: false,
        error: { reason: "invalid-state" },
        value: { notSentBytes: 5 },
      });
      await recoverWith(peer, { epoch: 1, holder: self });
      expect(await pending).toEqual({ ok: true, value: { epoch: 1, atSeq: 2 } });
      expect(controller.snapshot()).toMatchObject({
        phase: "ready",
        inputReady: true,
        controlEpoch: 1,
        appliedGeometry: { geometry: larger, atSeq: 2 },
        appliedAuthority: { epoch: 1, holder: self, atSeq: 2 },
      });
      // Recovery regained the server's recorded authority without asking for focus again.
      expect(focusCount(peer)).toBe(1);
      const sent = controller.sendInput({ source: "keyboard", bytes: encoder.encode("x\r") });
      await settle();
      const input = peer.commands.at(-1).command;
      expect(input).toMatchObject({ type: "input", epoch: 1 });
      peer.result(input, {
        epoch: 1,
        inputSeq: input.inputSeq,
        status: "written",
        writtenBytes: 2,
      });
      expect(await sent).toMatchObject({ ok: true, value: { writtenBytes: 2, notSentBytes: 0 } });
    });

    test("a focus result that arrives during the recovery is carried to the baseline", async () => {
      const { controller, peer } = await harness();
      controller.setInputTarget(true, true);
      const pending = controller.requestFocus(larger);
      const focus = peer.commands.at(-1).command;
      grantFacts(peer);
      await settle();
      expect(controller.snapshot().phase).not.toBe("ready");
      peer.result(focus, { epoch: 1, atSeq: 2 });
      await recoverWith(peer, { epoch: 1, holder: self });
      expect(await pending).toEqual({ ok: true, value: { epoch: 1, atSeq: 2 } });
      expect(controller.snapshot()).toMatchObject({ inputReady: true, controlEpoch: 1 });
      expect(focusCount(peer)).toBe(1);
    });

    test("an older baseline epoch keeps the grant while its fact is still ahead, then waits for its ACK", async () => {
      const { controller, peer } = await harness({ holdAcks: true });
      while (peer.releaseAck());
      controller.setInputTarget(true, true);
      let resolved = false;
      const pending = controller.requestFocus(larger).then((outcome) => {
        resolved = true;
        return outcome;
      });
      peer.result(peer.commands.at(-1).command, { epoch: 1, atSeq: 2 });
      peer.event({ type: "resize", run, seq: 1, geometry: larger, requiresBaseline: true });
      // The baseline was captured between the resize and the grant (B = 1 < A = 2).
      await recoverWith(peer, { epoch: 0, holder: null }, 1);
      expect(resolved).toBe(false);
      expect(controller.snapshot()).toMatchObject({ phase: "ready", controlEpoch: 1 });
      peer.event({ type: "control", run, seq: 2, epoch: 1, holder: self, geometry: larger });
      await settle();
      // Applied but its covering ACK is still behind the held one: not yet usable for input.
      expect(controller.snapshot().inputReady).toBe(true);
      expect(resolved).toBe(false);
      while (peer.releaseAck()) await settle();
      expect(await pending).toEqual({ ok: true, value: { epoch: 1, atSeq: 2 } });
      expect(controller.snapshot().appliedAuthority).toMatchObject({ epoch: 1, holder: self });
      expect(focusCount(peer)).toBe(1);
    });

    test("an older baseline epoch at or after the grant's seq drops the grant", async () => {
      expect(await dropCarriedGrant({ epoch: 0, holder: null })).toBe(1);
    });

    test("a view cannot rewrite the baseline authority that decides reinstatement", async () => {
      const { controller, peer } = await harness({
        onBeginBaseline: (descriptor) => {
          try {
            descriptor.control.epoch = 1;
          } catch {
            /* frozen */
          }
          try {
            descriptor.control.holder = self;
          } catch {
            /* frozen */
          }
          try {
            descriptor.control = { epoch: 1, holder: self };
          } catch {
            /* frozen */
          }
        },
      });
      controller.setInputTarget(true, true);
      const pending = controller.requestFocus(larger);
      peer.result(peer.commands.at(-1).command, { epoch: 1, atSeq: 2 });
      grantFacts(peer);
      await recoverWith(peer, { epoch: 2, holder: other });
      expect(await pending).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
      const snapshot = controller.snapshot();
      expect(snapshot).toMatchObject({
        inputReady: false,
        appliedAuthority: { epoch: 2, holder: other, atSeq: 2 },
      });
      expect(snapshot.controlEpoch).toBeUndefined();
    });

    test("a focus whose resize never arrives settles as a timeout within the recovery budget", async () => {
      const scheduler = clock();
      const { controller, peer } = await harness({ scheduler });
      controller.setInputTarget(true, true);
      let outcome;
      void controller.requestFocus(larger).then((value) => (outcome = value));
      peer.result(peer.commands.at(-1).command, { epoch: 1, atSeq: 2 });
      await settle();
      scheduler.advance(M0_LIMITS.recoveryDeadlineMs - 1);
      await settle();
      expect(outcome).toBeUndefined();
      scheduler.advance(1);
      await settle();
      expect(outcome).toMatchObject({ ok: false, error: { reason: "timeout" } });
    });

    test("an older control fact before the grant's seq does not revoke it", async () => {
      const { controller, peer } = await harness();
      const third = { connection, viewId: "view-3", subscriptionId: "subscription-8" };
      peer.event({ type: "control", run, seq: 1, epoch: 1, holder: other, geometry });
      await settle();
      controller.setInputTarget(true, true);
      const pending = controller.requestFocus(geometry);
      peer.result(peer.commands.at(-1).command, { epoch: 3, atSeq: 3 });
      expect(await pending).toEqual({ ok: true, value: { epoch: 3, atSeq: 3 } });
      // Epoch 2 at seq 2 precedes the grant (epoch 3 at seq 3), so it says nothing against it.
      peer.event({ type: "control", run, seq: 2, epoch: 2, holder: third, geometry });
      await settle();
      expect(controller.snapshot().controlEpoch).toBe(3);
      peer.event({ type: "control", run, seq: 3, epoch: 3, holder: self, geometry });
      await settle();
      expect(controller.snapshot()).toMatchObject({ inputReady: true, controlEpoch: 3 });
      const sent = controller.sendInput({ source: "keyboard", bytes: encoder.encode("x") });
      await settle();
      const input = peer.commands.at(-1).command;
      expect(input).toMatchObject({ type: "input", epoch: 3 });
      peer.result(input, {
        epoch: 3,
        inputSeq: input.inputSeq,
        status: "written",
        writtenBytes: 1,
      });
      expect(await sent).toMatchObject({ ok: true });
    });

    test("a focus still awaiting its result survives a second resize recovery", async () => {
      const { controller, peer } = await harness();
      const third = { cols: 120, rows: 40 };
      const blurs = () => peer.commands.filter(({ command }) => command.type === "blur").length;
      controller.setInputTarget(true, true);
      const pending = controller.requestFocus(larger);
      const focus = peer.commands.at(-1).command;
      peer.event({ type: "resize", run, seq: 1, geometry: larger, requiresBaseline: true });
      await recoverWith(peer, { epoch: 0, holder: null }, 1);
      expect(controller.snapshot().phase).toBe("ready");
      // Another grid change before the focus result: a second resize-context recovery.
      peer.event({ type: "resize", run, seq: 2, geometry: third, requiresBaseline: true });
      await settle();
      const recover = peer.commands.findLast(({ command }) => command.type === "recover").command;
      peer.result(recover, { mode: "baseline", atSeq: 2 });
      peer.baseline(2, {
        baselineId: "baseline-3",
        grid: third,
        control: { epoch: 0, holder: null },
      });
      await settle();
      expect(peer.commands.filter(({ command }) => command.type === "recover")).toHaveLength(2);
      // The result arrives after both baselines; its fact (seq 3) is still ahead of B = 2.
      peer.result(focus, { epoch: 1, atSeq: 3 });
      await settle();
      expect(controller.snapshot().controlEpoch).toBe(1);
      peer.event({ type: "control", run, seq: 3, epoch: 1, holder: self, geometry: third });
      expect(await pending).toEqual({ ok: true, value: { epoch: 1, atSeq: 3 } });
      expect(controller.snapshot()).toMatchObject({ inputReady: true, controlEpoch: 1 });
      expect(blurs()).toBe(0);
      expect(focusCount(peer)).toBe(1);
    });

    test("a focus result after a baseline that rules it out settles as a failure", async () => {
      const { controller, peer } = await harness();
      controller.setInputTarget(true, true);
      let outcome;
      void controller.requestFocus(larger).then((value) => (outcome = value));
      const focus = peer.commands.at(-1).command;
      peer.event({ type: "resize", run, seq: 1, geometry: larger, requiresBaseline: true });
      // B = 2 reports epoch 0, so a grant of epoch 1 at A = 2 cannot be current.
      await recoverWith(peer, { epoch: 0, holder: null }, 2);
      peer.result(focus, { epoch: 1, atSeq: 2 });
      await settle();
      expect(outcome).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
      const snapshot = controller.snapshot();
      expect(snapshot.controlEpoch).toBeUndefined();
      expect(snapshot.inputReady).toBe(false);
    });

    // Returns how many focus commands were sent: recovery must not have asked again.
    async function dropCarriedGrant(control) {
      const { controller, peer } = await harness();
      controller.setInputTarget(true, true);
      const pending = controller.requestFocus(larger);
      peer.result(peer.commands.at(-1).command, { epoch: 1, atSeq: 2 });
      grantFacts(peer);
      await recoverWith(peer, control);
      expect(await pending).toMatchObject({ ok: false, error: { reason: "invalid-state" } });
      const snapshot = controller.snapshot();
      expect(snapshot).toMatchObject({ phase: "ready", inputReady: false });
      expect(snapshot.controlEpoch).toBeUndefined();
      expect(
        await controller.sendInput({ source: "keyboard", bytes: encoder.encode("x") }),
      ).toMatchObject({ ok: false, value: { notSentBytes: 1 } });
      return focusCount(peer);
    }

    test("another focus before the baseline drops the carried grant", async () => {
      expect(await dropCarriedGrant({ epoch: 2, holder: other })).toBe(1);
    });

    test("a blur before the baseline drops the carried grant", async () => {
      expect(await dropCarriedGrant({ epoch: 1, holder: null })).toBe(1);
    });
  });

  test("binary input is copied exactly and waits for an applied focus grant", async () => {
    const { controller, peer, mounted } = await harness();
    controller.setInputTarget(true, true);
    const denied = await controller.sendInput({
      source: "paste",
      bytes: new Uint8Array([27, 91, 54, 110]),
    });
    expect(denied.ok).toBe(false);
    const focus = controller.requestFocus();
    const focusCommand = peer.commands.at(-1).command;
    const original = new Uint8Array([0, 255, 27, 91, 54, 110]);
    const staged = controller.sendInput({ source: "paste", bytes: original });
    original.fill(42);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(0);
    peer.result(focusCommand, { epoch: 1, atSeq: 1 });
    expect((await focus).ok).toBe(true);
    peer.event({
      type: "control",
      run,
      seq: 1,
      epoch: 1,
      holder: { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId },
      geometry,
    });
    await settle();
    const first = peer.commands.find(({ command }) => command.type === "input");
    expect([...first.payload]).toEqual([0, 255, 27, 91, 54, 110]);
    peer.result(first.command, {
      epoch: 1,
      inputSeq: first.command.inputSeq,
      status: "written",
      writtenBytes: 6,
    });
    const result = await staged;
    expect(result).toEqual({
      ok: true,
      value: { inputId: 1, source: "paste", writtenBytes: 6, unknownBytes: 0, notSentBytes: 0 },
    });
    mounted.input({
      viewGeneration: controller.snapshot().viewGeneration,
      source: "mouse",
      bytes: new Uint8Array([27, 91, 77]),
    });
    await settle();
    const mouse = peer.commands.at(-1);
    expect(mouse.command.type).toBe("input");
    expect(mouse.command.inputSeq).toBe(2);
    expect([...mouse.payload]).toEqual([27, 91, 77]);
    peer.result(mouse.command, { epoch: 1, inputSeq: 2, status: "written", writtenBytes: 3 });
    await settle();
    expect(controller.snapshot().retainedInputBytes).toBe(0);
  });

  test("short written result keeps only its exact prefix and does not resend", async () => {
    const { controller, peer } = await harness();
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus();
    const focusCommand = peer.commands.at(-1).command;
    peer.result(focusCommand, { epoch: 1, atSeq: 1 });
    await focus;
    peer.event({
      type: "control",
      run,
      seq: 1,
      epoch: 1,
      holder: { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId },
      geometry,
    });
    await settle();
    const input = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([1, 2, 3, 4]) });
    await settle();
    const sent = peer.commands.at(-1);
    peer.result(sent.command, {
      epoch: 1,
      inputSeq: sent.command.inputSeq,
      status: "written",
      writtenBytes: 2,
    });
    const result = await input;
    expect(result.ok).toBe(false);
    expect(result.value).toEqual({
      inputId: 1,
      source: "keyboard",
      writtenBytes: 2,
      unknownBytes: 2,
      notSentBytes: 0,
    });
    expect(result.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("negotiated input cap rejects before any frame and releases bounded leases", async () => {
    const { controller, peer } = await harness({ budgets: { inputQueueBytes: 4 } });
    await grant(controller, peer);
    const tooLarge = await controller.sendInput({ source: "keyboard", bytes: new Uint8Array(5) });
    expect(tooLarge).toMatchObject({ ok: false, value: { inputId: null, notSentBytes: 5 } });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(0);
    const pending = controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await settle();
    expect(controller.snapshot().retainedInputBytes).toBe(4);
    const concurrent = await controller.sendInput({ source: "mouse", bytes: new Uint8Array([7]) });
    expect(concurrent).toMatchObject({ ok: false, value: { inputId: null, notSentBytes: 1 } });
    const sent = peer.commands.at(-1).command;
    peer.result(sent, { epoch: 1, inputSeq: sent.inputSeq, status: "written", writtenBytes: 4 });
    expect((await pending).ok).toBe(true);
    expect(controller.snapshot().retainedInputBytes).toBe(0);
  });

  test("overreported input result is invalid and never replays the submitted bytes", async () => {
    const { controller, peer } = await harness();
    await grant(controller, peer);
    const pending = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([1, 2]) });
    await settle();
    const sent = peer.commands.at(-1).command;
    peer.result(sent, { epoch: 1, inputSeq: sent.inputSeq, status: "written", writtenBytes: 3 });
    const outcome = await pending;
    expect(outcome).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 2, notSentBytes: 0 },
    });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("a received higher epoch blocks a queued input before socket handoff", async () => {
    const { controller, peer } = await harness();
    await grant(controller, peer);
    const first = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([1]) });
    const second = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([2]) });
    await settle();
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
    peer.event({ type: "control", run, seq: 2, epoch: 2, holder: null, geometry });
    expect(controller.snapshot().inputReady).toBe(false);
    const firstCommand = peer.commands.at(-1).command;
    peer.result(firstCommand, {
      epoch: 1,
      inputSeq: firstCommand.inputSeq,
      status: "written",
      writtenBytes: 1,
    });
    expect((await first).ok).toBe(true);
    const later = await second;
    expect(later).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 0, notSentBytes: 1 },
    });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("definitely not sent and handed-off lost-result have distinct byte outcomes", async () => {
    const refused = await harness({
      onCommand: ({ command }) => (command.type === "input" ? "not-sent" : undefined),
    });
    await grant(refused.controller, refused.peer);
    const notSent = await refused.controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([1, 2]),
    });
    expect(notSent).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 0, notSentBytes: 2 },
    });
    expect(notSent.error).toEqual({ category: "local", reason: "transport" });
    expect(refused.peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);

    const scheduler = clock();
    const unknown = await harness({ scheduler });
    await grant(unknown.controller, unknown.peer);
    const pending = unknown.controller.sendInput({
      source: "paste",
      bytes: new Uint8Array([3, 4]),
    });
    await settle();
    scheduler.advance(5_001);
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 2, notSentBytes: 0 },
    });
    expect(result.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    expect(unknown.peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  async function checkAdapterUncertainty(mode) {
    const { controller, peer } = await harness({
      onCommand: ({ command }) => {
        if (command.type !== "input") return undefined;
        if (mode === "throw") throw new Error("adapter uncertainty");
        return "unknown";
      },
    });
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) => notices.push(notice));
    const result = await controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(result).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 3, notSentBytes: 0 },
    });
    expect("operationId" in result.error).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0].outcome).toEqual(result);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
    return result;
  }

  test("adapter unknown on input directs inspect-run without resend", async () => {
    expect((await checkAdapterUncertainty("unknown")).error).toEqual(
      domainError("RESULT_UNKNOWN", "unknown", "input"),
    );
  });

  test("adapter throw on input directs inspect-run without resend", async () => {
    expect((await checkAdapterUncertainty("throw")).error).toEqual(
      domainError("RESULT_UNKNOWN", "unknown", "input"),
    );
  });

  test("prehandoff input timeout stays definite while noninput unknown stays generic", async () => {
    const scheduler = clock();
    const { controller, peer } = await harness({ scheduler });
    await grant(controller, peer);
    scheduler.expireNextSet();
    const noHandoff = await controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([1]),
    });
    expect(noHandoff).toMatchObject({
      ok: false,
      error: { category: "local", reason: "timeout" },
      value: { unknownBytes: 0, notSentBytes: 1 },
    });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(0);

    const other = await harness({
      onCommand: ({ command }) => (command.type === "focus" ? "unknown" : undefined),
    });
    other.controller.setInputTarget(true, true);
    const focus = await other.controller.requestFocus();
    expect(focus.ok).toBe(false);
    expect(focus.error).toEqual(domainError("RESULT_UNKNOWN", "unknown"));
    expect(focus.error.nextAction).toBe("query-operation");
    expect("subject" in focus.error).toBe(false);
  });

  test("validated remote input uncertainty is preserved as received", async () => {
    const remote = domainError("RESULT_UNKNOWN", "unknown", "input");
    const { controller, peer } = await harness({
      onCommand: ({ command }, activePeer) => {
        if (command.type === "input")
          activePeer.emit(4, {
            type: "error",
            requestId: command.requestId,
            run,
            commandType: "input",
            error: remote,
          });
      },
    });
    await grant(controller, peer);
    const result = await controller.sendInput({ source: "paste", bytes: new Uint8Array([1, 2]) });
    expect(result).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 2, notSentBytes: 0 },
    });
    expect(result.error).toEqual(remote);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("synchronous socket close during input send keeps inspect-run uncertainty", async () => {
    const scheduler = clock();
    const { controller, peer } = await harness({
      scheduler,
      onCommand: ({ command }, activePeer) => {
        if (command.type === "input") {
          activePeer.close();
          return "not-sent"; // A later disposition cannot undo an already attempted send.
        }
      },
    });
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) =>
      notices.push({ notice, snapshot: controller.snapshot() }),
    );
    const outcome = await controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(outcome).toMatchObject({
      ok: false,
      value: { inputId: 1, writtenBytes: 0, unknownBytes: 3, notSentBytes: 0 },
    });
    expect(outcome.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    expect("operationId" in outcome.error).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0].notice).toEqual({ kind: "input", outcome });
    expect(notices[0].snapshot).toMatchObject({ retainedInputBytes: 0, pendingInputIntents: 0 });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
    scheduler.advance(5_001);
    peer.close();
    await settle();
    expect(notices).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ retainedInputBytes: 0, pendingInputIntents: 0 });
  });

  test("asynchronous close after input handoff settles once without replay", async () => {
    const scheduler = clock();
    const { controller, peer } = await harness({ scheduler });
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) =>
      notices.push({ notice, snapshot: controller.snapshot() }),
    );
    const pending = controller.sendInput({ source: "paste", bytes: new Uint8Array([4, 5]) });
    await settle();
    const sent = peer.commands.filter(({ command }) => command.type === "input");
    expect(sent).toHaveLength(1);
    peer.close();
    const outcome = await pending;
    expect(outcome).toMatchObject({
      ok: false,
      value: { inputId: 1, writtenBytes: 0, unknownBytes: 2, notSentBytes: 0 },
    });
    expect(outcome.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    expect(notices).toHaveLength(1);
    expect(notices[0].notice).toEqual({ kind: "input", outcome });
    expect(notices[0].snapshot).toMatchObject({ retainedInputBytes: 0, pendingInputIntents: 0 });
    peer.result(sent[0].command, {
      epoch: 1,
      inputSeq: sent[0].command.inputSeq,
      status: "written",
      writtenBytes: 2,
    });
    scheduler.advance(5_001);
    await settle();
    expect(notices).toHaveLength(1);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("client disposal after input handoff retains the last public uncertainty notice", async () => {
    const { client, controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) =>
      notices.push({ notice, snapshot: controller.snapshot() }),
    );
    const pending = controller.sendInput({ source: "mouse", bytes: new Uint8Array([7]) });
    await settle();
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
    client.dispose();
    const outcome = await pending;
    expect(outcome).toMatchObject({
      ok: false,
      value: { inputId: 1, writtenBytes: 0, unknownBytes: 1, notSentBytes: 0 },
    });
    expect(outcome.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    expect(notices).toHaveLength(1);
    expect(notices[0].notice).toEqual({ kind: "input", outcome });
    expect(notices[0].snapshot).toMatchObject({ retainedInputBytes: 0, pendingInputIntents: 0 });
    expect(mounted.disposed).toBe(1);
    client.dispose();
    await settle();
    expect(notices).toHaveLength(1);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("queued and timer-expired pre-send input remains definitely unsent on close", async () => {
    const { controller, peer } = await harness();
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) => notices.push(notice));
    const first = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([1]) });
    const second = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([2, 3]) });
    await settle();
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
    peer.close();
    const [uncertain, unsent] = await Promise.all([first, second]);
    expect(uncertain.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    expect(uncertain.value).toMatchObject({ unknownBytes: 1, notSentBytes: 0 });
    expect(unsent.error).toEqual({ category: "local", reason: "invalid-state" });
    expect(unsent.value).toMatchObject({ writtenBytes: 0, unknownBytes: 0, notSentBytes: 2 });
    expect(notices).toEqual([
      { kind: "input", outcome: uncertain },
      { kind: "input", outcome: unsent },
    ]);
    expect(controller.snapshot()).toMatchObject({ retainedInputBytes: 0, pendingInputIntents: 0 });

    const scheduler = clock();
    const beforeSend = await harness({ scheduler });
    await grant(beforeSend.controller, beforeSend.peer);
    const priorTimerSets = scheduler.timerSets;
    scheduler.expireNextSet();
    const timed = await beforeSend.controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([9]),
    });
    expect(timed.error).toEqual({ category: "local", reason: "timeout" });
    expect(timed.value).toMatchObject({ writtenBytes: 0, unknownBytes: 0, notSentBytes: 1 });
    expect(scheduler.timerSets).toBe(priorTimerSets + 1);
    expect(scheduler.synchronousExpirations).toBe(1);
    expect(beforeSend.peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(
      0,
    );
    beforeSend.peer.close();
    expect(beforeSend.controller.snapshot()).toMatchObject({
      retainedInputBytes: 0,
      pendingInputIntents: 0,
    });
  });

  test("noninput close stays local and completed input is not rewritten", async () => {
    const { controller, peer } = await harness();
    await grant(controller, peer);
    const resize = controller.requestResize({ cols: 90, rows: 30 });
    await settle();
    expect(peer.commands.at(-1).command.type).toBe("resize");
    peer.close();
    const closed = await resize;
    expect(closed.error).toEqual({ category: "local", reason: "transport" });
    expect("subject" in closed.error).toBe(false);

    const writtenCase = await harness();
    await grant(writtenCase.controller, writtenCase.peer);
    const notices = [];
    writtenCase.controller.onInputOutcome((notice) => notices.push(notice));
    const pending = writtenCase.controller.sendInput({
      source: "keyboard",
      bytes: new Uint8Array([6, 7]),
    });
    await settle();
    const sent = writtenCase.peer.commands.at(-1).command;
    writtenCase.peer.result(sent, {
      epoch: 1,
      inputSeq: sent.inputSeq,
      status: "written",
      writtenBytes: 2,
    });
    const written = await pending;
    expect(written).toMatchObject({
      ok: true,
      value: { writtenBytes: 2, unknownBytes: 0, notSentBytes: 0 },
    });
    writtenCase.peer.close();
    await settle();
    expect(notices).toEqual([{ kind: "input", outcome: written }]);
    expect(
      writtenCase.peer.commands.filter(({ command }) => command.type === "input"),
    ).toHaveLength(1);
    expect(writtenCase.controller.snapshot()).toMatchObject({
      retainedInputBytes: 0,
      pendingInputIntents: 0,
    });
  });

  test("observer disposal during input admission prevents any input handoff", async () => {
    const { controller, peer } = await harness();
    await grant(controller, peer);
    controller.onState((snapshot) => {
      if (snapshot.retainedInputBytes > 0) controller.dispose();
    });
    const result = await controller.sendInput({ source: "keyboard", bytes: new Uint8Array([65]) });
    expect(result).toMatchObject({ ok: false, value: { writtenBytes: 0, notSentBytes: 1 } });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(0);
  });

  test("synchronous input result during socket.send settles one written receipt", async () => {
    const { controller, peer } = await harness({
      onCommand: ({ command, payload }, activePeer) => {
        if (command.type === "input")
          activePeer.result(command, {
            epoch: command.epoch,
            inputSeq: command.inputSeq,
            status: "written",
            writtenBytes: payload.byteLength,
          });
      },
    });
    await grant(controller, peer);
    const result = await controller.sendInput({ source: "keyboard", bytes: new Uint8Array([65]) });
    expect(result).toMatchObject({
      ok: true,
      value: { writtenBytes: 1, unknownBytes: 0, notSentBytes: 0 },
    });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("view and direct input share one public terminal outcome path", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) => notices.push(notice));
    mounted.input({
      viewGeneration: controller.snapshot().viewGeneration,
      source: "mouse",
      bytes: new Uint8Array([0, 255]),
    });
    await settle();
    const viewCommand = peer.commands.at(-1).command;
    peer.result(viewCommand, {
      epoch: 1,
      inputSeq: viewCommand.inputSeq,
      status: "written",
      writtenBytes: 2,
    });
    await settle();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "input",
      outcome: {
        ok: true,
        value: { inputId: 1, source: "mouse", writtenBytes: 2, unknownBytes: 0, notSentBytes: 0 },
      },
    });
    expect(Object.isFrozen(notices[0].outcome.value)).toBe(true);
    const direct = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([65]) });
    await settle();
    const directCommand = peer.commands.at(-1).command;
    peer.result(directCommand, {
      epoch: 1,
      inputSeq: directCommand.inputSeq,
      status: "written",
      writtenBytes: 1,
    });
    const result = await direct;
    expect(notices).toHaveLength(2);
    expect(notices[1].outcome).toEqual(result);
  });

  test("current nonadmitting view input is rejected visibly, obsolete callback is silent", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) => notices.push(notice));
    const generation = controller.snapshot().viewGeneration;
    const recovering = controller.recover("gap");
    const beforeInput = peer.commands.filter(({ command }) => command.type === "input").length;
    mounted.input({ viewGeneration: generation, source: "paste", bytes: new Uint8Array([65, 66]) });
    await settle();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "input",
      outcome: { ok: false, value: { inputId: null, notSentBytes: 2 } },
    });
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(
      beforeInput,
    );
    const recoverCommand = peer.commands.findLast(
      ({ command }) => command.type === "recover",
    ).command;
    peer.result(recoverCommand, { mode: "baseline", atSeq: 1 });
    peer.baseline(1);
    await settle();
    expect((await recovering).ok).toBe(true);
    const beforeStale = notices.length;
    mounted.staleInput({
      viewGeneration: generation,
      source: "keyboard",
      bytes: new Uint8Array([67]),
    });
    expect(notices).toHaveLength(beforeStale);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(
      beforeInput,
    );
  });

  test("renderer INPUT_REJECTED is a separate no-ID advisory and leaves control healthy", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const notices = [];
    controller.onInputOutcome((notice) => notices.push(notice));
    mounted.fail(domainError("INPUT_REJECTED"));
    expect(notices).toEqual([{ kind: "renderer-rejection", error: domainError("INPUT_REJECTED") }]);
    expect("outcome" in notices[0]).toBe(false);
    expect(controller.snapshot().inputReady).toBe(true);
    expect(peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(0);
  });

  test("view-origin not-sent and unknown each notify once; late result cannot replay", async () => {
    const refused = await harness({
      onCommand: ({ command }) => (command.type === "input" ? "not-sent" : undefined),
    });
    await grant(refused.controller, refused.peer);
    const refusedNotices = [];
    refused.controller.onInputOutcome((notice) => refusedNotices.push(notice));
    refused.mounted.input({
      viewGeneration: refused.controller.snapshot().viewGeneration,
      source: "paste",
      bytes: new Uint8Array([1]),
    });
    await settle();
    expect(refusedNotices).toHaveLength(1);
    expect(refusedNotices[0]).toMatchObject({
      kind: "input",
      outcome: { ok: false, value: { unknownBytes: 0, notSentBytes: 1 } },
    });

    const scheduler = clock();
    const unknown = await harness({ scheduler });
    await grant(unknown.controller, unknown.peer);
    const notices = [];
    unknown.controller.onInputOutcome((notice) => notices.push(notice));
    unknown.mounted.input({
      viewGeneration: unknown.controller.snapshot().viewGeneration,
      source: "keyboard",
      bytes: new Uint8Array([2]),
    });
    await settle();
    const pendingCommand = unknown.peer.commands.at(-1).command;
    scheduler.advance(5_001);
    await settle();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "input",
      outcome: { ok: false, value: { unknownBytes: 1, notSentBytes: 0 } },
    });
    expect(notices[0].outcome.error).toEqual(domainError("RESULT_UNKNOWN", "unknown", "input"));
    unknown.peer.result(pendingCommand, {
      epoch: 1,
      inputSeq: pendingCommand.inputSeq,
      status: "written",
      writtenBytes: 1,
    });
    await settle();
    expect(notices).toHaveLength(1);
    expect(unknown.peer.commands.filter(({ command }) => command.type === "input")).toHaveLength(1);
  });

  test("observer throw, rejection, unsubscribe and dispose do not suppress an owned final notice", async () => {
    const scheduler = clock();
    const { controller, peer } = await harness({ scheduler });
    await grant(controller, peer);
    const seen = [];
    controller.onInputOutcome(() => {
      throw new Error("observer");
    });
    controller.onInputOutcome(() => Promise.reject(new Error("async observer")));
    let self;
    self = controller.onInputOutcome(() => self.dispose());
    controller.onInputOutcome((notice) => {
      seen.push({ notice, retained: controller.snapshot().retainedInputBytes });
    });
    const pending = controller.sendInput({ source: "keyboard", bytes: new Uint8Array([65]) });
    await settle();
    controller.dispose();
    scheduler.advance(5_001);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].retained).toBe(0);
    expect(seen[0].notice.outcome).toEqual(result);
  });

  test("observer can dispose during the final notice after byte debt is released", async () => {
    const { controller, peer } = await harness({
      onCommand: ({ command, payload }, activePeer) => {
        if (command.type === "input")
          activePeer.result(command, {
            epoch: command.epoch,
            inputSeq: command.inputSeq,
            status: "written",
            writtenBytes: payload.byteLength,
          });
      },
    });
    await grant(controller, peer);
    const seen = [];
    controller.onInputOutcome(() => controller.dispose());
    controller.onInputOutcome((notice) => seen.push({ notice, snapshot: controller.snapshot() }));
    const result = await controller.sendInput({ source: "keyboard", bytes: new Uint8Array([65]) });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].notice.outcome).toEqual(result);
    expect(seen[0].snapshot).toMatchObject({
      phase: "disposed",
      retainedInputBytes: 0,
      pendingInputIntents: 0,
    });
  });
});

describe("input right after a focus grant (Issue #21)", () => {
  const holder = { connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId };
  const type = (controller, mounted, focusSeq, text, keyGeometry = geometry) => {
    // Mirrors the xterm view: every deliberate input is preceded by a focus intent.
    const viewGeneration = controller.snapshot().viewGeneration;
    mounted.focus({ viewGeneration, focusSeq, focused: true, geometry: keyGeometry });
    mounted.input({ viewGeneration, source: "keyboard", bytes: encoder.encode(text) });
  };
  const ofType = (peer, type) => peer.commands.filter(({ command }) => command.type === type);

  test("keys typed while the click's focus is pending ride that grant and follow its ack", async () => {
    const { controller, peer, mounted } = await harness({ holdAcks: true });
    // The attach commit's ack stays in flight, so the grant's covering ack must queue behind it.
    expect(ofType(peer, "applied-ack")).toHaveLength(1);
    const outcomes = [];
    controller.onInputOutcome((notice) => outcomes.push(notice.outcome));
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus(geometry);
    const text = "echo cove-web-ok\r";
    [...text].forEach((key, index) => type(controller, mounted, index + 1, key));
    await settle();
    expect(ofType(peer, "focus")).toHaveLength(1);
    expect(ofType(peer, "input")).toHaveLength(0);
    peer.result(ofType(peer, "focus")[0].command, { epoch: 1, atSeq: 1 });
    expect((await focus).ok).toBe(true);
    peer.event({ type: "control", run, seq: 1, epoch: 1, holder, geometry });
    await settle();
    // The grant is applied locally, but no ack covering seq 1 has reached the uplink yet.
    expect(controller.snapshot().inputReady).toBe(true);
    expect(ofType(peer, "input")).toHaveLength(0);
    peer.releaseAck();
    await settle();
    const ackIndex = peer.commands.findIndex(
      ({ command }) => command.type === "applied-ack" && command.appliedSeq >= 1,
    );
    expect(ackIndex).toBeGreaterThan(-1);
    const delivered = [];
    for (let index = 0; index < text.length; index++) {
      const inputs = ofType(peer, "input");
      expect(inputs).toHaveLength(index + 1);
      const entry = inputs[index];
      expect(peer.commands.indexOf(entry)).toBeGreaterThan(ackIndex);
      expect(entry.command.epoch).toBe(1);
      delivered.push(decoder.decode(entry.payload));
      peer.result(entry.command, {
        epoch: 1,
        inputSeq: entry.command.inputSeq,
        status: "written",
        writtenBytes: entry.payload.byteLength,
      });
      await settle();
    }
    expect(delivered.join("")).toBe(text);
    expect(outcomes).toHaveLength(text.length);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(ofType(peer, "focus")).toHaveLength(1);
    expect(controller.snapshot().controlEpoch).toBe(1);
  });

  test("repeated focus intents while holding control keep the epoch; a new grid refocuses", async () => {
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const text = "abc";
    [...text].forEach((key, index) => type(controller, mounted, index + 1, key));
    await settle();
    for (let index = 0; index < text.length; index++) {
      const entry = ofType(peer, "input")[index];
      expect(entry.command.epoch).toBe(1);
      expect(decoder.decode(entry.payload)).toBe(text[index]);
      peer.result(entry.command, {
        epoch: 1,
        inputSeq: entry.command.inputSeq,
        status: "written",
        writtenBytes: 1,
      });
      await settle();
    }
    expect(ofType(peer, "focus")).toHaveLength(1);
    expect(controller.snapshot().controlEpoch).toBe(1);
    mounted.focus({
      viewGeneration: controller.snapshot().viewGeneration,
      focusSeq: 10,
      focused: true,
      geometry: { cols: 100, rows: 30 },
    });
    expect(ofType(peer, "focus")).toHaveLength(2);
    expect(ofType(peer, "focus")[1].command.geometry).toEqual({ cols: 100, rows: 30 });
  });

  test("input under a resized grant waits for the ack covering the resize", async () => {
    const { controller, peer, mounted } = await harness({ holdAcks: true });
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus(geometry);
    peer.result(ofType(peer, "focus")[0].command, { epoch: 1, atSeq: 1 });
    expect((await focus).ok).toBe(true);
    peer.event({ type: "control", run, seq: 1, epoch: 1, holder, geometry });
    await settle();
    peer.releaseAck();
    await settle();
    peer.releaseAck();
    const resized = { cols: 90, rows: 30 };
    const resize = controller.requestResize(resized);
    await settle();
    peer.result(ofType(peer, "resize")[0].command, { epoch: 1, atSeq: 2 });
    expect((await resize).ok).toBe(true);
    type(controller, mounted, 1, "x", resized);
    await settle();
    expect(ofType(peer, "focus")).toHaveLength(1);
    expect(ofType(peer, "input")).toHaveLength(0);
    peer.event({ type: "resize", run, seq: 2, geometry: resized, requiresBaseline: false });
    await settle();
    const input = ofType(peer, "input")[0];
    expect(input).toBeDefined();
    const ack = peer.commands.findIndex(
      ({ command }) => command.type === "applied-ack" && command.appliedSeq >= 2,
    );
    expect(ack).toBeGreaterThan(-1);
    expect(peer.commands.indexOf(input)).toBeGreaterThan(ack);
  });

  test("input typed while a granted resize is in flight is held and delivered in order", async () => {
    // The protocol allows a resize fact without a baseline requirement; that is the case where
    // held input can continue under the same grant.
    const { controller, peer, mounted } = await harness();
    await grant(controller, peer);
    const outcomes = [];
    controller.onInputOutcome((notice) => outcomes.push(notice.outcome));
    const resized = { cols: 90, rows: 30 };
    const resize = controller.requestResize(resized);
    await settle();
    const resizeCommand = ofType(peer, "resize")[0];
    expect(resizeCommand).toBeDefined();
    // The view still reports the applied grid while the resize is settling.
    const text = "while-resizing";
    [...text].forEach((key, index) => type(controller, mounted, index + 1, key));
    await settle();
    expect(ofType(peer, "focus")).toHaveLength(1);
    expect(ofType(peer, "input")).toHaveLength(0);
    peer.result(resizeCommand.command, { epoch: 1, atSeq: 2 });
    expect((await resize).ok).toBe(true);
    await settle();
    // The result moved the server's fence to seq 2; input still waits for that fact's ack.
    expect(ofType(peer, "input")).toHaveLength(0);
    peer.event({ type: "resize", run, seq: 2, geometry: resized, requiresBaseline: false });
    await settle();
    const ack = peer.commands.findIndex(
      ({ command }) => command.type === "applied-ack" && command.appliedSeq >= 2,
    );
    expect(ack).toBeGreaterThan(-1);
    const delivered = [];
    for (let index = 0; index < text.length; index++) {
      const entry = ofType(peer, "input")[index];
      expect(entry).toBeDefined();
      expect(peer.commands.indexOf(entry)).toBeGreaterThan(ack);
      delivered.push(decoder.decode(entry.payload));
      peer.result(entry.command, {
        epoch: 1,
        inputSeq: entry.command.inputSeq,
        status: "written",
        writtenBytes: entry.payload.byteLength,
      });
      await settle();
    }
    expect(delivered.join("")).toBe(text);
    expect(outcomes).toHaveLength(text.length);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(controller.snapshot().controlEpoch).toBe(1);
  });

  test("reacquiring control: a key between the newer focus result and its fact keeps the grant", async () => {
    const { controller, peer, mounted } = await harness();
    // Another view holds epoch 2; this view's grant will be newer than that observed fact.
    peer.event({
      type: "control",
      run,
      seq: 1,
      epoch: 2,
      holder: { connection, viewId: "other-view", subscriptionId: "other-subscription" },
      geometry,
    });
    await settle();
    const outcomes = [];
    controller.onInputOutcome((notice) => outcomes.push(notice.outcome));
    controller.setInputTarget(true, true);
    const focus = controller.requestFocus(geometry);
    type(controller, mounted, 1, "a");
    await settle();
    expect(ofType(peer, "focus")).toHaveLength(1);
    peer.result(ofType(peer, "focus")[0].command, { epoch: 3, atSeq: 2 });
    expect((await focus).ok).toBe(true);
    type(controller, mounted, 2, "b");
    await settle();
    expect(ofType(peer, "focus")).toHaveLength(1);
    expect(outcomes).toHaveLength(0);
    peer.event({ type: "control", run, seq: 2, epoch: 3, holder, geometry });
    await settle();
    const delivered = [];
    for (let index = 0; index < 2; index++) {
      const entry = ofType(peer, "input")[index];
      expect(entry).toBeDefined();
      expect(entry.command.epoch).toBe(3);
      delivered.push(decoder.decode(entry.payload));
      peer.result(entry.command, {
        epoch: 3,
        inputSeq: entry.command.inputSeq,
        status: "written",
        writtenBytes: 1,
      });
      await settle();
    }
    expect(delivered.join("")).toBe("ab");
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect(controller.snapshot().controlEpoch).toBe(3);
  });
});
