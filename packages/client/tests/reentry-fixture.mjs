// Shared fixture for the re-entry matrix and the callback re-entry regressions
// (docs/terminal-architecture.md 4.4.8). It drives the compiled client against a small in-memory
// model of the server's terminal lane: one ordered event sequence per run, control epochs and a
// holder, a grid, and per-subscription focus/input counters. Every foreign-code call point the
// client and controller reach (credentials, codec, clock, ID supplier, HTTP and terminal
// transports and their cleanup, socket send, timer disposal, view operations and listener
// registration) has a one-shot hook a test can arm to reenter the client there.
import { TextDecoder, TextEncoder } from "node:util";
import { createClient } from "@cove/client";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { createTerminalDecoder, encodeTerminalFrame } from "@cove/protocol/terminal";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });
export const run = { serverId: "server-1", relayInstanceId: "instance-1", runId: "run-1" };
export const geometry = Object.freeze({ cols: 80, rows: 24 });
export const larger = Object.freeze({ cols: 100, rows: 30 });

export async function settle(turns = 30) {
  for (let index = 0; index < turns; index++) await Promise.resolve();
}

// A manual clock. yieldTurn only yields microtasks here; fairness tests use realScheduler().
export function manualClock() {
  let now = 0;
  const timers = new Set();
  return {
    nowMs: () => now,
    setTimer(delay, callback) {
      const timer = { deadline: now + delay, callback, delay, onDispose: undefined };
      timers.add(timer);
      return {
        dispose() {
          timers.delete(timer);
          timer.onDispose?.();
        },
        timer,
      };
    },
    yieldTurn: async () => {},
    advance(ms) {
      now += ms;
      for (const timer of [...timers])
        if (timer.deadline <= now && timers.delete(timer)) timer.callback();
    },
    get pending() {
      return timers.size;
    },
  };
}

// A manual clock whose yieldTurn is a host task the test runs explicitly with runTask(), so a
// fairness test counts what happens per task without depending on wall-clock time. Until
// `manual` is set (after the harness is set up), turns are granted at once.
export function manualTasks() {
  const clock = manualClock();
  const turns = [];
  const tasks = {
    ...clock,
    manual: false,
    yieldTurn() {
      if (!tasks.manual) return Promise.resolve();
      return new Promise((resolve) => turns.push(resolve));
    },
    // Runs one host task: every turn yielded before it continues, and what that work yields
    // waits for the next task.
    async runTask() {
      for (const resolve of turns.splice(0)) resolve();
      await settle(300);
    },
    get waitingTurns() {
      return turns.length;
    },
  };
  return tasks;
}

// Host-task scheduler: yieldTurn resolves on a macrotask, as the Scheduler contract requires.
export function realScheduler() {
  return {
    nowMs: () => Date.now(),
    setTimer(delay, callback) {
      const handle = setTimeout(callback, delay);
      return { dispose: () => clearTimeout(handle) };
    },
    yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function bootstrap(terminal, connection, budgets = {}) {
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
  if (read.frames.length !== 1 || !parser.finish().ok) throw new Error("bad command frame");
  return {
    command: JSON.parse(decoder.decode(read.frames[0].metadata)),
    payload: read.frames[0].payload,
  };
}

// A fake view whose every foreign-code point can run a one-shot hook.
export function fakeView(fired, grid = geometry) {
  const listeners = { focus: new Set(), input: new Set(), failure: new Set() };
  const hooks = {};
  const fire = (name) => {
    const hook = hooks[name];
    if (!hook) return;
    hooks[name] = undefined;
    fired?.(name);
    hook();
  };
  const state = { grid: { ...grid }, generation: -1, disposed: 0, applied: [] };
  const subscribe = (kind) => (listener) => {
    listeners[kind].add(listener);
    fire("register");
    return {
      dispose() {
        listeners[kind].delete(listener);
        fire("disposer");
      },
    };
  };
  const terminalView = {
    initialize: async (input) => {
      // A test can hold the view at its previous generation by setting a promise here.
      if (state.initializeGate) await state.initializeGate;
      state.generation = input.viewGeneration;
      fire("initialize");
    },
    beginBaseline: async () => fire("beginBaseline"),
    writeBaselineChunk: async () => fire("writeBaselineChunk"),
    finishBaseline: async () => fire("finishBaseline"),
    applyEvent: async (event) => {
      state.applied.push(event.type);
      // A test can hold the parse of an event by setting a promise here.
      if (state.applyGate) await state.applyGate;
      fire("applyEvent");
    },
    measureGrid: () => {
      fire("measureGrid");
      return { ...state.grid };
    },
    setAppearance: () => fire("setAppearance"),
    setVisibility: () => fire("setVisibility"),
    onInputIntent: subscribe("input"),
    onFocusIntent: subscribe("focus"),
    onFailure: subscribe("failure"),
    dispose: () => {
      state.disposed++;
      fire("dispose");
    },
  };
  return {
    terminalView,
    hooks,
    state,
    focus(focused, grid = state.grid, focusSeq) {
      const intent = {
        viewGeneration: state.generation,
        focusSeq: focusSeq ?? ++state.focusSeq,
        focused,
        geometry: { ...grid },
      };
      for (const listener of [...listeners.focus]) listener(intent);
    },
    input(text, source = "keyboard") {
      const intent = { viewGeneration: state.generation, source, bytes: encoder.encode(text) };
      for (const listener of [...listeners.input]) listener(intent);
    },
    fail(error) {
      for (const listener of [...listeners.failure]) listener(error);
    },
  };
}

// An in-memory server for one run. Replies are delivered on a microtask unless `syncReplies`.
function createServer({ syncReplies, onCommand, grid }) {
  const state = {
    seq: 0,
    epoch: 0,
    holder: null,
    grid: { ...grid },
    subscriptions: 0,
    commands: [],
    duplicates: [],
    stale: [],
    connections: 0,
  };
  let current;
  const seenFocus = new Map();
  const seenInput = new Map();
  const live = new Map();
  const key = (ref) => `${ref.connection.connectionId}/${ref.subscriptionId}`;
  const holderRef = () => (state.holder ? (live.get(state.holder) ?? null) : null);
  const holderFact = () => {
    const ref = holderRef();
    return ref
      ? { connection: ref.connection, viewId: ref.viewId, subscriptionId: ref.subscriptionId }
      : null;
  };
  const deliver = (work) => {
    if (syncReplies) work();
    else queueMicrotask(work);
  };
  const emit = (kind, metadata, payload) =>
    current?.callbacks.onBinary(frame(kind, metadata, payload));
  const result = (command, extra) =>
    emit(2, { type: `${command.type}-result`, requestId: command.requestId, run, ...extra });
  const error = (command, kind, acceptance = "not-accepted") =>
    emit(4, {
      type: "error",
      requestId: command.requestId,
      run,
      commandType: command.type,
      error: domainError(kind, acceptance),
    });
  const event = (body, payload) => {
    state.seq++;
    for (const ref of live.values())
      if (ref.connection.connectionId === current?.connection.connectionId)
        emit(
          3,
          { type: "run-event", subscription: ref, event: { run, seq: state.seq, ...body } },
          payload,
        );
  };
  const baseline = (ref) => {
    const baselineId = `baseline-${state.seq}-${ref.subscriptionId}`;
    const descriptor = {
      baselineId,
      run,
      subscription: ref,
      profile: PROFILE,
      encoding: BASELINE_ENCODING,
      checkpointSeq: state.seq,
      atSeq: state.seq,
      captureGeometry: { ...state.grid },
      currentGeometry: { ...state.grid },
      control: { epoch: state.epoch, holder: holderFact() },
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
    emit(3, { type: "baseline-start", run, descriptor });
    emit(
      3,
      { type: "baseline-chunk", run, subscription: ref, baselineId, ordinal: 0 },
      new Uint8Array([65]),
    );
    emit(3, {
      type: "baseline-end",
      run,
      subscription: ref,
      baselineId,
      chunkCount: 1,
      totalBytes: 1,
      atSeq: state.seq,
    });
  };
  const holds = (command) =>
    command.epoch === state.epoch && state.holder === key(command.subscription);
  // `onCommand` may answer a command itself, or return "drop" to hold it for `process` later.
  const handle = (entry) => {
    if (onCommand?.(entry, server) === "drop") return;
    answer(entry);
  };
  const answer = ({ command, payload }) => {
    switch (command.type) {
      case "attach": {
        const ref = {
          run,
          connection: current.connection,
          subscriptionId: `subscription-${++state.subscriptions}`,
          viewId: command.viewId,
        };
        live.set(key(ref), ref);
        result(command, { subscription: ref, mode: "baseline", atSeq: state.seq });
        baseline(ref);
        return;
      }
      case "recover":
        if (!live.has(key(command.subscription))) return error(command, "STALE_CONNECTION");
        result(command, { subscription: command.subscription, mode: "baseline", atSeq: state.seq });
        baseline(command.subscription);
        return;
      case "detach":
        live.delete(key(command.subscription));
        if (state.holder === key(command.subscription)) state.holder = null;
        result(command, { subscription: command.subscription, detached: true });
        return;
      case "focus": {
        const seen = seenFocus.get(key(command.subscription)) ?? 0;
        if (command.focusSeq <= seen) state.duplicates.push(command);
        seenFocus.set(key(command.subscription), command.focusSeq);
        state.epoch++;
        state.holder = key(command.subscription);
        const resizes =
          command.geometry.cols !== state.grid.cols || command.geometry.rows !== state.grid.rows;
        const atSeq = state.seq + (resizes ? 2 : 1);
        result(command, { subscription: command.subscription, epoch: state.epoch, atSeq });
        if (resizes) {
          state.grid = { ...command.geometry };
          event({ type: "resize", geometry: { ...state.grid }, requiresBaseline: true });
        }
        event({
          type: "control",
          epoch: state.epoch,
          holder: holderFact(),
          geometry: { ...state.grid },
        });
        return;
      }
      case "blur":
        if (holds(command)) {
          state.holder = null;
          result(command, {
            subscription: command.subscription,
            epoch: command.epoch,
            atSeq: state.seq + 1,
          });
          event({ type: "control", epoch: state.epoch, holder: null, geometry: { ...state.grid } });
        } else
          result(command, {
            subscription: command.subscription,
            epoch: command.epoch,
            atSeq: state.seq,
          });
        return;
      case "resize": {
        if (!holds(command)) return error(command, "STALE_CONTROL");
        const resizes =
          command.geometry.cols !== state.grid.cols || command.geometry.rows !== state.grid.rows;
        result(command, {
          subscription: command.subscription,
          epoch: command.epoch,
          atSeq: state.seq + (resizes ? 1 : 0),
        });
        if (resizes) {
          state.grid = { ...command.geometry };
          event({ type: "resize", geometry: { ...state.grid }, requiresBaseline: true });
        }
        return;
      }
      case "appearance":
        if (!holds(command)) return error(command, "STALE_CONTROL");
        result(command, {
          subscription: command.subscription,
          epoch: command.epoch,
          atSeq: state.seq + 1,
        });
        event({ type: "appearance", appearance: command.appearance });
        return;
      case "input": {
        if (!holds(command)) {
          state.stale.push(command);
          return error(command, "STALE_CONTROL");
        }
        const seen = seenInput.get(key(command.subscription)) ?? 0;
        if (command.inputSeq <= seen) state.duplicates.push(command);
        seenInput.set(key(command.subscription), command.inputSeq);
        server.written.push(decoder.decode(payload));
        result(command, {
          subscription: command.subscription,
          epoch: command.epoch,
          inputSeq: command.inputSeq,
          status: "written",
          writtenBytes: payload.byteLength,
        });
        return;
      }
      case "applied-ack":
        result(command, { subscription: command.subscription, appliedSeq: command.appliedSeq });
        return;
      case "baseline-progress":
        result(command, {
          subscription: command.subscription,
          baselineId: command.baselineId,
          lastParsedOrdinal: command.lastParsedOrdinal,
        });
        return;
      case "preview": {
        // A transfer: its result, then the preview events, which carry no subscription and are
        // routed to the client's preview owner rather than to a controller.
        const previewId = `preview-${state.commands.length}`;
        const previewResult = { status: "transfer", version: 1, previewId };
        state.lastPreview = { command, previewResult };
        result(command, previewResult);
        const preview = { run, previewId, version: 1 };
        emit(3, {
          type: "preview-start",
          ...preview,
          atSeq: state.seq,
          geometry: { ...state.grid },
          generatedAtMs: 1,
          vtBytes: 1,
          chunkCount: 1,
        });
        emit(3, { type: "preview-chunk", ...preview, ordinal: 0 }, new Uint8Array([65]));
        emit(3, { type: "preview-end", ...preview, atSeq: state.seq, totalBytes: 1 });
        return;
      }
      default:
        return;
    }
  };
  const server = {
    state,
    written: [],
    // Output from the PTY, ordered after everything before it.
    output(text) {
      event({ type: "output" }, encoder.encode(text));
    },
    // Another client takes control (a new epoch held by someone else).
    takeover() {
      state.epoch++;
      state.holder = "other";
      live.set("other", {
        run,
        connection: { connectionId: "other-connection", generation: 1 },
        subscriptionId: "subscription-other",
        viewId: "other-view",
      });
      event({
        type: "control",
        epoch: state.epoch,
        holder: holderFact(),
        geometry: { ...state.grid },
      });
    },
    // Another client resizes the PTY, forcing this one through a resize-context recovery.
    foreignResize(grid) {
      state.grid = { ...grid };
      event({ type: "resize", geometry: { ...state.grid }, requiresBaseline: true });
    },
    gap() {
      state.seq++;
      event({ type: "output" }, encoder.encode("gap"));
    },
    // The last preview's result again, after the client settled it: an unmatched preview reply.
    previewAgain() {
      if (state.lastPreview) result(state.lastPreview.command, state.lastPreview.previewResult);
    },
    // A frame no server may send (a command frame), which the client treats as a protocol
    // violation and retires the connection for.
    invalidFrame() {
      emit(1, { type: "applied-ack", requestId: "server-command", run });
    },
    close() {
      current?.callbacks.onClose();
    },
    open(callbacks) {
      const connection = { connectionId: `connection-${++state.connections}`, generation: 1 };
      current = { callbacks, connection };
      return connection;
    },
    receive(entry) {
      state.commands.push(entry);
      deliver(() => handle(entry));
    },
    // Answers a held command as the server would have.
    process: answer,
    // Answers a command with a domain error.
    fail: error,
    ofType(type) {
      return state.commands.filter(({ command }) => command.type === type);
    },
  };
  return server;
}

// The client's connection cleanup paths, by the method that releases a handle. A cleanup call
// point is named after the innermost of these on the stack (for example `commitTimerDispose`), so
// a test can arm the release on one path rather than whichever release happens first.
const CLEANUP_PATHS = [
  ["tryCommit", "commit"],
  ["failConnect", "fail"],
  ["fenceConnection", "fence"],
  ["loseConnectedAttempt", "lose"],
];

function callStack() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  return stack;
}

function cleanupPath() {
  const stack = callStack();
  let found;
  let at = Infinity;
  for (const [method, path] of CLEANUP_PATHS) {
    const index = stack.indexOf(`.${method} `);
    if (index >= 0 && index < at) {
      at = index;
      found = path;
    }
  }
  return found;
}

// The lane's callback points (docs/terminal-architecture.md 4.4.1): the sender callbacks
// (beforeSend, onHandoff, onSettled), the route callbacks a controller registers, and the
// client's lane owner (preview events, unmatched preview replies, protocol violations). They are
// internal, so the harness wraps them on the client's lane instance, which the compiled class
// keeps as an ordinary property. Each wrapper fires its one-shot hook inside the callback, before
// the callback itself runs, so the reentering action happens within the lane entry.
function instrumentLane(client, fire) {
  const lane = client.terminalLane;
  if (!lane || typeof lane.send !== "function" || typeof lane.register !== "function")
    throw new Error("fixture cannot reach the client's terminal lane");
  const inside = (name, callback) =>
    callback &&
    ((...args) => {
      fire(name);
      return callback(...args);
    });
  const send = lane.send.bind(lane);
  lane.send = (command, deadlineMs, onHandoff, onSettled, beforeSend, payload) =>
    send(
      command,
      deadlineMs,
      inside("onHandoff", onHandoff),
      inside("onSettled", onSettled),
      inside("beforeSend", beforeSend),
      payload,
    );
  const register = lane.register.bind(lane);
  lane.register = (ref, receive) => register(ref, inside("route", receive));
  const owner = lane.owner;
  for (const [method, name] of [
    ["preview", "ownerPreview"],
    ["previewReply", "ownerPreviewReply"],
    ["invalid", "ownerInvalid"],
  ])
    owner[method] = inside(name, owner[method].bind(owner));
}

export async function reentryHarness({
  scheduler = manualClock(),
  syncReplies = false,
  budgets = {},
  onCommand,
  grant = true,
  grid = geometry,
  disposition,
} = {}) {
  const hooks = {};
  const fired = [];
  const fire = (name, ...args) => {
    const hook = hooks[name];
    if (!hook) return;
    hooks[name] = undefined;
    fired.push(name);
    hook(...args);
  };
  // Fires the named release on the cleanup path it runs on, if it runs on one.
  const fireCleanup = (name) => {
    const path = cleanupPath();
    if (path) fire(`${path}${name}`);
  };
  const server = createServer({ syncReplies, onCommand, grid });
  let request = 0;
  let depth = 0;
  let maxDepth = 0;
  const tracked = [];
  // Every terminal transport opened, and whether the client has closed it since.
  const transports = [];
  // Connection ports entered while the client did not report the attempt as connecting.
  const portViolations = [];
  const phase = { rpc: false, failConnect: false };
  let client;
  const requireConnecting = (port) => {
    const status = client.snapshot().status;
    if (status !== "connecting") portViolations.push(`${port} entered while ${status}`);
  };
  const ports = {
    ...scheduler,
    // nowMs and setTimer registration are pure by contract; a violating implementation that
    // reenters here exercises the client's defensive ownership checks (4.4.1).
    nowMs() {
      if (callStack().includes(".beginConnect ")) fire("connectNowMs");
      return scheduler.nowMs();
    },
    setTimer(delay, callback) {
      const stack = callStack();
      const connect = stack.includes(".beginConnect ");
      const rpc = stack.includes(".dispatchRpc ");
      if (connect) fire("connectSetTimer");
      const handle = scheduler.setTimer(delay, callback);
      return {
        dispose() {
          handle.dispose();
          fire("timerDispose", delay);
          if (connect) fireCleanup("TimerDispose");
          if (rpc) fire("rpcTimerDispose");
        },
      };
    },
  };
  client = createClient({
    expectedServerId: run.serverId,
    expectedRelayInstanceId: run.relayInstanceId,
    buildVersion: "client-build",
    credentials: () => {
      fire("credentials");
      return {
        get authorization() {
          fire("credentialGetter");
          return "Bearer test";
        },
        terminalSecret: "a".repeat(43),
      };
    },
    codec: {
      encode(value) {
        if (phase.rpc) fire("rpcEncode");
        const stack = callStack();
        if (stack.includes(".startConnectTransports ")) fire("connectEncode");
        if (stack.includes("terminal-delivery")) fire("laneEncode");
        return encoder.encode(value);
      },
      decodeFatal(bytes) {
        const stack = callStack();
        if (stack.includes("decodeBootstrap")) fire("bootstrapDecode");
        if (stack.includes("terminal-delivery")) fire("laneDecode");
        return decoder.decode(bytes);
      },
    },
    createOpaqueId: () => {
      const id = `request-${++request}`;
      fire(phase.rpc ? "rpcRequestId" : "requestId", id);
      return id;
    },
    scheduler: ports,
    http: {
      post(httpRequest, callback) {
        if (httpRequest.path !== "/bootstrap") {
          // An RPC: the fixture has no RPC server, so the request fails as a transport would.
          fire("rpcPost");
          queueMicrotask(() => callback.onFailure({ reason: "transport" }));
          return { cancel: () => "not-sent" };
        }
        requireConnecting("http.post");
        fire("httpPost");
        // A bootstrap the server answered with a non-200 status fails the attempt (fail path).
        const status = phase.failConnect ? 500 : 200;
        const body = encoder.encode(JSON.stringify(bootstrap(false, undefined, budgets)));
        queueMicrotask(() =>
          callback.onResponse({
            status,
            headers: {},
            get body() {
              fire("responseGetter");
              return body;
            },
          }),
        );
        return {
          cancel: () => {
            fireCleanup("HttpCancel");
            return "not-sent";
          },
        };
      },
    },
    terminal: {
      open(callbacks) {
        requireConnecting("terminal.open");
        fire("terminalOpen");
        const connection = server.open(callbacks);
        const transport = { closed: false };
        transports.push(transport);
        callbacks.onOpen({
          send(message) {
            if (typeof message === "string") {
              fire("bootstrapSend");
              callbacks.onText(
                encoder.encode(JSON.stringify(bootstrap(true, connection, budgets))),
              );
              return "handed-off";
            }
            depth++;
            maxDepth = Math.max(maxDepth, depth);
            try {
              const entry = decodeCommand(message);
              fire("send", entry.command);
              server.receive(entry);
              // What send reports is up to the test; the frame reached the server either way.
              return disposition?.(entry.command) ?? "handed-off";
            } finally {
              depth--;
            }
          },
          close() {
            transport.closed = true;
            fireCleanup("TransportClose");
          },
          dispose() {
            transport.closed = true;
            fireCleanup("TransportDispose");
          },
        });
        return {
          cancel: () => {
            fireCleanup("TerminalCancel");
            return "not-sent";
          },
        };
      },
    },
  });
  instrumentLane(client, fire);
  if (!(await client.connect()).ok) throw new Error("fixture connect failed");
  const mounted = fakeView((name) => fired.push(`view:${name}`), grid);
  mounted.state.focusSeq = 0;
  const opened = client.openTerminal({
    run,
    viewId: "view-1",
    view: mounted.terminalView,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  if (!opened.ok) throw new Error("fixture open failed");
  const controller = opened.value;
  const attached = controller.attach();
  await settle();
  if (!(await attached).ok) throw new Error("fixture attach failed");
  const harness = {
    run,
    client,
    controller,
    mounted,
    server,
    scheduler,
    hooks,
    fired,
    phase,
    portViolations,
    // Transports the client opened and has not closed: at most the one it is connected through.
    get liveTransports() {
      return transports.filter((transport) => !transport.closed).length;
    },
    get maxSendDepth() {
      return maxDepth;
    },
    track(value) {
      if (value && typeof value.then === "function") tracked.push(value);
      return value;
    },
    // Lets every pending deadline elapse, so anything waiting must settle.
    async finish() {
      for (let step = 0; step < 40; step++) {
        await settle();
        scheduler.advance?.(1_000);
      }
      await settle();
      const pending = Symbol("pending");
      const outcomes = await Promise.all(
        tracked.map((promise) =>
          Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(pending), 50))]),
        ),
      );
      return outcomes.filter((outcome) => outcome === pending).length;
    },
  };
  if (grant) {
    controller.setInputTarget(true, true);
    const focused = controller.requestFocus(grid);
    await settle();
    if (!(await focused).ok) throw new Error("fixture focus failed");
    await settle();
    if (!controller.snapshot().inputReady) throw new Error("fixture grant not usable");
  }
  return harness;
}
