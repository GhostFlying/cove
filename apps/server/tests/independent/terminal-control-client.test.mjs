import { describe, expect, test } from "vitest";
import {
  binary,
  connectConsumer,
  deferred,
  geometry,
  holder,
  onceOracle,
  readyOracle,
  run,
  turns,
  withControl,
} from "./terminal-control-byte-harness.mjs";

async function consumer(r, c = r.primary) {
  const h = await connectConsumer(r, c);
  h.ref = await h.baseline();
  return h;
}
function assertReadiness(h, grant, applied, fact, expected) {
  readyOracle({
    installed: true,
    applied,
    grant,
    fact,
    inputReady: h.controller.snapshot().inputReady,
    inputWrites: h.uplink.filter((x) => x.metadata.type === "input").length,
  });
  expect(h.controller.snapshot().inputReady).toBe(expected);
}

describe("P2-B2 independent actual compiled public consumer", () => {
  test("B2-06 actual grant receipt and held view application cannot manufacture input readiness", async () =>
    withControl(async (r) => {
      const h = await consumer(r);
      expect(h.uplink.filter((x) => x.metadata.type === "focus")).toHaveLength(0);
      const granted = await h.focus({ apply: false });
      expect(granted.reply.ok).toBe(true);
      const grant = { epoch: granted.pipe.nextEpoch, atSeq: 11, holder: holder(h.ref) };
      assertReadiness(h, grant, 10, { epoch: 0, holder: null }, false);
      const queued = h.controller.sendInput({ source: "keyboard", bytes: binary });
      await turns();
      expect(r.count("input")).toBe(0);
      const gate = deferred();
      h.controlled.controls.event = gate;
      r.control(h.ref, 6, 11);
      await turns();
      expect(h.controller.snapshot().appliedSeq).toBe(10);
      assertReadiness(h, grant, 10, { epoch: 6, holder: holder(h.ref) }, false);
      gate.resolve();
      await h.drainAcks();
      await turns();
      const input = r.last("input");
      r.accept(input, { inputSeq: input.inputSeq, writtenBytes: 9 });
      expect((await queued).ok).toBe(true);
      assertReadiness(h, grant, 11, { epoch: 6, holder: holder(h.ref) }, true);
      const snapshot = h.controller.snapshot();
      expect(snapshot.run).toEqual(run);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot.appliedAuthority).toMatchObject({
        epoch: 6,
        holder: holder(h.ref),
        atSeq: 11,
      });
      expect(snapshot.appliedGeometry).toMatchObject({ geometry, atSeq: 11 });
    }));

  test.each([9, 4])(
    "B2-08 actual server written receipt %s produces exact public partition and notice",
    async (written) =>
      withControl(async (r) => {
        const h = await consumer(r);
        await h.focus();
        expect(h.controller.snapshot().inputReady).toBe(true);
        const notices = [];
        h.controller.onInputOutcome((n) => notices.push(n));
        const pending = h.controller.sendInput({ source: "paste", bytes: binary });
        await turns();
        const command = r.last("input");
        expect([...r.inputFrames()[0].payload]).toEqual([...binary]);
        r.accept(command, { inputSeq: command.inputSeq, writtenBytes: written });
        const outcome = await pending;
        expect(outcome).toMatchObject({
          ok: written === 9,
          value: { writtenBytes: written, unknownBytes: 9 - written, notSentBytes: 0 },
        });
        expect(outcome).toMatchObject(
          written < 9
            ? {
                error: {
                  kind: "RESULT_UNKNOWN",
                  acceptance: "unknown",
                  subject: "input",
                  nextAction: "inspect-run",
                },
              }
            : { ok: true },
        );
        // Input notices are delivered by the controller's notifier on a later turn.
        await turns();
        expect(notices).toHaveLength(1);
        expect(notices[0].outcome).toEqual(outcome);
        expect(h.controller.snapshot()).toMatchObject({
          retainedInputBytes: 0,
          pendingInputIntents: 0,
        });
        onceOracle(
          r.inputFrames().map((x) => ({ identity: x.metadata.requestId })),
          command.requestId,
        );
      }),
  );

  test("B2-08 unknown actual pipe handoff remains input uncertainty and has no recovery replay", async () =>
    withControl(async (r) => {
      const h = await consumer(r);
      await h.focus();
      const notices = [];
      h.controller.onInputOutcome((n) => notices.push(n));
      const p = h.controller.sendInput({ source: "keyboard", bytes: binary });
      await turns();
      expect(r.count("input")).toBe(1);
      const command = r.last("input");
      r.advance(30_001);
      const result = await p;
      expect(result).toMatchObject({
        ok: false,
        value: { writtenBytes: 0, unknownBytes: 9, notSentBytes: 0 },
        error: {
          kind: "RESULT_UNKNOWN",
          acceptance: "unknown",
          subject: "input",
          nextAction: "inspect-run",
        },
      });
      // Input notices are delivered by the controller's notifier on a later turn.
      await turns();
      expect(notices).toHaveLength(1);
      expect(notices[0].outcome).toEqual(result);
      r.accept(command, { inputSeq: command.inputSeq, writtenBytes: 9 });
      r.advance(30_001);
      await turns();
      expect(notices).toHaveLength(1);
      expect(r.count("input")).toBe(1);
      const recover = h.controller.recover("expired");
      await turns();
      await recover;
      expect(r.count("input")).toBe(1);
    }));

  test("B2-12 two compiled clients apply focus handoff and stale blur cannot release newer holder", async () =>
    withControl(async (r) => {
      const a = await consumer(r),
        b = await consumer(r, r.addConnection());
      await a.focus();
      r.control(b.ref, 6, 11, geometry, holder(a.ref));
      await b.drainAcks();
      expect(a.controller.snapshot().inputReady).toBe(true);
      expect(b.controller.snapshot().inputReady).toBe(false);
      // The grid change reaches both subscriptions as resize 12 then control 13; each recovers
      // from a baseline that reports b as holder at epoch 7.
      const granted = await b.focus({ grid: { cols: 100, rows: 30 }, atSeq: 13 });
      await a.resizeRecovery({ cols: 100, rows: 30 }, 13, { epoch: 7, holder: holder(b.ref) });
      expect(granted.pipe).toMatchObject({
        expectedEpoch: 6,
        nextEpoch: 7,
        holder: holder(b.ref),
        geometry: { cols: 100, rows: 30 },
      });
      expect(b.controller.snapshot().inputReady).toBe(true);
      expect(a.controller.snapshot().inputReady).toBe(false);
      expect(a.controller.snapshot().appliedAuthority).toMatchObject({
        epoch: 7,
        holder: holder(b.ref),
        atSeq: 13,
      });
      expect(b.controller.snapshot().appliedGeometry).toMatchObject({
        geometry: { cols: 100, rows: 30 },
        atSeq: 13,
      });
      const before = r.count("set-control");
      await a.controller.blur();
      await turns();
      expect(r.count("set-control")).toBe(before);
      expect(r.arbiter.snapshot(run.runId).boundary.holder).toEqual(holder(b.ref));
      const denied = await a.controller.sendInput({ source: "keyboard", bytes: binary });
      expect(denied.ok).toBe(false);
      expect(r.count("input")).toBe(0);
    }));

  test("B2-06 newer applied foreign fact before delayed old grant stays fenced", async () =>
    withControl(async (r) => {
      const a = await consumer(r),
        b = await consumer(r, r.addConnection());
      a.controller.setInputTarget(true, true);
      const p = a.controller.requestFocus();
      await turns();
      r.status();
      await turns();
      const command = r.last("set-control");
      r.control(a.ref, 7, 11, geometry, holder(b.ref));
      await a.drainAcks();
      r.accept(command, { atSeq: 10 });
      const result = await p;
      expect(result.ok).toBe(false);
      expect(a.controller.snapshot().inputReady).toBe(false);
      expect(r.count("input")).toBe(0);
      expect(a.controller.snapshot().appliedAuthority).toMatchObject({
        epoch: 7,
        holder: holder(b.ref),
      });
    }));

  test("B2-12 stable-ref recover fences parse, preserves counters and never forwards query output", async () =>
    withControl(async (r) => {
      const h = await consumer(r);
      await h.focus();
      const ref = h.ref;
      const beforeFocus = r.count("set-control");
      r.session.receive(r.event(ref, { type: "output", run, seq: 12 }, binary));
      await h.drainAcks();
      expect(r.count("input")).toBe(0);
      expect(r.count("set-control")).toBe(beforeFocus);
      const p = h.controller.recover("expired");
      await turns();
      const command = r.last("recover");
      expect(command.subscription).toEqual(ref);
      expect(command.appliedSeq).toBe(12);
      r.accept(command, { recoveryMode: "replay", atSeq: 12 });
      expect((await p).ok).toBe(true);
      await h.drainAcks();
      expect(h.controller.snapshot().subscription).toEqual(ref);
      expect(r.count("input")).toBe(0);
      expect(r.count("set-control")).toBe(beforeFocus);
      await h.focus({ atSeq: 13 });
      const focusCommands = h.uplink.filter((x) => x.metadata.type === "focus");
      expect(focusCommands).toHaveLength(2);
      expect(focusCommands[1].metadata.focusSeq).toBeGreaterThan(
        focusCommands[0].metadata.focusSeq,
      );
      const pending = h.controller.sendInput({ source: "keyboard", bytes: binary });
      await turns();
      const input = r.last("input");
      r.accept(input, { inputSeq: input.inputSeq, writtenBytes: 9 });
      expect((await pending).ok).toBe(true);
      expect(r.count("input")).toBe(1);
    }));

  test("B2-12 watcher detach and held late parse leave current consumer ready", async () =>
    withControl(async (r) => {
      const a = await consumer(r),
        b = await consumer(r, r.addConnection());
      await a.focus();
      r.control(b.ref, 6, 11, geometry, holder(a.ref));
      await b.drainAcks();
      const gate = deferred();
      b.controlled.controls.event = gate;
      r.session.receive(r.event(b.ref, { type: "output", run, seq: 12 }, binary));
      await turns();
      const before = r.count("set-control");
      const p = b.controller.detach();
      await turns();
      const command = r.last("unsubscribe");
      expect(command.subscription).toEqual(b.ref);
      r.accept(command);
      expect((await p).ok).toBe(true);
      gate.resolve();
      await turns();
      expect(b.controller.snapshot().subscription).toBeUndefined();
      expect(b.controller.snapshot().inputReady).toBe(false);
      expect(a.controller.snapshot().inputReady).toBe(true);
      expect(r.count("set-control")).toBe(before);
      expect(r.count("stop")).toBe(0);
    }));
});
