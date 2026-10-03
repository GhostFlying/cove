import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PreviewService } from "../../dist/src/preview-service.js";
import {
  budgets,
  clock,
  deferred,
  delivery,
  executionRig,
  receipts,
  recoveryRig,
  record,
  run,
  turns,
  utf8,
  worker,
} from "./current-recovery-ports.mjs";

const ready = (atSeq = 1, text = "W2-PREVIEW") => ({
  status: "ready",
  preview: {
    atSeq,
    geometry: { cols: 12, rows: 4 },
    vt: utf8(text),
  },
});
function previewRig(patch = {}, scheduler) {
  const effective = budgets(patch);
  const ledger = receipts(effective.workerBytes, effective.reservedControlBytes);
  const sink = delivery(ledger);
  const time = clock();
  let next = 0;
  const service = new PreviewService(
    worker,
    effective,
    ledger.reserve,
    sink,
    scheduler ?? ((_runId, operation) => operation()),
    time,
  );
  const command = (target = run(), fields = {}) => ({
    type: "preview-refresh",
    worker,
    run: target,
    requestId: `preview-current-${++next}`,
    ...fields,
  });
  return {
    effective,
    ledger,
    sink,
    time,
    service,
    command,
    close() {
      service.shutdown();
      sink.close();
    },
  };
}

describe("W2 current preview", () => {
  it("W2C-P01 no-subscription changed and validated equal preview preserve exact bytes", async () => {
    const rig = executionRig();
    const target = run("preview-real");
    try {
      await rig.spawn(target);
      rig.native.owners[0].emit(utf8("W2-P01"));
      await turns();
      const before = rig.execution.snapshot();
      const result = await rig.execute(rig.command("preview-refresh", target));
      assert.equal(result.outcome, "accepted");
      assert.equal(result.previewVersion, 1);
      const frames = rig.sink.frames.filter((frame) =>
        frame.event.terminal.type.startsWith("preview-"),
      );
      assert.deepEqual(
        frames.map((frame) => frame.event.terminal.type),
        ["preview-start", "preview-chunk", "preview-end"],
      );
      assert.equal(frames[0].event.terminal.vtBytes, frames[1].payload.length);
      assert.equal(frames[2].event.terminal.totalBytes, frames[1].payload.length);
      assert(new TextDecoder().decode(frames[1].payload).includes("W2-P01"));
      assert.equal(rig.execution.snapshot().inputIdentities, before.inputIdentities);
      const equal = await rig.execute(rig.command("preview-refresh", target, { knownVersion: 1 }));
      assert.equal(equal.outcome, "accepted");
      assert.equal(equal.previewVersion, 1);
      assert.equal(rig.sink.frames.length, frames.length);
      record("W2C-P01", {
        result,
        equal,
        frames: frames.map(({ event, rawHex }) => ({ event, rawHex })),
        state: rig.execution.snapshot(),
      });
    } finally {
      await rig.close();
    }
  });
  it("W2C-P02 unavailable rejection and version-ahead remain distinct from unchanged", async () => {
    const rig = previewRig();
    try {
      assert.equal(
        (
          await rig.service.refresh(rig.command(), run(), async () => ({
            status: "unavailable",
            reason: "controlled",
          }))
        ).failure,
        "RECOVERY_UNAVAILABLE",
      );
      assert.equal(
        (
          await rig.service.refresh(rig.command(), run(), async () => {
            throw Error("controlled");
          })
        ).failure,
        "RECOVERY_UNAVAILABLE",
      );
      assert.equal(
        (
          await rig.service.refresh(rig.command(run(), { knownVersion: 2 }), run(), async () =>
            ready(),
          )
        ).failure,
        "RESYNC_REQUIRED",
      );
      assert.equal(rig.sink.frames.length, 0);
      const equal = await rig.service.refresh(
        rig.command(run(), { knownVersion: 1 }),
        run(),
        async () => ready(),
      );
      assert.equal(equal.result.previewVersion, 1);
      assert.equal(rig.sink.frames.length, 0);
      assert.equal(rig.ledger.account.snapshot().workerBytes, 0);
      record("W2C-P02", rig.ledger.events);
    } finally {
      rig.close();
    }
  });
  it("W2C-P03 capture blocked-send and throw deadlines retain first cause and late fences", async () => {
    for (const phase of ["capture", "blocked-send", "throw"]) {
      const rig = previewRig({ recoveryDeadlineMs: 1 });
      const gate = deferred();
      try {
        if (phase === "blocked-send") rig.sink.setBlocked(true);
        if (phase === "throw") rig.sink.throwAt(0);
        const pending = rig.service.refresh(rig.command(), run(), () =>
          phase === "capture" ? gate.promise : Promise.resolve(ready()),
        );
        await turns();
        rig.time.advance(0.5);
        await turns();
        if (phase !== "throw") {
          let finished = false;
          pending.then(() => {
            finished = true;
          });
          await turns();
          assert(!finished);
        }
        rig.time.advance(1);
        const result = await pending;
        assert.equal(result.failure, phase === "throw" ? "RESULT_UNKNOWN" : "RECOVERY_EXPIRED");
        const debt = rig.ledger.account.snapshot().workerBytes;
        if (phase === "capture") {
          assert(debt > 0);
          gate.resolve(ready());
          await turns();
        }
        rig.sink.setBlocked(false);
        rig.service.capacity();
        await turns();
        assert.equal(rig.sink.frames.length, 0);
        assert.equal(rig.ledger.account.snapshot().workerBytes, 0);
        record("W2C-P03", {
          semanticVariant: phase,
          result,
          debt,
          events: rig.ledger.events,
          clock: rig.time.snapshot(),
        });
      } finally {
        gate.resolve(ready());
        rig.close();
      }
    }
  });
  it("W2C-P04 four jobs two captures and same-run plus-one admission remain bounded", async () => {
    const scheduler = recoveryRig();
    const rig = previewRig({}, (id, operation) => scheduler.recovery.capture(id, operation));
    const gates = Array.from({ length: 4 }, () => deferred());
    let running = 0;
    let peak = 0;
    try {
      const work = gates.map((gate, index) =>
        rig.service.refresh(rig.command(run(`p${index}`)), run(`p${index}`), async () => {
          running++;
          peak = Math.max(peak, running);
          try {
            return await gate.promise;
          } finally {
            running--;
          }
        }),
      );
      await turns();
      assert.equal(running, 2);
      assert.equal(
        (await rig.service.refresh(rig.command(run("p0")), run("p0"), async () => ready())).failure,
        "BUSY",
      );
      assert.equal(
        (await rig.service.refresh(rig.command(run("p4")), run("p4"), async () => ready())).failure,
        "BUSY",
      );
      gates[0].resolve(ready());
      await turns();
      gates[1].resolve(ready());
      await turns();
      gates[2].resolve(ready());
      gates[3].resolve(ready());
      for (const result of await Promise.all(work)) assert.equal(result.result.outcome, "accepted");
      assert.equal(peak, 2);
      assert.equal(rig.sink.frames.length, 12);
      record("W2C-P04", {
        peak,
        acquisitions: rig.ledger.events.filter(
          (event) => event.phase === "acquire" && event.owner === "preview-transfer",
        ),
      });
    } finally {
      gates.forEach((gate) => gate.resolve(ready()));
      rig.close();
      scheduler.close();
    }
  });
  it("W2C-P05 expired unresolved owner blocks replacement until actual settlement", async () => {
    const rig = previewRig({ recoveryDeadlineMs: 1 });
    const gate = deferred();
    try {
      const pending = rig.service.refresh(rig.command(), run(), () => gate.promise);
      await turns();
      const owned = rig.ledger.account.snapshot().workerBytes;
      assert.equal(owned, rig.effective.previewBytesPerRun + 12288);
      rig.time.advance(1);
      assert.equal((await pending).failure, "RECOVERY_EXPIRED");
      assert.equal(rig.ledger.account.snapshot().workerBytes, owned);
      assert.equal(
        (await rig.service.refresh(rig.command(), run(), async () => ready())).failure,
        "BUSY",
      );
      gate.resolve(ready());
      await turns();
      assert.equal(rig.ledger.account.snapshot().workerBytes, 0);
      assert.equal(rig.sink.frames.length, 0);
      assert.equal(
        (await rig.service.refresh(rig.command(), run(), async () => ready())).result.outcome,
        "accepted",
      );
      record("W2C-P05", rig.ledger.events);
    } finally {
      gate.resolve(ready());
      rig.close();
    }
  });
  it("W2C-P06 preview result follows all admitted frames and cannot retract physical prefix", async () => {
    for (const fail of [false, true]) {
      const rig = previewRig({ recoveryDeadlineMs: 1 });
      const order = [];
      const enqueue = rig.sink.enqueue.bind(rig.sink);
      rig.sink.enqueue = (event, payload, token) => {
        if (rig.sink.frames.length === 1 && fail) return false;
        const result = enqueue(event, payload, token);
        if (result !== false) order.push(event.terminal.type);
        return result;
      };
      try {
        const pending = rig.service
          .refresh(rig.command(), run(), async () => ready())
          .then((result) => {
            order.push("result");
            return result;
          });
        await turns();
        const debt = rig.sink.physical
          .filter((frame) => !frame.settled)
          .reduce((sum, frame) => sum + frame.encodedBytes, 0);
        assert(debt > 0);
        if (fail) rig.time.advance(1);
        const result = await pending;
        assert.deepEqual(
          order,
          fail
            ? ["preview-start", "result"]
            : ["preview-start", "preview-chunk", "preview-end", "result"],
        );
        assert.equal(
          fail ? result.failure : result.result.outcome,
          fail ? "RECOVERY_EXPIRED" : "accepted",
        );
        assert.equal(rig.ledger.account.snapshot().workerBytes, debt);
        rig.service.shutdown();
        assert.equal(rig.ledger.account.snapshot().workerBytes, debt);
        rig.sink.close();
        assert.equal(rig.ledger.account.snapshot().workerBytes, 0);
        record("W2C-P06", {
          semanticVariant: fail ? "physical-prefix-expiry" : "result-last",
          order,
          debt,
          result,
        });
      } finally {
        rig.close();
      }
    }
  });
  it("W2C-P07 actual settled status distinguishes live unverifiable and exited", async () => {
    for (const uncertain of [false, true]) {
      const rig = executionRig({}, { stopUnverifiable: uncertain });
      const target = run(`status-${uncertain}`);
      try {
        await rig.spawn(target);
        const live = await rig.execute(rig.command("status", target));
        assert.equal(live.runStatus.status, "live");
        const stopped = await rig.execute(
          rig.command("stop", target, { operationId: `stop-${target.runId}` }),
        );
        const status = await rig.execute(rig.command("status", target));
        assert.equal(status.runStatus.status, uncertain ? "unverifiable" : "exited");
        record("W2C-P07", {
          semanticVariant: uncertain ? "contact-unverifiable" : "observed-exit",
          live,
          stopped,
          status,
        });
      } finally {
        await rig.close();
      }
    }
  });
});
