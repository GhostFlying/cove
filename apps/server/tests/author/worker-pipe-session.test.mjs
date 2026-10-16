import { PassThrough, Writable } from "node:stream";
import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import {
  HEADER_BYTES,
  MAX_METADATA_BYTES,
  PIPE_ROUTE_CONTROL_COMMANDS,
  createPipeDecoder,
  encodePipeFrame,
} from "@cove/protocol/pipe";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";
import { runWorkerPipe } from "@cove/terminal-worker/pipe";

const codec = {
  encode: (text) => new TextEncoder().encode(text),
  decode: (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
};
const worker = {
  serverId: "server",
  relayInstanceId: "instance",
  workerId: "worker",
  workerIncarnationId: "birth",
};
const run = { serverId: "server", relayInstanceId: "instance", runId: "run" };
const subscription = {
  run,
  connection: { connectionId: "connection", generation: 0 },
  subscriptionId: "subscription",
  viewId: "view",
};
function frame(value, payload = new Uint8Array()) {
  const kind = value.type === "terminal-event" ? 3 : value.type === "error" ? 4 : 2;
  const encoded = encodePipeFrame(kind, codec.encode(JSON.stringify(value)), payload);
  if (!encoded.ok) throw new Error("Invalid fixture frame");
  return encoded.value;
}
// `forward`, if given, also receives every written frame (to drive a real worker endpoint).
function fixture(
  budgets = { ...M0_LIMITS },
  identityLimit = 32,
  forward = undefined,
  timeoutMs = 100,
) {
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", budgets, bytes);
  const writes = [];
  let blocked = false;
  let now = 0;
  let lost = 0;
  const session = new WorkerPipeSession({
    worker,
    composition,
    buildVersion: "author",
    codec,
    transport: {
      write: (data, settled, handing) => {
        handing();
        writes.push({ data, settled });
        forward?.(data);
        return !blocked;
      },
    },
    now: () => now,
    timeoutMs,
    identityLimit,
    contactLost: () => {
      lost++;
    },
  });
  const ready = (changes = {}) =>
    frame({
      type: "ready",
      worker,
      pipeVersion: 2,
      buildVersion: "peer",
      effectiveBudgets: budgets,
      ...changes,
    });
  const command = (type, requestId, rest = {}) => ({ type, requestId, worker, run, ...rest });
  const reply = (request, rest = {}) =>
    frame({
      type: "result",
      worker,
      run,
      requestId: request.requestId,
      commandType: request.type,
      outcome: "accepted",
      ...rest,
    });
  const start = () => {
    session.start();
    writes[0].settled();
    session.receive(ready());
    session.registerRun(run);
  };
  return {
    session,
    bytes,
    writes,
    ready,
    start,
    command,
    reply,
    block: () => {
      blocked = true;
    },
    unblock: () => {
      blocked = false;
    },
    // Runs every write callback not yet run, as a transport that finished writing would.
    settleWrites: () => {
      for (const write of writes)
        if (!write.done) {
          write.done = true;
          write.settled();
        }
    },
    clock: (value) => {
      now = value;
    },
    // The worker's liveness frame (issue #103).
    heartbeat: () => frame({ type: "heartbeat", worker }),
    lost: () => lost,
  };
}

const RECLAIMED = { routes: 0, pending: 0, identities: 0, delivered: [], lost: 0 };
async function racedOpener(order) {
  const f = fixture();
  f.start();
  const delivered = [];
  f.session.onEvent((event) => delivered.push(event.terminal.seq));
  const subscribe = f.command("subscribe", "subscribe", { subscription, atSeq: 0 });
  const opened = f.session.request(subscribe, new Uint8Array(), () => true);
  const unsubscribe = f.command("unsubscribe", "unsubscribe", { subscription });
  const closed = f.session.request(unsubscribe);
  const failOpener = () =>
    f.session.receive(
      frame({
        type: "error",
        worker,
        run,
        requestId: subscribe.requestId,
        commandType: "subscribe",
        error: domainError("RESYNC_REQUIRED"),
      }),
    );
  const settleOpener = () =>
    order === "unsubscribe-then-accepted-opener"
      ? f.session.receive(f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 }))
      : failOpener();
  const settleUnsubscribe = () => f.session.receive(f.reply(unsubscribe));
  const [first, second] = order.startsWith("unsubscribe")
    ? [settleUnsubscribe, settleOpener]
    : [settleOpener, settleUnsubscribe];
  first();
  // Whichever settles first leaves the record for the other to reclaim.
  expect(f.session.snapshot().routes).toBe(1);
  second();
  await Promise.all([opened, closed]);
  const settled = f.session.snapshot();
  f.session.receive(
    frame(
      {
        type: "terminal-event",
        worker,
        run,
        subscription,
        terminal: { type: "output", run, seq: 1 },
      },
      new Uint8Array([65]),
    ),
  );
  const outcome = {
    routes: settled.routes,
    pending: settled.pending,
    identities: settled.identities,
    delivered,
    lost: f.lost(),
  };
  f.session.loseContact();
  f.session.transportReleased();
  return outcome;
}

describe("bounded worker pipe session", () => {
  it("refuses business before ready without publishing or writing a command", async () => {
    const f = fixture();
    const result = await f.session.request(f.command("status", "early"));
    expect(result.error.kind).toBe("WORKER_UNAVAILABLE");
    expect(f.writes).toHaveLength(0);
    f.session.loseContact();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("accepts split ready bytes and rejects exact-budget or incarnation mismatch", () => {
    const f = fixture();
    f.session.start();
    f.writes[0].settled();
    const ready = f.ready();
    expect(f.session.receive(ready.slice(0, 7))).toBe(7);
    expect(f.session.ready).toBe(false);
    f.session.receive(ready.slice(7));
    expect(f.session.ready).toBe(true);
    f.session.loseContact();
    const bad = fixture();
    bad.session.start();
    bad.writes[0].settled();
    bad.session.receive(bad.ready({ worker: { ...worker, workerIncarnationId: "foreign" } }));
    expect(bad.session.closed).toBe(true);
    expect(bad.lost()).toBe(1);
    const budget = fixture();
    budget.session.start();
    budget.writes[0].settled();
    budget.session.receive(
      budget.ready({ effectiveBudgets: { ...M0_LIMITS, pendingWorkerCommands: 1 } }),
    );
    expect(budget.session.closed).toBe(true);
  });

  it("fences malformed and oversized ingress without retaining the hostile backing", () => {
    const malformed = fixture();
    malformed.start();
    malformed.session.receive(new Uint8Array(16));
    expect(malformed.session.closed).toBe(true);
    const oversized = fixture();
    oversized.start();
    expect(oversized.session.receive(new Uint8Array(256 * 1024 + 1))).toBe(0);
    expect(oversized.session.closed).toBe(true);
    expect(oversized.bytes.snapshot().total).toBe(0);
  });

  it("keeps handed-off input unknown with inspect-run action after foreign result", async () => {
    const f = fixture();
    f.start();
    const input = f.command("input", "input", { subscription, epoch: 1, inputSeq: 1 });
    const promise = f.session.request(input, new Uint8Array([65]));
    f.session.receive(
      frame({
        type: "result",
        worker: { ...worker, workerIncarnationId: "foreign" },
        run,
        requestId: "input",
        commandType: "input",
        outcome: "accepted",
        inputSeq: 1,
        writtenBytes: 1,
      }),
    );
    const result = await promise;
    expect(result.error).toMatchObject({
      kind: "RESULT_UNKNOWN",
      acceptance: "unknown",
      subject: "input",
      nextAction: "inspect-run",
    });
    f.writes[1].settled();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("does not resend write false and retains physical charges through disposal and late callbacks", async () => {
    const f = fixture();
    f.start();
    f.block();
    const first = f.session.request(f.command("status", "one"));
    const second = f.session.request(f.command("stop", "two", { operationId: "stop" }));
    expect(f.writes).toHaveLength(2);
    expect(f.session.snapshot().queuedBytes).toBeGreaterThan(0);
    f.session.loseContact();
    expect((await first).error.acceptance).toBe("unknown");
    expect((await second).error.acceptance).toBe("not-accepted");
    expect(f.bytes.snapshot().total).toBeGreaterThan(0);
    f.session.drain();
    expect(f.writes).toHaveLength(2);
    f.writes[1].settled();
    f.writes[1].settled(new Error("late"));
    expect(f.bytes.snapshot().total).toBe(0);
    expect(f.lost()).toBe(1);
  });

  it("admits status stop and progress while the smallest ordinary slot is occupied", async () => {
    const f = fixture({ ...M0_LIMITS, pendingWorkerCommands: 1 });
    f.start();
    const recover = f.command("recover", "recover", { subscription });
    const held = f.session.request(recover, new Uint8Array(), () => true);
    const ordinary = await f.session.request(f.command("preview-refresh", "extra"));
    expect(ordinary.error.kind).toBe("BUSY");
    const status = f.session.request(f.command("status", "status"));
    const stop = f.session.request(f.command("stop", "stop", { operationId: "stop" }));
    const progress = f.session.request(
      f.command("baseline-progress", "progress", {
        subscription,
        baselineId: "baseline",
        lastParsedOrdinal: 0,
      }),
    );
    expect(f.session.snapshot().pending).toBe(4);
    f.session.loseContact();
    await Promise.all([held, status, stop, progress]);
    f.session.transportReleased();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  // Route-control fixtures (issue #96). Route control is prepaid only for a subscription the
  // pipe has opened, so each test opens its routes first.
  const on = (index) => ({ ...subscription, subscriptionId: `subscription-${index}` });
  async function openRoutes(f, count) {
    for (let index = 0; index < count; index++) {
      const subscribe = f.command("subscribe", `open-${index}`, {
        subscription: on(index),
        atSeq: 0,
      });
      const opened = f.session.request(subscribe, new Uint8Array(), () => true);
      f.session.receive(f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 }));
      expect(await opened).toMatchObject({ type: "result", outcome: "accepted" });
    }
  }
  // Request IDs of the commands handed to the transport after `from` writes, in write order.
  const writtenIds = (f, from) =>
    f.writes.slice(from).map(({ data }) => {
      const read = createPipeDecoder().read(data);
      return JSON.parse(codec.decode(read.frames[0].metadata)).requestId;
    });
  const ack = (f, index, requestId = `ack-${index}`) =>
    f.command("applied-ack", requestId, { subscription: on(index), appliedSeq: index });

  it("keeps route control within the worker's window and queues the rest in arrival order", async () => {
    const f = fixture();
    f.start();
    await openRoutes(f, 8);
    const from = f.writes.length;
    const route = (index) =>
      index % 2
        ? f.command("baseline-progress", `route-${index}`, {
            subscription: on(index),
            baselineId: "baseline",
            lastParsedOrdinal: index,
          })
        : ack(f, index, `route-${index}`);
    const window = Array.from({ length: PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) => route(index));
    const results = window.map((command) => f.session.request(command));
    expect(writtenIds(f, from)).toEqual(window.map((command) => command.requestId));
    // The transport finishes these writes; only the window holds the rest back here.
    f.settleWrites();
    // Past the window nothing is written for the worker to queue (it treats more than the
    // window as a protocol violation), and nothing is refused either: ACKs, progress reports and
    // unsubscribes of opened subscriptions wait unsent, in arrival order.
    const waiting = [
      route(PIPE_ROUTE_CONTROL_COMMANDS),
      f.command("unsubscribe", "unsubscribe-first", { subscription: on(0) }),
      route(PIPE_ROUTE_CONTROL_COMMANDS + 1),
      f.command("unsubscribe", "unsubscribe-second", { subscription: on(1) }),
    ];
    const waited = waiting.map((command) =>
      command.type === "unsubscribe"
        ? f.session.requestUnsubscribe(command)
        : f.session.request(command),
    );
    // Each subscription has one prepaid waiting record for an ACK or progress report and one for
    // its unsubscribe; a second command for an occupied record is refused unsent. Its route queue
    // never sends one.
    const duplicate = await f.session.request(ack(f, PIPE_ROUTE_CONTROL_COMMANDS, "duplicate"));
    expect(duplicate.error).toMatchObject({ kind: "BUSY", acceptance: "not-accepted" });
    expect(writtenIds(f, from)).toHaveLength(PIPE_ROUTE_CONTROL_COMMANDS);
    expect(f.session.snapshot().pending).toBe(PIPE_ROUTE_CONTROL_COMMANDS + waiting.length);
    // Each reply frees one slot, and only then is the oldest waiting command written.
    f.session.receive(f.reply(window[0]));
    expect(writtenIds(f, from).slice(PIPE_ROUTE_CONTROL_COMMANDS)).toEqual([waiting[0].requestId]);
    f.session.receive(f.reply(window[1]));
    f.session.receive(f.reply(window[2]));
    expect(writtenIds(f, from).slice(PIPE_ROUTE_CONTROL_COMMANDS)).toEqual(
      waiting.slice(0, 3).map((command) => command.requestId),
    );
    for (const command of [window[3], ...waiting]) f.session.receive(f.reply(command));
    expect(writtenIds(f, from).slice(PIPE_ROUTE_CONTROL_COMMANDS)).toEqual(
      waiting.map((command) => command.requestId),
    );
    for (const result of await Promise.all([...results, ...waited]))
      expect(result).toMatchObject({ type: "result", outcome: "accepted" });
    expect(f.session.snapshot()).toMatchObject({ pending: 0, identities: 0 });
    expect(f.lost()).toBe(0);
  });

  // Issue #103: a busy worker is not a lost one. These run with timeoutMs 100 (the liveness
  // window and the command deadline) and advance the clock in ticks of 10.
  const advance = (f, from, to, frames = () => []) => {
    for (let now = from + 10; now <= to; now += 10) {
      f.clock(now);
      for (const bytes of frames(now)) f.session.receive(bytes);
      f.session.tick();
    }
  };

  it("never times out route control while the worker is live and still loses a silent worker", async () => {
    const f = fixture();
    f.start();
    await openRoutes(f, 2 * PIPE_ROUTE_CONTROL_COMMANDS);
    // Four in the window, four waiting; none answered for ten deadlines while the worker beats.
    const acks = Array.from({ length: 2 * PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
      ack(f, index),
    );
    const results = acks.map((command) => f.session.request(command));
    f.settleWrites();
    advance(f, 0, 1000, () => [f.heartbeat()]);
    expect(f.lost()).toBe(0);
    for (const command of acks.slice(0, PIPE_ROUTE_CONTROL_COMMANDS))
      f.session.receive(f.reply(command));
    f.settleWrites();
    advance(f, 1000, 2000, () => [f.heartbeat()]);
    for (const command of acks.slice(PIPE_ROUTE_CONTROL_COMMANDS))
      f.session.receive(f.reply(command));
    for (const result of await Promise.all(results))
      expect(result).toMatchObject({ type: "result", outcome: "accepted" });
    expect(f.lost()).toBe(0);
    // A worker that sends nothing at all for the whole window is hung, and is lost.
    f.settleWrites();
    const silent = f.session.request(ack(f, 0, "silent"));
    advance(f, 2000, 2090);
    expect(f.lost()).toBe(0);
    advance(f, 2090, 2110);
    expect(f.lost()).toBe(1);
    expect((await silent).error.kind).toBe("RESULT_UNKNOWN");
  });

  it("counts any worker frame as contact, so output alone keeps a busy worker live", async () => {
    const f = fixture();
    f.start();
    await openRoutes(f, 1);
    let seq = 0;
    const output = () =>
      frame(
        {
          type: "terminal-event",
          worker,
          run,
          subscription: on(0),
          terminal: { type: "output", run, seq: ++seq },
        },
        new Uint8Array([65]),
      );
    const status = f.command("status", "slow-status");
    const held = f.session.request(status);
    advance(f, 0, 1000, (now) => (now % 50 === 0 ? [output()] : []));
    expect(f.lost()).toBe(0);
    // The status ended alone at its deadline; the worker stayed.
    expect((await held).error).toMatchObject({ kind: "RESULT_UNKNOWN", acceptance: "unknown" });
    f.session.loseContact();
    f.session.transportReleased();
  });

  it("does not charge a stall of the runtime's own clock ticks to the worker", async () => {
    const f = fixture({ ...M0_LIMITS }, 32, undefined, 15_000);
    f.start();
    f.session.tick();
    // The runtime's event loop stalls for 20 s; the worker's frames wait unread in the pipe.
    f.clock(20_000);
    f.session.tick();
    expect(f.lost()).toBe(0);
    f.session.receive(f.heartbeat());
    f.session.tick();
    // Genuine silence is still detected within a bounded time: 15 more seconds of ticks.
    for (let second = 1; second <= 14; second++) {
      f.clock(20_000 + second * 1000);
      f.session.tick();
    }
    expect(f.lost()).toBe(0);
    f.clock(35_000);
    f.session.tick();
    expect(f.lost()).toBe(1);
    f.session.transportReleased();
  });

  it("ends a timed-out command alone with an unknown outcome and discards its late reply", async () => {
    const f = fixture();
    f.start();
    const command = f.command("stop", "stop", { operationId: "stop" });
    const held = f.session.request(command);
    f.settleWrites();
    advance(f, 0, 100, () => [f.heartbeat()]);
    expect((await held).error).toMatchObject({ kind: "RESULT_UNKNOWN", acceptance: "unknown" });
    expect(f.lost()).toBe(0);
    expect(f.session.closed).toBe(false);
    // The abandoned stop keeps its slot until the worker answers: the next stop is refused.
    const second = f.command("stop", "stop-2", { operationId: "stop-2" });
    expect((await f.session.request(second)).error.kind).toBe("BUSY");
    // The late reply is validated and discarded; the worker stays and the slot frees.
    expect(f.session.receive(f.reply(command, { operationId: "stop" }))).toBeGreaterThan(0);
    expect(f.lost()).toBe(0);
    expect(f.session.snapshot()).toMatchObject({ pending: 0, identities: 0 });
    const third = f.command("stop", "stop-3", { operationId: "stop-3" });
    const accepted = f.session.request(third);
    f.session.receive(f.reply(third, { operationId: "stop-3" }));
    expect(await accepted).toMatchObject({ type: "result", outcome: "accepted" });
    // A late reply that breaks the protocol still fails closed.
    const fourth = f.command("stop", "stop-4", { operationId: "stop-4" });
    const unknown = f.session.request(fourth);
    advance(f, 100, 200, () => [f.heartbeat()]);
    expect((await unknown).error.kind).toBe("RESULT_UNKNOWN");
    f.session.receive(f.reply(fourth, { operationId: "someone-else" }));
    expect(f.lost()).toBe(1);
    f.session.transportReleased();
  });

  it("withdraws a timed-out command that never reached the transport with BUSY", async () => {
    const f = fixture();
    f.start();
    f.block();
    // The transport refuses more bytes (write returned false), so the next frames queue.
    const first = f.command("status", "first");
    void f.session.request(first);
    const input = f.command("input", "input", {
      subscription,
      epoch: 1,
      inputSeq: 1,
    });
    const held = f.session.request(input, new Uint8Array([65]));
    const before = f.writes.length;
    advance(f, 0, 100, () => [f.heartbeat()]);
    expect((await held).error).toMatchObject({ kind: "BUSY", acceptance: "not-accepted" });
    expect(f.lost()).toBe(0);
    expect(f.session.snapshot().queuedBytes).toBe(0);
    f.unblock();
    f.session.drain();
    // The withdrawn input was never written.
    expect(writtenIds(f, before)).not.toContain("input");
    f.session.loseContact();
    f.session.transportReleased();
  });

  it("keeps ACKs flowing while a slow subscribe waits past its deadline and never activates it late", async () => {
    const f = fixture();
    f.start();
    await openRoutes(f, 1);
    const delivered = [];
    f.session.onEvent((event) => delivered.push(event.subscription.subscriptionId));
    const slow = f.command("subscribe", "slow", { subscription: on(1), atSeq: 0 });
    let handoffs = 0;
    const opened = f.session.request(slow, new Uint8Array(), () => ++handoffs > 0);
    // The worker keeps answering ACKs on the open route while the subscribe is outstanding.
    for (let round = 0; round < 20; round++) {
      const command = ack(f, 0, `ack-${round}`);
      const result = f.session.request(command);
      f.settleWrites();
      advance(f, round * 10, round * 10 + 10, () => [f.reply(command)]);
      expect(await result).toMatchObject({ type: "result", outcome: "accepted" });
    }
    expect(f.lost()).toBe(0);
    expect((await opened).error.kind).toBe("RESULT_UNKNOWN");
    // Late acceptance after the caller gave up: no handoff, no activation, events stay fenced.
    const event = frame(
      {
        type: "terminal-event",
        worker,
        run,
        subscription: on(1),
        terminal: { type: "output", run, seq: 1 },
      },
      new Uint8Array([65]),
    );
    f.session.receive(f.reply(slow, { recoveryMode: "baseline", atSeq: 0 }));
    f.session.receive(event);
    expect(handoffs).toBe(0);
    expect(delivered).toEqual([]);
    expect(f.lost()).toBe(0);
    // The subscription layer's unsubscribe reclaims the route.
    const unsubscribe = f.command("unsubscribe", "unsubscribe-slow", { subscription: on(1) });
    const closed = f.session.request(unsubscribe);
    f.settleWrites();
    f.session.receive(f.reply(unsubscribe));
    await closed;
    expect(f.session.snapshot().routes).toBe(1);
    f.session.loseContact();
    f.session.transportReleased();
  });

  it("leaves a route inactive when its consumer refuses the handoff and keeps the worker", async () => {
    const f = fixture();
    f.start();
    const delivered = [];
    f.session.onEvent(() => delivered.push(1));
    const subscribe = f.command("subscribe", "subscribe", { subscription, atSeq: 0 });
    const pending = f.session.request(subscribe, new Uint8Array(), () => false);
    const result = f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 });
    const event = frame(
      {
        type: "terminal-event",
        worker,
        run,
        subscription,
        terminal: { type: "output", run, seq: 1 },
      },
      new Uint8Array([65]),
    );
    const chunk = new Uint8Array(result.length + event.length);
    chunk.set(result);
    chunk.set(event, result.length);
    f.session.receive(chunk);
    expect((await pending).outcome).toBe("accepted");
    expect(delivered).toEqual([]);
    expect(f.lost()).toBe(0);
    f.session.loseContact();
    f.session.transportReleased();
  });

  it("never refuses an opened route's control for byte pressure and keeps essential headroom", async () => {
    const f = fixture();
    f.start();
    await openRoutes(f, 2 * PIPE_ROUTE_CONTROL_COMMANDS);
    // Fill every ordinary byte the account allows, as sustained output would.
    const before = f.bytes.snapshot();
    const filler = f.bytes.reserve(before.limit - before.controlReserve - before.ordinary);
    expect(filler).not.toBeNull();
    const pressed = f.bytes.snapshot().total;
    const from = f.writes.length;
    const acks = Array.from({ length: 2 * PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
      ack(f, index),
    );
    const results = acks.map((command) => f.session.request(command));
    const unsubscribe = f.command("unsubscribe", "unsubscribe", { subscription: on(0) });
    const unsubscribed = f.session.requestUnsubscribe(unsubscribe);
    // Waiting and admitted route control is prepaid: the account did not move, so the control
    // reserve is still whole for status and stop, which are admitted into their own slots.
    expect(f.bytes.snapshot().total).toBe(pressed);
    const status = f.command("status", "status");
    const stop = f.command("stop", "stop", { operationId: "stop-operation" });
    const statusResult = f.session.request(status);
    const stopResult = f.session.request(stop);
    expect(writtenIds(f, from)).toEqual([
      ...acks.slice(0, PIPE_ROUTE_CONTROL_COMMANDS).map((command) => command.requestId),
      "status",
      "stop",
    ]);
    f.settleWrites();
    for (const command of [...acks, unsubscribe]) {
      f.session.receive(f.reply(command));
      f.settleWrites();
    }
    for (const result of await Promise.all([...results, unsubscribed]))
      expect(result).toMatchObject({ type: "result", outcome: "accepted" });
    expect(f.lost()).toBe(0);
    // Status and stop were admitted and written; their own replies are not the point here.
    f.session.loseContact();
    await Promise.all([statusResult, stopResult]);
    filler.release();
  });

  it("holds a route-control frame's transport slot until its write callback, even after the reply", async () => {
    const f = fixture();
    f.start();
    await openRoutes(f, 1);
    f.settleWrites();
    const before = f.bytes.snapshot();
    const filler = f.bytes.reserve(before.limit - before.controlReserve - before.ordinary);
    expect(filler).not.toBeNull();
    const pressed = f.bytes.snapshot().total;
    // One subscription's ACKs, one at a time as its route queue sends them. Every reply arrives
    // before its frame's write callback, which lags by up to four frames.
    const lagging = [];
    for (let index = 0; index < 2500; index++) {
      const command = ack(f, 0, `lag-${index}`);
      const from = f.writes.length;
      const result = f.session.request(command);
      // Once every transport slot holds a frame whose reply already arrived, the ACK waits
      // unsent until the oldest frame's callback frees one.
      const full = lagging.length === PIPE_ROUTE_CONTROL_COMMANDS;
      expect(f.writes.length - from).toBe(full ? 0 : 1);
      if (full) lagging.shift().settled();
      expect(writtenIds(f, from)).toEqual([command.requestId]);
      lagging.push(f.writes.at(-1));
      f.session.receive(f.reply(command));
      expect(await result).toMatchObject({ type: "result", outcome: "accepted" });
      // Every frame in transport is paid for by the arena; the account never grows.
      expect(f.session.snapshot().prepaidFrames).toBeLessThanOrEqual(PIPE_ROUTE_CONTROL_COMMANDS);
      expect(f.bytes.snapshot().total).toBe(pressed);
    }
    expect(f.lost()).toBe(0);
    // Closing with frames still in transport keeps their storage until the callbacks run.
    f.session.loseContact();
    expect(f.session.snapshot().prepaidFrames).toBe(PIPE_ROUTE_CONTROL_COMMANDS);
    expect(f.bytes.snapshot().total).toBeGreaterThan(filler.bytes);
    for (const write of lagging) write.settled();
    expect(f.session.snapshot()).toMatchObject({ prepaidFrames: 0, prepaidBytes: 0 });
    expect(f.bytes.snapshot().total).toBe(filler.bytes);
    filler.release();
  });

  it("queues route control, status and stop at the smallest valid queue budget behind blocked output", async () => {
    // The smallest budgets validation accepts: one maximum frame of queue and one maximum
    // metadata frame of control reserve.
    const budgets = {
      ...M0_LIMITS,
      pipeQueuedBytes: HEADER_BYTES + MAX_METADATA_BYTES + 65_536,
      reservedControlBytes: HEADER_BYTES + MAX_METADATA_BYTES,
    };
    const f = fixture(budgets);
    f.start();
    // Long identifiers make each ACK frame large, as a real deployment's may be.
    const long = (prefix, index) => `${prefix}-${index}-`.padEnd(128, "x");
    const wide = (index) => ({
      ...subscription,
      connection: { connectionId: long("connection", index), generation: 0 },
      subscriptionId: long("subscription", index),
      viewId: long("view", index),
    });
    for (let index = 0; index < PIPE_ROUTE_CONTROL_COMMANDS; index++) {
      const subscribe = f.command("subscribe", long("open", index), {
        subscription: wide(index),
        atSeq: 0,
      });
      const opened = f.session.request(subscribe, new Uint8Array(), () => true);
      f.session.receive(f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 }));
      expect(await opened).toMatchObject({ outcome: "accepted" });
    }
    f.settleWrites();
    const acks = Array.from({ length: PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
      f.command("applied-ack", long("ack", index), { subscription: wide(index), appliedSeq: 1 }),
    );
    const status = f.command("status", "status");
    const stop = f.command("stop", "stop", { operationId: "stop-operation" });
    const size = (command) =>
      encodePipeFrame(1, codec.encode(JSON.stringify(command)), new Uint8Array()).value.byteLength;
    // The window's frames plus status and stop exceed the control reserve.
    expect(
      acks.reduce((total, command) => total + size(command), size(status) + size(stop)),
    ).toBeGreaterThan(budgets.reservedControlBytes);
    // An ordinary frame that takes the whole ordinary allowance is handed off and blocks.
    const input = f.command("input", "input", { subscription: wide(0), epoch: 1, inputSeq: 1 });
    const payload = new Uint8Array(
      budgets.pipeQueuedBytes - budgets.reservedControlBytes - size(input),
    );
    f.block();
    const inputResult = f.session.request(input, payload);
    expect(f.session.snapshot().physicalBytes).toBe(
      budgets.pipeQueuedBytes - budgets.reservedControlBytes,
    );
    const from = f.writes.length;
    const statusResult = f.session.request(status);
    const stopResult = f.session.request(stop);
    const results = acks.map((command) => f.session.request(command));
    expect(f.lost()).toBe(0);
    expect(f.session.snapshot()).toMatchObject({ prepaidFrames: PIPE_ROUTE_CONTROL_COMMANDS });
    f.unblock();
    f.session.drain();
    expect(writtenIds(f, from)).toEqual([
      "status",
      "stop",
      ...acks.map((command) => command.requestId),
    ]);
    f.settleWrites();
    for (const command of acks) f.session.receive(f.reply(command));
    for (const result of await Promise.all(results))
      expect(result).toMatchObject({ type: "result", outcome: "accepted" });
    expect(f.lost()).toBe(0);
    f.session.loseContact();
    await Promise.all([inputResult, statusResult, stopResult]);
  });

  it("agrees with the real worker endpoint on the window when replies are read before their write callbacks", async () => {
    // The worker's output hands every write callback to the test, so the session can read a
    // reply while the worker still waits for that reply's callback.
    const toWorker = new PassThrough();
    const replies = [];
    const callbacks = [];
    const output = new Writable({
      highWaterMark: 1024 * 1024,
      write(chunk, _encoding, callback) {
        replies.push(Buffer.from(chunk));
        callbacks.push(callback);
      },
    });
    const executed = [];
    const execution = {
      execute(command) {
        executed.push(command.requestId);
        return Promise.resolve({
          type: "result",
          worker,
          run,
          requestId: command.requestId,
          commandType: command.type,
          outcome: "accepted",
          ...(command.type === "subscribe" ? { recoveryMode: "baseline", atSeq: 0 } : {}),
        });
      },
      snapshot: () => ({}),
      shutdown: async () => [],
    };
    const pipe = runWorkerPipe(toWorker, output, {
      buildVersion: "worker",
      createExecution: () => execution,
    });
    const f = fixture(undefined, 32, (data) => toWorker.write(Buffer.from(data)));
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    let read = 0;
    const deliver = () => {
      const chunk = Buffer.concat(replies.slice(read));
      read = replies.length;
      if (chunk.length) f.session.receive(new Uint8Array(chunk));
    };
    try {
      f.session.start();
      f.settleWrites();
      await turn();
      callbacks.shift()();
      deliver();
      expect(f.session.ready).toBe(true);
      f.session.registerRun(run);
      const routes = PIPE_ROUTE_CONTROL_COMMANDS + 1;
      for (let index = 0; index < routes; index++) {
        const subscribe = f.command("subscribe", `open-${index}`, {
          subscription: on(index),
          atSeq: 0,
        });
        const opened = f.session.request(subscribe, new Uint8Array(), () => true);
        f.settleWrites();
        await turn();
        while (callbacks.length) callbacks.shift()();
        deliver();
        expect(await opened).toMatchObject({ outcome: "accepted" });
      }
      executed.length = 0;
      const acks = Array.from({ length: routes }, (_, index) => ack(f, index));
      const results = acks.map((command) => f.session.request(command));
      f.settleWrites();
      await turn();
      // The worker answered the first ACK; its reply is on the wire, its callback still held.
      expect(executed).toEqual([acks[0].requestId]);
      expect(callbacks).toHaveLength(1);
      // Reading that reply frees a session window slot, so the fifth ACK goes to the worker
      // before the worker's write callback runs. The worker parks it instead of failing closed.
      deliver();
      expect(await results[0]).toMatchObject({ outcome: "accepted" });
      f.settleWrites();
      await turn();
      expect(pipe.snapshot()).toMatchObject({
        state: "ready",
        parkedRequests: PIPE_ROUTE_CONTROL_COMMANDS,
      });
      for (let step = 0; step < 4 * routes && executed.length < routes; step++) {
        callbacks.shift()?.();
        await turn();
        deliver();
        f.settleWrites();
        await turn();
      }
      while (callbacks.length) callbacks.shift()();
      deliver();
      for (const result of await Promise.all(results))
        expect(result).toMatchObject({ type: "result", outcome: "accepted" });
      expect(executed).toEqual(acks.map((command) => command.requestId));
      expect(pipe.snapshot().state).toBe("ready");
      expect(f.lost()).toBe(0);
    } finally {
      await pipe.shutdown("test-complete");
      f.session.loseContact();
    }
  });

  // Drives the real worker endpoint at the smallest valid budgets; `delivery` chooses how the
  // runtime's bytes reach it.
  async function prepaidBeyondQueue(delivery) {
    // The smallest valid budgets; the runtime legally sends a full ordinary allowance, status,
    // stop and four prepaid ACKs, more than pipeQueuedBytes in all.
    const budgets = {
      ...M0_LIMITS,
      pipeQueuedBytes: HEADER_BYTES + MAX_METADATA_BYTES + 65_536,
      reservedControlBytes: HEADER_BYTES + MAX_METADATA_BYTES,
    };
    const toWorker = new PassThrough();
    const replies = [];
    const output = new Writable({
      highWaterMark: 1024 * 1024,
      write(chunk, _encoding, callback) {
        replies.push(Buffer.from(chunk));
        callback();
      },
    });
    const executed = [];
    const pipe = runWorkerPipe(toWorker, output, {
      buildVersion: "worker",
      createExecution: () => ({
        execute(command, payload = new Uint8Array()) {
          executed.push(command.requestId);
          const correlated = {
            worker,
            run,
            requestId: command.requestId,
            commandType: command.type,
          };
          // Status and stop only need to reach the worker and be answered here.
          if (command.type === "status" || command.type === "stop")
            return Promise.resolve({
              ...correlated,
              type: "error",
              error: domainError("CAPABILITY_UNAVAILABLE"),
            });
          return Promise.resolve({
            ...correlated,
            type: "result",
            outcome: "accepted",
            ...(command.type === "subscribe" ? { recoveryMode: "baseline", atSeq: 0 } : {}),
            ...(command.type === "input"
              ? { inputSeq: command.inputSeq, writtenBytes: payload.byteLength }
              : {}),
          });
        },
        snapshot: () => ({}),
        shutdown: async () => [],
      }),
    });
    // The session's writes are held here and handed to the worker as the test chooses.
    const outbox = [];
    const f = fixture(budgets, 32, (data) => outbox.push(Buffer.from(data)));
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const send = () => {
      if (outbox.length) toWorker.write(Buffer.concat(outbox.splice(0)));
    };
    let read = 0;
    const exchange = async () => {
      send();
      f.settleWrites();
      await turn();
      const chunk = Buffer.concat(replies.slice(read));
      read = replies.length;
      if (chunk.length) f.session.receive(new Uint8Array(chunk));
    };
    const long = (prefix, index) => `${prefix}-${index}-`.padEnd(128, "x");
    const wide = (index) => ({
      ...subscription,
      connection: { connectionId: long("connection", index), generation: 0 },
      subscriptionId: long("subscription", index),
      viewId: long("view", index),
    });
    try {
      f.session.start();
      await exchange();
      expect(f.session.ready).toBe(true);
      f.session.registerRun(run);
      for (let index = 0; index < PIPE_ROUTE_CONTROL_COMMANDS; index++) {
        const subscribe = f.command("subscribe", long("open", index), {
          subscription: wide(index),
          atSeq: 0,
        });
        const opened = f.session.request(subscribe, new Uint8Array(), () => true);
        await exchange();
        expect(await opened).toMatchObject({ outcome: "accepted" });
      }
      const size = (command, payload = 0) =>
        encodePipeFrame(1, codec.encode(JSON.stringify(command)), new Uint8Array(payload)).value
          .byteLength;
      const input = f.command("input", "input", { subscription: wide(0), epoch: 1, inputSeq: 1 });
      const payload = budgets.pipeQueuedBytes - budgets.reservedControlBytes - size(input);
      const status = f.command("status", "status");
      const stop = f.command("stop", "stop", { operationId: "stop-operation" });
      const acks = Array.from({ length: PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
        f.command("applied-ack", long("ack", index), {
          subscription: wide(index),
          appliedSeq: 1,
        }),
      );
      const results = [
        f.session.request(input, new Uint8Array(payload)),
        ...acks.map((command) => f.session.request(command)),
      ];
      const answered = [f.session.request(status), f.session.request(stop)];
      const burst = Buffer.concat(outbox.splice(0));
      expect(burst.length).toBeGreaterThan(budgets.pipeQueuedBytes);
      // Frame boundaries of the burst, in wire order, to place split points exactly.
      const frames = [];
      for (let at = 0; at < burst.length;) {
        const metadataEnd = at + HEADER_BYTES + burst.readUInt32BE(at + 8);
        const end = metadataEnd + burst.readUInt32BE(at + 12);
        const type = JSON.parse(codec.decode(burst.subarray(at + HEADER_BYTES, metadataEnd))).type;
        frames.push({ end, route: type === "applied-ack" });
        at = end;
      }
      expect(frames.filter((entry) => entry.route)).toHaveLength(acks.length);
      // The ordinary frame right after the last prepaid ACK: split one byte before its end, the
      // ACKs park while the decoder holds that frame's complete header and partial body.
      const lastAck = frames.findLastIndex((entry) => entry.route);
      const ordinaryNextToAck = frames[lastAck + 1];
      expect(ordinaryNextToAck?.route).toBe(false);
      const split = {
        coalesced: burst.length,
        // The decoder holds the partial ordinary frame when the ACKs arrive.
        fragmented: 65_535,
        // The last prepaid control frame misses exactly one byte.
        "last-byte": frames.findLast((entry) => entry.route).end - 1,
        "ordinary-tail": ordinaryNextToAck.end - 1,
      }[delivery];
      // Each read owns its own exactly sized buffer (Buffer.from may copy into Node's pool).
      toWorker.write(new Uint8Array(burst.subarray(0, split)));
      if (split < burst.length) {
        await turn();
        toWorker.write(new Uint8Array(burst.subarray(split)));
      }
      for (let step = 0; step < 16 && executed.length < 4 + 3 + acks.length; step++)
        await exchange();
      const state = pipe.snapshot().state;
      expect(state === "ready" ? state : (await pipe.closed).reason).toBe("ready");
      for (const result of await Promise.all(results))
        expect(result).toMatchObject({ type: "result", outcome: "accepted" });
      for (const result of await Promise.all(answered))
        expect(result.error).toMatchObject({ kind: "CAPABILITY_UNAVAILABLE" });
      expect(f.lost()).toBe(0);
    } finally {
      await pipe.shutdown("test-complete");
      f.session.loseContact();
    }
  }

  it("lets the real worker take prepaid route control beyond pipeQueuedBytes in one chunk", async () => {
    await expect(prepaidBeyondQueue("coalesced")).resolves.toBeUndefined();
  });

  it("lets the real worker take prepaid route control beyond pipeQueuedBytes in fragments", async () => {
    await expect(prepaidBeyondQueue("fragmented")).resolves.toBeUndefined();
  });

  it("lets the real worker take prepaid route control whose last frame misses one byte", async () => {
    await expect(prepaidBeyondQueue("last-byte")).resolves.toBeUndefined();
  });

  it("lets the real worker take prepaid route control split at an adjacent ordinary frame's tail", async () => {
    await expect(prepaidBeyondQueue("ordinary-tail")).resolves.toBeUndefined();
  });

  it("never lets prepaid route control exhaust the identities other commands need", async () => {
    const f = fixture(undefined, 3);
    f.start();
    await openRoutes(f, 2 * PIPE_ROUTE_CONTROL_COMMANDS);
    const acks = Array.from({ length: 2 * PIPE_ROUTE_CONTROL_COMMANDS }, (_, index) =>
      ack(f, index),
    );
    const results = acks.map((command) => f.session.request(command));
    // Eight route-control identities are outstanding against a limit of three, yet status is
    // still admitted: prepaid route control is bounded by the routes, not by identityLimit.
    const from = f.writes.length;
    const status = f.command("status", "status");
    const statusResult = f.session.request(status);
    expect(writtenIds(f, from)).toEqual(["status"]);
    f.settleWrites();
    for (const command of acks) f.session.receive(f.reply(command));
    for (const result of await Promise.all(results))
      expect(result).toMatchObject({ type: "result", outcome: "accepted" });
    expect(f.lost()).toBe(0);
    f.session.loseContact();
    await statusResult;
  });

  it("activates same-chunk events only after synchronous result-marker admission", async () => {
    const f = fixture();
    f.start();
    const trace = [];
    f.session.onEvent(() => trace.push("event"));
    const subscribe = f.command("subscribe", "subscribe", { subscription, atSeq: 0 });
    const pending = f.session.request(subscribe, new Uint8Array(), () => {
      trace.push("marker");
      return true;
    });
    const result = f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 });
    const event = frame(
      {
        type: "terminal-event",
        worker,
        run,
        subscription,
        terminal: { type: "output", run, seq: 1 },
      },
      new Uint8Array([65]),
    );
    const chunk = new Uint8Array(result.length + event.length);
    chunk.set(result);
    chunk.set(event, result.length);
    f.session.receive(chunk);
    expect(trace).toEqual(["marker", "event"]);
    expect((await pending).outcome).toBe("accepted");
    f.session.loseContact();
    f.session.transportReleased();
  });

  it("does not activate a new producer when marker admission fails reentrantly", async () => {
    const f = fixture();
    f.start();
    let events = 0;
    f.session.onEvent(() => {
      events++;
    });
    const subscribe = f.command("subscribe", "subscribe", { subscription, atSeq: 0 });
    const pending = f.session.request(subscribe, new Uint8Array(), () => {
      f.session.loseContact();
      return true;
    });
    const result = f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 });
    const event = frame(
      {
        type: "terminal-event",
        worker,
        run,
        subscription,
        terminal: { type: "output", run, seq: 1 },
      },
      new Uint8Array([65]),
    );
    const chunk = new Uint8Array(result.length + event.length);
    chunk.set(result);
    chunk.set(event, result.length);
    f.session.receive(chunk);
    expect((await pending).error.kind).toBe("RESULT_UNKNOWN");
    expect(events).toBe(0);
    f.session.transportReleased();
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("rejects result request run and operation correlation mismatches", async () => {
    const f = fixture();
    f.start();
    const stop = f.command("stop", "stop", { operationId: "operation" });
    const pending = f.session.request(stop);
    f.session.receive(f.reply(stop, { operationId: "other" }));
    expect((await pending).error.kind).toBe("RESULT_UNKNOWN");
    f.session.transportReleased();
    const runMismatch = fixture();
    runMismatch.start();
    const held = runMismatch.session.request(
      runMismatch.command("stop", "stop", { operationId: "operation" }),
    );
    runMismatch.session.receive(
      frame({
        type: "result",
        worker,
        run: { ...run, runId: "other" },
        requestId: "foreign",
        commandType: "stop",
        outcome: "accepted",
        operationId: "operation",
      }),
    );
    expect((await held).error.kind).toBe("RESULT_UNKNOWN");
    runMismatch.session.transportReleased();
  });

  // Contract change: identityLimit bounds in-flight requests only. Callers mint worker
  // request IDs from monotonic counters, so retaining settled IDs only exhausted the cap and
  // made every later request on the worker BUSY for the life of the server.
  it("refuses in-flight identity reuse and cap plus one but releases identities on settlement", async () => {
    const f = fixture({ ...M0_LIMITS }, 1);
    f.start();
    const first = f.command("stop", "first", { operationId: "operation" });
    const pending = f.session.request(first);
    expect((await f.session.request(first)).error.kind).toBe("COUNTER_EXHAUSTED");
    expect((await f.session.request(f.command("status", "second"))).error.kind).toBe("BUSY");
    f.session.receive(f.reply(first, { operationId: "operation" }));
    expect((await pending).outcome).toBe("accepted");
    expect(f.session.snapshot()).toMatchObject({ pending: 0, identities: 0 });
    // Far more settled requests than identityLimit never exhaust the session.
    for (let index = 0; index < 8; index++) {
      const stop = f.command("stop", `stop-${index}`, { operationId: `operation-${index}` });
      const result = f.session.request(stop);
      f.session.receive(f.reply(stop, { operationId: `operation-${index}` }));
      expect((await result).outcome).toBe("accepted");
    }
    expect(f.session.snapshot()).toMatchObject({ pending: 0, identities: 0 });
    // Contact loss settles in-flight identities too.
    const lost = f.session.request(f.command("status", "lost"));
    expect(f.session.snapshot().identities).toBe(1);
    f.session.loseContact();
    expect((await lost).error.kind).toBe("RESULT_UNKNOWN");
    expect(f.session.snapshot().identities).toBe(0);
    f.session.transportReleased();
  });

  // Regression: routes stayed (inactive) after their unsubscribe until the pipe closed, so
  // the worker refused every subscribe with BUSY after maxRuns × subscriptionsPerConnection
  // lifetime subscriptions (2048 by default).
  it("releases a route when its unsubscribe settles and keeps fencing its late events", async () => {
    const f = fixture();
    const count = M0_LIMITS.maxRuns * M0_LIMITS.subscriptionsPerConnection + 8;
    f.start();
    const delivered = [];
    f.session.onEvent((event) => delivered.push(event.subscription.subscriptionId));
    const output = (ref, seq) =>
      frame(
        {
          type: "terminal-event",
          worker,
          run,
          subscription: ref,
          terminal: { type: "output", run, seq },
        },
        new Uint8Array([65]),
      );
    for (let index = 0; index < count; index++) {
      const ref = { ...subscription, subscriptionId: `subscription-${index}` };
      const subscribe = f.command("subscribe", `subscribe-${index}`, {
        subscription: ref,
        atSeq: 0,
      });
      const opened = f.session.request(subscribe, new Uint8Array(), () => true);
      f.session.receive(f.reply(subscribe, { recoveryMode: "baseline", atSeq: 0 }));
      expect((await opened).outcome).toBe("accepted");
      f.session.receive(output(ref, 1));
      const unsubscribe = f.command("unsubscribe", `unsubscribe-${index}`, { subscription: ref });
      const closed = f.session.request(unsubscribe);
      f.settleWrites();
      expect(f.session.snapshot().routes).toBe(1);
      // An outcome other than accepted still settles the route: it stays fenced either way.
      f.session.receive(
        index % 2 ? f.reply(unsubscribe) : f.reply(unsubscribe, { outcome: "unknown" }),
      );
      await closed;
      expect(f.session.snapshot()).toMatchObject({ routes: 0, pending: 0, identities: 0 });
      f.session.receive(output(ref, 2));
    }
    expect(delivered).toEqual(Array.from({ length: count }, (_, index) => `subscription-${index}`));
    expect(f.lost()).toBe(0);
    f.session.loseContact();
    f.session.transportReleased();
  });

  // A connection that closes while an attach's baseline capture runs can see the worker
  // accept the unsubscribe before it fails or accepts the cancelled subscribe. The route
  // must be reclaimed by whichever settles last, or each race leaks one route slot.
  it("reclaims a raced route when the opener fails after the unsubscribe settled", async () =>
    expect(await racedOpener("unsubscribe-then-failed-opener")).toEqual(RECLAIMED));
  it("reclaims a raced route when the unsubscribe settles after the opener failed", async () =>
    expect(await racedOpener("failed-opener-then-unsubscribe")).toEqual(RECLAIMED));
  it("reclaims a raced route when the opener is accepted after the unsubscribe settled", async () =>
    expect(await racedOpener("unsubscribe-then-accepted-opener")).toEqual(RECLAIMED));

  it("makes a silent worker's loss unknown and ignores late disposed result", async () => {
    const f = fixture();
    f.start();
    const command = f.command("stop", "stop", { operationId: "stop" });
    const held = f.session.request(command);
    // The stop's deadline passes at 100; the silent worker is lost once the window ends at 110.
    advance(f, 0, 120);
    expect((await held).error.acceptance).toBe("unknown");
    expect(f.session.receive(f.reply(command, { operationId: "stop" }))).toBe(0);
    expect(f.lost()).toBe(1);
    f.session.transportReleased();
  });
});
