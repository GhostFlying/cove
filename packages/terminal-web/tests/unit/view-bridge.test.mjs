import { afterEach, expect, test, vi } from "vitest";
import { domainError } from "@cove/protocol/errors";
import {
  createTerminalViewBridgeEndpoint,
  createTerminalViewBridgeHost,
} from "../../dist/src/view-bridge.js";
import { decodeBridgeBytes, encodeBridgeBytes } from "../../dist/src/view-bridge-wire.js";

const cleanup = [];
afterEach(() => {
  for (const release of cleanup.splice(0)) release();
  vi.useRealTimers();
});

const geometry = { cols: 80, rows: 24 };
const initialization = (viewGeneration) => ({
  profile: "pragmatic-logical-grid-v1",
  encoding: "vt-checkpoint-tail-v1",
  geometry,
  appearance: { palette: [] },
  viewGeneration,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const turns = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function fixture(options = {}, endpointOptions = {}) {
  const listeners = {};
  const calls = [];
  const view = Object.fromEntries(
    ["initialize", "beginBaseline", "writeBaselineChunk", "finishBaseline", "applyEvent"].map(
      (method) => [method, vi.fn(async (...args) => calls.push({ method, args }))],
    ),
  );
  Object.assign(view, {
    measureGrid: vi.fn(() => ({ ...geometry })),
    setAppearance: vi.fn(),
    setVisibility: vi.fn(),
    dispose: vi.fn(),
    ...Object.fromEntries(
      ["onInputIntent", "onFocusIntent", "onFailure"].map((method) => [
        method,
        (listener) => {
          listeners[method] = listener;
          return { dispose: () => delete listeners[method] };
        },
      ]),
    ),
  });
  let endpoint;
  const sent = [];
  const received = [];
  const inbox = [];
  let paused = false;
  const host = createTerminalViewBridgeHost({
    bridgeGeneration: 7,
    postMessage(message) {
      sent.push(JSON.parse(message));
      queueMicrotask(() => endpoint.receiveMessage(message));
    },
    ...options,
  });
  endpoint = createTerminalViewBridgeEndpoint({
    bridgeGeneration: 7,
    view,
    initialGeometry: geometry,
    postMessage(message) {
      received.push(JSON.parse(message));
      if (paused) inbox.push(message);
      else queueMicrotask(() => host.receiveMessage(message));
    },
    ...endpointOptions,
  });
  cleanup.push(() => {
    host.dispose();
    endpoint.dispose();
  });
  return {
    host,
    endpoint,
    view,
    listeners,
    calls,
    sent,
    received,
    suspendHost: () => {
      paused = true;
    },
    resumeHost() {
      paused = false;
      for (const message of inbox.splice(0)) queueMicrotask(() => host.receiveMessage(message));
    },
  };
}

test("readiness requires a measured current physical generation", async () => {
  const f = fixture();
  expect(() => f.host.measureGrid()).toThrow("RESYNC REQUIRED");
  expect(await f.host.ready).toEqual(geometry);
  expect(f.host.measureGrid()).toEqual(geometry);
  f.endpoint.publishGeometry({ cols: 102, rows: 38 });
  await turns();
  expect(f.host.measureGrid()).toEqual({ cols: 102, rows: 38 });
  f.host.receiveMessage(
    JSON.stringify({ version: 1, bridgeGeneration: 6, kind: "geometry", value: geometry }),
  );
  expect(f.host.measureGrid()).toEqual({ cols: 102, rows: 38 });
});

test("parse completion, rather than posting, releases credit and the next ordered command", async () => {
  const f = fixture();
  await f.host.ready;
  const parse = deferred();
  f.view.writeBaselineChunk.mockImplementation(() => parse.promise);
  let applied = false;
  const writing = f.host.writeBaselineChunk(Uint8Array.of(1, 2, 3)).then(() => (applied = true));
  const finishing = f.host.finishBaseline();
  await turns();
  expect(f.view.writeBaselineChunk).toHaveBeenCalledTimes(1);
  expect(f.view.finishBaseline).not.toHaveBeenCalled();
  expect(applied).toBe(false);
  expect(f.host.snapshot().pendingCommands).toBe(2);
  expect(f.host.snapshot().chargedBytes).toBeGreaterThan(0);
  parse.resolve();
  await Promise.all([writing, finishing]);
  expect(f.view.finishBaseline).toHaveBeenCalledTimes(1);
  expect(f.host.snapshot()).toEqual({ pendingCommands: 0, chargedBytes: 0, closed: false });
});

test("every legal chunk in the complete 8MiB plus tail baseline can stream with bounded credit", async () => {
  const f = fixture();
  await f.host.ready;
  await f.host.initialize(initialization(1));
  const bytes = Uint8Array.from({ length: 65_536 }, (_, i) => i % 251);
  let total = 0;
  let largestReservation = 0;
  f.view.writeBaselineChunk.mockImplementation(async (chunk) => {
    expect(chunk).toEqual(bytes);
    total += chunk.byteLength;
  });
  for (let i = 0; i < 129; i++) {
    const pending = f.host.writeBaselineChunk(bytes);
    largestReservation = Math.max(largestReservation, f.host.snapshot().chargedBytes);
    await pending;
  }
  expect(total).toBe(8 * 1024 * 1024 + 64 * 1024);
  expect(largestReservation).toBeLessThan(1024 * 1024);
  expect(f.host.snapshot().chargedBytes).toBe(0);
});

test("outbound bytes are captured at admission and preserve binary boundaries", async () => {
  const f = fixture();
  await f.host.ready;
  const bytes = Uint8Array.of(0, 128, 255, 13, 10);
  const pending = f.host.applyEvent({ type: "output" }, bytes);
  bytes.fill(42);
  await pending;
  expect(f.view.applyEvent.mock.calls[0][1]).toEqual(Uint8Array.of(0, 128, 255, 13, 10));
});

test("controller view generations can advance without recreating the physical bridge", async () => {
  const f = fixture();
  await f.host.ready;
  const input = vi.fn();
  const focus = vi.fn();
  f.host.onInputIntent(input);
  f.host.onFocusIntent(focus);
  await f.host.initialize(initialization(1));
  await f.host.initialize(initialization(2));
  f.listeners.onInputIntent({ viewGeneration: 1, source: "keyboard", bytes: Uint8Array.of(1) });
  f.listeners.onInputIntent({ viewGeneration: 2, source: "paste", bytes: Uint8Array.of(2, 3) });
  f.listeners.onFocusIntent({ viewGeneration: 1, focusSeq: 1, focused: true, geometry });
  f.listeners.onFocusIntent({ viewGeneration: 2, focusSeq: 1, focused: false, geometry });
  await turns();
  expect(input.mock.calls).toEqual([
    [{ viewGeneration: 2, source: "paste", bytes: Uint8Array.of(2, 3) }],
  ]);
  expect(focus.mock.calls).toEqual([
    [{ viewGeneration: 2, focusSeq: 1, focused: false, geometry }],
  ]);
});

test("old physical ACKs cannot settle a new view's in-flight application", async () => {
  const f = fixture();
  await f.host.ready;
  const parse = deferred();
  f.view.writeBaselineChunk.mockImplementation(() => parse.promise);
  const pending = f.host.writeBaselineChunk(Uint8Array.of(1));
  await turns();
  const command = f.sent.find((frame) => frame.kind === "command");
  f.host.receiveMessage(
    JSON.stringify({
      version: 1,
      bridgeGeneration: 6,
      kind: "ack",
      commandId: command.commandId,
      value: geometry,
    }),
  );
  expect(f.host.snapshot().pendingCommands).toBe(1);
  parse.resolve();
  await pending;
});

test("queue capacity closes dependent work and disposes the endpoint without replay", async () => {
  const f = fixture({ maxPendingCommands: 1 });
  await f.host.ready;
  const parse = deferred();
  f.view.writeBaselineChunk.mockImplementation(() => parse.promise);
  const first = f.host.writeBaselineChunk(Uint8Array.of(1)).catch((error) => error);
  await turns();
  const second = f.host.finishBaseline().catch((error) => error);
  expect((await first).kind).toBe("BUSY");
  expect((await second).kind).toBe("BUSY");
  await turns();
  expect(f.view.dispose).toHaveBeenCalledTimes(1);
  parse.resolve();
  await turns();
  expect(f.view.finishBaseline).not.toHaveBeenCalled();
  expect(f.host.snapshot()).toEqual({ pendingCommands: 0, chargedBytes: 0, closed: true });
});

test("lost parse acknowledgement expires and settles all reservations", async () => {
  vi.useFakeTimers();
  const f = fixture({ timeoutMs: 30 });
  await f.host.ready;
  const parse = deferred();
  f.view.writeBaselineChunk.mockImplementation(() => parse.promise);
  const pending = f.host.writeBaselineChunk(Uint8Array.of(1)).catch((error) => error);
  await turns();
  await vi.advanceTimersByTimeAsync(31);
  expect((await pending).kind).toBe("RESYNC_REQUIRED");
  expect(f.host.snapshot().chargedBytes).toBe(0);
  expect(f.view.dispose).toHaveBeenCalledTimes(1);
  parse.resolve();
});

test("normal disposal rejects pending work without publishing a spurious view failure", async () => {
  const f = fixture();
  await f.host.ready;
  const failure = vi.fn();
  f.host.onFailure(failure);
  const parse = deferred();
  f.view.writeBaselineChunk.mockImplementation(() => parse.promise);
  const pending = f.host.writeBaselineChunk(Uint8Array.of(1)).catch((error) => error);
  await turns();
  f.host.dispose();
  expect((await pending).kind).toBe("RESYNC_REQUIRED");
  await turns();
  expect(failure).not.toHaveBeenCalled();
  expect(f.view.dispose).toHaveBeenCalledTimes(1);
  expect(() => f.host.measureGrid()).toThrow("RESYNC REQUIRED");
  parse.resolve();
});

test("a real view application failure is not acknowledged as applied", async () => {
  const f = fixture();
  await f.host.ready;
  f.view.applyEvent.mockRejectedValue(new Error("view failed"));
  await expect(f.host.applyEvent({ type: "output" }, Uint8Array.of(1))).rejects.toMatchObject({
    kind: "RESYNC_REQUIRED",
  });
  expect(f.host.snapshot().closed).toBe(true);
  expect(f.view.dispose).toHaveBeenCalledTimes(1);
});

test("failed initial ready delivery releases the real view and all subscriptions", () => {
  const releases = [vi.fn(), vi.fn(), vi.fn()];
  const dispose = vi.fn();
  const view = {
    dispose,
    onInputIntent: () => ({ dispose: releases[0] }),
    onFocusIntent: () => ({ dispose: releases[1] }),
    onFailure: () => ({ dispose: releases[2] }),
  };
  expect(() =>
    createTerminalViewBridgeEndpoint({
      bridgeGeneration: 7,
      view,
      initialGeometry: geometry,
      postMessage: () => {
        throw new Error("content process departed");
      },
    }),
  ).toThrow("content process departed");
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("corrupt current-generation user input fails visibly instead of silently dropping bytes", async () => {
  const f = fixture();
  await f.host.ready;
  await f.host.initialize(initialization(1));
  const failure = vi.fn();
  f.host.onFailure(failure);
  f.host.receiveMessage(
    JSON.stringify({
      version: 1,
      bridgeGeneration: 7,
      kind: "input",
      noticeId: 1,
      value: { viewGeneration: 1, source: "keyboard" },
      bytes: "AB==",
    }),
  );
  expect(failure).toHaveBeenCalledTimes(1);
  expect(f.host.snapshot().closed).toBe(true);
});

test("a stalled host cannot accumulate unbounded input IPC or replay overflowed notices", async () => {
  const f = fixture({}, { maxPendingNotices: 2 });
  await f.host.ready;
  await f.host.initialize(initialization(1));
  const input = vi.fn();
  f.host.onInputIntent(input);
  f.suspendHost();
  const emitInput = f.listeners.onInputIntent;
  emitInput({ viewGeneration: 1, source: "keyboard", bytes: Uint8Array.of(1) });
  emitInput({ viewGeneration: 1, source: "keyboard", bytes: Uint8Array.of(2) });
  expect(f.endpoint.snapshot().pendingNotices).toBe(2);
  expect(f.received.filter((frame) => frame.kind === "input")).toHaveLength(1);
  emitInput({ viewGeneration: 1, source: "keyboard", bytes: Uint8Array.of(3) });
  expect(f.endpoint.snapshot()).toEqual({ pendingNotices: 0, chargedBytes: 0, closed: true });
  expect(f.view.dispose).toHaveBeenCalledTimes(1);
  f.resumeHost();
  await turns();
  expect(input).toHaveBeenCalledTimes(1);
  expect(f.host.snapshot().closed).toBe(true);
  expect(f.received.filter((frame) => frame.kind === "input")).toHaveLength(1);
});

test("host receipt preserves focus/input/layout order but never proves PTY acceptance or retries", async () => {
  vi.useFakeTimers();
  const f = fixture({}, { timeoutMs: 30 });
  await f.host.ready;
  await f.host.initialize(initialization(1));
  const delivered = [];
  const remoteWrite = deferred();
  let remoteSettled = false;
  void remoteWrite.promise.then(() => (remoteSettled = true));
  f.host.onFocusIntent(() => delivered.push("focus"));
  f.host.onInputIntent(() => delivered.push("input"));
  f.suspendHost();
  f.listeners.onFocusIntent({ viewGeneration: 1, focusSeq: 1, focused: true, geometry });
  f.listeners.onInputIntent({ viewGeneration: 1, source: "keyboard", bytes: Uint8Array.of(1) });
  f.endpoint.publishGeometry({ cols: 91, rows: 32 });
  expect(f.endpoint.snapshot().pendingNotices).toBe(3);
  f.resumeHost();
  await turns();
  expect(delivered).toEqual(["focus", "input"]);
  expect(f.host.measureGrid()).toEqual({ cols: 91, rows: 32 });
  expect(f.endpoint.snapshot().pendingNotices).toBe(0);
  expect(remoteSettled).toBe(false);
  f.suspendHost();
  f.listeners.onInputIntent({ viewGeneration: 1, source: "keyboard", bytes: Uint8Array.of(2) });
  const postedInputs = f.received.filter((frame) => frame.kind === "input").length;
  await vi.advanceTimersByTimeAsync(31);
  expect(f.endpoint.snapshot()).toEqual({ pendingNotices: 0, chargedBytes: 0, closed: true });
  expect(f.received.filter((frame) => frame.kind === "input")).toHaveLength(postedInputs);
  remoteWrite.resolve();
});

test("recoverable input rejection reaches the controller without retiring the terminal view", async () => {
  const f = fixture();
  await f.host.ready;
  await f.host.initialize(initialization(1));
  const failure = vi.fn();
  f.host.onFailure(failure);
  f.listeners.onFailure(domainError("INPUT_REJECTED"));
  await turns();
  expect(failure.mock.calls[0][0].kind).toBe("INPUT_REJECTED");
  expect(f.host.snapshot().closed).toBe(false);
  expect(f.endpoint.snapshot().closed).toBe(false);
  expect(f.view.dispose).not.toHaveBeenCalled();
  await f.host.applyEvent({ type: "output" }, Uint8Array.of(1));
});

test("the wire codec handles legal binary sizes and rejects corrupt padding or over-limit data", () => {
  for (const length of [0, 1, 2, 3, 65_534, 65_535, 65_536]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
    const encoded = encodeBridgeBytes(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(decodeBridgeBytes(encoded)).toEqual(bytes);
  }
  for (const text of ["A", "A===", "AA=A", "AB==", "AAB=", "    "])
    expect(decodeBridgeBytes(text)).toBeNull();
  expect(() => encodeBridgeBytes(new Uint8Array(65_537))).toThrow(
    "Terminal bridge payload exceeds the terminal chunk limit",
  );
  expect(decodeBridgeBytes(Buffer.alloc(65_537).toString("base64"))).toBeNull();
});
