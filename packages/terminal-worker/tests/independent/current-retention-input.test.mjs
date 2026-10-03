import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import { TerminalModel } from "@cove/terminal-engine";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createPipeDecoder, validatePipeFrame } from "@cove/protocol/pipe";
import { PreviewService } from "../../dist/src/preview-service.js";
import { ReplayWindow } from "../../dist/src/replay-window.js";
import { PtyInputController, SharedNativeInputBudget } from "../../dist/src/pty-input.js";
import {
  budgets,
  clock,
  delivery,
  executionRig,
  parseBaseline,
  receipts,
  recoveryRig,
  record,
  ref,
  run,
  turns,
  untilTurn,
  utf8,
  worker,
} from "./current-recovery-ports.mjs";

const factCharge = (fact) =>
  256 +
  2 * JSON.stringify(fact.event).length +
  (fact.event.type === "appearance" ? 64 * fact.event.appearance.palette.length : 0) +
  (fact.bytes?.length ?? 0);
const charge = (event) => 512 + 2 * JSON.stringify(event).length;
const outputFact = (seq, payload = "A", target = run()) => ({
  event: { type: "output", run: target, seq },
  bytes: utf8(payload),
});
const liveSet = (rig) =>
  [...rig.liveLeases.values()].map((entry) => ({ ...entry })).sort((a, b) => a.id - b.id);
function pressureState(rig) {
  const state = rig.execution.snapshot();
  return {
    replay: state.replay,
    inputIdentities: state.inputIdentities,
    retained: state.retainedBreakdown,
    liveSet: liveSet(rig),
    tasks: rig.native.owners.map((owner) => owner.tasks.length),
    factsSha256: createHash("sha256").update(JSON.stringify(rig.facts)).digest("hex"),
  };
}
async function pressureRig(patch = {}, native = {}) {
  const rig = executionRig({ workerBytes: 262144, reservedControlBytes: 4112, ...patch }, native);
  const targets = [run("pressure-one"), run("pressure-two")];
  const routes = targets.map((target, index) => ref(`pressure-${index}`, target));
  const sameRun = (actual, expected) =>
    actual?.serverId === expected.serverId &&
    actual?.relayInstanceId === expected.relayInstanceId &&
    actual?.runId === expected.runId;
  const snapshot = () => ({
    execution: rig.execution.snapshot(),
    native: rig.native.snapshot(),
    nativeReceipts: rig.native.receipts,
    liveLeases: liveSet(rig),
    leaseEvents: rig.leaseEvents,
    sinkOwners: rig.sink.ledger.snapshot(),
    physical: rig.sink.physical.map((frame, index) => ({
      index,
      token: frame.token,
      encodedBytes: frame.encodedBytes,
      settled: frame.settled,
      event: frame.event,
      rawHex: frame.rawHex,
    })),
  });
  let observerOrdinal = 0;
  const capture = (phase, value = {}) => {
    const event = {
      ordinal: ++observerOrdinal,
      phase,
      targets,
      routes,
      effectiveBudgets: rig.effective,
      ...value,
      state: snapshot(),
    };
    record("W2C-pressure-seed-setup", event);
    return event;
  };
  try {
    for (let index = 0; index < 2; index++) {
      capture("before-original-spawn", { index });
      const spawned = await rig.spawn(targets[index]);
      capture("after-original-spawn", { index, spawned });
      const installed = await rig.install(routes[index]);
      capture("after-original-install", { index, installed });
      const granted = await rig.grant(routes[index]);
      capture("after-original-grant", { index, granted });
    }
    for (let index = 0; index < 2; index++) {
      const raw = new Uint8Array(5000).fill(65 + index);
      const rawSHA256 = createHash("sha256").update(raw).digest("hex");
      rig.native.owners[index].emit(raw);
      const command = rig.command("status", targets[index]);
      const before = capture("status-command-before", {
        index,
        command,
        seed: { bytes: raw.length, rawSHA256, rawHex: Buffer.from(raw).toString("hex") },
      });
      const execution = before.state.execution;
      const session = execution.sessions.find((entry) =>
        sameRun(entry.run, targets[index]),
      ).snapshot;
      assert.equal(execution.ordinaryPendingCommands, 0);
      assert.equal(execution.pendingCommands, 0);
      assert.equal(execution.reservedStatusPending, false);
      assert.equal(execution.shuttingDown, false);
      assert.equal(
        execution.runs.find((entry) => sameRun(entry.run, targets[index])).status,
        "live",
      );
      assert.equal(session.faulted, false);
      assert.equal(session.disposed, false);
      assert.equal(session.consumerFenced, false);
      assert(session.queuedItems < 256, "fixed run-session ordinary status queue cap");
      const result = await rig.execute(command);
      capture("status-command-result", { index, command, result });
      assert.equal(result.type, "result");
      assert.equal(result.outcome, "accepted");
      assert.equal(result.requestId, command.requestId);
      assert.deepEqual(result.worker, worker);
      assert.deepEqual(result.run, targets[index]);
      assert.equal(result.runStatus.status, "live");
      assert.equal(result.runStatus.receivedSeq, 2);
      assert.equal(result.runStatus.parsedSeq, 2);
    }
    for (let index = 0; index < 2; index++) {
      let observation;
      await untilTurn(() => {
        const frame = rig.sink.physical.find(
          (entry) =>
            entry.event.terminal?.type === "output" &&
            entry.event.terminal.seq === 2 &&
            sameRun(entry.event.run, targets[index]) &&
            sameRun(entry.event.terminal.run, targets[index]) &&
            sameRun(entry.event.subscription?.run, routes[index].run) &&
            entry.event.subscription.connection.connectionId ===
              routes[index].connection.connectionId &&
            entry.event.subscription.connection.generation ===
              routes[index].connection.generation &&
            entry.event.subscription.viewId === routes[index].viewId &&
            entry.event.subscription.subscriptionId === routes[index].subscriptionId &&
            entry.rawHex,
        );
        capture("publication-predicate-observed", { index, framePresent: Boolean(frame) });
        if (!frame) return false;
        const raw = Buffer.from(frame.rawHex, "hex");
        const decoded = createPipeDecoder().read(raw);
        const metadata =
          decoded.frames[0] && JSON.parse(Buffer.from(decoded.frames[0].metadata).toString());
        const validation = decoded.frames[0] && validatePipeFrame(decoded.frames[0], metadata);
        const payload = decoded.frames[0]?.payload;
        observation = {
          index,
          rawHex: frame.rawHex,
          rawBytes: raw.length,
          metadataBytes: raw.readUInt32BE(8),
          payloadBytes: raw.readUInt32BE(12),
          rawSHA256: createHash("sha256").update(raw).digest("hex"),
          payloadSHA256: payload && createHash("sha256").update(payload).digest("hex"),
          decodedStatus: decoded.status,
          decodedFrames: decoded.frames.length,
          metadata,
          validation,
          settled: frame.settled,
        };
        capture("publication-ready-before-assertions", observation);
        assert.equal(frame.settled, false);
        assert.notEqual(decoded.status, "error");
        assert.equal(decoded.frames.length, 1);
        assert(validation.ok);
        assert.deepEqual(metadata.worker, worker);
        assert.deepEqual(metadata.run, targets[index]);
        assert.deepEqual(metadata.subscription, routes[index]);
        assert.equal(metadata.terminal.type, "output");
        assert.equal(metadata.terminal.seq, 2);
        assert.equal(payload.length, 5000);
        assert.deepEqual(payload, new Uint8Array(5000).fill(65 + index));
        return true;
      }, `fixed pressure seed ${index} actual route output2`);
      const command = rig.command("applied-ack", targets[index], {
        subscription: routes[index],
        appliedSeq: 2,
      });
      const physicalIds = rig.sink.physical.map((frame, index) => ({
        index,
        encodedBytes: frame.encodedBytes,
        settled: frame.settled,
      }));
      const physicalOwnerIds = [...rig.sink.ledger.live.values()]
        .filter((owner) => owner.owner === "physical-delivery")
        .map((owner) => owner.id);
      capture("original-ACK2-before", {
        index,
        command,
        observation,
        physicalIds,
        physicalOwnerIds,
      });
      const result = await rig.execute(command);
      capture("original-ACK2-result", {
        index,
        command,
        result,
        observation,
        physicalIds,
        physicalOwnerIds,
      });
      assert.equal(result.outcome, "accepted");
      assert.equal(result.requestId, command.requestId);
      assert.deepEqual(result.worker, worker);
      assert.deepEqual(result.run, targets[index]);
      assert(
        physicalOwnerIds.every((id) => rig.sink.ledger.live.has(id)),
        "logical ACK cannot release physical delivery leases",
      );
      assert(
        physicalIds.every((entry) => rig.sink.physical[entry.index].settled === entry.settled),
        "logical ACK does not settle physical delivery",
      );
    }
    capture("before-original-sink-close");
    rig.sink.close();
    capture("after-original-sink-close");
    return { ...rig, targets, routes };
  } catch (error) {
    capture("setup-failure-before-close", {
      error: { name: error.name, message: error.message, stack: error.stack },
    });
    await rig.close();
    record("W2C-pressure-seed-setup-failure-closed", {
      targets,
      routes,
      error: { name: error.name, message: error.message },
      state: snapshot(),
    });
    throw error;
  }
}
function controllerRig(mode = "held", limit = 8192) {
  const ledger = receipts(limit, 0);
  const shared = new SharedNativeInputBudget(65536, 256);
  const faults = [];
  const settlements = [];
  const tasks = [];
  let ticket = 0;
  let closed = false;
  const settle = (task, status = "written", writtenBytes = task.bytes) => {
    task.raw = undefined;
    task.callback({
      ticket: task.ticket,
      status,
      originalBytes: task.bytes,
      writtenBytes,
      remainingBytes: task.bytes - writtenBytes,
    });
  };
  const writer = {
    writeBounded(raw, callback) {
      if (mode === "denial") return { accepted: false, reason: "byte-limit" };
      const task = { ticket: ++ticket, bytes: raw.length, raw, callback };
      tasks.push(task);
      if (mode === "throw") throw Error("controlled native throw after owned admission");
      if (mode === "sync") settle(task);
      return { accepted: true, ticket: task.ticket, byteLength: raw.length };
    },
    disposeBoundedWrite() {
      closed = true;
      tasks.filter((task) => task.raw).forEach((task) => settle(task, "closed", 0));
      return true;
    },
  };
  const controller = new PtyInputController({
    writer,
    sharedBudget: shared,
    maxBytes: 65536,
    maxTasks: 256,
    reserveRetainedBytes: (bytes) => ledger.reserve(bytes, "native-input", "native-input"),
    onFault: (fault) => faults.push(fault),
  });
  return {
    ledger,
    shared,
    faults,
    settlements,
    tasks,
    controller,
    settle,
    isClosed: () => closed,
    close() {
      controller.retire();
    },
  };
}
function audit(events) {
  const owned = new Map();
  for (const event of events) {
    if (event.phase === "acquire") {
      assert(!owned.has(event.id));
      owned.set(event.id, event.bytes);
    }
    if (event.phase === "release") {
      assert(owned.has(event.id));
      owned.delete(event.id);
    }
    if (event.phase === "shrink") {
      assert(owned.has(event.id));
      assert(event.bytes <= owned.get(event.id));
      owned.set(event.id, event.bytes);
    }
    assert.notEqual(event.phase, "duplicate-release");
  }
  return owned;
}

describe("W2 current retention and input", () => {
  it("W2C-I01 replay facts and selected references have isolated exact charges", () => {
    const ledger = receipts();
    const replay = new ReplayWindow(1048576, 4096, ledger.reserve);
    const facts = [
      outputFact(1, "ABC"),
      { event: { type: "appearance", run: run(), seq: 2, appearance: DEFAULT_APPEARANCE } },
      outputFact(3, "DEF"),
    ];
    try {
      facts.forEach((fact) => replay.append(fact));
      assert.deepEqual(
        ledger.events
          .filter((event) => event.phase === "acquire")
          .map((event) => [event.owner, event.bytes]),
        facts.map((fact) => ["replay-fact", factCharge(fact)]),
      );
      const before = ledger.events.length;
      const empty = replay.select(3, 3);
      assert(empty);
      empty.release();
      assert.equal(ledger.events.length, before);
      const selected = replay.select(0, 3);
      assert(selected);
      const reference = [...ledger.live.values()].find(
        (entry) => entry.owner === "replay-selected-references",
      );
      assert.equal(reference.bytes, 256);
      const ids = [...ledger.live.keys()];
      replay.clear();
      assert.deepEqual([...ledger.live.keys()], ids);
      selected.release();
      assert.equal(ledger.account.snapshot().workerBytes, 0);
      audit(ledger.events);
      record("W2C-I01", { charges: facts.map(factCharge), events: ledger.events });
    } finally {
      replay.clear();
    }
  });
  it("W2C-I02 route detached table pin copy and sent owners survive only their references", async () => {
    for (const pinned of [true, false]) {
      const rig = recoveryRig();
      const subscription = ref(pinned ? "pin" : "copy");
      const source = rig.source(subscription.run);
      try {
        const command = rig.command("subscribe", subscription, { atSeq: 0 });
        const outcome = await rig.recovery.open(command, source);
        const entries = [...rig.ledger.live.values()];
        assert.equal(entries.find((entry) => entry.owner === "recovery-route").bytes, 8320);
        assert.equal(entries.find((entry) => entry.owner === "recovery-connection").bytes, 8320);
        assert.equal(entries.find((entry) => entry.owner === "recovery-baseline").bytes, 4097);
        const suffix = outputFact(1, "PIN-COPY", subscription.run);
        if (pinned) source.replay.append(suffix);
        rig.recovery.onFact(subscription.run, suffix, pinned ? source.replay : undefined);
        const post = [...rig.ledger.live.values()].find(
          (entry) => entry.owner === (pinned ? "recovery-post-n-pin" : "recovery-post-n-copy"),
        );
        assert.equal(post.bytes, pinned ? 128 : factCharge(suffix));
        const parsed = await parseBaseline(rig, subscription, { command, result: outcome.result });
        await turns();
        const transfer = rig.ledger.events.find(
          (event) => event.phase === "acquire" && event.owner === "recovery-transfer-frames",
        );
        const frames = parsed.frames.filter((frame) =>
          frame.event.terminal.type.startsWith("baseline-"),
        );
        assert.equal(
          transfer.bytes,
          charge(frames[0].event) + charge(frames[1].event) + charge(frames[2].event),
        );
        const sent = [...rig.ledger.live.values()].find(
          (entry) => entry.owner === "recovery-sent-ledger",
        );
        assert.equal(sent.bytes, 256);
        const physicalBefore = [...rig.ledger.live.values()]
          .filter((entry) => entry.owner === "physical-delivery")
          .map((entry) => entry.id);
        assert.equal(
          rig.recovery.command(rig.command("applied-ack", subscription, { appliedSeq: 1 })).result
            .outcome,
          "accepted",
        );
        assert.deepEqual(
          [...rig.ledger.live.values()]
            .filter((entry) => entry.owner === "physical-delivery")
            .map((entry) => entry.id),
          physicalBefore,
        );
        rig.recovery.shutdown();
        source.replay.clear();
        assert.deepEqual([...rig.ledger.live.keys()], physicalBefore);
        rig.sink.close();
        assert.equal(rig.ledger.live.size, 0);
        audit(rig.ledger.events);
        record("W2C-I02", { semanticVariant: pinned ? "pin" : "copy", events: rig.ledger.events });
      } finally {
        source.replay.clear();
        rig.close();
      }
    }
  });
  it("W2C-I03 preview transfer ownership is separate from actual engine scratch", async () => {
    const effective = budgets();
    const ledger = receipts();
    const sink = delivery(ledger);
    const time = clock();
    const target = run("scratch");
    let phase = "engine-initial";
    const engine = new TerminalModel({
      run: target,
      geometry: { cols: 12, rows: 4 },
      effectiveBudgets: effective,
      onAutomaticOutput() {},
      reserveRetainedBytes: (bytes) => ledger.reserve(bytes, phase, "engine"),
      availableRetainedBytes: () => ledger.account.availableOrdinaryBytes(),
    });
    const service = new PreviewService(
      worker,
      effective,
      ledger.reserve,
      sink,
      (_id, operation) => operation(),
      time,
    );
    try {
      assert(
        (await engine.apply({ type: "output", run: target, seq: 1 }, utf8("PREVIEW-SCRATCH"))).ok,
      );
      phase = "engine-preview";
      const result = await service.refresh(
        { type: "preview-refresh", worker, run: target, requestId: "scratch-preview" },
        target,
        () => engine.capturePreview(),
      );
      assert.equal(result.result.outcome, "accepted");
      const transfer = ledger.events.find(
        (event) => event.phase === "acquire" && event.owner === "preview-transfer",
      );
      assert.equal(transfer.bytes, 65536 + 3 * 4096);
      const scratch = ledger.events.find(
        (event) =>
          event.phase === "acquire" &&
          event.owner === "engine-preview" &&
          event.bytes === 65536 + 512 * 12 * 4 + 256,
      );
      assert(scratch);
      const transferAt = ledger.events.findIndex(
        (event) => event.phase === "acquire" && event.id === transfer.id,
      );
      const scratchAt = ledger.events.findIndex(
        (event) => event.phase === "acquire" && event.id === scratch.id,
      );
      assert(transferAt < scratchAt);
      assert(!ledger.live.has(transfer.id));
      assert(!ledger.live.has(scratch.id));
      assert([...ledger.live.values()].some((entry) => entry.owner === "physical-delivery"));
      record("W2C-I03", { result, transfer, scratch, events: ledger.events });
    } finally {
      service.shutdown();
      engine.dispose();
      sink.close();
      assert.equal(ledger.live.size, 0);
      audit(ledger.events);
    }
  });
  it("W2C-I04 real input controller lease survives synchronous worker settlement reentry", () => {
    const rig = controllerRig("sync", 800);
    let observed;
    try {
      const admission = rig.controller.submit(new Uint8Array(16), "user", (settlement) => {
        observed = {
          settlement,
          controller: rig.controller.snapshot(),
          shared: rig.shared.snapshot(),
          owners: [...rig.ledger.live.values()],
        };
        assert.equal(rig.ledger.account.snapshot().nativeInputBytes, 800);
        assert.equal(rig.controller.snapshot().allocatedBytes, 16);
        assert.equal(rig.shared.snapshot().tasks, 1);
        assert.equal(
          rig.controller.submit(new Uint8Array(1), "user", () => {}).reason,
          "worker-byte-limit",
        );
        assert.equal(rig.ledger.account.snapshot().nativeInputBytes, 800);
      });
      assert.equal(admission.kind, "accepted");
      assert.equal(observed.settlement.kind, "written");
      assert.equal(rig.ledger.account.snapshot().nativeInputBytes, 0);
      assert.equal(rig.shared.snapshot().tasks, 0);
      assert.equal(rig.tasks[0].raw, undefined);
      record("W2C-I04", { observed, events: rig.ledger.events });
    } finally {
      rig.close();
    }
  });
  it("W2C-I05 denial short unknown throw close and duplicate input callbacks settle once", () => {
    for (const mode of ["denial", "short", "unknown", "throw", "close", "duplicate"]) {
      const rig = controllerRig(mode);
      let callbacks = 0;
      const results = [];
      try {
        const admission = rig.controller.submit(new Uint8Array(8), "user", (result) => {
          callbacks++;
          results.push(result);
        });
        if (mode === "short") rig.settle(rig.tasks[0], "written", 4);
        if (mode === "unknown") rig.settle(rig.tasks[0], "error", 0);
        if (mode === "close") rig.close();
        if (mode === "duplicate") {
          rig.settle(rig.tasks[0]);
          rig.settle(rig.tasks[0]);
        }
        if (mode === "throw") assert.equal(admission.kind, "unknown");
        else if (mode === "denial") assert.equal(admission.kind, "rejected");
        else {
          assert.equal(admission.kind, "accepted");
          assert.equal(callbacks, 1);
        }
        if (mode === "duplicate")
          assert(rig.faults.some((fault) => fault.reason === "native-settlement-duplicate"));
        if (["short", "unknown", "close"].includes(mode)) assert.equal(results[0].kind, "unknown");
        rig.close();
        assert.equal(rig.shared.snapshot().tasks, 0);
        assert.equal(rig.controller.snapshot().allocatedBytes, 0);
        assert.equal(rig.ledger.account.snapshot().nativeInputBytes, 0);
        audit(rig.ledger.events);
        record("W2C-I05", {
          semanticVariant: mode,
          admission,
          callbacks,
          results,
          faults: rig.faults,
          events: rig.ledger.events,
        });
      } finally {
        rig.close();
      }
    }
  });
  it("W2C-I06 lifecycle releases only owned leases and malformed release traces fail", async () => {
    const rig = executionRig();
    try {
      await rig.spawn();
      await rig.install();
      await rig.grant();
      rig.native.owners[0].emit(utf8("LIFECYCLE"));
      await turns();
      await rig.execution.shutdown("owned-lifecycle");
      rig.sink.close();
      const remaining = audit(rig.leaseEvents);
      assert.deepEqual(
        [...remaining.keys()].sort((a, b) => a - b),
        [...rig.liveLeases.keys()].sort((a, b) => a - b),
      );
      assert([...rig.liveLeases.values()].every((entry) => entry.category === "worker"));
      const first = rig.leaseEvents.find((event) => event.phase === "acquire");
      assert.throws(() => audit([{ phase: "release", id: 999, bytes: 1 }]));
      assert.throws(() =>
        audit([first, { ...first, phase: "release" }, { ...first, phase: "release" }]),
      );
      assert.throws(() => audit([first, { ...first, phase: "shrink", bytes: first.bytes + 1 }]));
      record("W2C-I06", {
        events: rig.leaseEvents,
        remaining: liveSet(rig),
        malformedVariantsRejected: ["unowned release", "duplicate release", "increased shrink"],
      });
    } finally {
      await rig.close();
    }
  });
  it("W2C-I07 logically invalid pressured input writes and reclaims nothing", async () => {
    for (const variant of [
      "stale",
      "wrong-holder",
      "duplicate",
      "lower",
      "exhausted",
      "identity-cap",
    ]) {
      const rig = await pressureRig(variant === "identity-cap" ? { pendingWorkerCommands: 1 } : {});
      try {
        let ordinal = 0;
        const capture = (phase, value = {}) => {
          const receipt = structuredClone({
            ordinal: ++ordinal,
            semanticVariant: variant,
            phase,
            ...value,
            effectiveBudgets: rig.effective,
            pressureState: pressureState(rig),
            execution: rig.execution.snapshot(),
            native: rig.native.snapshot(),
            nativeReceipts: rig.native.receipts,
            leaseEvents: rig.leaseEvents,
            physicalOwners: rig.sink.ledger.snapshot(),
            physical: rig.sink.physical.map((frame, index) => ({
              index,
              token: frame.token,
              event: frame.event,
              rawHex: frame.rawHex,
              encodedBytes: frame.encodedBytes,
              settled: frame.settled,
            })),
          });
          record("W2C-I07-admission", receipt);
          return receipt;
        };
        const endpoint = rig.execution;
        const settlements = [];
        // Observe immutable public calls without replacing endpoint methods.
        const observedExecute = async (command, payload) => {
          const start = rig.leaseEvents.length;
          let stage = "before-execute";
          try {
            capture("public-command-before", {
              command,
              payload: payload && {
                bytes: payload.length,
                rawHex: Buffer.from(payload).toString("hex"),
                sha256: createHash("sha256").update(payload).digest("hex"),
              },
              eventStart: start,
            });
            stage = "execute";
            const pending = endpoint.execute.call(endpoint, command, payload);
            capture("public-command-after-call", { command, eventStart: start });
            const result = await pending;
            capture("public-command-result", {
              command,
              result,
              eventStart: start,
              eventEnd: rig.leaseEvents.length,
            });
            stage = "markerEnqueued";
            const markerReturn = endpoint.markerEnqueued.call(endpoint, command, result);
            capture("public-markerEnqueued-return", {
              command,
              result,
              markerReturn: markerReturn === undefined ? "undefined" : markerReturn,
            });
            stage = "responseSettled";
            const settledStart = rig.leaseEvents.length;
            capture("public-responseSettled-before", {
              command,
              requestId: command.requestId,
              eventStart: settledStart,
            });
            const settledReturn = endpoint.responseSettled.call(endpoint, command.requestId);
            const receipt = capture("public-responseSettled-after", {
              command,
              requestId: command.requestId,
              actualReturn: settledReturn === undefined ? "undefined" : settledReturn,
              eventStart: settledStart,
              eventEnd: rig.leaseEvents.length,
            });
            settlements.push(receipt);
            return result;
          } catch (error) {
            try {
              capture("public-call-exception", {
                command,
                stage,
                error: { name: error.name, message: error.message, stack: error.stack },
                eventStart: start,
                eventEnd: rig.leaseEvents.length,
              });
            } catch {
              /* Preserve the actual thrown object when persistence fails. */
            }
            throw error;
          }
        };
        const observedInstall = async (subscription) => {
          const command = rig.command("subscribe", subscription.run, { subscription, atSeq: 0 });
          const value = await observedExecute(command);
          assert.equal(value.outcome, "accepted");
          let progress = -1;
          for (let turn = 0; turn < 64; turn++) {
            await turns(1);
            const current = rig.sink.frames.filter(
              (frame) => frame.event.subscription?.subscriptionId === subscription.subscriptionId,
            );
            const start = current.findLast(
              (frame) => frame.event.terminal.type === "baseline-start",
            );
            const chunks = current.filter(
              (frame) =>
                frame.event.terminal.type === "baseline-chunk" &&
                frame.event.terminal.baselineId === start?.event.terminal.descriptor.baselineId,
            );
            if (chunks.length && chunks.at(-1).event.terminal.ordinal > progress) {
              progress = chunks.at(-1).event.terminal.ordinal;
              const result = await observedExecute(
                rig.command("baseline-progress", subscription.run, {
                  subscription,
                  baselineId: start.event.terminal.descriptor.baselineId,
                  lastParsedOrdinal: progress,
                }),
              );
              assert.equal(result.outcome, "accepted");
            }
            if (
              current.some(
                (frame) =>
                  frame.event.terminal.type === "baseline-end" &&
                  frame.event.terminal.baselineId === start?.event.terminal.descriptor.baselineId,
              )
            ) {
              const ack = await observedExecute(
                rig.command("applied-ack", subscription.run, {
                  subscription,
                  appliedSeq: value.atSeq,
                }),
              );
              assert.equal(ack.outcome, "accepted");
              return value;
            }
          }
          assert.fail("NOT_EXERCISED: complete actual installation");
        };
        const correlated = (command, result) => {
          assert.equal(result.requestId, command.requestId);
          assert.deepEqual(result.worker, worker);
          assert.deepEqual(result.run, command.run);
        };
        const commandQ = (command, payload) =>
          128 + Buffer.byteLength(JSON.stringify(command)) + payload.length;
        try {
          const target = rig.targets[0];
          const installed = rig.routes[0];
          const originalOther = ref("other-holder", target);
          await observedInstall(originalOther);
          capture("original-other-installed-before-physical-close", { originalOther });
          rig.sink.close();
          const earlyCommand = rig.command("input", target, {
            subscription: installed,
            epoch: 2,
            inputSeq: 1,
          });
          const earlyPayload = new Uint8Array(50000);
          const earlyQ = commandQ(earlyCommand, earlyPayload);
          const earlyBefore = pressureState(rig);
          const earlyStart = rig.leaseEvents.length;
          capture("early-copy-BUSY-control-before", { command: earlyCommand, Q: earlyQ });
          const earlyResult = await observedExecute(earlyCommand, earlyPayload);
          capture("early-copy-BUSY-control-result-before-assertions", {
            command: earlyCommand,
            result: earlyResult,
            Q: earlyQ,
            before: earlyBefore,
            eventStart: earlyStart,
            eventEnd: rig.leaseEvents.length,
            orderedLogicalKindCredit: 0,
          });
          assert(rig.effective.workerBytes - earlyBefore.retained.accountedBytes < earlyQ);
          correlated(earlyCommand, earlyResult);
          assert.equal(earlyResult.type, "error");
          assert.equal(earlyResult.error.kind, "BUSY");
          assert.deepEqual(rig.leaseEvents.slice(earlyStart), [
            { phase: "denied", category: "worker", bytes: earlyQ },
          ]);
          assert.deepEqual(pressureState(rig), earlyBefore, "early-copy resource control");
          const preserved = pressureState(rig);
          for (const route of [originalOther, rig.routes[1]]) {
            const command = rig.command("unsubscribe", route.run, { subscription: route });
            const before = capture("logical-route-retirement-before", { command });
            const result = await observedExecute(command);
            const after = capture("logical-route-retirement-result-before-assertions", {
              command,
              result,
            });
            correlated(command, result);
            assert.equal(result.outcome, "accepted");
            const actual = settlements.filter((entry) => entry.requestId === command.requestId);
            assert.equal(actual.length, 1);
            const released = rig.leaseEvents.slice(actual[0].eventStart, actual[0].eventEnd);
            assert.equal(
              released.filter(
                (entry) =>
                  entry.phase === "release" && entry.category === "worker" && entry.bytes === 8320,
              ).length,
              2,
            );
            for (const entry of released.filter((event) => event.phase === "release"))
              assert.equal(
                rig.leaseEvents.filter(
                  (event) => event.phase === "release" && event.id === entry.id,
                ).length,
                1,
              );
            assert.deepEqual(after.pressureState.replay, before.pressureState.replay);
            assert.deepEqual(after.pressureState.tasks, before.pressureState.tasks);
            assert.equal(after.pressureState.factsSha256, before.pressureState.factsSha256);
            assert.equal(
              after.execution.retainedBreakdown.engineBytes,
              before.execution.retainedBreakdown.engineBytes,
            );
            assert.deepEqual(after.physicalOwners, before.physicalOwners);
            assert(after.execution.runs.every((entry) => entry.status === "live"));
            assert.equal(after.native.activeOwners, 2);
          }
          const other = { ...originalOther, connection: installed.connection };
          const counterpartStart = rig.leaseEvents.length;
          const counterpartInstalled = await observedInstall(other);
          capture("shared-connection-counterpart-installed-before-close", {
            other,
            result: counterpartInstalled,
            eventStart: counterpartStart,
            eventEnd: rig.leaseEvents.length,
          });
          const records = rig.leaseEvents
            .slice(counterpartStart)
            .filter(
              (entry) =>
                entry.phase === "acquire" && entry.category === "worker" && entry.bytes === 8320,
            );
          assert.equal(records.length, 1, "counterpart borrows the existing connection record");
          rig.sink.close();
          const retained = capture("counterpart-ready-after-real-physical-close", { other });
          assert.deepEqual(retained.pressureState.replay, preserved.replay);
          assert.deepEqual(retained.pressureState.tasks, preserved.tasks);
          assert.equal(retained.pressureState.factsSha256, preserved.factsSha256);
          assert(retained.execution.runs.every((entry) => entry.status === "live"));
          assert.equal(retained.native.activeOwners, 2);
          assert.equal(
            retained.pressureState.liveSet.filter(
              (entry) => entry.category === "engine" && entry.bytes === 65536,
            ).length,
            2,
          );
          let inputSeq = 1;
          if (["duplicate", "lower", "exhausted", "identity-cap"].includes(variant)) {
            const seedSeq = variant === "exhausted" ? Number.MAX_SAFE_INTEGER : 2;
            const command = rig.command("input", target, {
              subscription: installed,
              epoch: 1,
              inputSeq: seedSeq,
            });
            const result = await observedExecute(command, new Uint8Array(1));
            capture("original-one-byte-seed-result-before-assertions", { command, result });
            correlated(command, result);
            assert.equal(result.outcome, "accepted");
            inputSeq =
              variant === "exhausted" ? Number.MAX_SAFE_INTEGER : variant === "lower" ? 1 : 2;
          }
          if (variant === "identity-cap") {
            const command = rig.command("set-control", target, {
              expectedEpoch: 1,
              nextEpoch: 2,
              holder: {
                connection: other.connection,
                viewId: other.viewId,
                subscriptionId: other.subscriptionId,
              },
              geometry: { cols: 12, rows: 4 },
            });
            const result = await observedExecute(command);
            capture("original-identity-cap-control-result-before-assertions", { command, result });
            correlated(command, result);
            assert.equal(result.outcome, "accepted");
          }
          await turns();
          rig.sink.close();
          const before = pressureState(rig);
          const subscription = ["wrong-holder", "identity-cap"].includes(variant)
            ? other
            : installed;
          const epoch = variant === "stale" ? 2 : variant === "identity-cap" ? 2 : 1;
          const command = rig.command("input", target, { subscription, epoch, inputSeq });
          const payload = new Uint8Array(50000);
          const Q = commandQ(command, payload);
          const start = rig.leaseEvents.length;
          capture("logical-input-before-copy-eligibility-assertions", {
            command,
            Q,
            before,
            available: rig.effective.workerBytes - before.retained.accountedBytes,
          });
          assert(
            rig.effective.workerBytes - before.retained.accountedBytes >= Q,
            "NOT_EXERCISED: fixed logical input command copy headroom",
          );
          if (variant === "identity-cap") {
            assert.equal(before.inputIdentities, 1);
            const status = rig.execution
              .snapshot()
              .runs.find((entry) => entry.run.runId === target.runId);
            assert.equal(status.controlEpoch, 2);
            assert.deepEqual(status.controlHolder, {
              connection: other.connection,
              viewId: other.viewId,
              subscriptionId: other.subscriptionId,
            });
          }
          const result = await observedExecute(command, payload);
          const after = pressureState(rig);
          capture("logical-input-result-before-all-assertions", {
            command,
            result,
            Q,
            before,
            after,
            eventStart: start,
            eventEnd: rig.leaseEvents.length,
          });
          correlated(command, result);
          const copies = rig.leaseEvents
            .slice(start)
            .filter(
              (entry) =>
                entry.phase === "acquire" && entry.category === "worker" && entry.bytes === Q,
            );
          assert.equal(copies.length, 1, "NOT_EXERCISED: actual command copy reservation");
          assert.equal(
            rig.leaseEvents
              .slice(start)
              .filter((entry) => entry.phase === "release" && entry.id === copies[0].id).length,
            1,
          );
          assert.equal(result.type, "error");
          assert.equal(
            result.error.kind,
            {
              stale: "STALE_CONTROL",
              "wrong-holder": "STALE_CONTROL",
              duplicate: "INPUT_REJECTED",
              lower: "INPUT_REJECTED",
              exhausted: "COUNTER_EXHAUSTED",
              "identity-cap": "BUSY",
            }[variant],
            "intended logical rejection boundary",
          );
          assert.deepEqual(pressureState(rig), before, variant);
          if (["stale", "wrong-holder"].includes(variant)) {
            const command = rig.command("input", target, {
              subscription: installed,
              epoch: 1,
              inputSeq: 1,
            });
            capture("original-valid-20000-before", { command });
            const valid = await observedExecute(command, new Uint8Array(20000));
            capture("original-valid-20000-result-before-assertions", { command, result: valid });
            correlated(command, valid);
            assert.equal(valid.outcome, "accepted");
          }
          record("W2C-I07", {
            semanticVariant: variant,
            before,
            result,
            after: pressureState(rig),
          });
        } catch (error) {
          try {
            capture("first-failure-before-cleanup", {
              error: { name: error.name, message: error.message, stack: error.stack },
            });
          } catch {
            /* Failure observation cannot replace the primary exception. */
          }
          throw error;
        }
      } finally {
        await rig.close();
      }
    }
  });
  it("W2C-I08 ordered authority changes reject queued input before replay reclamation", async () => {
    for (const variant of ["holder-change", "close", "failure"]) {
      const rig = await pressureRig();
      try {
        const target = rig.targets[0];
        const subscription = rig.routes[0];
        const before = pressureState(rig);
        let barrier;
        if (variant === "holder-change")
          barrier = rig.execution.execute(
            rig.command("set-control", target, {
              expectedEpoch: 1,
              nextEpoch: 1,
              holder: null,
              geometry: { cols: 12, rows: 4 },
            }),
          );
        if (variant === "close")
          barrier = rig.execution.execute(rig.command("unsubscribe", target, { subscription }));
        if (variant === "failure") {
          rig.native.owners[0].observer.onFault({
            kind: "input",
            reason: "controlled ordered failure",
          });
          barrier = Promise.resolve();
        }
        const invalid = rig.execution.execute(
          rig.command("input", target, { subscription, epoch: 1, inputSeq: 1 }),
          new Uint8Array(50000),
        );
        await barrier;
        const result = await invalid;
        assert.equal(result.type, "error");
        const after = rig.execution.snapshot();
        assert.equal(rig.native.owners[0].tasks.length, before.tasks[0]);
        assert.equal(after.inputIdentities, before.inputIdentities);
        if (variant === "holder-change") assert(after.replay[0].events >= before.replay[0].events);
        assert.deepEqual(after.replay[1], before.replay[1]);
        record("W2C-I08", {
          semanticVariant: variant,
          before,
          after,
          result,
          leases: rig.leaseEvents,
        });
      } finally {
        await rig.close();
      }
    }
  });
  it("W2C-I09 valid input rotates minimal whole facts and unreclaimable attempt stays consumed", async () => {
    const rig = await pressureRig({}, { hold: true });
    try {
      let ordinal = 0;
      const capture = (phase, value = {}) => {
        const receipt = structuredClone({
          ordinal: ++ordinal,
          phase,
          ...value,
          effectiveBudgets: rig.effective,
          execution: rig.execution.snapshot(),
          native: rig.native.snapshot(),
          nativeReceipts: rig.native.receipts,
          leaseEvents: rig.leaseEvents,
          liveLeases: liveSet(rig),
          physicalOwners: rig.sink.ledger.snapshot(),
          physical: rig.sink.physical.map((frame, index) => ({
            index,
            token: frame.token,
            event: frame.event,
            encodedBytes: frame.encodedBytes,
            rawHex: frame.rawHex,
            settled: frame.settled,
          })),
        });
        record("W2C-I09-seq3-setup", receipt);
        return receipt;
      };
      const sameRun = (actual, expected) =>
        actual?.serverId === expected.serverId &&
        actual?.relayInstanceId === expected.relayInstanceId &&
        actual?.runId === expected.runId;
      for (let index = 0; index < 2; index++) {
        rig.native.owners[index].emit(new Uint8Array(10000).fill(67 + index));
        await turns();
      }
      for (let index = 0; index < 2; index++) {
        const command = rig.command("status", rig.targets[index]);
        const before = capture("ordinary-status-before-guards", { index, command });
        const session = before.execution.sessions.find((entry) =>
          sameRun(entry.run, rig.targets[index]),
        ).snapshot;
        const runStatus = before.execution.runs.find((entry) =>
          sameRun(entry.run, rig.targets[index]),
        );
        assert.equal(before.execution.ordinaryPendingCommands, 0);
        assert.equal(before.execution.pendingCommands, 0);
        assert.equal(before.execution.reservedStatusPending, false);
        assert.equal(before.execution.shuttingDown, false);
        assert.equal(runStatus.status, "live");
        assert.equal(session.disposed, false);
        assert.equal(session.faulted, false);
        assert.equal(session.consumerFenced, false);
        assert(session.queuedItems < 256, "fixed run-session ordinary status queue cap");
        const eventStart = rig.leaseEvents.length;
        const result = await rig.execute(command);
        capture("ordinary-status-result-before-assertions", {
          index,
          command,
          result,
          eventStart,
          eventEnd: rig.leaseEvents.length,
        });
        assert.equal(result.type, "result");
        assert.equal(result.outcome, "accepted");
        assert.equal(result.requestId, command.requestId);
        assert.deepEqual(result.worker, worker);
        assert.deepEqual(result.run, rig.targets[index]);
        assert.equal(result.runStatus.status, "live");
        assert.equal(result.runStatus.receivedSeq, 3);
        assert.equal(result.runStatus.parsedSeq, 3);
        assert.equal(result.runStatus.controlEpoch, 1);
        assert.deepEqual(result.runStatus.controlHolder, runStatus.controlHolder);
      }
      for (let index = 0; index < 2; index++) {
        let observation;
        await untilTurn(() => {
          const frame = rig.sink.physical.find(
            (entry) =>
              entry.event.terminal?.type === "output" &&
              entry.event.terminal.seq === 3 &&
              sameRun(entry.event.run, rig.targets[index]) &&
              sameRun(entry.event.terminal.run, rig.targets[index]) &&
              sameRun(entry.event.subscription?.run, rig.routes[index].run) &&
              entry.event.subscription.connection.connectionId ===
                rig.routes[index].connection.connectionId &&
              entry.event.subscription.connection.generation ===
                rig.routes[index].connection.generation &&
              entry.event.subscription.viewId === rig.routes[index].viewId &&
              entry.event.subscription.subscriptionId === rig.routes[index].subscriptionId &&
              entry.rawHex,
          );
          capture("publication-predicate-observed", { index, framePresent: Boolean(frame) });
          if (!frame) return false;
          const raw = Buffer.from(frame.rawHex, "hex");
          const decoded = createPipeDecoder().read(raw);
          const metadata =
            decoded.frames[0] && JSON.parse(Buffer.from(decoded.frames[0].metadata).toString());
          const validation = decoded.frames[0] && validatePipeFrame(decoded.frames[0], metadata);
          const payload = decoded.frames[0]?.payload;
          observation = {
            index,
            rawHex: frame.rawHex,
            rawBytes: raw.length,
            metadataBytes: raw.readUInt32BE(8),
            payloadBytes: raw.readUInt32BE(12),
            rawSHA256: createHash("sha256").update(raw).digest("hex"),
            payloadSHA256: payload && createHash("sha256").update(payload).digest("hex"),
            decodedStatus: decoded.status,
            decodedFrames: decoded.frames.length,
            metadata,
            validation,
            settled: frame.settled,
          };
          capture("publication-ready-before-assertions", observation);
          assert.equal(raw.length, 16 + raw.readUInt32BE(8) + raw.readUInt32BE(12));
          assert.equal(raw.length, frame.encodedBytes);
          assert.equal(frame.settled, false);
          assert.notEqual(decoded.status, "error");
          assert.equal(decoded.frames.length, 1);
          assert(validation.ok);
          assert.deepEqual(metadata.worker, worker);
          assert.deepEqual(metadata.run, rig.targets[index]);
          assert.deepEqual(metadata.subscription, rig.routes[index]);
          assert.equal(metadata.terminal.type, "output");
          assert.equal(metadata.terminal.seq, 3);
          assert.equal(payload.length, 10000);
          assert.deepEqual(payload, new Uint8Array(10000).fill(67 + index));
          assert.equal(
            observation.payloadSHA256,
            [
              "cdc2cdefd474d525462f60edfe48d4c1117af64dc9d91f567bf51e264ab79769",
              "27b4a9f24cdf8b6aca655971f4d42b0a34b7ed6cd3e2fd69439e6fa6145bc3fd",
            ][index],
          );
          return true;
        }, `fixed I09 seed ${index} actual route output3`);
        const command = rig.command("applied-ack", rig.targets[index], {
          subscription: rig.routes[index],
          appliedSeq: 3,
        });
        const physicalIds = rig.sink.physical.map((frame, index) => ({
          index,
          token: frame.token,
          encodedBytes: frame.encodedBytes,
          settled: frame.settled,
        }));
        const physicalOwnerIds = [...rig.sink.ledger.live.values()]
          .filter((owner) => owner.owner === "physical-delivery")
          .map((owner) => owner.id);
        const eventStart = rig.leaseEvents.length;
        capture("original-ACK3-before", {
          index,
          command,
          observation,
          physicalIds,
          physicalOwnerIds,
          eventStart,
        });
        const result = await rig.execute(command);
        capture("original-ACK3-result-before-assertions", {
          index,
          command,
          result,
          observation,
          physicalIds,
          physicalOwnerIds,
          eventStart,
          eventEnd: rig.leaseEvents.length,
        });
        assert.equal(result.type, "result");
        assert.equal(result.requestId, command.requestId);
        assert.deepEqual(result.worker, worker);
        assert.deepEqual(result.run, rig.targets[index]);
        assert.equal(result.outcome, "accepted");
        assert(
          physicalOwnerIds.every((id) => rig.sink.ledger.live.has(id)),
          "logical ACK cannot release physical delivery leases",
        );
        assert(
          physicalIds.every((entry) => rig.sink.physical[entry.index].settled === entry.settled),
          "logical ACK does not settle physical delivery",
        );
      }
      capture("before-original-sink-close-after-both-ACK3");
      rig.sink.close();
      capture("after-original-sink-close-after-both-ACK3");
      const before = rig.execution.snapshot();
      const ownersBefore = liveSet(rig);
      const eventsBefore = rig.leaseEvents.length;
      const input = rig.command("input", rig.targets[0], {
        subscription: rig.routes[0],
        epoch: 1,
        inputSeq: 1,
      });
      const pending = rig.execution.execute(input, new Uint8Array(20000));
      await turns();
      assert.equal(rig.native.owners[0].tasks.length, 1);
      const admitted = rig.execution.snapshot();
      assert.equal(admitted.retainedBreakdown.nativeInputBytes, 40768);
      const evicted = before.replay.map(
        (entry, index) => entry.events - admitted.replay[index].events,
      );
      assert(evicted.every((count) => count >= 0));
      assert(evicted.reduce((a, b) => a + b, 0) > 0);
      const released = rig.leaseEvents
        .slice(eventsBefore)
        .filter(
          (event) =>
            event.phase === "release" && ownersBefore.some((owner) => owner.id === event.id),
        );
      const replayCharges = rig.facts.map((fact) =>
        factCharge({ event: fact.event, bytes: fact.hex && Buffer.from(fact.hex, "hex") }),
      );
      assert(released.every((event) => replayCharges.includes(event.bytes)));
      assert.equal(
        released.length,
        evicted.reduce((a, b) => a + b, 0),
      );
      assert(
        released.at(-1).bytes > 262144 - admitted.accountedBytes,
        "last whole fact was necessary for exact native admission",
      );
      rig.native.owners[0].settle();
      assert.equal((await pending).outcome, "accepted");
      record("W2C-I09-valid", { before, admitted, evicted, released, leases: rig.leaseEvents });
    } finally {
      await rig.close();
    }
    const unreclaimable = await pressureRig();
    try {
      const unknown = await unreclaimable.execute(
        unreclaimable.command("input", unreclaimable.targets[0], {
          subscription: unreclaimable.routes[0],
          epoch: 1,
          inputSeq: 1,
        }),
        new Uint8Array(50000),
      );
      assert.equal(unknown.type, "error");
      assert.equal(unknown.error.kind, "BUSY");
      assert.equal(unreclaimable.native.owners[0].tasks.length, 0);
      assert.equal(unreclaimable.execution.snapshot().inputIdentities, 1);
      const retry = await unreclaimable.execute(
        unreclaimable.command("input", unreclaimable.targets[0], {
          subscription: unreclaimable.routes[0],
          epoch: 1,
          inputSeq: 1,
        }),
        new Uint8Array(1),
      );
      assert.equal(retry.error.kind, "INPUT_REJECTED");
      record("W2C-I09-unreclaimable", {
        payloadBytes: 50000,
        nativeRequirement: 100768,
        unknown,
        retry,
        state: unreclaimable.execution.snapshot(),
        leases: unreclaimable.leaseEvents,
      });
    } finally {
      await unreclaimable.close();
    }
  });
  it("W2C-I10 original pressure bytes remain fixed and shutdown preserves exact records", async () => {
    const rig = executionRig({ workerBytes: 262144, reservedControlBytes: 4112 }, { hold: true });
    const targets = [run("run-80"), run("run-80-second")];
    const routes = [ref("80", targets[0]), ref("80-second", targets[1])];
    let first;
    let capture;
    try {
      let ordinal = 0;
      capture = (phase, value = {}) => {
        const receipt = structuredClone({
          ordinal: ++ordinal,
          phase,
          ...value,
          effectiveBudgets: rig.effective,
          targets,
          routes,
          execution: rig.execution.snapshot(),
          liveLeases: liveSet(rig),
          leaseEvents: rig.leaseEvents,
          native: rig.native.snapshot(),
          nativeReceipts: rig.native.receipts,
          nativeOwners: rig.native.owners.map((owner) => ({
            snapshot: owner.adapter.snapshot(),
            controller: owner.controller.snapshot(),
            tasks: owner.tasks.map((task) => ({
              ticket: task.ticket,
              settled: task.settled,
              bytes: task.raw?.length ?? task.byteLength,
              sha256: task.sha256,
              rawHex: task.raw && Buffer.from(task.raw).toString("hex"),
            })),
          })),
          physicalOwners: rig.sink.ledger.snapshot(),
          physical: rig.sink.physical.map((frame, index) => ({
            index,
            token: frame.token,
            event: frame.event,
            rawHex: frame.rawHex,
            encodedBytes: frame.encodedBytes,
            settled: frame.settled,
          })),
        });
        record("W2C-I10-actual-boundary", receipt);
        return receipt;
      };
      const sameRun = (actual, expected) =>
        actual?.serverId === expected.serverId &&
        actual?.relayInstanceId === expected.relayInstanceId &&
        actual?.runId === expected.runId;
      for (let index = 0; index < 2; index++) {
        await rig.spawn(targets[index]);
        await rig.install(routes[index]);
        await rig.grant(routes[index]);
      }
      for (let index = 0; index < 2; index++) {
        rig.native.owners[index].emit(new Uint8Array(5000).fill(65 + index));
        await turns();
      }
      for (let index = 0; index < 2; index++) {
        const command = rig.command("status", targets[index]);
        const before = capture("ordinary-status-before-guards", { index, command });
        const status = before.execution.runs.find((entry) => sameRun(entry.run, targets[index]));
        const session = before.execution.sessions.find((entry) =>
          sameRun(entry.run, targets[index]),
        ).snapshot;
        assert.equal(before.execution.ordinaryPendingCommands, 0);
        assert.equal(before.execution.pendingCommands, 0);
        assert.equal(before.execution.reservedStatusPending, false);
        assert.equal(before.execution.shuttingDown, false);
        assert.equal(status.status, "live");
        assert.equal(session.faulted, false);
        assert.equal(session.disposed, false);
        assert.equal(session.consumerFenced, false);
        assert(session.queuedItems < 256, "fixed run-session ordinary status queue cap");
        const eventStart = rig.leaseEvents.length;
        const result = await rig.execute(command);
        capture("ordinary-status-result-before-assertions", {
          index,
          command,
          result,
          eventStart,
          eventEnd: rig.leaseEvents.length,
        });
        assert.equal(result.type, "result");
        assert.equal(result.outcome, "accepted");
        assert.equal(result.requestId, command.requestId);
        assert.deepEqual(result.worker, worker);
        assert.deepEqual(result.run, targets[index]);
        assert.equal(result.runStatus.status, "live");
        assert.equal(result.runStatus.receivedSeq, 2);
        assert.equal(result.runStatus.parsedSeq, 2);
        assert.equal(result.runStatus.controlEpoch, 1);
        assert.deepEqual(result.runStatus.controlHolder, status.controlHolder);
      }
      for (let index = 0; index < 2; index++) {
        const command = rig.command("applied-ack", targets[index], {
          subscription: routes[index],
          appliedSeq: 1,
        });
        const eventStart = rig.leaseEvents.length;
        capture("original-ACK1-before", { index, command, eventStart });
        const result = await rig.execute(command);
        capture("original-ACK1-result-before-assertions", {
          index,
          command,
          result,
          eventStart,
          eventEnd: rig.leaseEvents.length,
        });
        assert.equal(result.outcome, "accepted");
      }
      capture("before-original-sink-close-after-both-ACK1");
      rig.sink.close();
      const before = rig.execution.snapshot();
      capture("physical-tail-before-original-strict-assertion", {
        before,
        configuredTailCap: rig.effective.baselineTailBytes,
      });
      assert(
        before.sessions.every(
          (entry) => entry.snapshot.settledState.resources.tailAllocatedBytes === 65536,
        ),
      );
      const firstCommand = rig.command("input", targets[0], {
        subscription: routes[0],
        epoch: 1,
        inputSeq: 1,
      });
      const firstPayload = new Uint8Array(20000);
      const firstEventStart = rig.leaseEvents.length;
      capture("original-first-input-before", {
        command: firstCommand,
        payload: {
          bytes: firstPayload.length,
          rawHex: Buffer.from(firstPayload).toString("hex"),
          sha256: createHash("sha256").update(firstPayload).digest("hex"),
        },
        eventStart: firstEventStart,
      });
      first = rig.execution.execute(firstCommand, firstPayload);
      capture("original-first-input-after-call", {
        command: firstCommand,
        eventStart: firstEventStart,
        eventEnd: rig.leaseEvents.length,
      });
      await turns();
      const held = rig.execution.snapshot();
      capture("original-held-input-before-assertions", {
        command: firstCommand,
        held,
        eventStart: firstEventStart,
        eventEnd: rig.leaseEvents.length,
      });
      assert.equal(held.retainedBreakdown.nativeInputBytes, 40768);
      assert.equal(rig.native.shared.snapshot().allocatedBytes, 20000);
      assert.equal(rig.native.shared.snapshot().tasks, 1);
      const secondCommand = rig.command("input", targets[1], {
        subscription: routes[1],
        epoch: 1,
        inputSeq: 1,
      });
      const secondPayload = new Uint8Array(20000);
      const secondEventStart = rig.leaseEvents.length;
      capture("original-second-input-before", {
        command: secondCommand,
        payload: {
          bytes: secondPayload.length,
          rawHex: Buffer.from(secondPayload).toString("hex"),
          sha256: createHash("sha256").update(secondPayload).digest("hex"),
        },
        eventStart: secondEventStart,
      });
      const second = await rig.execute(secondCommand, secondPayload);
      capture("original-second-input-result-before-assertions", {
        command: secondCommand,
        result: second,
        eventStart: secondEventStart,
        eventEnd: rig.leaseEvents.length,
      });
      assert.equal(second.error.kind, "BUSY");
      assert.deepEqual(
        rig.native.owners.map((owner) => owner.tasks.length),
        [1, 0],
      );
      capture("before-original-pressure-shutdown", { firstCommand, secondCommand });
      const shutdownResult = await rig.execution.shutdown("fixed-pressure-shutdown");
      capture("after-original-pressure-shutdown", { shutdownResult, firstCommand, secondCommand });
      const firstResult = await first;
      capture("original-first-promise-result", {
        command: firstCommand,
        result: firstResult,
        eventStart: firstEventStart,
        eventEnd: rig.leaseEvents.length,
      });
      capture("before-original-post-shutdown-sink-close");
      rig.sink.close();
      const after = rig.execution.snapshot();
      capture("original-after-shutdown-before-scalar-assertions", { after });
      const owned = after.retainedBreakdown;
      assert.equal(owned.workerBytes, 12816);
      assert.equal(owned.reservedControlBytes, 4112);
      assert.equal(owned.accountedBytes, 16928);
      assert.equal(owned.engineBytes, 0);
      assert.equal(owned.nativeInputBytes, 0);
      assert.equal(owned.nativeOutputBytes, 0);
      assert.equal(after.runIds, 2);
      assert.equal(after.inputIdentities, 2);
      assert.equal(after.sessions.length, 2);
      assert(after.sessions.every((entry) => entry.snapshot.disposed));
      assert(after.replay.every((entry) => entry.events === 0 && entry.bytes === 0));
      assert.equal(rig.native.snapshot().owners, 0);
      assert.equal(rig.native.shared.snapshot().tasks, 0);
      assert(
        rig.native.owners.every(
          (owner) =>
            owner.controller.snapshot().allocatedBytes === 0 &&
            owner.controller.snapshot().tasks === 0,
        ),
      );
      assert(held.peakAccountedBytes <= 262144);
      record("W2C-I10", {
        before,
        held,
        second,
        after,
        worker: 12816,
        runRecordBytes: 12341,
        inputIdentityBytes: 475,
        leases: rig.leaseEvents,
        native: rig.native.receipts,
      });
    } catch (error) {
      try {
        capture?.("first-failure-before-cleanup", {
          error: { name: error.name, message: error.message, stack: error.stack },
        });
      } catch {
        /* Preserve the primary failure if persistence fails. */
      }
      throw error;
    } finally {
      await rig.close();
      capture?.("original-finally-close-completed");
      if (first) await first;
    }
  });
});
