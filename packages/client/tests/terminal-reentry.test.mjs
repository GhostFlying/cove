// Callback re-entry (docs/terminal-architecture.md 4.4.8): a systematic matrix of every foreign
// code call point the client and controller reach against every reentering action, plus the named
// regressions from #84, the #80 round-4 failure modes and the design review rounds 1-3.
import { describe, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { domainError } from "@cove/protocol/errors";
import {
  encoder,
  fakeView,
  larger,
  realScheduler,
  reentryHarness,
  settle,
} from "./reentry-fixture.mjs";

const keyboard = (text) => ({ source: "keyboard", bytes: encoder.encode(text) });

// Sends one input and records it with its outcome, in admission order.
function type(h, text) {
  const outcome = h.controller.sendInput(keyboard(text));
  h.inputs.push({ text, outcome });
  return outcome;
}

// Each action reenters the controller, the view or the client from inside foreign code. Returned
// promises are tracked so the invariant "every promise settles" covers them.
const ACTIONS = {
  dispose: (h) => h.controller.dispose(),
  detach: (h) => h.controller.detach(),
  replaceView: (h) => h.controller.replaceView(fakeView().terminalView),
  attach: (h) => h.controller.attach(),
  recover: (h) => h.controller.recover("gap"),
  requestFocus: (h) => h.controller.requestFocus(larger),
  setInputTarget: (h) => h.controller.setInputTarget(true, false),
  blur: (h) => h.controller.blur(),
  requestResize: (h) => h.controller.requestResize(larger),
  updateAppearance: (h) => h.controller.updateAppearance({ ...DEFAULT_APPEARANCE }),
  sendInput: (h) => type(h, "r"),
  setVisibility: (h) => h.controller.setVisibility(false),
  // The application reinitializes the mounted view underneath the controller.
  initialize: (h) =>
    h.mounted.terminalView.initialize({
      geometry: { ...h.mounted.state.grid },
      appearance: { ...DEFAULT_APPEARANCE },
      viewGeneration: h.mounted.state.generation + 1,
    }),
  clientDispose: (h) => {
    h.clientDisposed = true;
    return h.client.dispose();
  },
  reconnect: (h) => h.client.reconnect(),
};

// Call points (docs/terminal-architecture.md 4.4.1). Port and connection points are hooks in the
// harness's ports; view points are hooks in the mounted view; observers subscribe once.
// Lane points: the ID supplier, socket send, timer disposal, the codec encoding a command before
// it is registered and decoding a received frame, and the getters of a view being installed.
const LANE_POINTS = ["requestId", "send", "timerDispose", "laneEncode", "laneDecode", "viewGetter"];
// The view operations the controller calls. It never calls setAppearance (appearance arrives as
// an event through applyEvent); the application does, and terminal-web covers that re-entry.
const VIEW_POINTS = [
  "measureGrid",
  "initialize",
  "beginBaseline",
  "writeBaselineChunk",
  "finishBaseline",
  "applyEvent",
  "setVisibility",
  "register",
  "disposer",
  "dispose",
];
const OBSERVER_POINTS = ["controllerState", "inputNotice", "clientState"];
// Connection points: credentials and their getters, the clock and timer registration before an
// attempt is installed, the codec, the terminal and HTTP transports and the response getters, and
// every handle release on each cleanup path (commit, fail, fence by reconnect, loss).
const CONNECTION_POINTS = [
  "connectNowMs",
  "connectSetTimer",
  "credentials",
  "credentialGetter",
  "connectEncode",
  "terminalOpen",
  "bootstrapSend",
  "bootstrapDecode",
  "httpPost",
  "responseGetter",
  "commitTimerDispose",
  "commitHttpCancel",
  "failTimerDispose",
  "failHttpCancel",
  "failTerminalCancel",
  "failTransportClose",
  "failTransportDispose",
  "fenceTerminalCancel",
  "fenceTransportClose",
  "fenceTransportDispose",
  "loseTerminalCancel",
  "loseTransportClose",
  "loseTransportDispose",
];
// RPC points: the ID supplier and codec before the RPC entry is installed, the request, its timer.
const RPC_POINTS = ["rpcRequestId", "rpcEncode", "rpcPost", "rpcTimerDispose"];

function arm(h, point, action) {
  const run = () => {
    try {
      h.track(ACTIONS[action](h));
    } catch (error) {
      h.thrown.push(error);
    }
  };
  if (VIEW_POINTS.includes(point)) h.mounted.hooks[point] = run;
  else if (OBSERVER_POINTS.includes(point)) {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      h.fired.push(point);
      run();
    };
    if (point === "controllerState") h.controller.onState(once);
    if (point === "inputNotice") h.controller.onInputOutcome(once);
    if (point === "clientState") h.client.onState(once);
  } else h.hooks[point] = run;
}

// A view whose property reads, made while the controller installs it, can reenter.
function observedView(h) {
  const view = fakeView().terminalView;
  return new Proxy(view, {
    get(target, key) {
      const hook = h.hooks.viewGetter;
      if (hook) {
        h.hooks.viewGetter = undefined;
        h.fired.push("viewGetter");
        hook();
      }
      return target[key];
    },
  });
}

// One scenario that passes every call point at least once: input, output (ACK), a focus that
// measures, appearance, visibility, a resize recovery, a rejected input notice, a replacement, an
// RPC, a reconnect (fencing the connection, then committing a new one), a lost transport, a
// connect whose bootstrap fails and a final connect.
async function drive(h) {
  const step = (work) => {
    try {
      h.track(work());
    } catch (error) {
      h.thrown.push(error);
    }
  };
  step(() => type(h, "a"));
  await settle();
  h.server.output("o");
  await settle();
  step(() => h.controller.requestFocus());
  step(() =>
    h.controller.updateAppearance({ ...DEFAULT_APPEARANCE, foreground: "1234/5678/9abc" }),
  );
  step(() => h.controller.setVisibility(true));
  await settle();
  step(() => h.controller.requestResize(larger));
  await settle();
  step(() => type(h, "b"));
  step(() => h.controller.sendInput({ source: "keyboard", bytes: "not bytes" }));
  await settle();
  step(() => h.controller.replaceView(observedView(h)));
  await settle();
  h.phase.rpc = true;
  step(() => h.client.getOperation("operation-1"));
  h.phase.rpc = false;
  await settle();
  // Moves the client through connecting/connected, which client state observers see.
  step(() => h.client.reconnect());
  await settle();
  h.server.close();
  await settle();
  h.phase.failConnect = true;
  step(() => h.client.reconnect());
  await settle();
  h.phase.failConnect = false;
  step(() => h.client.reconnect());
  await settle();
}

// The invariants every matrix case must keep, as a list of violations: no nested lane send, no
// reused focusSeq/inputSeq, nothing thrown out of foreign code, every promise settled, only true
// input receipts, and a coherent client: a disposed client stays disposed, connection ports run
// only for the attempt the client reports as connecting, and no transport outlives its attempt.
async function violations(h) {
  const found = [];
  if (h.maxSendDepth > 1) found.push(`nested lane send (depth ${h.maxSendDepth})`);
  if (h.server.state.duplicates.length) found.push("reused focusSeq or inputSeq");
  if (h.thrown.length) found.push(`thrown: ${h.thrown.map(String).join(", ")}`);
  const pending = await h.finish();
  if (pending) found.push(`${pending} promises never settled`);
  for (const { text } of await untrueReceipts(h)) found.push(`untrue receipt for ${text}`);
  found.push(...h.portViolations);
  const status = h.client.snapshot().status;
  if (h.clientDisposed && status !== "disposed") found.push(`disposed client became ${status}`);
  const allowed = status === "connected" ? 1 : 0;
  if (h.liveTransports > allowed) found.push(`${h.liveTransports} live transports while ${status}`);
  return found;
}

// The PTY received the inputs in admission order, each at most once, and every receipt is true:
// an input reported written was written, one reported not sent was not, and only one whose
// outcome is unknown (handed off before its connection was lost) may go either way.
async function untrueReceipts(h) {
  const written = [...h.server.written];
  const untrue = [];
  for (const { text, outcome } of h.inputs) {
    const result = await outcome;
    const wasWritten = written[0] === text;
    if (wasWritten) written.shift();
    if (result.ok ? !wasWritten : result.value.unknownBytes === 0 && wasWritten)
      untrue.push({ text, result });
  }
  for (const text of written) untrue.push({ text: `${text} (written without an input)` });
  return untrue;
}

// Runs every combination of the given points with every action. Each case reports its violations
// by name, and the result lists unreached call points, so a test fails unless every combination
// ran and reached its call point. The matrix is three tests, not one per case, because the CI
// gate discovers tests statically and counts a test declared in a loop once.
async function runMatrix(points) {
  const actions = Object.keys(ACTIONS);
  const executed = new Set();
  const failures = [];
  for (const point of points)
    for (const action of actions) {
      const h = await reentryHarness();
      h.thrown = [];
      h.inputs = [];
      arm(h, point, action);
      await drive(h);
      const reached = h.fired.some((name) => name === point || name === `view:${point}`);
      if (!reached) failures.push(`${point} x ${action}: call point not reached`);
      else executed.add(`${point} x ${action}`);
      for (const violation of await violations(h))
        failures.push(`${point} x ${action}: ${violation}`);
    }
  return { failures, executed: executed.size, expected: points.length * actions.length };
}

const MATRIX_TIMEOUT_MS = 120_000;

describe("re-entry matrix: every foreign-code call point x every reentering action", () => {
  test(
    "view, lane and observer call points keep the invariants",
    async () => {
      const result = await runMatrix([...LANE_POINTS, ...VIEW_POINTS, ...OBSERVER_POINTS]);
      expect(result.failures).toEqual([]);
      expect(result.executed).toBe(result.expected);
      expect(result.executed).toBe(19 * 15);
    },
    MATRIX_TIMEOUT_MS,
  );

  test(
    "connection call points keep the invariants",
    async () => {
      const result = await runMatrix(CONNECTION_POINTS);
      expect(result.failures).toEqual([]);
      expect(result.executed).toBe(result.expected);
      expect(result.executed).toBe(23 * 15);
    },
    MATRIX_TIMEOUT_MS,
  );

  test(
    "RPC call points keep the invariants",
    async () => {
      const result = await runMatrix(RPC_POINTS);
      expect(result.failures).toEqual([]);
      expect(result.executed).toBe(result.expected);
      expect(result.executed).toBe(4 * 15);
    },
    MATRIX_TIMEOUT_MS,
  );
});

const outcomeOf = async (promise) => {
  const result = await promise;
  return result.ok ? "ok" : (result.error.reason ?? result.error.kind);
};

describe("#84 and #80 round-4 regressions", () => {
  test("a deferred focus behind a second recovery started by an observer is sent after it", async () => {
    const h = await reentryHarness();
    // Another client resizes the PTY: this one recovers (resize-context) and loses nothing.
    h.server.foreignResize({ cols: 90, rows: 24 });
    const focused = h.controller.requestFocus(larger);
    let second = false;
    h.controller.onState((snapshot) => {
      // On the first ready after the first recovery, another resize starts a second recovery
      // before the deferred focus has been handed off.
      if (!second && snapshot.phase === "ready" && snapshot.recoverySequence === 2) {
        second = true;
        h.server.foreignResize({ cols: 70, rows: 24 });
      }
    });
    await h.finish();
    expect(second).toBe(true);
    expect(await outcomeOf(focused)).toBe("ok");
    expect(h.server.ofType("focus").at(-1).command.geometry).toEqual(larger);
    expect(h.controller.snapshot()).toMatchObject({ phase: "ready", inputReady: true });
  });

  test("an older focus reentering from the ID supplier never overwrites the newer focus", async () => {
    const h = await reentryHarness();
    const focusesBefore = h.server.ofType("focus").length;
    let newer;
    h.hooks.requestId = () => {
      newer = h.controller.requestFocus({ cols: 120, rows: 40 });
    };
    const older = h.controller.requestFocus(larger);
    await h.finish();
    // The older request is superseded before handoff; only the newer grid reaches the server.
    expect(await outcomeOf(older)).toBe("invalid-state");
    expect(await outcomeOf(newer)).toBe("ok");
    const sent = h.server.ofType("focus").slice(focusesBefore);
    expect(sent.map(({ command }) => command.geometry)).toEqual([{ cols: 120, rows: 40 }]);
    expect(h.server.state.grid).toEqual({ cols: 120, rows: 40 });
  });

  test("observers republishing an identical state stop, and timers still run", async () => {
    const h = await reentryHarness({ scheduler: realScheduler() });
    let reactions = 0;
    // An idempotent reaction to every snapshot, and a client observer reconnecting on loss.
    h.controller.onState(() => {
      reactions++;
      h.controller.setInputTarget(true, true);
    });
    let reconnects = 0;
    h.client.onState((snapshot) => {
      if (snapshot.status === "unverifiable" && reconnects++ === 0) void h.client.reconnect();
    });
    let timerRan = false;
    setTimeout(() => (timerRan = true), 0);
    h.server.output("x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(timerRan).toBe(true);
    // Identical snapshots are not delivered again, so the idempotent reaction stops.
    const settled = reactions;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reactions).toBe(settled);
    expect(reactions).toBeLessThan(5);
    h.server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconnects).toBe(1);
    expect(h.client.snapshot().status).toBe("connected");
  });

  test("a deferred focus whose deadline passes while foreign code runs is never handed off", async () => {
    const held = [];
    const h = await reentryHarness({
      grant: false,
      onCommand: (entry) => {
        if (entry.command.type !== "recover" || held.length) return undefined;
        held.push(entry);
        return "drop";
      },
    });
    // A gap recovery is in progress (its recover command unanswered), so the focus is deferred.
    h.server.gap();
    await settle();
    expect(held).toHaveLength(1);
    h.controller.setInputTarget(true, true);
    const focused = h.controller.requestFocus();
    await settle();
    // Once ready, the focus measures the view on its way to the lane; the clock passes its
    // deadline there, after the earlier checks and before handoff.
    h.mounted.hooks.measureGrid = () => h.scheduler.advance(20_000);
    h.server.process(held[0]);
    await h.finish();
    expect(h.fired).toContain("view:measureGrid");
    expect(await outcomeOf(focused)).toBe("timeout");
    expect(h.server.ofType("focus")).toEqual([]);
  });

  test("an accepted focus error delivered before send() returns is not resent", async () => {
    let failed = false;
    const h = await reentryHarness({
      syncReplies: true,
      onCommand: ({ command }, server) => {
        if (command.type !== "focus" || failed) return undefined;
        failed = true;
        server.fail(command, "RESULT_UNKNOWN", "accepted");
        return "drop";
      },
      grant: false,
    });
    h.controller.setInputTarget(true, true);
    const focused = h.controller.requestFocus(larger);
    await h.finish();
    expect((await focused).ok).toBe(false);
    expect(h.server.ofType("focus")).toHaveLength(1);
  });

  test("recover survives measureGrid disposing the controller", async () => {
    const h = await reentryHarness();
    // A recovery that may resume the retained model measures the view first.
    h.mounted.hooks.measureGrid = () => h.controller.dispose();
    const recovered = h.track(h.controller.recover("expired"));
    expect(h.fired).toContain("view:measureGrid");
    expect(await outcomeOf(recovered)).toBe("disposed");
    expect(await h.finish()).toBe(0);
  });

  // Tests are declared one by one: the CI gate discovers them statically.
  test("a replacement made from the old view's dispose owns the controller", async () => {
    expect.hasAssertions();
    await replacementFrom("dispose");
  });
  test("a replacement made from the ID supplier owns the controller", async () => {
    expect.hasAssertions();
    await replacementFrom("requestId");
  });

  const replacementFrom = async (point) => {
    const h = await reentryHarness();
    const second = fakeView();
    const third = fakeView();
    let inner;
    const reenter = () => (inner = h.controller.replaceView(third.terminalView));
    if (point === "dispose") h.mounted.hooks.dispose = reenter;
    else h.hooks.requestId = reenter;
    const outer = h.controller.replaceView(second.terminalView);
    await h.finish();
    expect(await outcomeOf(outer)).toBe("invalid-state");
    expect(await outcomeOf(inner)).toBe("ok");
    // The newer view is attached and alive; the superseded one was disposed exactly once.
    expect(third.state.disposed).toBe(0);
    expect(second.state.disposed).toBe(1);
    expect(third.state.generation).toBe(h.controller.snapshot().viewGeneration);
    expect(h.controller.snapshot().phase).toBe("ready");
  };

  test("settlement never starts a nested lane send", async () => {
    const h = await reentryHarness({ syncReplies: true });
    // A takeover makes the grant stale (released as follow-up work); a fatal view failure
    // releases the subscription. Replies arrive inside send(), where nesting would show.
    h.server.takeover();
    h.mounted.fail(domainError("RECOVERY_UNAVAILABLE"));
    await h.finish();
    expect(h.maxSendDepth).toBe(1);
    expect(h.server.ofType("detach")).toHaveLength(1);
  });
});

// A harness whose first recover command stays unanswered until the test releases it, so a
// recovery can be observed in progress.
async function withHeldRecovery(options = {}) {
  const held = [];
  const h = await reentryHarness({
    ...options,
    onCommand: (entry, server) => {
      if (entry.command.type === "recover" && !held.length && h?.armed) {
        held.push(entry);
        return "drop";
      }
      return options.onCommand?.(entry, server);
    },
  });
  h.armed = true;
  h.held = held;
  // Starts a recovery and waits until its recover command is held. Another client's resize
  // forces a resize-context recovery, across which this subscription's grant is carried; a gap
  // recovery starts from no authority (TerminalControl.resetForRecovery).
  h.startRecovery = async (kind = "resize") => {
    if (kind === "gap") h.server.gap();
    else h.server.foreignResize({ cols: 90, rows: 24 });
    await settle();
    expect(held).toHaveLength(1);
  };
  h.release = async () => {
    h.server.process(held[0]);
    await settle();
  };
  return h;
}

function noticesOf(h) {
  const notices = [];
  h.controller.onInputOutcome((notice) => notices.push(notice));
  return notices;
}

describe("design review regressions (rounds 1-3)", () => {
  test("rejections beyond the free slots fold into one tail aggregate of finite structure", async () => {
    const h = await reentryHarness();
    h.inputs = [];
    const notices = noticesOf(h);
    const reject = (count) => {
      for (let index = 0; index < count; index++)
        h.controller.sendInput({ source: { untrusted: index }, bytes: "x" });
    };
    reject(40);
    type(h, "a");
    reject(40);
    await h.finish();
    const individual = notices.filter((notice) => notice.kind === "input" && !notice.outcome.ok);
    expect(individual).toHaveLength(32);
    const aggregates = notices.filter((notice) => notice.kind === "input-rejections");
    // Accepting the input marks a state change, which queues behind the first aggregate, so the
    // later rejections start a second one: each aggregate covers one contiguous run of overflow
    // and FIFO order is kept. The input's own notice is queued when its result arrives.
    const aggregate = (count) => ({
      kind: "input-rejections",
      count,
      groups: [
        {
          source: "malformed",
          error: "invalid-request",
          count,
          knownBytes: 0,
          unknownLengthCount: count,
        },
      ],
    });
    expect(aggregates).toEqual([aggregate(8), aggregate(40)]);
    expect(notices.map((notice) => notice.kind).slice(32)).toEqual([
      "input-rejections",
      "input-rejections",
      "input",
    ]);
    expect(notices.at(-1).outcome.ok).toBe(true);
    // Nothing the caller passed is retained.
    expect(JSON.stringify(aggregates)).not.toContain("untrusted");
  });

  test("a focus and input storm keeps the intent log bounded and ends on the last intent", async () => {
    const h = await reentryHarness();
    const focusesBefore = h.server.ofType("focus").length;
    const outcomes = [];
    for (let index = 0; index < 500; index++) {
      outcomes.push(h.controller.requestFocus({ cols: 81 + (index % 2), rows: 24 }));
      h.controller.setInputTarget(true, false);
      h.controller.setInputTarget(true, true);
    }
    const last = h.controller.requestFocus(larger);
    // Registration is synchronous bookkeeping: the log holds at most unfocus, focus and fatal.
    expect(h.controller.snapshot().pendingInputIntents).toBeLessThanOrEqual(3);
    await h.finish();
    for (const outcome of outcomes) expect(await outcomeOf(outcome)).toBe("invalid-state");
    expect(await outcomeOf(last)).toBe("ok");
    const sent = h.server.ofType("focus").slice(focusesBefore);
    expect(sent.map(({ command }) => command.geometry)).toEqual([larger]);
    expect(h.server.ofType("blur").length).toBeLessThanOrEqual(1);
  });

  test("focus, input, unfocus in one stack: the unfocus drops the focus and fails the input", async () => {
    const h = await reentryHarness();
    h.inputs = [];
    const focusesBefore = h.server.ofType("focus").length;
    const focused = h.controller.requestFocus(larger);
    const typed = type(h, "x");
    h.controller.setInputTarget(true, false);
    await h.finish();
    expect(await outcomeOf(focused)).toBe("invalid-state");
    expect(await typed).toMatchObject({ ok: false, value: { notSentBytes: 1, unknownBytes: 0 } });
    expect(h.server.ofType("focus").length).toBe(focusesBefore);
    expect(h.server.ofType("blur")).toHaveLength(1);
    expect(h.server.written).toEqual([]);
    expect(h.server.state.holder).toBe(null);
  });

  test("a fatal view failure is not reopened by a later focus", async () => {
    const h = await reentryHarness();
    const focusesBefore = h.server.ofType("focus").length;
    h.mounted.fail(domainError("RECOVERY_UNAVAILABLE"));
    const focused = h.controller.requestFocus(larger);
    h.mounted.focus(true, larger);
    const typed = h.controller.sendInput(keyboard("x"));
    await h.finish();
    expect((await focused).ok).toBe(false);
    expect((await typed).ok).toBe(false);
    expect(h.server.ofType("focus").length).toBe(focusesBefore);
    expect(h.server.written).toEqual([]);
  });

  test("a failed hold generation ends, and later input takes the ordinary path", async () => {
    const h = await withHeldRecovery();
    h.inputs = [];
    await h.startRecovery();
    const held = type(h, "a");
    // Losing the input target fails the held input at once and closes its generation; it ends
    // once that failure is delivered, without needing a grant again.
    h.controller.setInputTarget(true, false);
    const closed = type(h, "x");
    await settle();
    expect(await held).toMatchObject({
      ok: false,
      error: { reason: "invalid-state" },
      value: { notSentBytes: 1 },
    });
    expect((await closed).ok).toBe(false);
    // The user's next click announces focus; the input after it is held in a new generation
    // and sent once the recovery is over.
    h.controller.setInputTarget(true, true);
    const refocused = h.controller.requestFocus({ cols: 80, rows: 24 });
    const later = type(h, "b");
    await h.release();
    await h.finish();
    expect((await refocused).ok).toBe(true);
    expect((await later).ok).toBe(true);
    expect(h.server.written).toEqual(["b"]);
  });

  test("held input waits behind an earlier in-flight input that is written", async () => {
    expect.hasAssertions();
    await behindBarrier("written");
  });
  test("held input fails behind an earlier in-flight input that is refused", async () => {
    expect.hasAssertions();
    await behindBarrier("refused");
  });

  const behindBarrier = async (earlier) => {
    const inFlight = [];
    const h = await withHeldRecovery({
      onCommand: (entry) => {
        if (entry.command.type !== "input" || inFlight.length) return undefined;
        inFlight.push(entry);
        return "drop";
      },
    });
    h.inputs = [];
    const first = type(h, "a");
    await settle();
    expect(inFlight).toHaveLength(1);
    await h.startRecovery();
    const second = type(h, "b");
    await h.release();
    // b is not sent while a, its barrier, is unsettled.
    expect(h.server.ofType("input")).toHaveLength(1);
    if (earlier === "written") h.server.process(inFlight[0]);
    else h.server.fail(inFlight[0].command, "BUSY");
    await h.finish();
    const summary = async (promise) => {
      const result = await promise;
      return { outcome: await outcomeOf(promise), notSentBytes: result.value?.notSentBytes };
    };
    // Prefix closure: an incomplete earlier input stops the held suffix, which fails visibly.
    expect({
      first: await summary(first),
      second: await summary(second),
      written: h.server.written,
    }).toEqual(
      earlier === "written"
        ? {
            first: { outcome: "ok", notSentBytes: 0 },
            second: { outcome: "ok", notSentBytes: 0 },
            written: ["a", "b"],
          }
        : {
            first: { outcome: "BUSY", notSentBytes: 1 },
            second: { outcome: "BUSY", notSentBytes: 1 },
            written: [],
          },
    );
  };

  test("a renderer rejection closes the hold generation after the inputs before it", async () => {
    const h = await withHeldRecovery();
    h.inputs = [];
    await h.startRecovery();
    const before = type(h, "a");
    h.mounted.fail(domainError("INPUT_REJECTED"));
    const after = type(h, "b");
    await h.release();
    await h.finish();
    expect((await before).ok).toBe(true);
    expect(await after).toMatchObject({ ok: false, value: { notSentBytes: 1 } });
    expect(h.server.written).toEqual(["a"]);
  });

  test("an input before a renderer rejection that fails moves the closure back to it", async () => {
    let refused = false;
    const h = await withHeldRecovery({
      onCommand: ({ command }, server) => {
        if (command.type !== "input" || refused) return undefined;
        refused = true;
        server.fail(command, "BUSY");
        return "drop";
      },
    });
    h.inputs = [];
    await h.startRecovery();
    const first = type(h, "a");
    const second = type(h, "b");
    h.mounted.fail(domainError("INPUT_REJECTED"));
    await h.release();
    await h.finish();
    // a is refused, so b, accepted after it, is behind a gap and is never sent.
    expect(await first).toMatchObject({ ok: false, error: { kind: "BUSY" } });
    expect(await second).toMatchObject({ ok: false, value: { notSentBytes: 1 } });
    expect(h.server.ofType("input")).toHaveLength(1);
    expect(h.server.written).toEqual([]);
  });

  test("a same-grid focus during a gap recovery without a grant is the user's request", async () => {
    const h = await withHeldRecovery({ grant: false });
    await h.startRecovery("gap");
    h.controller.setInputTarget(true, true);
    const focused = h.controller.requestFocus({ cols: 80, rows: 24 });
    await settle();
    expect(h.server.ofType("focus")).toEqual([]);
    await h.release();
    await h.finish();
    expect(await outcomeOf(focused)).toBe("ok");
    expect(h.server.ofType("focus").map(({ command }) => command.geometry)).toEqual([
      { cols: 80, rows: 24 },
    ]);
  });

  test("an announcement at the carried grant's grid during a recovery adds nothing", async () => {
    const h = await withHeldRecovery();
    h.inputs = [];
    const focusesBefore = h.server.ofType("focus").length;
    await h.startRecovery();
    h.mounted.focus(true, { cols: 80, rows: 24 });
    const typed = type(h, "a");
    await h.release();
    await h.finish();
    expect(h.server.ofType("focus").length).toBe(focusesBefore);
    expect((await typed).ok).toBe(true);
    expect(h.server.written).toEqual(["a"]);
  });

  test("a blur during a recovery waits for ready and releases the held epoch", async () => {
    const h = await withHeldRecovery();
    const epoch = h.server.state.epoch;
    await h.startRecovery();
    const blurred = h.controller.blur();
    await settle();
    expect(h.server.ofType("blur")).toEqual([]);
    await h.release();
    await h.finish();
    expect((await blurred).ok).toBe(true);
    expect(h.server.ofType("blur").map(({ command }) => command.epoch)).toEqual([epoch]);
    expect(h.server.state.holder).toBe(null);
  });

  test("a blur is still sent when the later focus is never handed off", async () => {
    const h = await withHeldRecovery();
    const epoch = h.server.state.epoch;
    await h.startRecovery();
    h.controller.setInputTarget(true, false);
    h.controller.setInputTarget(true, true);
    // The later focus measures the view, which fails: it is never handed off.
    h.mounted.hooks.measureGrid = () => {
      throw new Error("measure failed");
    };
    const focused = h.controller.requestFocus();
    await h.release();
    await h.finish();
    expect((await focused).ok).toBe(false);
    expect(h.server.ofType("blur").map(({ command }) => command.epoch)).toEqual([epoch]);
    expect(h.server.state.holder).toBe(null);
  });

  const ackReentry = async (action) => {
    const h = await reentryHarness({ syncReplies: true });
    h.hooks.requestId = () => h.track(ACTIONS[action](h));
    h.server.output("o");
    await h.finish();
    expect(h.fired).toContain("requestId");
    const acked = h.server.ofType("applied-ack").map(({ command }) => command.appliedSeq);
    expect(new Set(acked).size).toBe(acked.length);
    expect(h.maxSendDepth).toBe(1);
  };
  test("an ACK whose ID supplier reenters with recover is handed off at most once", async () => {
    expect.hasAssertions();
    await ackReentry("recover");
  });
  test("an ACK whose ID supplier reenters with dispose is handed off at most once", async () => {
    expect.hasAssertions();
    await ackReentry("dispose");
  });

  test("a granted resize reserves itself before its ID supplier runs", async () => {
    const h = await reentryHarness();
    h.inputs = [];
    let typed;
    // Input typed from the resize's ID supplier sees the unsettled granted control and waits.
    h.hooks.requestId = () => (typed = type(h, "x"));
    const resized = h.controller.requestResize(larger);
    await h.finish();
    expect(await outcomeOf(resized)).toBe("ok");
    expect((await typed).ok).toBe(true);
    const order = h.server.state.commands
      .map(({ command }) => command.type)
      .filter((type) => type === "resize" || type === "input");
    expect(order).toEqual(["resize", "input"]);
    expect(h.server.state.stale).toEqual([]);
  });

  test("an accepted focus whose grant is lost during its recovery reports accepted", async () => {
    const h = await withHeldRecovery();
    const focused = h.controller.requestFocus(larger);
    // The focus resizes the PTY; this client recovers, and another client takes over first.
    await settle();
    expect(h.held).toHaveLength(1);
    h.server.takeover();
    await h.release();
    await h.finish();
    const result = await focused;
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ category: "local", reason: "invalid-state" });
    expect(result.accepted).toEqual({ epoch: expect.any(Number), atSeq: expect.any(Number) });
  });

  test("a focus re-registered from measureGrid yields to host tasks between drain quanta", async () => {
    const h = await reentryHarness({ scheduler: realScheduler() });
    let measures = 0;
    let measuresAtTimer;
    const rearm = () => {
      h.mounted.hooks.measureGrid = () => {
        measures++;
        h.controller.requestFocus();
        if (measures < 200) rearm();
      };
    };
    rearm();
    setTimeout(() => (measuresAtTimer = measures), 0);
    h.controller.requestFocus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(measures).toBe(200);
    expect(measuresAtTimer).toBeLessThan(200);
  });

  test("a deferred F80 is superseded by an F100 announcement over a 100x30 baseline", async () => {
    // The applied grid is 100x30; a deferred focus asks for 80x24. Announcing 100x30 matches
    // the applied grid but not the live request, so it is a newer request, not a duplicate.
    const h = await withHeldRecovery({ grant: false, grid: larger });
    await h.startRecovery("gap");
    h.controller.setInputTarget(true, true);
    const f80 = h.controller.requestFocus({ cols: 80, rows: 24 });
    h.mounted.focus(true, larger);
    await h.release();
    await h.finish();
    expect(await outcomeOf(f80)).toBe("invalid-state");
    expect(h.server.ofType("focus").map(({ command }) => command.geometry)).toEqual([larger]);
  });
});

describe("implementation review regressions (#86 round 1)", () => {
  test("an input whose send reports not-sent after it was entered is reported unknown", async () => {
    // The adapter forwards the frame and then reports "not-sent"; once send was entered the
    // write may have happened, so no byte may be reported as not sent (4.4.6).
    const h = await reentryHarness({
      disposition: (command) => (command.type === "input" ? "not-sent" : undefined),
    });
    h.inputs = [];
    const outcome = type(h, "x");
    await h.finish();
    expect(h.server.written).toEqual(["x"]);
    expect(await outcome).toMatchObject({
      ok: false,
      value: { writtenBytes: 0, unknownBytes: 1, notSentBytes: 0 },
    });
  });
});
