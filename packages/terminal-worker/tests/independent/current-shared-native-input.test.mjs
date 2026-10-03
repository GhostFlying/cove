import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import { createWorkerExecution } from "@cove/terminal-worker/execution";
import { PROFILE, DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { composeSpawnPayload } from "@cove/protocol/pipe";
import { WorkerRetainedBytes } from "../../dist/src/worker-retained-bytes.js";
import { currentByteFactory } from "./current-byte-factory.mjs";
import {
  budgets,
  delivery,
  record,
  ref,
  run,
  turns,
  untilTurn,
  utf8,
} from "./current-recovery-ports.mjs";

const rawReceipt = (raw) => ({
  bytes: raw.byteLength,
  rawHex: Buffer.from(raw).toString("hex"),
  sha256: createHash("sha256").update(raw).digest("hex"),
});
const inputKeyCharge = (subscription) =>
  192 +
  Buffer.byteLength(subscription.connection.connectionId) +
  Buffer.byteLength(subscription.viewId) +
  Buffer.byteLength(subscription.subscriptionId);

async function sharedCase(id, dimension, variant) {
  const effective = budgets({ workerBytes: 262144, reservedControlBytes: 4112 });
  const participants = ["a", "b"].map((suffix) => {
    const name = `global-${dimension}-${suffix}`;
    const target = run(name);
    return {
      name,
      target,
      subscription: ref(name, target),
      sink: delivery(),
      worker: {
        serverId: "w2-server",
        relayInstanceId: "w2-relay",
        workerId: name,
        workerIncarnationId: `global-${dimension}-incarnation-${suffix}`,
      },
      facts: [],
      faults: [],
      live: new Map(),
      next: 0,
    };
  });
  const [a, b] = participants;
  const leaseEvents = [];
  const portEvents = [];
  const callbackReturns = [];
  const closeValues = new Map();
  const accounts = new WeakMap();
  const ownerParticipants = new WeakMap();
  let actor;
  let leaseId = 0;
  let ordinal = 0;
  let factory;
  const snapshot = () => ({
    effective,
    shared: factory?.shared.snapshot(),
    factory: factory?.snapshot(),
    participants: participants.map((p) => ({
      worker: p.worker,
      run: p.target,
      subscription: p.subscription,
      execution: p.execution?.snapshot(),
      account: p.account?.snapshot(),
      accountId: p.accountId,
      live: [...p.live.values()].map((value) => ({ ...value })),
      facts: p.facts,
      faults: p.faults,
      physicalAccount: p.sink.ledger.snapshot(),
      physical: p.sink.physical.map((frame, index) => ({
        index,
        event: frame.event,
        token: frame.token,
        rawHex: frame.rawHex,
        encodedBytes: frame.encodedBytes,
        settled: frame.settled,
      })),
      native: p.owner && {
        controller: p.owner.controller.snapshot(),
        tasks: p.owner.tasks.map((task) => ({
          ticket: task.ticket,
          settled: task.settled,
          raw: task.raw && rawReceipt(task.raw),
          byteLength: task.byteLength,
          sha256: task.sha256,
        })),
      },
    })),
    leaseEvents,
    portEvents,
    nativeReceipts: factory?.receipts,
  });
  const capture = (phase, value = {}) => {
    const receipt = structuredClone({
      ordinal: ++ordinal,
      id,
      variant,
      dimension,
      phase,
      ...value,
      state: snapshot(),
    });
    record(`${id}-${variant}`, receipt);
    return receipt;
  };
  factory = currentByteFactory({
    sharedBytes: dimension === "byte" ? 20000 : 65536,
    sharedTasks: dimension === "byte" ? 256 : 1,
    hold: true,
    onSettlement(owner, value) {
      if (value.status === "closed") closeValues.set(value.ticket, value);
      capture("actual-writer-settlement-enter", {
        worker: ownerParticipants.get(owner)?.worker,
        value,
      });
    },
    onConsumerReturn(owner, result) {
      const receipt = capture("actual-consumer-return-before-physical-release", {
        worker: ownerParticipants.get(owner)?.worker,
        result,
      });
      callbackReturns.push(receipt);
    },
  });
  const originalSpawn = factory.spawn;
  factory.spawn = function (spec, observer) {
    const p = actor;
    capture("actual-factory-spawn-enter", {
      worker: p?.worker,
      spec: {
        ...spec,
        env: { keys: Object.keys(spec.env ?? {}), values: "not-recorded" },
        reserveRetainedBytes: typeof spec.reserveRetainedBytes,
      },
    });
    const result = originalSpawn.call(this, spec, observer);
    const owner = factory.owners.at(-1);
    p.owner = owner;
    ownerParticipants.set(owner, p);
    const originalSubmit = result.pty.submit;
    result.pty.submit = function (raw, callback) {
      const eventStart = leaseEvents.length;
      capture("actual-native-submit-enter", { worker: p.worker, raw: rawReceipt(raw), eventStart });
      try {
        const admission = originalSubmit.call(this, raw, function (value) {
          capture("actual-native-consumer-enter", { worker: p.worker, value });
          try {
            const returned = callback.call(this, value);
            capture("actual-native-consumer-return", { worker: p.worker, value, returned });
            return returned;
          } catch (error) {
            capture("actual-native-consumer-throw", { worker: p.worker, error: String(error) });
            throw error;
          }
        });
        const event = {
          worker: p.worker,
          raw: rawReceipt(raw),
          admission,
          eventStart,
          eventEnd: leaseEvents.length,
        };
        portEvents.push(structuredClone(event));
        capture("actual-native-submit-return", event);
        return admission;
      } catch (error) {
        capture("actual-native-submit-throw", {
          worker: p.worker,
          error: String(error),
          eventStart,
        });
        throw error;
      }
    };
    capture("actual-factory-spawn-return", { worker: p.worker, kind: result.kind });
    return result;
  };
  const originalReserve = WorkerRetainedBytes.prototype.reserve;
  const observedReserve = function (category, bytes) {
    const actual = originalReserve.call(this, category, bytes);
    if (participants.some((p) => p.sink.ledger.account === this)) return actual;
    let p = accounts.get(this);
    if (!p) {
      p = actor;
      assert(p, "actual retained account must have its originating worker command");
      accounts.set(this, p);
      p.account = this;
      p.accountId = `actual-account-${p.name}`;
    }
    if (!actual) {
      leaseEvents.push({ phase: "denied", accountId: p.accountId, category, bytes });
      return actual;
    }
    const entry = { id: ++leaseId, accountId: p.accountId, category, bytes };
    p.live.set(entry.id, entry);
    leaseEvents.push({ phase: "acquire", ...entry });
    return {
      release() {
        leaseEvents.push({
          phase: p.live.has(entry.id) ? "release" : "duplicate-release",
          ...entry,
        });
        p.live.delete(entry.id);
        return actual.release();
      },
      shrinkTo(next) {
        const returned = actual.shrinkTo(next);
        entry.bytes = next;
        leaseEvents.push({ phase: "shrink", ...entry });
        return returned;
      },
    };
  };
  WorkerRetainedBytes.prototype.reserve = observedReserve;
  const command = (p, type, fields = {}) => ({
    type,
    worker: p.worker,
    run: p.target,
    requestId: `${p.name}-${++p.next}`,
    ...fields,
  });
  const start = (p, c, payload) => {
    const eventStart = leaseEvents.length;
    capture("command-before", { command: c, payload: payload && rawReceipt(payload), eventStart });
    let pending;
    const previous = actor;
    actor = p;
    try {
      pending = p.execution.execute(c, payload);
    } catch (error) {
      capture("command-synchronous-throw", { command: c, error: String(error), eventStart });
      throw error;
    } finally {
      actor = previous;
    }
    capture("command-after-call", { command: c, eventStart, eventEnd: leaseEvents.length });
    return pending.then(
      (result) => {
        capture("command-result-before-marker", {
          command: c,
          result,
          eventStart,
          eventEnd: leaseEvents.length,
        });
        p.execution.markerEnqueued(c, result);
        capture("marker-enqueued-return", { command: c, result });
        p.execution.responseSettled(c.requestId);
        capture("response-settled-return", { command: c, result });
        return result;
      },
      (error) => {
        capture("command-rejected", { command: c, error: String(error), eventStart });
        throw error;
      },
    );
  };
  const accepted = (p, c, value) => {
    assert.equal(value.type, "result");
    assert.equal(value.outcome, "accepted");
    assert.equal(value.requestId, c.requestId);
    assert.deepEqual(value.worker, p.worker);
    assert.deepEqual(value.run, p.target);
  };
  const install = async (p) => {
    const c = command(p, "subscribe", { subscription: p.subscription, atSeq: 0 });
    const value = await start(p, c);
    accepted(p, c, value);
    let progress = -1;
    for (let turn = 0; turn < 64; turn++) {
      await turns(1);
      const frames = p.sink.frames.filter(
        (f) => f.event.subscription?.subscriptionId === p.subscription.subscriptionId,
      );
      const first = frames.findLast((f) => f.event.terminal.type === "baseline-start");
      const chunks = frames.filter(
        (f) =>
          f.event.terminal.type === "baseline-chunk" &&
          f.event.terminal.baselineId === first?.event.terminal.descriptor.baselineId,
      );
      if (chunks.length && chunks.at(-1).event.terminal.ordinal > progress) {
        progress = chunks.at(-1).event.terminal.ordinal;
        const next = command(p, "baseline-progress", {
          subscription: p.subscription,
          baselineId: first.event.terminal.descriptor.baselineId,
          lastParsedOrdinal: progress,
        });
        accepted(p, next, await start(p, next));
      }
      if (
        frames.some(
          (f) =>
            f.event.terminal.type === "baseline-end" &&
            f.event.terminal.baselineId === first?.event.terminal.descriptor.baselineId,
        )
      ) {
        const ack = command(p, "applied-ack", {
          subscription: p.subscription,
          appliedSeq: value.atSeq,
        });
        accepted(p, ack, await start(p, ack));
        return value;
      }
    }
    assert.fail("NOT_EXERCISED: complete actual public installation");
  };
  let primaryError;
  try {
    for (const p of participants) {
      p.execution = createWorkerExecution({
        worker: p.worker,
        effectiveBudgets: effective,
        factory,
        delivery: p.sink,
        onFact: (fact) =>
          p.facts.push({
            event: structuredClone(fact.event),
            raw: fact.bytes && rawReceipt(fact.bytes),
          }),
        onFault: (fault) => p.faults.push(fault),
      });
      const payload = composeSpawnPayload(
        { executable: "fixture", argv: [], cwd: process.cwd() },
        utf8,
      );
      assert(payload.ok !== false);
      const spawn = command(p, "spawn", {
        operationId: `spawn-${p.name}`,
        geometry: { cols: 12, rows: 4 },
        profile: PROFILE,
        appearance: DEFAULT_APPEARANCE,
        effectiveBudgets: effective,
        spawnPayloadBytes: payload.bytes.length,
      });
      accepted(p, spawn, await start(p, spawn, payload.bytes));
      await install(p);
      const grant = command(p, "set-control", {
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: {
          connection: p.subscription.connection,
          viewId: p.subscription.viewId,
          subscriptionId: p.subscription.subscriptionId,
        },
        geometry: { cols: 12, rows: 4 },
      });
      accepted(p, grant, await start(p, grant));
    }
    for (const [index, p] of participants.entries()) {
      const raw = new Uint8Array(5000).fill(65 + index);
      capture("fixed-native-seed-before", { worker: p.worker, raw: rawReceipt(raw) });
      p.owner.emit(raw);
      const c = command(p, "status");
      const before = capture("ordinary-status-guards-before", { command: c });
      const state = before.state.participants[index].execution;
      const session = state.sessions[0].snapshot;
      assert.equal(state.ordinaryPendingCommands, 0);
      assert.equal(state.pendingCommands, 0);
      assert.equal(state.reservedStatusPending, false);
      assert.equal(state.shuttingDown, false);
      assert.equal(state.runs[0].status, "live");
      assert.equal(session.faulted, false);
      assert.equal(session.disposed, false);
      assert.equal(session.consumerFenced, false);
      assert(session.queuedItems < 256);
      const result = await start(p, c);
      accepted(p, c, result);
      assert.equal(result.runStatus.receivedSeq, 2);
      assert.equal(result.runStatus.parsedSeq, 2);
      const ack = command(p, "applied-ack", { subscription: p.subscription, appliedSeq: 1 });
      accepted(p, ack, await start(p, ack));
      capture("physical-sink-close-after-original-ACK1", { worker: p.worker });
      p.sink.close();
      const backing = capture("physical-tail-before-strict-assertions", { worker: p.worker });
      const physical = backing.state.participants[index];
      assert.equal(
        physical.execution.sessions[0].snapshot.settledState.resources.tailAllocatedBytes,
        65536,
      );
      assert(physical.live.some((entry) => entry.category === "engine" && entry.bytes === 65536));
    }
    assert.notEqual(a.account, b.account);
    const payload = new Uint8Array(20000);
    const firstCommand = command(a, "input", {
      subscription: a.subscription,
      epoch: 1,
      inputSeq: 1,
    });
    let firstDone = false;
    const first = start(a, firstCommand, payload).then((result) => {
      firstDone = true;
      return result;
    });
    await untilTurn(() => a.owner.tasks.length === 1, "actual A native writer admission");
    capture("A-native-held-before-assertions", {
      command: firstCommand,
      promiseCompleted: firstDone,
    });
    assert.equal(firstDone, false);
    assert.equal(a.owner.tasks[0].raw.length, 20000);
    assert.deepEqual(rawReceipt(a.owner.tasks[0].raw), rawReceipt(payload));
    assert.equal(factory.shared.snapshot().allocatedBytes, 20000);
    assert.equal(factory.shared.snapshot().tasks, 1);
    assert.equal(a.account.snapshot().nativeInputBytes, 40768);
    const secondCommand = command(b, "input", {
      subscription: b.subscription,
      epoch: 1,
      inputSeq: 1,
    });
    const q = 128 + Buffer.byteLength(JSON.stringify(secondCommand)) + payload.length;
    const key = inputKeyCharge(b.subscription);
    const eventStart = leaseEvents.length;
    const portStart = portEvents.length;
    const before = capture("B-global-rejection-isolation-before", {
      command: secondCommand,
      Q: q,
      keyCharge: key,
      requiredHeadroom: q + key + 40768,
      eventStart,
      portStart,
    });
    const bBefore = before.state.participants[1];
    assert(b.account.availableOrdinaryBytes() >= q + key + 40768);
    assert.equal(bBefore.execution.ordinaryPendingCommands, 0);
    assert.equal(bBefore.execution.inputIdentities, 0);
    const second = await start(b, secondCommand, payload);
    const after = capture("B-global-rejection-result-before-assertions", {
      command: secondCommand,
      result: second,
      Q: q,
      keyCharge: key,
      eventStart,
      eventEnd: leaseEvents.length,
      portStart,
    });
    assert.equal(second.type, "error");
    assert.equal(second.requestId, secondCommand.requestId);
    assert.deepEqual(second.worker, b.worker);
    assert.deepEqual(second.run, b.target);
    assert.equal(second.error.kind, "BUSY");
    assert.equal(second.error.acceptance, "not-accepted");
    const ports = portEvents.slice(portStart);
    assert.equal(ports.length, 1);
    assert.equal(ports[0].admission.kind, "rejected");
    assert.equal(ports[0].admission.reason, `factory-${dimension}-limit`);
    assert.equal(b.owner.tasks.length, 0);
    assert.equal(b.owner.controller.snapshot().allocatedBytes, 0);
    assert.equal(b.owner.controller.snapshot().tasks, 0);
    assert.equal(factory.shared.snapshot().allocatedBytes, 20000);
    assert.equal(factory.shared.snapshot().tasks, 1);
    const bEvents = leaseEvents
      .slice(eventStart)
      .filter((event) => event.accountId === b.accountId);
    assert(!bEvents.some((event) => event.phase === "denied"));
    const copy = bEvents.filter(
      (event) => event.phase === "acquire" && event.category === "worker" && event.bytes === q,
    );
    const identity = bEvents.filter(
      (event) => event.phase === "acquire" && event.category === "worker" && event.bytes === key,
    );
    assert.equal(copy.length, 1);
    assert.equal(identity.length, 1);
    assert.equal(
      bEvents.filter((event) => event.phase === "release" && event.id === copy[0].id).length,
      1,
    );
    assert(b.live.has(identity[0].id));
    assert.equal(after.state.participants[1].execution.inputIdentities, 1);
    assert.deepEqual(after.state.participants[1].execution.replay, bBefore.execution.replay);
    assert.deepEqual(after.state.participants[1].facts, bBefore.facts);
    assert.deepEqual(
      after.state.participants[1].live,
      [...bBefore.live, identity[0]].map(({ phase: _phase, ...entry }) => entry),
    );
    const aTask = a.owner.tasks[0];
    capture("before-actual-A-written-settlement", {
      ticket: aTask.ticket,
      raw: rawReceipt(aTask.raw),
    });
    a.owner.settle(aTask, "written", 20000);
    const firstResult = await first;
    capture("A-written-result-before-assertions", { command: firstCommand, result: firstResult });
    accepted(a, firstCommand, firstResult);
    assert.equal(firstResult.writtenBytes, 20000);
    const aReturn = callbackReturns.find((entry) => entry.worker.workerId === a.worker.workerId);
    assert(aReturn, "actual A callback return receipt");
    assert.equal(aReturn.state.shared.allocatedBytes, 20000);
    assert.equal(aReturn.state.shared.tasks, 1);
    assert.equal(aReturn.state.participants[0].account.nativeInputBytes, 40768);
    assert.equal(factory.shared.snapshot().allocatedBytes, 0);
    assert.equal(a.account.snapshot().nativeInputBytes, 0);
    const validCommand = command(b, "input", {
      subscription: b.subscription,
      epoch: 1,
      inputSeq: 2,
    });
    const valid = start(b, validCommand, payload);
    await untilTurn(() => b.owner.tasks.length === 1, "actual B seq2 matched writer admission");
    const bTask = b.owner.tasks[0];
    capture("B-valid-seq2-held-before-assertions", {
      command: validCommand,
      raw: rawReceipt(bTask.raw),
      ticket: bTask.ticket,
    });
    assert.equal(factory.shared.snapshot().allocatedBytes, 20000);
    assert.equal(factory.shared.snapshot().tasks, 1);
    assert.equal(b.account.snapshot().nativeInputBytes, 40768);
    assert.deepEqual(rawReceipt(bTask.raw), rawReceipt(payload));
    if (variant === "written") b.owner.settle(bTask, "written", 20000);
    else {
      capture("before-real-B-shutdown", { command: validCommand });
      const shutdown = await b.execution.shutdown(`${id}-closed-late`);
      capture("after-real-B-shutdown", { command: validCommand, shutdown });
    }
    const validResult = await valid;
    capture("B-valid-seq2-result-before-assertions", {
      command: validCommand,
      result: validResult,
    });
    if (variant === "written") {
      accepted(b, validCommand, validResult);
      assert.equal(validResult.writtenBytes, 20000);
    } else {
      assert.equal(validResult.type, "error");
      assert.equal(validResult.requestId, validCommand.requestId);
      assert.deepEqual(validResult.worker, b.worker);
      assert.deepEqual(validResult.run, b.target);
      assert.equal(validResult.error.kind, "RESULT_UNKNOWN");
      assert.equal(validResult.error.acceptance, "unknown");
      const actualClose = closeValues.get(bTask.ticket);
      assert(actualClose, "actual disposeBoundedWrite close callback argument");
      const beforeLate = capture("before-captured-actual-close-callback-late", {
        ticket: bTask.ticket,
        actualClose,
      });
      bTask.callback(actualClose);
      const afterLate = capture("after-captured-actual-close-callback-late", {
        ticket: bTask.ticket,
        actualClose,
      });
      assert.deepEqual(afterLate.state.shared, beforeLate.state.shared);
      assert.deepEqual(afterLate.state.participants[1].live, beforeLate.state.participants[1].live);
      assert.equal(b.owner.tasks.length, 1);
    }
    const bReturn = callbackReturns.find((entry) => entry.worker.workerId === b.worker.workerId);
    assert(bReturn, "actual B callback return receipt");
    assert.equal(bReturn.state.shared.allocatedBytes, 20000);
    assert.equal(bReturn.state.shared.tasks, 1);
    assert.equal(bReturn.state.participants[1].account.nativeInputBytes, 40768);
    assert.equal(factory.shared.snapshot().allocatedBytes, 0);
    assert.equal(factory.shared.snapshot().tasks, 0);
    assert.equal(b.account.snapshot().nativeInputBytes, 0);
    for (const p of participants) {
      const native = leaseEvents.filter(
        (entry) => entry.accountId === p.accountId && entry.category === "native-input",
      );
      assert.equal(native.filter((entry) => entry.phase === "acquire").length, 1);
      assert.equal(native.filter((entry) => entry.phase === "release").length, 1);
      assert(!native.some((entry) => entry.phase === "duplicate-release"));
    }
    capture("variant-body-complete");
  } catch (error) {
    primaryError = error;
    capture("first-body-failure", { error: String(error), stack: error.stack });
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      for (const p of participants) {
        try {
          capture("cleanup-before-real-shutdown", { worker: p.worker });
          const result = await p.execution?.shutdown(`${id}-finally`);
          p.sink.close();
          capture("cleanup-after-real-shutdown-and-sink-close", { worker: p.worker, result });
        } catch (error) {
          cleanupErrors.push(error);
          capture("cleanup-error", { worker: p.worker, error: String(error) });
        }
      }
      capture("complete-cleanup-before-assertions", {
        cleanupErrors: cleanupErrors.map(String),
        primaryError: primaryError && String(primaryError),
      });
      if (!primaryError) {
        assert.equal(cleanupErrors.length, 0);
        assert.equal(factory.shared.snapshot().allocatedBytes, 0);
        assert.equal(factory.shared.snapshot().tasks, 0);
        assert.equal(factory.snapshot().owners, 0);
        for (const p of participants) {
          const state = p.execution.snapshot();
          assert.equal(state.retainedBreakdown.engineBytes, 0);
          assert.equal(state.retainedBreakdown.nativeInputBytes, 0);
          assert.equal(state.retainedBreakdown.nativeOutputBytes, 0);
          assert(state.replay.every((entry) => entry.bytes === 0 && entry.events === 0));
          assert([...p.live.values()].every((entry) => entry.category === "worker"));
          assert.equal(p.owner.controller.snapshot().tasks, 0);
          assert.equal(p.owner.controller.snapshot().allocatedBytes, 0);
          assert.equal(p.sink.ledger.live.size, 0);
        }
      }
    } finally {
      WorkerRetainedBytes.prototype.reserve = originalReserve;
    }
  }
}

describe("W2 current shared native input", () => {
  it("W2C-N01 two worker accounts isolate shared native byte cap and callback retirement", async () => {
    let completed = 0;
    for (const variant of ["written", "closed-late"]) {
      await sharedCase("W2C-N01", "byte", variant);
      completed++;
    }
    assert.equal(completed, 2, "both registered settlement variants completed");
  });
  it("W2C-N02 two worker accounts isolate shared native task cap and callback retirement", async () => {
    let completed = 0;
    for (const variant of ["written", "closed-late"]) {
      await sharedCase("W2C-N02", "task", variant);
      completed++;
    }
    assert.equal(completed, 2, "both registered settlement variants completed");
  });
});
