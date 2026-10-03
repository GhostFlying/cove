import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import {
  composeSpawnPayload,
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
} from "@cove/protocol/pipe";
import { DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { validateBaselineDescriptor, validateBaselineTransfer } from "@cove/protocol/terminal";
import {
  deferred,
  encoded,
  endpointRig,
  executionRig,
  parseBaseline,
  recoveryRig,
  record,
  ref,
  run,
  sessionRecoveryRig,
  syntheticBaseline,
  turns,
  untilTurn,
  utf8,
  worker,
} from "./current-recovery-ports.mjs";

let request = 0;
const pipeCommand = (type, target, fields = {}) => ({
  type,
  worker,
  run: target,
  requestId: `recovery-pipe-${++request}`,
  ...fields,
});
async function pipeResult(rig, command, payload) {
  rig.send(command, payload);
  await untilTurn(
    () => rig.frames.some((frame) => frame.metadata.requestId === command.requestId),
    command.requestId,
  );
  return rig.frames.find((frame) => frame.metadata.requestId === command.requestId).metadata;
}
async function pipeSpawn(rig, target) {
  await untilTurn(
    () => rig.frames.some((frame) => frame.metadata.type === "ready"),
    "actual pipe ready",
  );
  const payload = composeSpawnPayload(
    { executable: "fixture", argv: [], cwd: process.cwd() },
    utf8,
  );
  const command = pipeCommand("spawn", target, {
    operationId: `spawn-${target.runId}`,
    profile: PROFILE,
    appearance: DEFAULT_APPEARANCE,
    geometry: { cols: 12, rows: 4 },
    effectiveBudgets: rig.effective,
    spawnPayloadBytes: payload.bytes.length,
  });
  assert.equal((await pipeResult(rig, command, payload.bytes)).outcome, "accepted");
}
async function pipeInstall(rig, subscription) {
  const result = await pipeResult(
    rig,
    pipeCommand("subscribe", subscription.run, { subscription, atSeq: 0 }),
  );
  assert.equal(result.outcome, "accepted");
  await untilTurn(
    () => rig.frames.some((frame) => frame.metadata.terminal?.type === "baseline-end"),
    "baseline end",
  );
  const start = rig.frames.findLast((frame) => frame.metadata.terminal?.type === "baseline-start")
    .metadata.terminal.descriptor;
  const chunks = rig.frames.filter(
    (frame) =>
      frame.metadata.terminal?.type === "baseline-chunk" &&
      frame.metadata.terminal.baselineId === start.baselineId,
  );
  const end = rig.frames.find(
    (frame) =>
      frame.metadata.terminal?.type === "baseline-end" &&
      frame.metadata.terminal.baselineId === start.baselineId,
  );
  assert(
    validateBaselineTransfer(
      start,
      chunks.map((frame) => ({ metadata: frame.metadata.terminal, payload: frame.payload })),
      end.metadata.terminal,
    ),
  );
  const progress = await pipeResult(
    rig,
    pipeCommand("baseline-progress", subscription.run, {
      subscription,
      baselineId: start.baselineId,
      lastParsedOrdinal: chunks.at(-1).metadata.terminal.ordinal,
    }),
  );
  assert.equal(progress.outcome, "accepted");
  assert.equal(
    (
      await pipeResult(
        rig,
        pipeCommand("applied-ack", subscription.run, { subscription, appliedSeq: result.atSeq }),
      )
    ).outcome,
    "accepted",
  );
  return { result, descriptor: start };
}
async function drainHeld(rig, predicate, limit = 64) {
  for (let turn = 0; turn < limit; turn++) {
    if (predicate()) return;
    if (rig.callbacks.length) rig.release();
    rig.output.emit("drain");
    await turns(1);
    assert(rig.callbacks.length <= 1, "one physical callback per controlled turn");
  }
  assert(predicate(), "NOT_EXERCISED: held endpoint later progress");
}
const descriptorOf = (baseline, subscription = ref()) => ({
  baselineId: "valid",
  run: subscription.run,
  subscription,
  profile: baseline.profile,
  encoding: baseline.encoding,
  checkpointSeq: baseline.checkpointSeq,
  atSeq: baseline.atSeq,
  captureGeometry: baseline.captureGeometry,
  currentGeometry: baseline.currentGeometry,
  coverage: baseline.coverage,
  vtBytes: baseline.vt.length,
  tailBytes: baseline.tail.length,
  chunkCount: Math.ceil(baseline.vt.length / 65536) + Math.ceil(baseline.tail.length / 65536),
});

async function captureSchedule(seed, injected, action = "keep") {
  const rig = sessionRecoveryRig();
  const holder = ref("holder", rig.target);
  const route = ref("second", rig.target);
  try {
    await rig.install(holder);
    assert.equal(
      (
        await rig.capability.execute({
          type: "control",
          expectedEpoch: 0,
          nextEpoch: 1,
          holder: {
            connection: holder.connection,
            viewId: holder.viewId,
            subscriptionId: holder.subscriptionId,
          },
          geometry: { cols: 12, rows: 4 },
        })
      ).atSeq,
      1,
    );
    rig.native.owners[0].emit(Buffer.from(seed, "hex"));
    await turns();
    assert.equal((await rig.capability.execute({ type: "status" })).atSeq, 2);
    const captureOrder = [];
    let captureReturned = false;
    let trigger = 0;
    let cancellation;
    const before = rig.sink.frames.length;
    rig.setDetached((bytes) => {
      assert(!captureReturned, "detached callback before capture/open returns");
      trigger++;
      captureOrder.push("reserve-detached-callback");
      assert(rig.ledger.live.size > 0);
      record("detached-callback", {
        bytes,
        action,
        beforeReturn: !captureReturned,
        owners: rig.ledger.snapshot(),
      });
      rig.native.owners[0].emit(Buffer.from(injected, "hex"));
      rig.pending.push(
        rig.capability.execute({
          type: "resize",
          subscription: holder,
          epoch: 1,
          geometry: { cols: 13, rows: 4 },
        }),
      );
      rig.native.owners[0].exit();
      if (action === "cancel") {
        const c = rig.command("unsubscribe", route);
        cancellation = rig.recovery.command(c);
        rig.recovery.responseSettled(c.requestId);
      }
      if (action === "recover") {
        rig.setDetached(undefined);
        const c = rig.command("recover", route);
        cancellation = rig.recovery.open(c, rig.source);
      }
    });
    const command = rig.command("subscribe", route, { atSeq: 0 });
    const outcome = await rig.recovery.open(command, rig.source);
    captureReturned = true;
    captureOrder.push("capture-return");
    assert.equal(trigger, 1);
    if (action !== "keep") {
      const canceled = await cancellation;
      if (action === "cancel") assert.equal(canceled.result?.outcome, "accepted");
      else
        assert.notEqual(
          canceled.failure,
          "BUSY",
          "frozen same-ref recovery must fence preparation, not refuse the trigger",
        );
      assert(!outcome.result, "retired capture must not publish an accepted marker");
      assert(
        !rig.sink.frames
          .slice(before)
          .some((frame) => JSON.stringify(frame.event.subscription) === JSON.stringify(route)),
      );
      return { action, outcome, cancellation: canceled, trigger, facts: rig.facts };
    }
    assert.equal(outcome.result.atSeq, 2);
    assert.equal(rig.sink.frames.length, before);
    const captured = await parseBaseline(rig, route, { command, result: outcome.result });
    const raw = Buffer.concat(
      captured.frames
        .filter((frame) => frame.event.terminal.type === "baseline-chunk")
        .map((frame) => Buffer.from(frame.payload)),
    );
    assert(!raw.includes(Buffer.from("|W2-R03-SUFFIX|")));
    await untilTurn(
      () =>
        rig.sink.frames
          .filter((frame) => JSON.stringify(frame.event.subscription) === JSON.stringify(route))
          .some((frame) => frame.event.terminal.type === "exit"),
      "post-N exit",
    );
    const suffix = rig.sink.frames.filter(
      (frame) =>
        JSON.stringify(frame.event.subscription) === JSON.stringify(route) &&
        frame.event.terminal.seq > 2,
    );
    assert.deepEqual(
      suffix.map((frame) => [frame.event.terminal.type, frame.event.terminal.seq]),
      [
        ["output", 3],
        ["resize", 4],
        ["exit", 5],
      ],
    );
    assert.equal(Buffer.from(suffix[0].payload).toString("hex"), injected);
    return {
      action,
      trigger,
      captureOrder,
      descriptor: captured.descriptor,
      baselineHex: raw.toString("hex"),
      suffix: suffix.map(({ event, rawHex }) => ({ event, rawHex })),
    };
  } finally {
    rig.setDetached(undefined);
    await rig.close();
  }
}

async function combinedEndpointSchedule() {
  let rig;
  let ordinal = 0;
  let nextWrite = 0;
  const executionEvents = [];
  const physicalEvents = [];
  const capture = (phase, value = {}) =>
    record("W2C-R08-prospective", {
      ordinal: ++ordinal,
      phase,
      ...value,
      pipe: rig?.pipe.snapshot(),
      worker: rig?.execution?.snapshot(),
      native: rig?.native.snapshot(),
      nativeReceipts: rig?.native.receipts,
      callbacksHeld: rig?.callbacks.length,
      output: rig && {
        writableLength: rig.output.writableLength,
        writableNeedDrain: rig.output.writableNeedDrain,
        closed: rig.output.closed,
      },
      executionEvents,
      physicalEvents,
      frames: rig?.frames,
      directExecuteTrace: "UNAVAILABLE_IN_ORIGINAL_UNGATED_R08_FIXTURE",
    });
  rig = endpointRig(
    {
      pendingWorkerCommands: 1,
      reservedControlBytes: 4112,
      pipeQueuedBytes: 69648,
    },
    {
      executionObserver(event) {
        executionEvents.push(event);
        capture("actual-execution-marker-settlement", { event });
      },
    },
  );
  const originalWrite = rig.output.write;
  const originalEmit = rig.output.emit;
  rig.output.write = function (...args) {
    const ticket = ++nextWrite;
    const raw = args[0];
    const entry = {
      ticket,
      bytes: raw.byteLength,
      rawHex: Buffer.from(raw).toString("hex"),
      sha256: createHash("sha256").update(raw).digest("hex"),
      callbackEnters: 0,
      callbackReturns: 0,
    };
    physicalEvents.push(entry);
    const index = args.length - 1;
    const completion = args[index];
    if (typeof completion === "function")
      args[index] = function (...values) {
        entry.callbackEnters++;
        capture("actual-callback-before", { ticket, args: values });
        try {
          return completion.apply(this, values);
        } finally {
          entry.callbackReturns++;
          capture("actual-callback-after", { ticket });
        }
      };
    const accepted = originalWrite.apply(this, args);
    entry.writeAccepted = accepted;
    capture("actual-write-return", { ticket, accepted });
    return accepted;
  };
  rig.output.emit = function (type, ...args) {
    if (type === "drain" || type === "close") capture("actual-event-before", { type, args });
    try {
      return originalEmit.call(this, type, ...args);
    } finally {
      if (type === "drain" || type === "close") capture("actual-event-after", { type, args });
    }
  };
  rig.output.once("close", () => capture("actual-output-close"));
  const target = run("combined");
  const subscription = ref("combined", target);
  try {
    await pipeSpawn(rig, target);
    const installed = await pipeInstall(rig, subscription);
    await turns();
    rig.hold();
    const commands = [
      pipeCommand("recover", target, { subscription }),
      pipeCommand("status", target),
      pipeCommand("stop", target, { operationId: "stop-combined" }),
      pipeCommand("applied-ack", target, { subscription, appliedSeq: installed.result.atSeq }),
      pipeCommand("applied-ack", target, { subscription, appliedSeq: installed.result.atSeq }),
    ];
    const ingress = commands.map((command) => ({
      command,
      raw: Buffer.from(encoded(command, undefined, 1)),
    }));
    const batch = Buffer.concat(ingress.map((item) => item.raw));
    capture("fixed-input-before", {
      inputs: ingress.map(({ command, raw }) => ({
        command,
        rawHex: raw.toString("hex"),
        bytes: raw.length,
        sha256: createHash("sha256").update(raw).digest("hex"),
      })),
      batchRawHex: batch.toString("hex"),
      batchBytes: batch.length,
      batchSHA256: createHash("sha256").update(batch).digest("hex"),
    });
    rig.input.write(batch);
    capture("fixed-input-after");
    await untilTurn(() => rig.callbacks.length === 1, "combined physical callback");
    const first = rig.pipe.snapshot();
    capture("first-before-assert", { first, commands });
    assert.equal(first.parkedRequests, 1);
    assert.equal(first.outstandingRequests - first.parkedRequests, 4);
    assert.equal(first.outstandingRequests, 5);
    assert.equal(first.responseItems, 1);
    assert(first.ingressBytes > 0);
    assert(first.ordinaryAccountedBytes <= 69648 - 4112);
    const observations = [first];
    await drainHeld(rig, () =>
      commands.every((command) =>
        rig.frames.some((frame) => frame.metadata.requestId === command.requestId),
      ),
    );
    observations.push(rig.pipe.snapshot());
    for (const snapshot of observations) {
      capture("observation-before-guard", { snapshot, commands });
      assert(snapshot.parkedRequests >= 0 && snapshot.parkedRequests <= 1);
      assert(snapshot.outstandingRequests - snapshot.parkedRequests <= 4);
      assert(snapshot.outstandingRequests <= 4 + snapshot.parkedRequests);
      assert(snapshot.ordinaryAccountedBytes <= 65536);
      assert(snapshot.transportBytes + snapshot.queuedBytes <= 69648);
    }
    const replies = commands.map(
      (command) =>
        rig.frames.find((frame) => frame.metadata.requestId === command.requestId).metadata,
    );
    capture("replies-before-assert", { commands, replies });
    assert.equal(new Set(replies.map((reply) => reply.requestId)).size, 5);
    return { commands, first, observations, replies, frames: rig.frames };
  } catch (error) {
    capture("first-body-failure", {
      error: { name: error.name, message: error.message, stack: error.stack },
    });
    throw error;
  } finally {
    capture("finally-before-close");
    try {
      await rig.close();
      capture("finally-after-close");
    } finally {
      rig.output.write = originalWrite;
      rig.output.emit = originalEmit;
    }
  }
}

describe("W2 current recovery", () => {
  it("W2C-R01 large real baseline waits for parsed progress and installation", async () => {
    const rig = executionRig();
    const target = run("large-real");
    const subscription = ref("large", target);
    try {
      await rig.spawn(target, { cols: 120, rows: 40 });
      let text = "";
      for (let row = 0; row < 900; row++) {
        for (let col = 0; col < 100; col++)
          text += `\x1b[${31 + ((row + col) % 7)}m${String.fromCharCode(33 + ((row * 7 + col) % 80))}`;
        text += "\r\n";
      }
      const raw = utf8(text);
      assert.equal(raw.length, 541800);
      assert.equal(
        createHash("sha256").update(raw).digest("hex"),
        "841f67104be23c0133e148e3430ba2bc22c9a5f41afd8eca43ea98c861a6eb51",
      );
      const settledEmission = async (payload, ordinal, offset) => {
        const before = rig.execution.snapshot();
        const beforeSession = before.sessions.find(
          (value) => value.run.runId === target.runId,
        ).snapshot;
        record("W2C-R01-before-emission", { ordinal, offset, before, beforeSession });
        assert.equal(before.ordinaryPendingCommands, 0);
        assert.equal(before.pendingCommands, 0);
        assert.equal(before.reservedStatusPending, false);
        assert.equal(beforeSession.receivedSeq, ordinal - 1);
        assert.equal(beforeSession.parsedSeq, ordinal - 1);
        assert.equal(beforeSession.faulted, false);
        assert.equal(beforeSession.disposed, false);
        assert.equal(beforeSession.consumerFenced, false);
        assert.equal(beforeSession.exited, false);
        rig.native.owners[0].emit(payload);
        const command = rig.command("status", target);
        const request = rig.execution.snapshot();
        const session = request.sessions.find((value) => value.run.runId === target.runId).snapshot;
        const bytes = {
          length: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
        };
        record("W2C-R01-settlement-request", { ordinal, offset, bytes, command, request, session });
        assert.equal(request.ordinaryPendingCommands, 0);
        assert.equal(request.pendingCommands, 0);
        assert.equal(request.reservedStatusPending, false);
        assert(session.queuedItems <= 1, "noncached FIFO status admission below item cap");
        assert.equal(session.faulted, false);
        assert.equal(session.disposed, false);
        assert.equal(session.consumerFenced, false);
        assert.equal(session.exited, false);
        assert.equal(session.receivedSeq, ordinal);
        const result = await rig.execute(command);
        const after = rig.execution.snapshot();
        const afterSession = after.sessions.find(
          (value) => value.run.runId === target.runId,
        ).snapshot;
        record("W2C-R01-settlement-result", {
          ordinal,
          offset,
          bytes,
          command,
          result,
          after,
          afterSession,
          facts: rig.facts,
        });
        assert.equal(result.requestId, command.requestId);
        assert.equal(result.outcome, "accepted");
        assert.deepEqual(result.run, target);
        assert.equal(result.runStatus.status, "live");
        assert.equal(result.runStatus.receivedSeq, ordinal);
        assert.equal(result.runStatus.parsedSeq, ordinal);
        assert.deepEqual(
          rig.facts.map((fact) => fact.event.seq),
          Array.from({ length: ordinal }, (_, index) => index + 1),
        );
        assert(rig.facts.every((fact) => fact.event.type === "output"));
        assert.equal(rig.facts.at(-1).hex, Buffer.from(payload).toString("hex"));
        assert.equal(
          createHash("sha256")
            .update(Buffer.from(rig.facts.at(-1).hex, "hex"))
            .digest("hex"),
          bytes.sha256,
        );
      };
      for (let offset = 0; offset < raw.length; offset += 65536) {
        await settledEmission(raw.subarray(offset, offset + 65536), offset / 65536 + 1, offset);
      }
      assert.deepEqual(
        rig.facts.map((fact) => fact.event.seq),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
      const command = rig.command("subscribe", target, { subscription, atSeq: 0 });
      const marker = await rig.execution.execute(command);
      assert.equal(marker.atSeq, 9);
      assert.equal(marker.outcome, "accepted");
      assert.equal(rig.sink.frames.length, 0);
      rig.execution.markerEnqueued(command, marker);
      rig.execution.responseSettled(command.requestId);
      await turns();
      const start = rig.sink.frames.find((frame) => frame.event.terminal.type === "baseline-start")
        .event.terminal.descriptor;
      assert(start.vtBytes + start.tailBytes > 262144, "NOT_EXERCISED: frozen real large baseline");
      assert(!rig.sink.frames.some((frame) => frame.event.terminal.type === "baseline-end"));
      const rejected = await rig.execute(
        rig.command("input", target, { subscription, epoch: 1, inputSeq: 1 }),
        utf8("W2-R01-INPUT"),
      );
      assert.equal(rejected.type, "error");
      assert.equal(rig.native.owners[0].tasks.length, 0);
      let last = -1;
      for (let turn = 0; turn < 64; turn++) {
        const chunks = rig.sink.frames.filter(
          (frame) => frame.event.terminal.type === "baseline-chunk",
        );
        if (chunks.length && chunks.at(-1).event.terminal.ordinal > last) {
          last = chunks.at(-1).event.terminal.ordinal;
          assert.equal(
            (
              await rig.execute(
                rig.command("baseline-progress", target, {
                  subscription,
                  baselineId: start.baselineId,
                  lastParsedOrdinal: last,
                }),
              )
            ).outcome,
            "accepted",
          );
        }
        await turns(1);
        if (rig.sink.frames.some((frame) => frame.event.terminal.type === "baseline-end")) break;
      }
      const chunks = rig.sink.frames.filter(
        (frame) => frame.event.terminal.type === "baseline-chunk",
      );
      const end = rig.sink.frames.find((frame) => frame.event.terminal.type === "baseline-end");
      assert(end);
      assert(
        validateBaselineTransfer(
          start,
          chunks.map((frame) => ({ metadata: frame.event.terminal, payload: frame.payload })),
          end.event.terminal,
        ),
      );
      assert.equal(
        (await rig.execute(rig.command("applied-ack", target, { subscription, appliedSeq: 9 })))
          .outcome,
        "accepted",
      );
      await settledEmission(utf8("|W2-R01-SUFFIX|"), 10, raw.length);
      await turns();
      const suffix = rig.sink.frames.filter(
        (frame) => frame.event.terminal.type === "output" && frame.event.terminal.seq === 10,
      );
      assert.equal(suffix.length, 1);
      assert.equal(Buffer.from(suffix[0].payload).toString(), "|W2-R01-SUFFIX|");
      await rig.grant(subscription);
      assert.equal(
        (
          await rig.execute(
            rig.command("input", target, { subscription, epoch: 1, inputSeq: 1 }),
            utf8("W2-R01-INPUT"),
          )
        ).outcome,
        "accepted",
      );
      record("W2C-R01", {
        marker,
        descriptor: start,
        rejected,
        chunks: chunks.map((frame) => ({
          ordinal: frame.event.terminal.ordinal,
          bytes: frame.payload.length,
          rawHex: frame.rawHex,
        })),
        end: end.event,
        suffix: suffix[0].event,
      });
    } finally {
      await rig.close();
    }
  });
  it("W2C-R02 same-ref recovery preserves old physical bytes and equal-N attempt fencing", async () => {
    const rig = endpointRig();
    const target = run("same-n");
    const subscription = ref("same-n", target);
    try {
      await pipeSpawn(rig, target);
      const old = await pipeInstall(rig, subscription);
      await turns();
      rig.hold();
      const first = pipeCommand("recover", target, { subscription });
      rig.send(first);
      await untilTurn(() => rig.callbacks.length === 1, "old physical recover marker");
      const debt = rig.pipe.snapshot().transportBytes;
      assert(debt > 0);
      const oldStartIndex = rig.frames.length;
      await drainHeld(rig, () =>
        rig.frames
          .slice(oldStartIndex)
          .some((frame) => frame.metadata.terminal?.type === "baseline-start"),
      );
      const oldId = rig.frames.findLast(
        (frame) => frame.metadata.terminal?.type === "baseline-start",
      ).metadata.terminal.descriptor.baselineId;
      const second = pipeCommand("recover", target, { subscription });
      rig.send(second);
      const staleProgress = pipeCommand("baseline-progress", target, {
        subscription,
        baselineId: oldId,
        lastParsedOrdinal: 0,
      });
      rig.send(staleProgress);
      const staleAck = pipeCommand("applied-ack", target, {
        subscription,
        appliedSeq: old.result.atSeq,
      });
      rig.send(staleAck);
      assert(rig.pipe.snapshot().transportBytes > 0);
      await drainHeld(rig, () =>
        rig.frames.some((frame) => frame.metadata.requestId === second.requestId),
      );
      const newMarker = rig.frames.find(
        (frame) => frame.metadata.requestId === second.requestId,
      ).metadata;
      assert.equal(newMarker.atSeq, old.result.atSeq);
      await drainHeld(rig, () =>
        rig.frames.some((frame) => frame.metadata.requestId === staleProgress.requestId),
      );
      assert.equal(
        rig.frames.find((frame) => frame.metadata.requestId === staleProgress.requestId).metadata
          .type,
        "error",
      );
      await drainHeld(
        rig,
        () =>
          rig.frames.filter((frame) => frame.metadata.terminal?.type === "baseline-end").length >=
          2,
      );
      const current = rig.frames.findLast(
        (frame) => frame.metadata.terminal?.type === "baseline-start",
      ).metadata.terminal.descriptor;
      assert.notEqual(current.baselineId, oldId);
      const beforeMarker = rig.frames.findIndex(
        (frame) => frame.metadata.requestId === second.requestId,
      );
      const newStart = rig.frames.findIndex(
        (frame) => frame.metadata.terminal?.descriptor?.baselineId === current.baselineId,
      );
      assert(beforeMarker < newStart);
      rig.hold(false);
      await drainHeld(rig, () => rig.callbacks.length === 0);
      const chunks = rig.frames.filter(
        (frame) =>
          frame.metadata.terminal?.type === "baseline-chunk" &&
          frame.metadata.terminal.baselineId === current.baselineId,
      );
      assert.equal(
        (
          await pipeResult(
            rig,
            pipeCommand("baseline-progress", target, {
              subscription,
              baselineId: current.baselineId,
              lastParsedOrdinal: chunks.at(-1).metadata.terminal.ordinal,
            }),
          )
        ).outcome,
        "accepted",
      );
      assert.equal(
        (
          await pipeResult(
            rig,
            pipeCommand("applied-ack", target, { subscription, appliedSeq: current.atSeq }),
          )
        ).outcome,
        "accepted",
      );
      record("W2C-R02", {
        debt,
        oldId,
        current,
        newMarker,
        frames: rig.frames,
        state: rig.pipe.snapshot(),
      });
    } finally {
      await rig.close();
    }
  });
  it("W2C-R03 detached capture fixes N before reentrant output resize and exit", async () => {
    for (const [variant, seed, injected] of [
      ["normal", "4e4f524d414c", "7c57322d5230332d5355464649587c"],
      ["alternate", "4e4f524d414c1b5b3f343768414c54", "7c57322d5230332d5355464649587c"],
      ["partial-csi", "4e4f524d414c1b5b3331", "6d7c57322d5230332d5355464649587c"],
    ]) {
      const observed = await captureSchedule(seed, injected);
      const verifyOrder = (order) =>
        assert.deepEqual(
          order,
          ["reserve-detached-callback", "capture-return"],
          "fixed before-return trigger",
        );
      verifyOrder(observed.captureOrder);
      assert.throws(() => verifyOrder([...observed.captureOrder].reverse()));
      record("W2C-R03", { semanticVariant: variant, ...observed });
    }
  });
  it("W2C-R04 capture cancellation fences late publication without early release", async () => {
    for (const action of ["keep", "cancel", "recover"]) {
      for (const [variant, seed, injected] of [
        ["normal", "4e4f524d414c", "7c57322d5230332d5355464649587c"],
        ["alternate", "4e4f524d414c1b5b3f343768414c54", "7c57322d5230332d5355464649587c"],
        ["partial-csi", "4e4f524d414c1b5b3331", "6d7c57322d5230332d5355464649587c"],
      ]) {
        const observed = await captureSchedule(seed, injected, action);
        assert.equal(observed.trigger, 1, "single actual detached reservation callback");
        record("W2C-R04", { semanticVariant: `${action}/${variant}`, ...observed });
      }
    }
  });
  it("W2C-R05 two generation owners bound waiters bytes and later-run progress", async () => {
    const rig = recoveryRig({ pendingWorkerCommands: 1 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const work = [];
    try {
      const capture = (id, gate) =>
        rig.recovery.capture(id, async () => {
          const scratch = rig.ledger.reserve(32768, "controlled-capture-scratch");
          assert(scratch);
          running++;
          peak = Math.max(peak, running);
          try {
            return await gate.promise;
          } finally {
            running--;
            scratch.release();
          }
        });
      work.push(capture("one", gates[0]), capture("two", gates[1]), capture("later", gates[2]));
      await turns();
      assert.equal(running, 2);
      assert.equal(rig.ledger.account.snapshot().workerBytes, 65536);
      assert.equal(await rig.recovery.capture("plus-one", async () => "forbidden"), undefined);
      gates[0].resolve("first");
      await turns();
      assert.equal(running, 2);
      gates[1].resolve("second");
      gates[2].resolve("later");
      assert.deepEqual(await Promise.all(work), ["first", "second", "later"]);
      assert.equal(peak, 2);
      assert.equal(rig.ledger.account.snapshot().workerBytes, 0);
      record("W2C-R05", {
        actualRealSerializerConcurrencyClaim: false,
        peak,
        events: rig.ledger.events,
      });
    } finally {
      gates.forEach((gate) => gate.resolve("cleanup"));
      await Promise.all(work);
      rig.close();
    }
  });
  it("W2C-R06 recovery deadlines expire exactly without progress-based reset", async () => {
    for (const deadline of [1, 15000]) {
      const rig = recoveryRig(deadline === 15000 ? {} : { recoveryDeadlineMs: deadline });
      const subscription = ref();
      try {
        const command = rig.command("subscribe", subscription, { atSeq: 0 });
        const outcome = await rig.recovery.open(command, rig.source());
        rig.recovery.markerEnqueued(command, outcome.result);
        await turns();
        const start = rig.sink.frames.find(
          (frame) => frame.event.terminal.type === "baseline-start",
        ).event.terminal.descriptor;
        rig.time.advance(deadline - 0.5);
        assert.equal(
          rig.recovery.command(
            rig.command("baseline-progress", subscription, {
              baselineId: start.baselineId,
              lastParsedOrdinal: 0,
            }),
          ).result?.outcome,
          "accepted",
        );
        rig.time.advance(deadline);
        assert.equal(
          rig.recovery.command(rig.command("applied-ack", subscription, { appliedSeq: 0 })).failure,
          "RECOVERY_EXPIRED",
        );
        assert(!rig.recovery.installed(subscription));
        record("W2C-R06", {
          deadline,
          clock: rig.time.snapshot(),
          frames: rig.sink.frames.map((frame) => frame.event),
        });
      } finally {
        rig.close();
      }
    }
  });
  it("W2C-R07 reader-before-callback reentry preserves marker FIFO and callback debt", async () => {
    const labels = [
      "sync progress",
      "sync ACK",
      "sync recover",
      "sync unsubscribe",
      "sync shutdown",
      "late capacity",
      "close before callback",
    ];
    for (const label of labels) {
      const rig = endpointRig();
      const target = run("reader-reentry");
      const subscription = ref("reader", target);
      const reentry = [];
      let observer;
      let firstEnd;
      let variantCommand;
      let shutdown;
      const capture = (phase, value) => observer.capture(phase, { label, ...value });
      const checkBounds = () => {
        const event = capture("bounded-step");
        assert(rig.callbacks.length <= 1, "one physical callback per controlled turn");
        assert(event.snapshot.pendingDrains.length <= 1, "one genuine drain per controlled turn");
      };
      const advance = async (predicate, deliver = true) => {
        for (let step = 0; step < 64; step++) {
          capture("advance-before-predicate", { step });
          if (predicate()) return;
          if (rig.callbacks.length) {
            capture("advance-before-real-callback", { step });
            rig.release();
          }
          await turns(1);
          checkBounds();
          if (deliver && observer.snapshot().pendingDrains.length) observer.deliverDrain();
          await turns(1);
          checkBounds();
        }
        capture("advance-bound-exhausted");
        assert(predicate(), "NOT_EXERCISED: R07 genuine callback/drain progress");
      };
      const sendInReader = (command, ticket) => {
        capture("sync-reentry-before", { command, ticket: ticket.id });
        assert.equal(ticket.outerCallbackReturns, 0);
        assert.equal(ticket.observedRetirementBoundary, undefined);
        rig.send(command);
        capture("sync-reentry-after", { command, ticket: ticket.id });
        assert.equal(
          ticket.outerCallbackReturns,
          0,
          "logical reentry cannot settle actual physical callback",
        );
        assert.equal(ticket.observedRetirementBoundary, undefined);
        reentry.push(command);
      };
      try {
        await pipeSpawn(rig, target);
        observer = rig.observeCallbacks(label);
        rig.hold();
        rig.reader((metadata) => {
          const ticket = observer.tickets.findLast((item) =>
            item.readerMetadata === undefined
              ? false
              : JSON.stringify(item.readerMetadata) === JSON.stringify(metadata),
          );
          const observed = capture("reader-before-callback", { metadata, ticket: ticket?.id });
          assert(ticket, "actual reader frame has a real write ticket");
          assert.equal(ticket.outerCallbackReturns, 0);
          assert.equal(ticket.observedRetirementBoundary, undefined);
          assert(observed.snapshot.pipe.transportBytes >= ticket.bytes);
          if (metadata.terminal?.type === "baseline-chunk") {
            sendInReader(
              pipeCommand("baseline-progress", target, {
                subscription,
                baselineId: metadata.terminal.baselineId,
                lastParsedOrdinal: metadata.terminal.ordinal,
              }),
              ticket,
            );
          }
          if (metadata.terminal?.type !== "baseline-end") return;
          if (!firstEnd) {
            firstEnd = ticket;
            if (label === "sync recover" || label === "sync unsubscribe") {
              variantCommand = pipeCommand(
                label === "sync recover" ? "recover" : "unsubscribe",
                target,
                {
                  subscription,
                  ...(label === "sync recover" ? { atSeq: 0 } : {}),
                },
              );
              sendInReader(variantCommand, ticket);
              return;
            }
            if (label === "sync shutdown") {
              capture("sync-shutdown-before", { ticket: ticket.id });
              shutdown = rig.pipe.shutdown("R07-sync-shutdown");
              capture("sync-shutdown-after", { ticket: ticket.id });
              assert.equal(ticket.outerCallbackReturns, 0);
              return;
            }
            if (label === "close before callback") {
              capture("real-close-request-before", { ticket: ticket.id });
              rig.output.destroy();
              capture("real-close-request-return", { ticket: ticket.id });
              assert.equal(ticket.outerCallbackReturns, 0);
              return;
            }
          }
          sendInReader(
            pipeCommand("applied-ack", target, {
              subscription,
              appliedSeq: metadata.terminal.atSeq,
            }),
            ticket,
          );
        });
        const command = pipeCommand("subscribe", target, { subscription, atSeq: 0 });
        capture("subscribe-request", { command });
        rig.send(command);
        const closing = label === "sync shutdown" || label === "close before callback";
        await advance(() =>
          closing
            ? Boolean(firstEnd)
            : Boolean(firstEnd) &&
              reentry.every((item) =>
                rig.frames.some((frame) => frame.metadata.requestId === item.requestId),
              ),
        );
        capture("marker-FIFO-before-assert", { frames: rig.frames });
        const marker = rig.frames.findIndex(
          (frame) => frame.metadata.requestId === command.requestId,
        );
        const start = rig.frames.findIndex(
          (frame) => frame.metadata.terminal?.type === "baseline-start",
        );
        assert(marker >= 0 && marker < start);
        const initialChunk = rig.frames.find(
          (frame) => frame.metadata.terminal?.type === "baseline-chunk",
        );
        assert.equal(initialChunk.payload.length, 289);
        if (closing) {
          capture("closing-before-retirement", { ticket: firstEnd.id });
          assert.equal(firstEnd.outerCallbackReturns, 0);
          if (label === "close before callback") {
            for (let step = 0; step < 64 && !observer.snapshot().realCloses; step++) await turns(1);
            const closed = capture("real-close-before-late-callback", { ticket: firstEnd.id });
            assert.equal(closed.snapshot.realCloses, 1);
            assert.equal(firstEnd.observedRetirementBoundary, "close");
            assert.equal(firstEnd.outerCallbackReturns, 0);
            assert.equal(closed.snapshot.pipe.transportBytes, 0);
          }
          capture("before-once-late-internal-callback", { ticket: firstEnd.id });
          assert.equal(rig.callbacks.length, 1);
          rig.release();
          for (let step = 0; step < 64 && !firstEnd.outerCallbackReturns; step++) await turns(1);
          capture("after-once-late-outer-callback", { ticket: firstEnd.id });
          assert.equal(firstEnd.outerCallbackEnters, 1);
          assert.equal(firstEnd.outerCallbackReturns, 1);
          if (shutdown) await shutdown;
          else await rig.pipe.closed;
          await turns(1);
          const retired = capture("closed-before-late-capacity", { frames: rig.frames });
          const frameCount = rig.frames.length;
          const ticketCount = observer.tickets.length;
          assert.equal(retired.snapshot.pipe.state, "closed");
          assert.equal(retired.snapshot.pipe.transportBytes, 0);
          observer.lateCapacity();
          await turns(1);
          capture("closed-after-late-capacity");
          assert.equal(rig.frames.length, frameCount);
          assert.equal(observer.tickets.length, ticketCount);
          assert.equal(firstEnd.outerCallbackReturns, 1);
        } else {
          const before = capture("isolated-before-real-callback");
          assert.equal(before.snapshot.pipe.state, "ready");
          assert.equal(before.snapshot.pipe.blocked, true);
          assert.equal(before.snapshot.heldCallbacks.length, 1);
          assert.equal(before.snapshot.pendingDrains.length, 0);
          const ticket = observer.tickets.find(
            (item) => item.id === before.snapshot.heldCallbacks[0],
          );
          assert.equal(ticket.writeAccepted, false);
          assert.equal(ticket.outerCallbackReturns, 0);
          rig.release();
          for (let step = 0; step < 64 && !ticket.outerCallbackReturns; step++) await turns(1);
          const callbackOnly = capture("isolated-callback-completed-drain-undelivered", {
            ticket: ticket.id,
          });
          assert.equal(ticket.outerCallbackEnters, 1);
          assert.equal(ticket.outerCallbackReturns, 1);
          assert.equal(ticket.observedRetirementBoundary, "callback");
          assert.equal(callbackOnly.snapshot.pipe.state, "ready");
          assert.equal(callbackOnly.snapshot.realCloses, 0);
          assert.equal(callbackOnly.snapshot.deliveredDrains, before.snapshot.deliveredDrains);
          assert.equal(callbackOnly.snapshot.pendingDrains.length, 1);
          assert.equal(callbackOnly.snapshot.pipe.blocked, true);
          observer.deliverDrain();
          capture("matched-genuine-drain-control", { ticket: ticket.id });
          assert.equal(observer.snapshot().deliveredDrains, before.snapshot.deliveredDrains + 1);
          assert.equal(ticket.outerCallbackReturns, 1);
          await advance(
            () => rig.callbacks.length === 0 && observer.snapshot().pendingDrains.length === 0,
          );
          capture("reentry-results-before-assert", { reentry, frames: rig.frames });
          assert(
            reentry.every((item) =>
              rig.frames.some(
                (frame) =>
                  frame.metadata.requestId === item.requestId &&
                  frame.metadata.outcome === "accepted",
              ),
            ),
          );
          if (label === "sync recover") {
            const recoverMarker = rig.frames.findIndex(
              (frame) => frame.metadata.requestId === variantCommand.requestId,
            );
            const laterStart = rig.frames.findIndex(
              (frame, index) => index > start && frame.metadata.terminal?.type === "baseline-start",
            );
            assert(recoverMarker > start && laterStart > recoverMarker);
          }
          if (label !== "sync unsubscribe") {
            const valid = pipeCommand("applied-ack", target, { subscription, appliedSeq: 0 });
            capture("valid-ACK-request", { command: valid });
            rig.send(valid);
            await advance(() =>
              rig.frames.some((frame) => frame.metadata.requestId === valid.requestId),
            );
            capture("valid-ACK-result-before-assert", { command: valid });
            assert.equal(
              rig.frames.find((frame) => frame.metadata.requestId === valid.requestId).metadata
                .outcome,
              "accepted",
            );
            await advance(
              () => rig.callbacks.length === 0 && observer.snapshot().pendingDrains.length === 0,
            );
            const unsubscribe = pipeCommand("unsubscribe", target, { subscription });
            capture("valid-unsubscribe-request", { command: unsubscribe });
            rig.send(unsubscribe);
            await advance(() =>
              rig.frames.some((frame) => frame.metadata.requestId === unsubscribe.requestId),
            );
            capture("valid-unsubscribe-result-before-assert", { command: unsubscribe });
            assert.equal(
              rig.frames.find((frame) => frame.metadata.requestId === unsubscribe.requestId)
                .metadata.outcome,
              "accepted",
            );
          }
          await advance(
            () => rig.callbacks.length === 0 && observer.snapshot().pendingDrains.length === 0,
          );
          if (label === "late capacity") {
            const frames = rig.frames.length;
            const tickets = observer.tickets.length;
            capture("unsubscribed-before-late-capacity");
            observer.lateCapacity();
            await turns(1);
            capture("unsubscribed-after-late-capacity");
            assert.equal(rig.frames.length, frames);
            assert.equal(observer.tickets.length, tickets);
          }
        }
        capture("inner-label-complete", { frames: rig.frames });
      } finally {
        rig.reader(undefined);
        await rig.close();
      }
    }
    record("W2C-R07", { completedInnerLabels: labels, dynamicDeclarationCredit: 0 });
  });
  it("W2C-R08 B1 C4112 O S T X records share one reply permit and bounded parked X", async () => {
    const observed = await combinedEndpointSchedule();
    assert.equal(
      observed.replies.length,
      5,
      "all five real shared-lane requests make later progress",
    );
    record("W2C-R08", observed);
  });
  it("W2C-R09 legal exact wire maxima and each isolated plus-one bound discriminate", () => {
    const subscription = ref();
    const metadata = {
      type: "terminal-event",
      worker,
      run: subscription.run,
      subscription,
      terminal: { type: "output", run: subscription.run, seq: 1 },
    };
    const json = JSON.stringify(metadata);
    const padded = utf8(json + " ".repeat(4096 - utf8(json).length));
    const payload = new Uint8Array(65536).fill(65);
    const legal = encodePipeFrame(3, padded, payload);
    assert(legal.ok);
    assert.equal(legal.value.length, 69648);
    const decoded = createPipeDecoder().read(legal.value);
    assert.equal(decoded.frames.length, 1);
    assert(validatePipeFrame(decoded.frames[0], metadata).ok);
    const metaPlus = encodePipeFrame(3, new Uint8Array(4097), payload);
    assert(!metaPlus.ok);
    const payloadPlus = encodePipeFrame(3, padded, new Uint8Array(65537));
    assert(!payloadPlus.ok);
    const headerPlus = Uint8Array.from(legal.value);
    new DataView(headerPlus.buffer).setUint32(8, 4097, false);
    assert.equal(createPipeDecoder().read(headerPlus.subarray(0, 16)).status, "error");
    record("W2C-R09", {
      legalBytes: legal.value.length,
      metadataBytes: padded.length,
      payloadBytes: payload.length,
      metaPlus,
      payloadPlus,
    });
  });
  it("W2C-R10 129 controlled chunks and each isolated descriptor violation reach producer", async () => {
    const failureReceipt = (error) =>
      error && { name: error.name, message: error.message, stack: error.stack };
    const cleanup = (fixture, source, semanticVariant, bodyFailure) => {
      const receipt = () => {
        const events = structuredClone(fixture.ledger.events);
        const physicalOwners = events.filter(
          (event) => event.phase === "acquire" && event.owner === "physical-delivery",
        );
        return {
          semanticVariant,
          effectiveBudgets: fixture.effective,
          ledger: fixture.ledger.snapshot(),
          events,
          availableOrdinaryBytes: fixture.ledger.account.availableOrdinaryBytes(),
          physical: fixture.sink.physical.map((frame, index) => ({
            index,
            ownerId: physicalOwners[index]?.id,
            token: frame.token,
            encodedBytes: frame.encodedBytes,
            settled: frame.settled,
            payloadBytes: frame.payload.length,
            event: frame.event,
            rawSHA256: createHash("sha256").update(Buffer.from(frame.rawHex, "hex")).digest("hex"),
          })),
          bodyFailure: failureReceipt(bodyFailure),
        };
      };
      const before = receipt();
      record("W2C-R10-cleanup-before", before);
      let cleanupOperationFailure;
      try {
        source?.replay.clear();
        fixture.close();
      } catch (error) {
        cleanupOperationFailure = error;
      }
      const after = receipt();
      record("W2C-R10-cleanup-after", {
        ...after,
        cleanupOperationFailure: failureReceipt(cleanupOperationFailure),
      });
      try {
        if (cleanupOperationFailure) throw cleanupOperationFailure;
        assert.equal(fixture.effective.workerBytes, 67108864);
        assert.equal(fixture.effective.reservedControlBytes, 65536);
        assert.deepEqual(after.ledger.owners, []);
        assert.equal(fixture.ledger.live.size, 0);
        assert.equal(after.ledger.account.reservedControlBytes, 65536);
        assert.equal(after.ledger.account.workerBytes, 0);
        assert.equal(after.ledger.account.engineBytes, 0);
        assert.equal(after.ledger.account.nativeInputBytes, 0);
        assert.equal(after.ledger.account.nativeOutputBytes, 0);
        assert.equal(after.ledger.account.accountedBytes, 65536);
        assert.equal(after.availableOrdinaryBytes, 67043328);
        if (!bodyFailure && ["default129", "derived-count-valid"].includes(semanticVariant)) {
          assert(before.physical.length > 0, "logical final ACK leaves handed physical ownership");
          for (const frame of before.physical) {
            assert.equal(frame.settled, false);
            assert(frame.encodedBytes > 0);
            if (frame.event.terminal.type === "baseline-chunk") {
              assert(frame.payloadBytes > 0);
            } else {
              assert(["baseline-start", "baseline-end"].includes(frame.event.terminal.type));
              assert.equal(frame.payloadBytes, 0);
            }
            assert(
              before.ledger.owners.some(
                (owner) =>
                  owner.id === frame.ownerId &&
                  owner.owner === "physical-delivery" &&
                  owner.bytes === frame.encodedBytes,
              ),
            );
          }
        }
        const acquisitions = after.events.filter((event) => event.phase === "acquire");
        const releases = after.events.filter((event) => event.phase === "release");
        assert.equal(new Set(acquisitions.map((event) => event.id)).size, acquisitions.length);
        assert.equal(releases.length, acquisitions.length);
        for (const owner of acquisitions) {
          const matching = releases.filter((event) => event.id === owner.id);
          assert.equal(matching.length, 1, `owner ${owner.id} released exactly once`);
          assert.equal(matching[0].owner, owner.owner);
          assert.equal(matching[0].category, owner.category);
        }
        const physicalOwners = acquisitions.filter((event) => event.owner === "physical-delivery");
        assert.equal(after.physical.length, physicalOwners.length);
        for (const frame of after.physical) {
          const owner = physicalOwners.find((event) => event.id === frame.ownerId);
          assert(owner);
          assert.equal(owner.bytes, frame.encodedBytes);
          assert.equal(frame.settled, true, "real sink settlement retires physical backing");
          assert.equal(frame.payloadBytes, 0);
        }
        record("W2C-R10-cleanup-verified", {
          semanticVariant,
          acquiredOwnerIds: acquisitions.map((owner) => owner.id),
          after,
        });
      } catch (error) {
        record("W2C-R10-cleanup-failure", {
          semanticVariant,
          bodyFailure: failureReceipt(bodyFailure),
          cleanupFailure: failureReceipt(error),
          before,
          after,
        });
        if (!bodyFailure) throw error;
      }
    };
    const rig = recoveryRig();
    const subscription = ref("max");
    const source = rig.source(subscription.run, { vtBytes: 8388608, tailBytes: 65536 });
    let defaultBodyFailure;
    try {
      const command = rig.command("subscribe", subscription, { atSeq: 0 });
      const outcome = await rig.recovery.open(command, source);
      const captureOwner = rig.ledger.events.find(
        (event) => event.phase === "acquire" && event.owner === "recovery-baseline",
      );
      assert.equal(captureOwner.bytes, 8458240);
      const parsed = await parseBaseline(rig, subscription, { command, result: outcome.result });
      const chunks = parsed.frames.filter(
        (frame) => frame.event.terminal.type === "baseline-chunk",
      );
      assert.equal(chunks.length, 129);
      assert(chunks.every((frame) => frame.payload.length === 65536));
      assert(validateBaselineDescriptor(parsed.descriptor));
      const leafCount130 = { ...parsed.descriptor, chunkCount: 130 };
      assert.equal(validateBaselineDescriptor(leafCount130), null);
      record("W2C-R10-leaf-only-count", {
        validDescriptor: parsed.descriptor,
        leafCount130,
        originalProducerExtraField: "NOT_REPRESENTABLE_ON_THIS_PORT",
        producerFaultCreditFromIgnoredExtraField: 0,
      });
      record("W2C-R10-valid", {
        descriptor: parsed.descriptor,
        detachedReserve: captureOwner,
        chunks: chunks.map((frame) => ({
          ordinal: frame.event.terminal.ordinal,
          bytes: frame.payload.length,
          rawHex: frame.rawHex,
        })),
      });
    } catch (error) {
      defaultBodyFailure = error;
      record("W2C-R10-body-failure", {
        semanticVariant: "default129",
        failure: failureReceipt(error),
      });
      throw error;
    } finally {
      cleanup(rig, source, "default129", defaultBodyFailure);
    }
    for (const variant of ["derived-count-fault", "derived-count-valid"]) {
      const small = recoveryRig({
        baselineVtBytes: 65537,
        baselineTailBytes: 1,
        baselineChunks: 2,
      });
      const route = ref(`negotiated-${variant}`);
      const fault = variant === "derived-count-fault";
      const vtBytes = fault ? 65537 : 65536;
      const detachedCharge = fault ? 69634 : 69633;
      const sourceSmall = small.source(route.run);
      const phases = [];
      sourceSmall.captureBaseline = async (reserveDetached) => {
        const reserved = reserveDetached(detachedCharge);
        phases.push({ phase: "reserve-result", reserved, bytes: detachedCharge });
        if (!reserved) return { status: "unavailable", reason: "denied-detached" };
        const owner = [...small.ledger.live.values()].find(
          (value) => value.owner === "recovery-baseline" && value.bytes === detachedCharge,
        );
        assert(owner, "real detached owner exists before typed-array allocation");
        phases.push({ phase: "before-allocation", ownerId: owner.id });
        const baseline = syntheticBaseline(route.run, vtBytes, 1);
        phases.push({
          phase: "after-allocation",
          vtBytes: baseline.vt.length,
          tailBytes: baseline.tail.length,
        });
        const descriptor = descriptorOf(baseline, route);
        assert.equal(descriptor.chunkCount, fault ? 3 : 2);
        assert(validateBaselineDescriptor(descriptor), "small count3 is globally leaf-valid");
        phases.push({ phase: "globally-leaf-valid", descriptor });
        return { status: "ready", baseline };
      };
      let negotiatedBodyFailure;
      try {
        const command = small.command("subscribe", route, { atSeq: 0 });
        const outcome = await small.recovery.open(command, sourceSmall);
        assert.deepEqual(
          phases.map((value) => value.phase),
          ["reserve-result", "before-allocation", "after-allocation", "globally-leaf-valid"],
        );
        const detached = small.ledger.events.find(
          (value) => value.phase === "acquire" && value.owner === "recovery-baseline",
        );
        assert.equal(detached.bytes, detachedCharge);
        if (fault) {
          assert.equal(outcome.failure, "RECOVERY_UNAVAILABLE");
          assert.equal(outcome.result, undefined);
          assert(
            !small.ledger.events.some(
              (value) => value.phase === "acquire" && value.owner === "recovery-transfer-frames",
            ),
          );
          assert.equal(small.sink.frames.length, 0);
          assert(!small.ledger.live.has(detached.id), "fault releases its exact detached owner");
          assert.equal(small.ledger.live.size, 2);
          assert(
            [...small.ledger.live.values()].every((value) =>
              ["recovery-route", "recovery-connection"].includes(value.owner),
            ),
            "only owned route/connection tombstone records remain",
          );
        } else {
          assert.equal(outcome.result.outcome, "accepted");
          assert.equal(
            small.sink.frames.length,
            0,
            "no baseline publication before accepted marker barrier",
          );
          const parsed = await parseBaseline(small, route, { command, result: outcome.result });
          assert.equal(parsed.descriptor.chunkCount, 2);
          assert.deepEqual(
            parsed.frames
              .filter((frame) => frame.event.terminal.type === "baseline-chunk")
              .map((frame) => frame.payload.length),
            [65536, 1],
          );
          assert(small.sink.frames[0].event.terminal.type === "baseline-start");
          assert(small.sink.frames.at(-1).event.terminal.type === "baseline-end");
          const physicalIds = new Set(
            [...small.ledger.live.values()]
              .filter((value) => value.owner === "physical-delivery")
              .map((value) => value.id),
          );
          assert(physicalIds.size > 0, "final logical ACK cannot reclaim handed physical bytes");
          assert(
            !small.ledger.live.has(detached.id),
            "parsed final ACK releases exact logical detached owner",
          );
          assert(
            [...small.ledger.live.values()].every(
              (value) =>
                physicalIds.has(value.id) ||
                ["recovery-route", "recovery-connection"].includes(value.owner),
            ),
            "physical callbacks and persistent route records keep their own owners",
          );
        }
        record("W2C-R10-negotiated-count", {
          semanticVariant: variant,
          effectiveBudgets: small.effective,
          phases,
          outcome,
          events: small.ledger.events,
          liveOwners: [...small.ledger.live.values()],
          publishedFrames: small.sink.frames.map((frame) => ({
            event: frame.event,
            bytes: frame.payload.length,
            rawHex: frame.rawHex,
          })),
        });
      } catch (error) {
        negotiatedBodyFailure = error;
        record("W2C-R10-body-failure", {
          semanticVariant: variant,
          failure: failureReceipt(error),
        });
        throw error;
      } finally {
        cleanup(small, sourceSmall, variant, negotiatedBodyFailure);
      }
    }
    for (const variant of ["descriptor-field", "VT", "tail", "total"]) {
      const bad = recoveryRig();
      const route = ref(`bad-${variant}`);
      let sourceBad;
      let negativeBodyFailure;
      try {
        const vtBytes = variant === "VT" ? 8388609 : variant === "total" ? 8388608 : 1;
        const tailBytes = variant === "tail" || variant === "total" ? 65537 : 0;
        sourceBad = bad.source(route.run, {
          vtBytes,
          tailBytes,
          mutate(baseline) {
            if (variant === "descriptor-field") baseline.captureGeometry.cols = 121;
          },
        });
        const sample = syntheticBaseline(route.run, vtBytes, tailBytes);
        if (variant === "descriptor-field") sample.captureGeometry.cols = 121;
        const descriptor = descriptorOf(sample, route);
        assert.equal(validateBaselineDescriptor(descriptor), null, variant);
        const outcome = await bad.recovery.open(
          bad.command("subscribe", route, { atSeq: 0 }),
          sourceBad,
        );
        assert.equal(
          outcome.failure,
          "RECOVERY_UNAVAILABLE",
          `${variant}: intended actual producer boundary`,
        );
        assert(
          !bad.ledger.events.some(
            (event) => event.phase === "acquire" && event.owner === "recovery-transfer-frames",
          ),
        );
        assert.equal(bad.sink.frames.length, 0);
        record("W2C-R10-fault", {
          semanticVariant: variant,
          descriptor,
          outcome,
          events: bad.ledger.events,
        });
      } catch (error) {
        negativeBodyFailure = error;
        record("W2C-R10-body-failure", {
          semanticVariant: variant,
          failure: failureReceipt(error),
        });
        throw error;
      } finally {
        cleanup(bad, sourceBad, variant, negativeBodyFailure);
      }
    }
    const identity = "x".repeat(1024);
    const long = ref("legal");
    long.viewId = identity;
    long.subscriptionId = identity;
    const baseline = syntheticBaseline(long.run);
    const descriptor = descriptorOf(baseline, long);
    const meta = {
      type: "terminal-event",
      worker,
      run: long.run,
      subscription: long,
      terminal: { type: "baseline-start", run: long.run, descriptor },
    };
    assert(utf8(JSON.stringify(meta)).length > 4096);
    assert(!encodePipeFrame(3, utf8(JSON.stringify(meta)), new Uint8Array()).ok);
  });
  it("W2C-R11 complete next frame yields before byte and frame turn caps", async () => {
    for (const payloadBytes of [1, 65536]) {
      const semanticVariant = payloadBytes === 1 ? "frame-cap" : "byte-cap";
      const countPlanned = payloadBytes === 1 ? 40 : 12;
      record("W2C-R11-requested-budget", {
        semanticVariant,
        patch: { subscriptionCreditBytes: 262144 },
        payloadBytes,
        records: countPlanned,
        atSeq: 1,
        selected: countPlanned - 1,
      });
      const rig = recoveryRig({ subscriptionCreditBytes: 262144 });
      const source = rig.source();
      const subscription = ref();
      const originalEnqueue = rig.sink.enqueue;
      const decoder = createPipeDecoder();
      const handoffs = [];
      const acknowledgments = [];
      let previous;
      let ordinal = 0;
      let bodyFailure;
      const state = () => ({
        effectiveBudgets: rig.effective,
        ledger: rig.ledger.snapshot(),
        events: structuredClone(rig.ledger.events),
        availableOrdinaryBytes: rig.ledger.account.availableOrdinaryBytes(),
        physical: rig.sink.physical.map((frame, index) => ({
          index,
          token: frame.token,
          encodedBytes: frame.encodedBytes,
          settled: frame.settled,
          terminal: frame.event.terminal,
        })),
      });
      const capture = (phase, value = {}) => {
        const observation = {
          ordinal: ++ordinal,
          semanticVariant,
          phase,
          ...value,
          state: state(),
        };
        record("W2C-R11-port-event", observation);
        return observation;
      };
      rig.sink.enqueue = (event, payload, token) => {
        capture("enqueue-entry", { event, payloadBytes: payload.length, token, previous });
        if (previous) {
          const command = rig.command("applied-ack", subscription, { appliedSeq: previous.seq });
          capture("prior-handoff-ACK-before", { event, previous, command });
          assert.equal(event.terminal.seq, previous.seq + 1);
          assert(previous.seq >= 2 && previous.seq < countPlanned);
          assert.equal(event.terminal.type, "output");
          assert.deepEqual(command.worker, worker);
          assert.deepEqual(command.run, subscription.run);
          assert.deepEqual(command.subscription, subscription);
          assert(
            !acknowledgments.some(
              (ack) =>
                ack.command.requestId === command.requestId ||
                ack.command.appliedSeq === command.appliedSeq,
            ),
          );
          const physicalIds = [...rig.ledger.live.values()]
            .filter((owner) => owner.owner === "physical-delivery")
            .map((owner) => owner.id);
          const outcome = rig.recovery.command(command);
          acknowledgments.push({ command, outcome, priorSeq: previous.seq });
          capture("prior-handoff-ACK-result", { event, previous, command, outcome, physicalIds });
          assert.equal(outcome.result?.outcome, "accepted");
          assert.equal(outcome.result.requestId, command.requestId);
          assert.deepEqual(outcome.result.worker, worker);
          assert.deepEqual(outcome.result.run, subscription.run);
          assert(physicalIds.length > 0);
          assert(
            physicalIds.every((id) => rig.ledger.live.has(id)),
            "logical ACK does not retire actual physical backing",
          );
        }
        let charge;
        try {
          charge = originalEnqueue.call(rig.sink, event, payload, token);
        } catch (error) {
          capture("enqueue-throw", {
            event,
            token,
            error: { name: error.name, message: error.message },
          });
          throw error;
        }
        if (charge === false) {
          handoffs.push({ event, charge });
          capture("enqueue-false", { event, token });
          return charge;
        }
        const frame = rig.sink.frames.at(-1);
        const raw = Buffer.from(frame.rawHex, "hex");
        const decoded = decoder.read(raw);
        const metadata =
          decoded.frames[0] && JSON.parse(Buffer.from(decoded.frames[0].metadata).toString());
        const validated = decoded.frames[0] && validatePipeFrame(decoded.frames[0], metadata);
        const observed = {
          event,
          charge,
          rawHex: frame.rawHex,
          rawSHA256: createHash("sha256").update(raw).digest("hex"),
          rawBytes: raw.length,
          decodedStatus: decoded.status,
          decodedFrames: decoded.frames.length,
          metadata,
          validation: validated,
        };
        handoffs.push(observed);
        capture("enqueue-successful-real-handoff", observed);
        assert(charge > 0);
        assert.equal(charge, raw.length);
        assert.notEqual(decoded.status, "error");
        assert.equal(decoded.frames.length, 1);
        assert(validated.ok);
        assert.deepEqual(metadata, event);
        assert.equal(metadata.terminal.type, "output");
        previous = {
          seq: metadata.terminal.seq,
          rawSHA256: observed.rawSHA256,
          encodedBytes: charge,
        };
        return charge;
      };
      try {
        capture("effective-legal-budget");
        assert.equal(rig.effective.subscriptionCreditBytes, 262144);
        for (let seq = 1; seq <= countPlanned; seq++)
          source.replay.append({
            event: { type: "output", run: subscription.run, seq },
            bytes: new Uint8Array(payloadBytes).fill(65),
          });
        const command = rig.command("subscribe", subscription, { atSeq: 1 });
        const outcome = await rig.recovery.open(command, source);
        capture("accepted-open-before-marker", { command, outcome });
        rig.recovery.markerEnqueued(command, outcome.result);
        const firstTurn = [];
        let samplerOrdinal;
        setImmediate(() => {
          firstTurn.push(...rig.sink.frames);
          samplerOrdinal = capture("original-setImmediate-sampler", {
            frames: firstTurn.map((frame) => ({
              event: frame.event,
              encodedBytes: frame.encodedBytes,
              rawHex: frame.rawHex,
            })),
          }).ordinal;
        });
        await turns(1);
        const bytes = firstTurn.reduce((sum, frame) => sum + frame.encodedBytes, 0);
        capture("first-boundary-before-assertions", {
          samplerOrdinal,
          firstTurnFrames: firstTurn.length,
          bytes,
          handoffs,
          acknowledgments,
          independentlyExpected:
            payloadBytes === 1
              ? { frames: 32, bytes: 18168, nextCost: 568 }
              : { frames: 3, bytes: 198306, nextCost: 66102, crossingCost: 264408 },
          creditEligibility: {
            maximumLagCharge: 132206,
            credit: 262144,
            qualification:
              "source-bound inference from prior successful decoded handoff/accepted lag ACK and immutable commit seam; no direct logicalDebt or turn-branch trace",
          },
        });
        assert(firstTurn.length > 0);
        assert(firstTurn.length <= 32);
        assert(bytes <= 262144);
        const nextCost = encoded(
          {
            type: "terminal-event",
            worker,
            run: subscription.run,
            subscription,
            terminal: {
              type: "output",
              run: subscription.run,
              seq: firstTurn.at(-1).event.terminal.seq + 1,
            },
          },
          new Uint8Array(payloadBytes),
        ).length;
        capture("complete-next-frame-before-assertions", {
          samplerOrdinal,
          bytes,
          nextCost,
          handoffs,
          acknowledgments,
        });
        assert(firstTurn.length === 32 || bytes + nextCost > 262144);
        assert.deepEqual(
          firstTurn.map((frame) => frame.event.terminal.seq),
          Array.from({ length: firstTurn.length }, (_, index) => index + 2),
        );
        if (payloadBytes === 1) {
          assert.equal(firstTurn.length, 32);
          assert.equal(bytes, 18168);
          assert.equal(nextCost, 568);
        } else {
          assert.equal(firstTurn.length, 3);
          assert.equal(bytes, 198306);
          assert.equal(nextCost, 66102);
          assert.equal(bytes + nextCost, 264408);
        }
        assert(handoffs.every((handoff) => handoff.charge > 0));
        assert(!rig.ledger.events.some((event) => event.phase === "denied"));
        assert(rig.ledger.account.availableOrdinaryBytes() > 0);
        const count = rig.sink.frames.length;
        await turns(2);
        capture("original-later-turns-before-assertion", {
          originalTurns: 2,
          firstBoundaryCount: count,
          laterFrames: rig.sink.frames.map((frame) => ({
            event: frame.event,
            encodedBytes: frame.encodedBytes,
            rawHex: frame.rawHex,
          })),
          handoffs,
          acknowledgments,
        });
        assert(rig.sink.frames.length > count);
        record("W2C-R11", {
          semanticVariant,
          firstTurnFrames: firstTurn.length,
          bytes,
          nextCost,
          laterFrames: rig.sink.frames.length,
          samplerOrdinal,
          attribution: "source-bound inference, not direct internal branch trace",
          handoffs,
          acknowledgments,
          state: state(),
        });
      } catch (error) {
        bodyFailure = { name: error.name, message: error.message, stack: error.stack };
        capture("body-failure", { bodyFailure });
        throw error;
      } finally {
        rig.sink.enqueue = originalEnqueue;
        capture("cleanup-before", { bodyFailure });
        try {
          source.replay.clear();
          rig.close();
        } finally {
          capture("cleanup-after", { bodyFailure });
        }
      }
    }
  });
  it("W2C-R12 offline suffix order fifth-record and missing-progress controls fail", async () => {
    const observed = await captureSchedule("4e4f524d414c", "7c57322d5230332d5355464649587c");
    function check(trace) {
      assert.equal(trace.trigger, 1);
      assert.equal(trace.descriptor.atSeq, 2);
      assert.deepEqual(
        trace.suffix.map((frame) => [frame.event.terminal.type, frame.event.terminal.seq]),
        [
          ["output", 3],
          ["resize", 4],
          ["exit", 5],
        ],
      );
      assert.equal(trace.occupancy.parkedRequests, 1);
      assert.equal(trace.occupancy.outstandingRequests - trace.occupancy.parkedRequests, 4);
      assert.equal(trace.occupancy.outstandingRequests, 5);
      assert(trace.laterReplies.length === 5);
      assert.equal(trace.failure.failure, "RECOVERY_UNAVAILABLE");
      assert.equal(trace.tableAcquisitions, 0);
    }
    const endpoint = await combinedEndpointSchedule();
    const rig = recoveryRig();
    const route = ref("offline-invalid");
    let failure;
    try {
      failure = await rig.recovery.open(
        rig.command("subscribe", route, { atSeq: 0 }),
        rig.source(route.run, {
          mutate(baseline) {
            baseline.captureGeometry.cols = 121;
          },
        }),
      );
    } finally {
      rig.close();
    }
    const untouched = {
      ...observed,
      occupancy: endpoint.first,
      laterReplies: endpoint.replies,
      failure,
      tableAcquisitions: rig.ledger.events.filter(
        (event) => event.phase === "acquire" && event.owner === "recovery-transfer-frames",
      ).length,
    };
    record("W2C-R12-before-check", { label: "untouched", trace: untouched });
    check(untouched);
    record("W2C-R12-check-passed", { label: "untouched" });
    const duplicate = structuredClone(untouched);
    duplicate.suffix.push(duplicate.suffix[0]);
    record("W2C-R12-before-check", { label: "duplicate suffix", trace: duplicate });
    assert.throws(() => check(duplicate));
    record("W2C-R12-check-passed", { label: "duplicate suffix rejected" });
    const reordered = structuredClone(untouched);
    reordered.suffix.reverse();
    record("W2C-R12-before-check", { label: "reordered suffix", trace: reordered });
    assert.throws(() => check(reordered));
    record("W2C-R12-check-passed", { label: "reordered suffix rejected" });
    const fifthAdmitted = {
      ...untouched,
      occupancy: { ...untouched.occupancy, outstandingRequests: 6 },
    };
    record("W2C-R12-before-check", { label: "fifth admitted record", trace: fifthAdmitted });
    assert.throws(() => check(fifthAdmitted));
    record("W2C-R12-check-passed", { label: "fifth admitted record rejected" });
    const missingProgress = { ...untouched, laterReplies: [] };
    record("W2C-R12-before-check", { label: "missing later progress", trace: missingProgress });
    assert.throws(() => check(missingProgress));
    record("W2C-R12-check-passed", { label: "missing later progress rejected" });
    const wrongBoundary = { ...untouched, failure: { failure: "INPUT_REJECTED" } };
    record("W2C-R12-before-check", { label: "wrong boundary", trace: wrongBoundary });
    assert.throws(() => check(wrongBoundary));
    record("W2C-R12-check-passed", { label: "wrong boundary rejected" });
    record("W2C-R12", {
      untouched,
      mutationsRejected: [
        "duplicate suffix",
        "reordered suffix",
        "fifth record",
        "missing later progress",
        "wrong boundary",
      ],
    });
  });
  it("W2C-R13 parked route request ID conflicts before ordinary admission and once settlement", async () => {
    const target = run("parked-id-conflict");
    const subscription = ref("parked-id-conflict", target);
    const blockerId = "w2c-r13-blocker";
    const parkedId = "w2c-r13-X";
    const validId = "w2c-r13-valid";
    const gate = deferred();
    const executionEvents = [];
    const writeEvents = [];
    const callbackCounts = new Map();
    let ordinal = 0;
    let nextWriteTicket = 0;
    let realCloses = 0;
    let rig;
    let closedReceipt;
    const capture = (phase, value = {}) =>
      record("W2C-R13", {
        ordinal: ++ordinal,
        phase,
        ...value,
        pipe: rig?.pipe.snapshot(),
        worker: rig?.execution?.snapshot(),
        native: rig?.native.snapshot(),
        nativeReceipts: rig?.native.receipts,
        callbacksHeld: rig?.callbacks.length,
        realCloses,
        closedReceipt,
        output: rig && {
          writableLength: rig.output.writableLength,
          writableNeedDrain: rig.output.writableNeedDrain,
          closed: rig.output.closed,
        },
        resizeCalls: rig?.native.owners.map((owner) => owner.resizeCalls),
        executionEvents,
        writeEvents,
        callbackCounts: [...callbackCounts],
        frames: rig?.frames,
      });
    rig = endpointRig(
      { pendingWorkerCommands: 1, reservedControlBytes: 4112, pipeQueuedBytes: 69648 },
      {
        outputHighWaterMark: 69648,
        executeReturnGate: { requestId: blockerId, promise: gate.promise },
        executionObserver(event) {
          executionEvents.push(event);
          capture("actual-execution-event", { event });
        },
      },
    );
    rig.output.on("close", () => {
      realCloses++;
      capture("actual-output-close");
    });
    rig.pipe.closed.then((value) => {
      closedReceipt = value;
      capture("actual-pipe-closed", { value });
    });
    const originalIngressWrite = rig.input.write;
    rig.input.write = function (...args) {
      const raw = args[0];
      const input = {
        rawHex: Buffer.from(raw).toString("hex"),
        bytes: raw.byteLength,
        sha256: createHash("sha256").update(raw).digest("hex"),
        args: args.map((arg) =>
          typeof arg === "function"
            ? { kind: "actual-callback" }
            : ArrayBuffer.isView(arg)
              ? { rawHex: Buffer.from(arg).toString("hex") }
              : arg,
        ),
        sameReceiver: this === rig.input,
      };
      capture("actual-ingress-write-before", input);
      try {
        const accepted = originalIngressWrite.apply(this, args);
        capture("actual-ingress-write-return", { ...input, accepted });
        return accepted;
      } catch (error) {
        capture("actual-ingress-write-throw", {
          ...input,
          error: { name: error.name, message: error.message, stack: error.stack },
        });
        throw error;
      }
    };
    const originalWrite = rig.output.write;
    rig.output.write = function (raw, callback) {
      const ticket = ++nextWriteTicket;
      callbackCounts.set(ticket, 0);
      const observed = (...args) => {
        callbackCounts.set(ticket, callbackCounts.get(ticket) + 1);
        capture("actual-write-callback-before", { ticket, args });
        try {
          return callback(...args);
        } finally {
          capture("actual-write-callback-after", { ticket });
        }
      };
      const accepted = originalWrite.call(this, raw, observed);
      writeEvents.push({
        ticket,
        accepted,
        rawHex: Buffer.from(raw).toString("hex"),
        bytes: raw.byteLength,
      });
      capture("actual-write-return", { ticket, accepted });
      return accepted;
    };
    const send = (command) => {
      const raw = encoded(command, undefined, 1);
      capture("input-before", {
        command,
        rawHex: Buffer.from(raw).toString("hex"),
        bytes: raw.length,
      });
      rig.input.write(raw);
      capture("input-after", { command });
    };
    const calls = (command) =>
      executionEvents.filter(
        (event) =>
          event.method === "execute" &&
          event.phase === "before" &&
          event.args[0].requestId === command.requestId &&
          event.args[0].type === command.type,
      );
    try {
      await pipeSpawn(rig, target);
      const installed = await pipeInstall(rig, subscription);
      capture("installed-before-assert", { installed });
      assert.equal(installed.result.atSeq, 0, "fixed empty-seed installation sequence");
      await untilTurn(
        () =>
          rig.pipe.snapshot().outstandingRequests === 0 &&
          rig.pipe.snapshot().responseItems === 0 &&
          !rig.pipe.snapshot().blocked,
        "R13 setup physical completion",
      );
      const blocker = {
        type: "applied-ack",
        worker,
        run: target,
        requestId: blockerId,
        subscription,
        appliedSeq: 0,
      };
      const parked = { ...blocker, requestId: parkedId };
      const ordinary = {
        type: "set-control",
        worker,
        run: target,
        requestId: parkedId,
        expectedEpoch: 0,
        nextEpoch: 1,
        holder: {
          connection: subscription.connection,
          viewId: subscription.viewId,
          subscriptionId: subscription.subscriptionId,
        },
        geometry: { cols: 13, rows: 4 },
      };
      const valid = { ...ordinary, requestId: validId };
      rig.hold();
      send(blocker);
      await untilTurn(
        () =>
          executionEvents.some(
            (event) => event.phase === "gate-enter" && event.args[0].requestId === blockerId,
          ),
        "R13 genuine route execute-return hold",
      );
      capture("blocker-held-before-assert", { blocker });
      assert.equal(calls(blocker).length, 1);
      assert.equal(
        executionEvents.find(
          (event) => event.phase === "gate-enter" && event.args[0].requestId === blockerId,
        ).result.outcome,
        "accepted",
      );
      assert.equal(rig.frames.filter((frame) => frame.metadata.requestId === blockerId).length, 0);
      assert.equal(rig.pipe.snapshot().pendingCommands, 1);
      send(parked);
      await untilTurn(
        () =>
          rig.input.writableLength === 0 &&
          rig.pipe.snapshot().ingressBytes > 0 &&
          !rig.pipe.snapshot().blocked,
        "R13 consumed complete parked route bytes",
      );
      capture("parked-before-assert", { parked });
      assert.equal(calls(parked).length, 0);
      assert.equal(rig.frames.filter((frame) => frame.metadata.requestId === parkedId).length, 0);
      assert.equal(rig.pipe.snapshot().parkedRequests, 1);
      assert.equal(rig.pipe.snapshot().outstandingRequests, 2);
      assert.equal(rig.pipe.snapshot().pendingCommands, 1);
      assert.equal(calls(ordinary).length, 0);
      gate.resolve();
      await untilTurn(
        () =>
          rig.frames.some((frame) => frame.metadata.requestId === blockerId) &&
          rig.callbacks.length === 1 &&
          rig.pipe.snapshot().pendingCommands === 0 &&
          rig.pipe.snapshot().parkedRequests === 1 &&
          rig.pipe.snapshot().outstandingRequests === 2 &&
          rig.pipe.snapshot().responseItems === 1 &&
          !rig.pipe.snapshot().blocked &&
          !rig.output.writableNeedDrain,
        "R13 real blocker handoff with physical callback held",
      );
      const blockerFrame = rig.frames.find((frame) => frame.metadata.requestId === blockerId);
      const blockerTicket = writeEvents.find((event) => event.rawHex === blockerFrame.rawHex);
      const blockerCallback = rig.callbacks[0];
      capture("blocker-handoff-before-assert", { blockerFrame, blockerTicket });
      assert.deepEqual(
        blockerFrame.metadata,
        executionEvents.find(
          (event) => event.phase === "gate-enter" && event.args[0].requestId === blockerId,
        ).result,
      );
      assert.equal(Buffer.from(blockerFrame.rawHex, "hex").length, 336);
      assert.equal(blockerTicket.bytes, 336);
      assert.equal(callbackCounts.get(blockerTicket.ticket), 0);
      assert.equal(rig.pipe.snapshot().transportBytes, 336);
      send(ordinary);
      await untilTurn(
        () => rig.pipe.snapshot().responseItems === 2,
        "R13 two real response items within control budget",
      );
      const ownership = rig.pipe.snapshot();
      const unsettledWrites = writeEvents.filter((event) => callbackCounts.get(event.ticket) === 0);
      capture("conflict-enqueued-before-assert", {
        blockerFrame,
        blockerTicket,
        ownership,
        unsettledWrites,
      });
      assert.equal(rig.callbacks.length, 1);
      assert.equal(rig.callbacks[0], blockerCallback);
      assert.equal(rig.pipe.snapshot().pendingCommands, 0);
      assert.equal(rig.pipe.snapshot().parkedRequests, 1);
      assert.equal(rig.pipe.snapshot().outstandingRequests, 2);
      assert.equal(rig.pipe.snapshot().state, "ready");
      assert.equal(rig.pipe.snapshot().blocked, false);
      assert.equal(ownership.transportBytes + ownership.queuedBytes, 780);
      assert(
        ownership.transportBytes + ownership.queuedBytes <= rig.effective.reservedControlBytes,
      );
      assert.equal(ownership.ordinaryAccountedBytes, 0);
      assert(
        ownership.ordinaryAccountedBytes <=
          rig.effective.pipeQueuedBytes - rig.effective.reservedControlBytes,
      );
      assert.equal(unsettledWrites.length, 2);
      assert.equal(unsettledWrites[0], blockerTicket);
      assert.deepEqual(
        unsettledWrites.map((event) => event.bytes),
        [336, 444],
      );
      assert(unsettledWrites.every((event) => event.accepted === true));
      assert.equal(
        unsettledWrites.reduce((sum, event) => sum + event.bytes, 0),
        780,
      );
      capture("blocker-release-before", { ticket: blockerTicket.ticket });
      rig.release();
      capture("blocker-release-after", { ticket: blockerTicket.ticket });

      await untilTurn(
        () =>
          rig.frames.some(
            (frame) => frame.metadata.requestId === parkedId && frame.metadata.type === "error",
          ),
        "R13 actual duplicate conflict reply",
      );
      capture("duplicate-before-assert", { ordinary });
      const duplicate = rig.frames.filter(
        (frame) => frame.metadata.requestId === parkedId && frame.metadata.type === "error",
      );
      assert.equal(duplicate.length, 1);
      assert.deepEqual(duplicate[0].metadata, {
        type: "error",
        worker,
        run: target,
        requestId: parkedId,
        commandType: "set-control",
        error: {
          kind: "OPERATION_ID_CONFLICT",
          code: 1015,
          message: "OPERATION ID CONFLICT",
          acceptance: "not-accepted",
          nextAction: "query-operation",
        },
      });
      assert.equal(calls(ordinary).length, 0);
      assert.deepEqual(rig.native.owners[0].resizeCalls, []);
      assert.equal(rig.pipe.snapshot().state, "ready");
      assert.equal(rig.pipe.snapshot().blocked, false);
      assert.equal(rig.output.writableNeedDrain, false);
      assert.equal(rig.callbacks.length, 1);
      assert(writeEvents.every((event) => event.accepted === true));
      assert(rig.pipe.snapshot().transportBytes > 0);
      send(valid);
      await untilTurn(
        () =>
          executionEvents.some(
            (event) =>
              event.method === "execute" &&
              event.phase === "returned" &&
              event.args[0].requestId === validId,
          ),
        "R13 distinct ID ordinary actual execution",
      );
      capture("valid-counterpart-before-assert", { valid });
      const validReturn = executionEvents.find(
        (event) =>
          event.method === "execute" &&
          event.phase === "returned" &&
          event.args[0].requestId === validId,
      );
      assert.equal(calls(valid).length, 1);
      assert.equal(validReturn.result.outcome, "accepted");
      assert.deepEqual(rig.native.owners[0].resizeCalls, [{ cols: 13, rows: 4 }]);
      rig.hold(false);
      rig.release();
      await untilTurn(
        () =>
          rig.pipe.snapshot().outstandingRequests === 0 &&
          rig.pipe.snapshot().pendingCommands === 0 &&
          rig.pipe.snapshot().responseItems === 0 &&
          rig.callbacks.length === 0 &&
          rig.pipe.snapshot().transportBytes === 0 &&
          rig.pipe.snapshot().queuedBytes === 0 &&
          rig.pipe.snapshot().ingressBytes === 0,
        "R13 genuine callbacks and endpoint retirement",
      );
      capture("settled-before-assert", { blocker, parked, ordinary, valid });
      for (const command of [blocker, parked, valid]) {
        const replies = rig.frames.filter(
          (frame) =>
            frame.metadata.requestId === command.requestId && frame.metadata.type === "result",
        );
        assert.equal(replies.length, 1);
        assert.equal(replies[0].metadata.commandType, command.type);
        assert.equal(replies[0].metadata.outcome, "accepted");
        assert.deepEqual(replies[0].metadata.worker, worker);
        assert.deepEqual(replies[0].metadata.run, target);
        assert.equal(calls(command).length, 1);
        assert.equal(
          executionEvents.filter(
            (event) =>
              event.method === "markerEnqueued" &&
              event.phase === "before" &&
              event.args[0].requestId === command.requestId,
          ).length,
          1,
        );
        assert.equal(
          executionEvents.filter(
            (event) =>
              event.method === "responseSettled" &&
              event.phase === "before" &&
              event.args[0] === command.requestId,
          ).length,
          1,
        );
      }
      assert.equal(calls(ordinary).length, 0);
      assert.equal(rig.frames.filter((frame) => frame.metadata.requestId === parkedId).length, 2);
      assert.equal(
        rig.pipe.snapshot().ordinaryAccountedBytes,
        0,
        "no reserved reply-byte leak before shutdown",
      );
      assert(rig.pipe.snapshot().peakAccountedBytes <= 69648);
      assert([...callbackCounts.values()].every((count) => count === 1));
    } catch (error) {
      capture("first-body-failure", {
        error: { name: error.name, message: error.message, stack: error.stack },
      });
      throw error;
    } finally {
      gate.resolve();
      capture("finally-before-close");
      try {
        await rig.close();
        await untilTurn(() => realCloses === 1, "R13 genuine physical close");
        capture("finally-after-close");
      } finally {
        rig.input.write = originalIngressWrite;
        rig.output.write = originalWrite;
      }
    }
  });
});
