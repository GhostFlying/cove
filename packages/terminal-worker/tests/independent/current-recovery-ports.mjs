import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { M0_LIMITS, validateEffectiveBudgets } from "@cove/protocol/budgets";
import { PROFILE, DEFAULT_APPEARANCE, BASELINE_ENCODING } from "@cove/protocol/profile";
import {
  composeSpawnPayload,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
} from "@cove/protocol/pipe";
import { createWorkerExecution } from "@cove/terminal-worker/execution";
import { runWorkerPipe } from "@cove/terminal-worker/pipe";
import { WorkerRetainedBytes } from "../../dist/src/worker-retained-bytes.js";
import { RecoverySubscriptions } from "../../dist/src/recovery-subscription.js";
import { ReplayWindow } from "../../dist/src/replay-window.js";
import { currentByteFactory } from "./current-byte-factory.mjs";
import { createWorkerRunSession } from "../../dist/src/run-session.js";
import { validateBaselineTransfer } from "@cove/protocol/terminal";

export const utf8 = (value) => new TextEncoder().encode(value);
export const worker = {
  serverId: "w2-server",
  relayInstanceId: "w2-relay",
  workerId: "w2-worker",
  workerIncarnationId: "w2-incarnation",
};
export const run = (id = "run") => ({
  serverId: worker.serverId,
  relayInstanceId: worker.relayInstanceId,
  runId: id,
});
export const ref = (id = "route", target = run()) => ({
  run: target,
  connection: { connectionId: `connection-${id}`, generation: 1 },
  viewId: `view-${id}`,
  subscriptionId: `subscription-${id}`,
});
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export async function turns(count = 4) {
  assert(count <= 256, "bounded callback turns");
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
}
export async function untilTurn(predicate, label, count = 64) {
  for (let i = 0; i < count; i++) {
    if (predicate()) return;
    await turns(1);
  }
  assert(predicate(), `NOT_EXERCISED: ${label}`);
}
export function record(id, value) {
  const dir = process.env.COVE_W2_CURRENT_QA_OUTPUT;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "controlled-receipts.jsonl"), JSON.stringify({ id, value }) + "\n");
}
export const budgets = (patch = {}) => {
  const result = validateEffectiveBudgets({ ...M0_LIMITS, ...patch });
  assert(result, "source-valid effective budgets required");
  return result;
};
export function clock() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++next;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(value) {
      assert(value >= now);
      now = value;
      let callbacks = 0;
      for (;;) {
        const due = [...timers].find(([, entry]) => entry.at <= now);
        if (!due) break;
        assert(++callbacks <= 256, "timer turn bound");
        timers.delete(due[0]);
        due[1].callback();
      }
    },
    snapshot: () => ({ now, timers: timers.size, allocatedIds: next }),
  };
}
export function receipts(limit = M0_LIMITS.workerBytes, control = 4112) {
  const account = new WorkerRetainedBytes(limit, control);
  const events = [];
  const live = new Map();
  let next = 0;
  const reserve = (bytes, owner = "engine", category = "worker") => {
    const lease = account.reserve(category, bytes);
    if (!lease) {
      events.push({ phase: "denied", owner, bytes });
      return;
    }
    const id = ++next;
    const entry = { id, owner, bytes, category };
    live.set(id, entry);
    events.push({ phase: "acquire", ...entry });
    return {
      release() {
        assert(live.has(id), `duplicate owner release ${id}`);
        live.delete(id);
        events.push({ phase: "release", ...entry });
        lease.release();
      },
      shrinkTo(bytes) {
        assert(live.has(id));
        lease.shrinkTo(bytes);
        entry.bytes = bytes;
        events.push({ phase: "shrink", ...entry });
      },
    };
  };
  return {
    account,
    reserve,
    events,
    live,
    snapshot: () => ({ account: account.snapshot(), owners: [...live.values()] }),
  };
}
export function encoded(metadata, payload = new Uint8Array(), kind) {
  const result = encodePipeFrame(
    kind ?? (metadata.type === "terminal-event" ? 3 : metadata.type === "error" ? 4 : 2),
    utf8(JSON.stringify(metadata)),
    payload,
  );
  assert(result.ok, "actual pipe encoder rejected fixture");
  return result.value;
}
export function delivery(ledger = receipts()) {
  const frames = [];
  const physical = [];
  let blocked = false;
  let throwAt;
  return {
    frames,
    physical,
    ledger,
    setBlocked(value) {
      blocked = value;
    },
    throwAt(index) {
      throwAt = index;
    },
    enqueue(event, payload, token) {
      if (throwAt === frames.length) throw Error("controlled-delivery-throw");
      if (blocked) return false;
      const raw = encoded(event, payload);
      const lease = ledger.reserve(raw.length, "physical-delivery");
      if (!lease) return false;
      const frame = {
        event: structuredClone(event),
        payload: Uint8Array.from(payload),
        token,
        encodedBytes: raw.length,
        rawHex: Buffer.from(raw).toString("hex"),
        lease,
        settled: false,
      };
      frames.push(frame);
      physical.push(frame);
      record("actual-delivery-frame", {
        event: frame.event,
        rawHex: frame.rawHex,
        token,
        owners: ledger.snapshot(),
      });
      return raw.length;
    },
    cancelUnsent(token) {
      record("cancel-unsent", {
        token,
        physicalDebt: physical.filter((f) => !f.settled).reduce((n, f) => n + f.encodedBytes, 0),
      });
    },
    settle(index) {
      const frame = physical[index];
      if (frame.settled) return;
      frame.settled = true;
      frame.payload = new Uint8Array();
      frame.lease.release();
    },
    close() {
      physical.forEach((_, index) => this.settle(index));
    },
  };
}
export function syntheticBaseline(target, vtBytes = 1, tailBytes = 0, atSeq = 0) {
  return {
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    checkpointSeq: atSeq,
    atSeq,
    captureGeometry: { cols: 12, rows: 4 },
    currentGeometry: { cols: 12, rows: 4 },
    coverage: {
      normal: {
        historyLines: 0,
        includedHistoryLines: 0,
        trimmedBefore: false,
        resizeContext: "complete",
      },
      alternate: { included: true, resizeContext: "complete" },
    },
    appearance: DEFAULT_APPEARANCE,
    vt: new Uint8Array(vtBytes).fill(65),
    tail: new Uint8Array(tailBytes).fill(66),
    run: target,
  };
}
export function recoveryRig(patch = {}) {
  const effective = budgets(patch);
  const ledger = receipts(effective.workerBytes, effective.reservedControlBytes);
  const sink = delivery(ledger);
  const time = clock();
  const recovery = new RecoverySubscriptions(worker, effective, ledger.reserve, sink, time);
  let next = 0;
  const command = (type, subscription = ref(), fields = {}) => ({
    type,
    worker,
    run: subscription.run,
    requestId: `current-${++next}`,
    subscription,
    ...fields,
  });
  const source = (target = run(), options = {}) => {
    const replay = new ReplayWindow(effective.replayBytes, effective.replayEvents, ledger.reserve);
    return {
      run: target,
      replay,
      async captureBaseline(reserve) {
        const n = (options.vtBytes ?? 1) + (options.tailBytes ?? 0) + 4096;
        if (!reserve(n)) return { status: "unavailable", reason: "denied-detached" };
        const baseline = syntheticBaseline(
          target,
          options.vtBytes ?? 1,
          options.tailBytes ?? 0,
          options.atSeq ?? 0,
        );
        options.mutate?.(baseline);
        return { status: "ready", baseline };
      },
    };
  };
  return {
    effective,
    ledger,
    sink,
    time,
    recovery,
    command,
    source,
    close() {
      recovery.shutdown();
      sink.close();
    },
  };
}
export function executionRig(patch = {}, nativeOptions = {}) {
  const effective = budgets(patch);
  const native = currentByteFactory(nativeOptions);
  const sink = delivery();
  const facts = [];
  const faults = [];
  const leaseEvents = [];
  const liveLeases = new Map();
  let leaseId = 0;
  const originalReserve = WorkerRetainedBytes.prototype.reserve;
  const observedReserve = function (category, bytes) {
    const actual = originalReserve.call(this, category, bytes);
    if (this === sink.ledger.account) return actual;
    if (!actual) {
      leaseEvents.push({ phase: "denied", category, bytes });
      return;
    }
    const id = ++leaseId;
    const entry = { id, category, bytes };
    liveLeases.set(id, entry);
    leaseEvents.push({ phase: "acquire", ...entry });
    return {
      release() {
        leaseEvents.push({ phase: liveLeases.has(id) ? "release" : "duplicate-release", ...entry });
        liveLeases.delete(id);
        actual.release();
      },
      shrinkTo(next) {
        actual.shrinkTo(next);
        entry.bytes = next;
        leaseEvents.push({ phase: "shrink", ...entry });
      },
    };
  };
  WorkerRetainedBytes.prototype.reserve = observedReserve;
  const execution = createWorkerExecution({
    worker,
    effectiveBudgets: effective,
    factory: native,
    delivery: sink,
    onFact: (fact) =>
      facts.push({
        event: structuredClone(fact.event),
        hex: fact.bytes && Buffer.from(fact.bytes).toString("hex"),
      }),
    onFault: (fault) => faults.push(fault),
  });
  let next = 0;
  const command = (type, target = run(), fields = {}) => ({
    type,
    worker,
    run: target,
    requestId: `execution-${++next}`,
    ...fields,
  });
  const execute = async (c, payload) => {
    const value = await execution.execute(c, payload);
    execution.markerEnqueued(c, value);
    execution.responseSettled(c.requestId);
    return value;
  };
  return {
    effective,
    native,
    sink,
    facts,
    faults,
    leaseEvents,
    liveLeases,
    execution,
    command,
    execute,
    async spawn(target = run(), geometry = { cols: 12, rows: 4 }) {
      const payload = composeSpawnPayload(
        { executable: "fixture", argv: [], cwd: process.cwd() },
        utf8,
      );
      assert(payload.ok !== false);
      const c = command("spawn", target, {
        operationId: `spawn-${target.runId}`,
        geometry,
        profile: PROFILE,
        appearance: DEFAULT_APPEARANCE,
        effectiveBudgets: effective,
        spawnPayloadBytes: payload.bytes.length,
      });
      const result = await execute(c, payload.bytes);
      assert.equal(result.outcome, "accepted");
      return result;
    },
    async install(subscription = ref()) {
      const c = command("subscribe", subscription.run, { subscription, atSeq: 0 });
      const value = await execute(c);
      assert.equal(value.outcome, "accepted");
      let progress = -1;
      for (let turn = 0; turn < 64; turn++) {
        await turns(1);
        const current = sink.frames.filter(
          (f) => f.event.subscription?.subscriptionId === subscription.subscriptionId,
        );
        const start = current.findLast((f) => f.event.terminal.type === "baseline-start");
        const chunks = current.filter(
          (f) =>
            f.event.terminal.type === "baseline-chunk" &&
            f.event.terminal.baselineId === start?.event.terminal.descriptor.baselineId,
        );
        if (chunks.length && chunks.at(-1).event.terminal.ordinal > progress) {
          progress = chunks.at(-1).event.terminal.ordinal;
          const p = await execute(
            command("baseline-progress", subscription.run, {
              subscription,
              baselineId: start.event.terminal.descriptor.baselineId,
              lastParsedOrdinal: progress,
            }),
          );
          assert.equal(p.outcome, "accepted");
        }
        if (
          current.some(
            (f) =>
              f.event.terminal.type === "baseline-end" &&
              f.event.terminal.baselineId === start?.event.terminal.descriptor.baselineId,
          )
        ) {
          const ack = await execute(
            command("applied-ack", subscription.run, { subscription, appliedSeq: value.atSeq }),
          );
          assert.equal(ack.outcome, "accepted");
          return value;
        }
      }
      assert.fail("NOT_EXERCISED: complete actual installation");
    },
    async grant(subscription = ref()) {
      const value = await execute(
        command("set-control", subscription.run, {
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: {
            connection: subscription.connection,
            viewId: subscription.viewId,
            subscriptionId: subscription.subscriptionId,
          },
          geometry: { cols: 12, rows: 4 },
        }),
      );
      assert.equal(value.outcome, "accepted");
      return value;
    },
    async close() {
      try {
        const value = await execution.shutdown("current-QA-only");
        sink.close();
        record("execution-cleanup", {
          value,
          state: execution.snapshot(),
          native: native.snapshot(),
          nativeReceipts: native.receipts,
          leaseEvents,
          liveLeases: [...liveLeases.values()],
        });
      } finally {
        assert.equal(WorkerRetainedBytes.prototype.reserve, observedReserve);
        WorkerRetainedBytes.prototype.reserve = originalReserve;
      }
    },
  };
}
export function endpointRig(patch = {}, options = {}) {
  const effective = budgets(patch);
  const native = currentByteFactory(options.native);
  const input = new PassThrough();
  const frames = [];
  const callbacks = [];
  const decoder = createPipeDecoder();
  let execution;
  let held = false;
  let reader;
  let rawReader;
  const output = new Writable({
    highWaterMark: 1,
    write(raw, _encoding, callback) {
      record("actual-pipe-output", { rawHex: Buffer.from(raw).toString("hex") });
      rawReader?.(raw);
      const result = decoder.read(raw);
      assert.notEqual(result.status, "error");
      for (const frame of result.frames) {
        const metadata = JSON.parse(Buffer.from(frame.metadata).toString());
        assert(validatePipeFrame(frame, metadata).ok);
        frames.push({
          metadata,
          payload: Uint8Array.from(frame.payload),
          rawHex: Buffer.from(raw).toString("hex"),
        });
        reader?.(metadata);
      }
      if (held) callbacks.push(callback);
      else callback();
    },
  });
  const pipe = runWorkerPipe(input, output, {
    buildVersion: "current-QA",
    createExecution(opts) {
      execution = createWorkerExecution({ ...opts, factory: native });
      return execution;
    },
  });
  const send = (metadata, payload) => input.write(encoded(metadata, payload, 1));
  if (!options.externalHello)
    send({
      type: "hello",
      worker,
      pipeVersion: 2,
      buildVersion: "current-QA",
      effectiveBudgets: effective,
    });
  return {
    effective,
    native,
    input,
    output,
    frames,
    callbacks,
    pipe,
    get execution() {
      return execution;
    },
    send,
    hold(value = true) {
      held = value;
    },
    reader(callback) {
      reader = callback;
    },
    rawReader(callback) {
      rawReader = callback;
    },
    release() {
      const callback = callbacks.shift();
      assert(callback, "real physical callback");
      callback();
    },
    async close() {
      held = false;
      while (callbacks.length) callbacks.shift()();
      input.end();
      await pipe.closed;
      output.destroy();
      record("endpoint-cleanup", {
        pipe: pipe.snapshot(),
        worker: execution?.snapshot(),
        native: native.snapshot(),
        nativeReceipts: native.receipts,
      });
    },
  };
}

export async function parseBaseline(rig, subscription, marker) {
  assert.equal(marker.result.outcome, "accepted");
  const first = rig.sink.frames.length;
  assert.equal(rig.recovery.installed(subscription), false);
  rig.recovery.markerEnqueued(marker.command, marker.result);
  let parsed = -1;
  let baselineId;
  for (let turn = 0; turn < 192; turn++) {
    await turns(1);
    const frames = rig.sink.frames
      .slice(first)
      .filter((frame) => JSON.stringify(frame.event.subscription) === JSON.stringify(subscription));
    const start = frames.find((frame) => frame.event.terminal.type === "baseline-start");
    if (!start) continue;
    baselineId = start.event.terminal.descriptor.baselineId;
    const chunks = frames.filter(
      (frame) =>
        frame.event.terminal.type === "baseline-chunk" &&
        frame.event.terminal.baselineId === baselineId,
    );
    if (chunks.length && chunks.at(-1).event.terminal.ordinal > parsed) {
      parsed = chunks.at(-1).event.terminal.ordinal;
      const progress = rig.recovery.command(
        rig.command("baseline-progress", subscription, { baselineId, lastParsedOrdinal: parsed }),
      );
      assert.equal(progress.result?.outcome, "accepted");
    }
    const end = frames.find(
      (frame) =>
        frame.event.terminal.type === "baseline-end" &&
        frame.event.terminal.baselineId === baselineId,
    );
    if (!end) continue;
    assert(
      validateBaselineTransfer(
        start.event.terminal.descriptor,
        chunks.map((frame) => ({ metadata: frame.event.terminal, payload: frame.payload })),
        end.event.terminal,
      ),
    );
    assert.equal(rig.recovery.installed(subscription), false);
    const ack = rig.recovery.command(
      rig.command("applied-ack", subscription, { appliedSeq: marker.result.atSeq }),
    );
    assert.equal(ack.result?.outcome, "accepted");
    assert(rig.recovery.installed(subscription));
    return { frames, baselineId, descriptor: start.event.terminal.descriptor };
  }
  assert.fail("NOT_EXERCISED: valid complete parsed baseline");
}

export function sessionRecoveryRig(patch = {}) {
  const rig = recoveryRig(patch);
  const native = currentByteFactory();
  const target = run("capture-real");
  const replay = new ReplayWindow(
    rig.effective.replayBytes,
    rig.effective.replayEvents,
    rig.ledger.reserve,
  );
  const facts = [];
  const identities = [];
  const pending = [];
  const created = createWorkerRunSession({
    run: target,
    geometry: { cols: 12, rows: 4 },
    effectiveBudgets: rig.effective,
    spawn: { file: "fixture", args: [], cwd: process.cwd(), inputBytes: 65536, inputTasks: 256 },
    factory: native,
    isSubscriptionInstalled: (subscription) => rig.recovery.installed(subscription),
    reserveIngressBytes: (bytes) => rig.ledger.reserve(bytes, "run-ingress"),
    reserveInputIdentity: () => {
      const lease = rig.ledger.reserve(512, "input-identity");
      if (!lease) return false;
      identities.push(lease);
      return true;
    },
    reserveRetainedBytes: (bytes) => rig.ledger.reserve(bytes, "engine", "engine"),
    availableRetainedBytes: () => rig.ledger.account.availableOrdinaryBytes(),
    reserveNativeRetainedBytes: (category, bytes) =>
      rig.ledger.reserve(
        bytes,
        category,
        category === "native-input" ? "native-input" : "native-output",
      ),
    onRetainedFact(fact) {
      replay.append(fact);
      rig.recovery.onFact(target, fact, replay);
    },
    onFact(fact) {
      facts.push({
        event: structuredClone(fact.event),
        hex: fact.bytes && Buffer.from(fact.bytes).toString("hex"),
      });
    },
  });
  assert.equal(created.kind, "created");
  let onDetached;
  const source = {
    run: target,
    replay,
    captureBaseline: (reserve) =>
      created.capability.captureBaseline((bytes) => {
        const accepted = reserve(bytes);
        if (accepted) onDetached?.(bytes);
        return accepted;
      }),
  };
  return {
    ...rig,
    target,
    native,
    replay,
    facts,
    pending,
    session: created.session,
    capability: created.capability,
    source,
    setDetached(callback) {
      onDetached = callback;
    },
    async install(subscription) {
      const command = rig.command("subscribe", subscription, { atSeq: 0 });
      const outcome = await rig.recovery.open(command, source);
      assert(outcome.result);
      return parseBaseline(rig, subscription, { command, result: outcome.result });
    },
    async close() {
      rig.recovery.shutdown();
      await created.capability.execute({ type: "stop" });
      await Promise.all(pending);
      replay.clear();
      identities.forEach((lease) => lease.release());
      rig.sink.close();
      record("session-cleanup", { state: rig.ledger.snapshot(), native: native.snapshot() });
    },
  };
}
