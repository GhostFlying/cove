import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { domainError } from "@cove/protocol/errors";
import { encodePipeFrame } from "@cove/protocol/pipe";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { WorkerPipeSession } from "../../dist/terminal/worker-pipe-session.js";

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
function fixture(budgets = { ...M0_LIMITS }, identityLimit = 32) {
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
      write: (data, settled) => {
        writes.push({ data, settled });
        return !blocked;
      },
    },
    now: () => now,
    timeoutMs: 100,
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
    clock: (value) => {
      now = value;
    },
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

  it("makes monotonic deadline loss unknown and ignores late disposed result", async () => {
    const f = fixture();
    f.start();
    const command = f.command("stop", "stop", { operationId: "stop" });
    const held = f.session.request(command);
    f.clock(100);
    f.session.tick();
    expect((await held).error.acceptance).toBe("unknown");
    expect(f.session.receive(f.reply(command, { operationId: "stop" }))).toBe(0);
    expect(f.lost()).toBe(1);
    f.session.transportReleased();
  });
});
