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
  const rig = endpointRig({
    pendingWorkerCommands: 1,
    reservedControlBytes: 4112,
    pipeQueuedBytes: 69648,
  });
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
    rig.input.write(
      Buffer.concat(commands.map((command) => Buffer.from(encoded(command, undefined, 1)))),
    );
    await untilTurn(() => rig.callbacks.length === 1, "combined physical callback");
    const first = rig.pipe.snapshot();
    assert.equal(first.outstandingRequests, 4);
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
      assert(snapshot.outstandingRequests <= 4);
      assert(snapshot.ordinaryAccountedBytes <= 65536);
      assert(snapshot.transportBytes + snapshot.queuedBytes <= 69648);
    }
    const replies = commands.map(
      (command) =>
        rig.frames.find((frame) => frame.metadata.requestId === command.requestId).metadata,
    );
    assert.equal(new Set(replies.map((reply) => reply.requestId)).size, 5);
    return { commands, first, observations, replies, frames: rig.frames };
  } finally {
    await rig.close();
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
    const rig = endpointRig();
    const target = run("reader-reentry");
    const subscription = ref("reader", target);
    const reentry = [];
    try {
      await pipeSpawn(rig, target);
      rig.hold();
      rig.reader((metadata) => {
        if (metadata.terminal?.type === "baseline-chunk") {
          assert(rig.pipe.snapshot().transportBytes > 0);
          const progress = pipeCommand("baseline-progress", target, {
            subscription,
            baselineId: metadata.terminal.baselineId,
            lastParsedOrdinal: metadata.terminal.ordinal,
          });
          reentry.push(progress.requestId);
          rig.send(progress);
        }
        if (metadata.terminal?.type === "baseline-end") {
          const ack = pipeCommand("applied-ack", target, {
            subscription,
            appliedSeq: metadata.terminal.atSeq,
          });
          reentry.push(ack.requestId);
          rig.send(ack);
        }
      });
      const command = pipeCommand("subscribe", target, { subscription, atSeq: 0 });
      rig.send(command);
      await drainHeld(
        rig,
        () =>
          reentry.length >= 2 &&
          reentry.every((id) => rig.frames.some((frame) => frame.metadata.requestId === id)),
      );
      const marker = rig.frames.findIndex(
        (frame) => frame.metadata.requestId === command.requestId,
      );
      const start = rig.frames.findIndex(
        (frame) => frame.metadata.terminal?.type === "baseline-start",
      );
      assert(marker < start);
      const before = rig.pipe.snapshot();
      assert(before.transportBytes > 0);
      rig.release();
      const callbackOnly = rig.pipe.snapshot();
      assert(callbackOnly.blocked);
      rig.output.emit("drain");
      await turns();
      assert.equal(
        rig.frames.filter((frame) => frame.metadata.terminal?.type === "baseline-chunk").length,
        1,
      );
      rig.reader(undefined);
      rig.hold(false);
      await drainHeld(rig, () => rig.callbacks.length === 0);
      const valid = await pipeResult(
        rig,
        pipeCommand("applied-ack", target, { subscription, appliedSeq: 0 }),
      );
      assert.equal(valid.outcome, "accepted");
      const unsubscribe = await pipeResult(
        rig,
        pipeCommand("unsubscribe", target, { subscription }),
      );
      assert.equal(unsubscribe.outcome, "accepted");
      record("W2C-R07", { reentry, before, callbackOnly, frames: rig.frames });
    } finally {
      rig.reader(undefined);
      await rig.close();
    }
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
    const rig = recoveryRig();
    const subscription = ref("max");
    const source = rig.source(subscription.run, { vtBytes: 8388608, tailBytes: 65536 });
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
    } finally {
      source.replay.clear();
      rig.close();
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
      } finally {
        sourceSmall.replay.clear();
        small.close();
        assert.equal(small.ledger.live.size, 0);
        assert.equal(small.ledger.account.snapshot().accountedBytes, 4112);
      }
    }
    for (const variant of ["descriptor-field", "VT", "tail", "total"]) {
      const bad = recoveryRig();
      const route = ref(`bad-${variant}`);
      try {
        const vtBytes = variant === "VT" ? 8388609 : variant === "total" ? 8388608 : 1;
        const tailBytes = variant === "tail" || variant === "total" ? 65537 : 0;
        const sourceBad = bad.source(route.run, {
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
      } finally {
        bad.close();
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
      const rig = recoveryRig({ subscriptionCreditBytes: 1048576 });
      const source = rig.source();
      const subscription = ref();
      try {
        for (let seq = 1; seq <= (payloadBytes === 1 ? 40 : 12); seq++)
          source.replay.append({
            event: { type: "output", run: subscription.run, seq },
            bytes: new Uint8Array(payloadBytes).fill(65),
          });
        const command = rig.command("subscribe", subscription, { atSeq: 1 });
        const outcome = await rig.recovery.open(command, source);
        rig.recovery.markerEnqueued(command, outcome.result);
        const firstTurn = [];
        setImmediate(() => firstTurn.push(...rig.sink.frames));
        await turns(1);
        const bytes = firstTurn.reduce((sum, frame) => sum + frame.encodedBytes, 0);
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
        assert(firstTurn.length === 32 || bytes + nextCost > 262144);
        const count = rig.sink.frames.length;
        await turns(2);
        assert(rig.sink.frames.length > count);
        record("W2C-R11", {
          semanticVariant: payloadBytes === 1 ? "frame-cap" : "byte-cap",
          firstTurnFrames: firstTurn.length,
          bytes,
          nextCost,
          laterFrames: rig.sink.frames.length,
        });
      } finally {
        source.replay.clear();
        rig.close();
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
      assert.equal(trace.occupancy.outstandingRequests, 4);
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
    check(untouched);
    const duplicate = structuredClone(untouched);
    duplicate.suffix.push(duplicate.suffix[0]);
    assert.throws(() => check(duplicate));
    const reordered = structuredClone(untouched);
    reordered.suffix.reverse();
    assert.throws(() => check(reordered));
    assert.throws(() =>
      check({ ...untouched, occupancy: { ...untouched.occupancy, outstandingRequests: 5 } }),
    );
    assert.throws(() => check({ ...untouched, laterReplies: [] }));
    assert.throws(() => check({ ...untouched, failure: { failure: "INPUT_REJECTED" } }));
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
});
