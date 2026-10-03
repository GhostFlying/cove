import { describe, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import {
  backingOracle,
  binary,
  controlFixture,
  grantOracle,
  holder,
  onceOracle,
  readyOracle,
  releaseOracle,
  geometry,
  run,
  turns,
  withControl,
} from "./terminal-control-byte-harness.mjs";

const business = (r) =>
  r.commands.filter((x) =>
    ["set-control", "input", "resize", "appearance", "stop"].includes(x.type),
  );
const state = (r) => r.arbiter.snapshot(run.runId);
async function installedOperator(r, options = {}) {
  const c = r.primary,
    ref = await r.attach(c);
  const granted = await r.focus(c, ref, options);
  expect(granted.reply.type).toBe("focus-result");
  r.control(ref, granted.pipe.nextEpoch, options.atSeq ?? 11, options.grid ?? geometry);
  expect((await r.ack(c, ref, options.atSeq ?? 11)).type).toBe("applied-ack-result");
  return { c, ref, epoch: granted.pipe.nextEpoch, granted };
}
async function recover(r, c, ref, seq = 11) {
  const pending = c.service.handle(
    r.command("recover", ref, {
      reason: "expired",
      resume: {
        appliedSeq: seq,
        profile: "pragmatic-logical-grid-v1",
        encoding: "vt-checkpoint-tail-v1",
        geometry,
      },
    }),
  );
  await turns();
  r.accept(r.last("recover"), { recoveryMode: "replay", atSeq: seq });
  const reply = await pending;
  expect(reply.subscription).toEqual(ref);
  return reply;
}

describe("P2-B2 independent actual compiled control contracts", () => {
  test("B2-01 baseline final ACK is necessary for focus and input admission", async () =>
    withControl(async (r) => {
      const c = r.primary,
        ref = await r.attach(c, { mode: "baseline" });
      r.emitBaseline(ref);
      await turns();
      const before = business(r).length;
      for (const type of ["focus", "input"]) {
        const cmd = r.command(
          type,
          ref,
          type === "focus" ? { focusSeq: 1, geometry } : { inputSeq: 1, epoch: 6 },
        );
        const reply = await c.service.handle(cmd, type === "input" ? binary : new Uint8Array());
        expect(reply.type).toBe("error");
        expect(reply.error.acceptance).toBe("not-accepted");
      }
      expect(business(r)).toHaveLength(before);
      expect((await r.ack(c, ref, 10)).type).toBe("applied-ack-result");
      expect((await r.focus(c, ref)).reply.type).toBe("focus-result");
    }));

  test("B2-01 replay installed below accepted marker still refuses control", async () =>
    withControl(async (r) => {
      const c = r.primary,
        ref = await r.attach(c, { appliedSeq: 9, atSeq: 10 });
      const reply = await c.service.handle(r.command("focus", ref, { focusSeq: 1, geometry }));
      expect(reply.type).toBe("error");
      expect(r.count("set-control")).toBe(0);
      r.session.receive(r.event(ref, { type: "output", run, seq: 10 }, binary));
      expect((await r.ack(c, ref, 10)).type).toBe("applied-ack-result");
      expect((await r.focus(c, ref)).reply.type).toBe("focus-result");
    }));

  test.each([
    "serverId",
    "relayInstanceId",
    "runId",
    "connectionId",
    "generation",
    "viewId",
    "subscriptionId",
  ])("B2-01 each stale complete subscription field %s has no business effect", async (field) =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r);
      const stale = structuredClone(ref);
      if (field in stale.run) stale.run[field] += "-foreign";
      else if (field in stale.connection)
        stale.connection[field] = field === "generation" ? 2 : "foreign";
      else stale[field] = "foreign";
      const before = business(r).length,
        counters = state(r).counters;
      for (const type of ["focus", "blur", "input", "resize", "appearance"]) {
        const extra =
          type === "focus"
            ? { focusSeq: 2, geometry }
            : type === "input"
              ? { epoch, inputSeq: 1 }
              : type === "resize"
                ? { epoch, geometry }
                : type === "appearance"
                  ? { epoch, appearance: DEFAULT_APPEARANCE }
                  : { epoch };
        expect(
          (
            await c.service.handle(
              r.command(type, stale, extra),
              type === "input" ? binary : new Uint8Array(),
            )
          ).type,
        ).toBe("error");
      }
      expect(business(r)).toHaveLength(before);
      expect(state(r).counters).toBe(counters);
    }),
  );

  test.each(["workerId", "workerIncarnationId"])(
    "B2-01 foreign worker result %s cannot grant",
    async (field) =>
      withControl(async (r) => {
        const c = r.primary,
          ref = await r.attach(c);
        const p = c.service.handle(r.command("focus", ref, { focusSeq: 1, geometry }));
        await turns();
        r.status();
        await turns();
        const command = r.last("set-control");
        const result = r.result(command, { atSeq: 11 });
        result.worker = { ...result.worker, [field]: "foreign" };
        const { pipeFrame } = await import("./subscription-byte-harness.mjs");
        r.session.receive(pipeFrame(result));
        await turns();
        expect(c.transport.trace().some((x) => x.metadata.type === "focus-result")).toBe(false);
        expect(state(r).boundary.holder).toBeNull();
        r.advance(30_001);
        expect((await p).type).toBe("error");
      }),
  );

  test.each([false, true])(
    "B2-02 accepted focus order reversed=%s controls epoch and full holder",
    async (reverse) =>
      withControl(async (r) => {
        const a = r.primary,
          b = r.addConnection(),
          ar = await r.attach(a),
          br = await r.attach(b);
        const [first, second] = reverse
          ? [
              [b, br],
              [a, ar],
            ]
          : [
              [a, ar],
              [b, br],
            ];
        const firstExternal = r.command("focus", first[1], { focusSeq: 1, geometry });
        const p = first[0].service.handle(firstExternal);
        const q = second[0].service.handle(
          r.command("focus", second[1], { focusSeq: 1, geometry }),
        );
        await turns();
        expect(r.count("status")).toBe(1);
        expect(r.count("set-control")).toBe(0);
        r.status();
        await turns();
        const pc = r.last("set-control");
        expect(pc).toMatchObject({
          expectedEpoch: 5,
          nextEpoch: 6,
          holder: holder(first[1]),
          geometry,
        });
        expect(r.count("set-control")).toBe(1);
        r.accept(pc, { atSeq: 11 });
        const pr = await p;
        grantOracle(pr, { ...pc, requestId: firstExternal.requestId }, 10);
        await turns();
        const qc = r.last("set-control");
        expect(qc).toMatchObject({ expectedEpoch: 6, nextEpoch: 7, holder: holder(second[1]) });
        r.accept(qc, { atSeq: 12 });
        expect((await q).epoch).toBe(7);
        expect(r.count("resize")).toBe(0);
        expect(state(r).boundary.holder).toEqual(holder(second[1]));
      }),
  );

  test("B2-02 changed grid is one control command and implicit stimuli never focus", async () =>
    withControl(async (r) => {
      const c = r.primary,
        ref = await r.attach(c);
      expect(r.count("set-control")).toBe(0);
      r.session.receive(r.event(ref, { type: "output", run, seq: 11 }, binary));
      await r.ack(c, ref, 11);
      await recover(r, c, ref);
      expect(r.count("set-control")).toBe(0);
      const result = await r.focus(c, ref, {
        grid: { cols: 100, rows: 30 },
        appearance: DEFAULT_APPEARANCE,
        atSeq: 12,
      });
      expect(result.pipe.geometry).toEqual({ cols: 100, rows: 30 });
      expect(result.pipe.appearance).toEqual(DEFAULT_APPEARANCE);
      expect(r.count("set-control")).toBe(1);
      expect(r.count("resize")).toBe(0);
    }));

  test.each(["rejected", "unknown", "missing-atSeq"])(
    "B2-02 %s control outcome cannot publish grant",
    async (outcome) =>
      withControl(async (r) => {
        const c = r.primary,
          ref = await r.attach(c);
        const p = c.service.handle(r.command("focus", ref, { focusSeq: 1, geometry }));
        await turns();
        r.status();
        await turns();
        const pc = r.last("set-control");
        r.accept(pc, outcome === "missing-atSeq" ? {} : { outcome });
        const reply = await p;
        expect(reply.type).toBe("error");
        expect(c.transport.trace().some((x) => x.metadata.type === "focus-result")).toBe(false);
        expect(state(r).boundary.holder).toBeNull();
      }),
  );

  test.each([false, true])("B2-03 close pending focus with queued newer holder=%s", async (newer) =>
    withControl(async (r) => {
      const a = r.primary,
        ar = await r.attach(a),
        b = r.addConnection(),
        br = await r.attach(b);
      const p = a.service.handle(r.command("focus", ar, { focusSeq: 1, geometry }));
      await turns();
      r.status();
      await turns();
      const pc = r.last("set-control");
      const q = newer
        ? b.service.handle(
            r.command("focus", br, { focusSeq: 1, geometry: { cols: 100, rows: 30 } }),
          )
        : undefined;
      a.service.close();
      await turns();
      expect(r.commands.some((x) => x.type === "set-control" && x.holder === null)).toBe(false);
      r.accept(pc, { atSeq: 11 });
      expect((await p).type).toBe("error");
      await turns();
      expect(a.transport.trace().some((x) => x.metadata.type === "focus-result")).toBe(false);
      const next = r.last("set-control");
      expect(next.holder).toEqual(newer ? holder(br) : null);
      if (!newer)
        releaseOracle({ ...next, owner: holder(ar) }, { holder: holder(ar), epoch: 6, geometry });
      r.accept(next, { atSeq: 12 });
      const nextReply = q ? await q : undefined;
      expect(nextReply?.epoch).toBe(newer ? 7 : undefined);
      a.service.close();
      r.arbiter.retire(ar);
      r.arbiter.tick();
      await turns();
      expect(r.commands.filter((x) => x.type === "set-control" && x.holder === null)).toHaveLength(
        newer ? 0 : 1,
      );
      expect(state(r).boundary.holder).toEqual(newer ? holder(br) : null);
      expect(r.count("stop")).toBe(0);
    }),
  );

  test("B2-04 blur compares complete holder even at same epoch and preserves grid", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r, { grid: { cols: 100, rows: 30 } });
      const b = r.addConnection(),
        br = await r.attach(b),
        sameConnectionWatcher = await r.attach(c, { viewId: "b2-same-connection-watcher" });
      const before = r.count("set-control");
      for (const [conn, sub, value] of [
        [b, br, epoch],
        [c, sameConnectionWatcher, epoch],
        [c, ref, epoch - 1],
      ]) {
        expect((await conn.service.handle(r.command("blur", sub, { epoch: value }))).type).toBe(
          "error",
        );
      }
      expect(r.count("set-control")).toBe(before);
      const p = c.service.handle(r.command("blur", ref, { epoch }));
      await turns();
      const pc = r.last("set-control");
      releaseOracle(
        { ...pc, owner: holder(ref) },
        { holder: holder(ref), epoch, geometry: { cols: 100, rows: 30 } },
      );
      expect(pc.appearance).toBeUndefined();
      r.accept(pc, { atSeq: 12 });
      expect((await p).type).toBe("blur-result");
      expect(state(r).boundary.holder).toBeNull();
    }));

  test.each(["detach", "close"])(
    "B2-05 own versus watcher %s keeps PTY and no election",
    async (mode) =>
      withControl(async (r) => {
        const { c, ref, epoch } = await installedOperator(r);
        const b = r.addConnection(),
          br = await r.attach(b);
        const before = r.count("set-control");
        async function retire(connection, sub) {
          const p =
            mode === "detach" ? connection.service.handle(r.command("detach", sub)) : undefined;
          if (mode === "close") connection.service.close();
          await turns();
          const unsub = r.last("unsubscribe");
          expect(unsub.subscription).toEqual(sub);
          r.accept(unsub);
          const reply = p ? await p : undefined;
          expect(reply?.type).toBe(mode === "detach" ? "detach-result" : undefined);
          await turns();
        }
        await retire(b, br);
        expect(r.count("set-control")).toBe(before);
        expect(state(r).boundary.holder).toEqual(holder(ref));
        const input = c.service.handle(r.command("input", ref, { epoch, inputSeq: 1 }), binary);
        await turns();
        const pc = r.last("input");
        r.accept(pc, { inputSeq: 1, writtenBytes: 9 });
        expect((await input).writtenBytes).toBe(9);
        await retire(c, ref);
        const release = r.last("set-control");
        expect(release.holder).toBeNull();
        expect(release.expectedEpoch).toBe(epoch);
        r.accept(release, { atSeq: 12 });
        await turns();
        expect(state(r).boundary.holder).toBeNull();
        expect(r.count("stop")).toBe(0);
      }),
  );

  test("B2-07 current resize and appearance effects versus watcher stale and invalid", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r),
        b = r.addConnection(),
        br = await r.attach(b);
      for (const type of ["resize", "appearance"]) {
        const values =
          type === "resize"
            ? { geometry: { cols: 100, rows: 30 } }
            : { appearance: DEFAULT_APPEARANCE };
        const before = r.count(type);
        expect((await b.service.handle(r.command(type, br, { epoch, ...values }))).type).toBe(
          "error",
        );
        expect(
          (await c.service.handle(r.command(type, ref, { epoch: epoch - 1, ...values }))).type,
        ).toBe("error");
        const invalid =
          type === "resize"
            ? { geometry: { cols: 121, rows: 30 } }
            : { appearance: { palette: [{ index: 1, rgb: "bad" }] } };
        expect((await c.service.handle(r.command(type, ref, { epoch, ...invalid }))).type).toBe(
          "error",
        );
        expect(r.count(type)).toBe(before);
        const p = c.service.handle(r.command(type, ref, { epoch, ...values }));
        await turns();
        const pc = r.last(type);
        expect(pc.subscription).toEqual(ref);
        expect(pc.epoch).toBe(epoch);
        r.accept(pc, { atSeq: type === "resize" ? 12 : 13 });
        expect((await p).type).toBe(`${type}-result`);
        if (type === "resize") {
          r.session.receive(
            r.event(ref, {
              type: "resize",
              run,
              seq: 12,
              geometry: values.geometry,
              requiresBaseline: false,
            }),
          );
          await r.ack(c, ref, 12);
        }
      }
    }));

  test.each([9, 4, 10])(
    "B2-08 binary once preserves writtenBytes=%s bounds",
    async (writtenBytes) =>
      withControl(async (r) => {
        const { c, ref, epoch } = await installedOperator(r);
        const original = binary.slice();
        const p = c.service.handle(r.command("input", ref, { epoch, inputSeq: 1 }), original);
        original.fill(7);
        await turns();
        const frames = r.inputFrames();
        expect(frames).toHaveLength(1);
        expect([...frames[0].payload]).toEqual([...binary]);
        const pc = r.last("input");
        expect(pc).toMatchObject({ subscription: ref, epoch, inputSeq: 1 });
        r.accept(pc, { inputSeq: 1, writtenBytes });
        const reply = await p;
        const expected =
          writtenBytes > binary.length
            ? {
                type: "error",
                error: {
                  kind: "RESULT_UNKNOWN",
                  acceptance: "unknown",
                  subject: "input",
                  nextAction: "inspect-run",
                },
              }
            : { type: "input-result", writtenBytes, inputSeq: 1, epoch };
        expect(reply).toMatchObject(expected);
        onceOracle(
          r.inputFrames().map((x) => ({ identity: x.metadata.requestId })),
          pc.requestId,
        );
      }),
  );

  test.each(["timeout", "contact-loss"])(
    "B2-08 %s after handoff is unknown and never resent",
    async (loss) =>
      withControl(async (r) => {
        const { c, ref, epoch } = await installedOperator(r);
        const external = r.command("input", ref, { epoch, inputSeq: 1 });
        const p = c.service.handle(external, binary);
        await turns();
        expect(r.inputFrames()).toHaveLength(1);
        if (loss === "timeout") r.advance(30_001);
        else r.session.loseContact();
        expect(await p).toMatchObject({
          type: "error",
          error: {
            kind: "RESULT_UNKNOWN",
            acceptance: "unknown",
            subject: "input",
            nextAction: "inspect-run",
          },
        });
        r.advance(30_001);
        r.arbiter.tick();
        await c.service.handle({ ...external, requestId: r.requestId() }, binary);
        await c.service.handle(r.command("focus", ref, { focusSeq: 2, geometry }));
        c.service.close();
        await turns();
        expect(r.inputFrames()).toHaveLength(1);
      }),
  );

  test("B2-09 same-ref recover preserves attempted focus and input monotonic proof", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r, { focusSeq: 8 });
      const p = c.service.handle(r.command("input", ref, { epoch, inputSeq: 8 }), binary);
      await turns();
      r.accept(r.last("input"), { inputSeq: 8, writtenBytes: 9 });
      await p;
      await recover(r, c, ref);
      const before = business(r).length;
      for (const seq of [7, 8]) {
        expect(
          (await c.service.handle(r.command("focus", ref, { focusSeq: seq, geometry }))).type,
        ).toBe("error");
        expect(
          (await c.service.handle(r.command("input", ref, { epoch, inputSeq: seq }), binary)).type,
        ).toBe("error");
      }
      expect(business(r)).toHaveLength(before);
      expect((await r.focus(c, ref, { focusSeq: 9, atSeq: 12 })).reply.epoch).toBe(epoch + 1);
    }));

  test("B2-09 queued old-holder input is rechecked after earlier accepted B focus", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r);
      const b = r.addConnection(),
        br = await r.attach(b);
      const q = b.service.handle(r.command("focus", br, { focusSeq: 1, geometry }));
      await turns();
      const bc = r.last("set-control");
      const p = c.service.handle(r.command("input", ref, { epoch, inputSeq: 1 }), binary);
      await turns();
      expect(r.count("input")).toBe(0);
      r.accept(bc, { atSeq: 12 });
      expect((await q).epoch).toBe(7);
      expect((await p).type).toBe("error");
      expect(r.count("input")).toBe(0);
    }));

  test("B2-09 epoch max refuses increment without overflow dispatch", async () =>
    withControl(async (r) => {
      const c = r.primary,
        ref = await r.attach(c);
      const p = c.service.handle(r.command("focus", ref, { focusSeq: 9007199254740991, geometry }));
      await turns();
      r.status(undefined, { epoch: Number.MAX_SAFE_INTEGER });
      expect((await p).error.kind).toBe("COUNTER_EXHAUSTED");
      expect(r.count("set-control")).toBe(0);
      expect(
        (
          await c.service.handle(
            r.command("focus", ref, { focusSeq: Number.MAX_SAFE_INTEGER, geometry }),
          )
        ).type,
      ).toBe("error");
    }));

  test("B2-10 cap plus one payload refuses and original backing remains physically charged", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r);
      const before = r.account.snapshot().total;
      expect(
        (
          await c.service.handle(
            r.command("input", ref, { epoch, inputSeq: 1 }),
            new Uint8Array(65537),
          )
        ).type,
      ).toBe("error");
      expect(r.count("input")).toBe(0);
      const backing = new Uint8Array(65536),
        original = backing.subarray(100, 109);
      original.set(binary);
      const lease = r.account.retainBacking(original);
      expect(lease).not.toBeNull();
      const p = c.service.handle(r.command("input", ref, { epoch, inputSeq: 2 }), original);
      await turns();
      backingOracle({
        retained: r.account.snapshot().total - before,
        backing: backing.length,
        physicallyReleased: false,
      });
      c.service.close();
      await turns();
      backingOracle({
        retained: r.account.snapshot().total,
        backing: backing.length,
        physicallyReleased: false,
      });
      r.accept(r.last("input"), { inputSeq: 2, writtenBytes: 9 });
      expect((await p).writtenBytes).toBe(9);
      await turns();
      backingOracle({
        retained: r.account.snapshot().total,
        backing: backing.length,
        physicallyReleased: false,
      });
      const held = r.account.snapshot().total;
      lease.release();
      lease.release();
      expect(held - r.account.snapshot().total).toBe(backing.length + 256);
    }));

  test("B2-10 saturated ordinary account refuses new control while healthy ACK progresses", async () =>
    withControl(async (r) => {
      const { c, ref } = await installedOperator(r);
      const b = r.addConnection(),
        br = await r.attach(b);
      r.session.receive(r.event(br, { type: "output", run, seq: 11 }, binary));
      const snap = r.account.snapshot(),
        lease = r.account.reserve(snap.limit - snap.controlReserve - snap.ordinary);
      expect(lease).not.toBeNull();
      const before = r.count("set-control");
      expect(
        (await c.service.handle(r.command("focus", ref, { focusSeq: 2, geometry }))).type,
      ).toBe("error");
      expect(r.count("set-control")).toBe(before);
      expect((await r.ack(b, br, 11)).type).toBe("applied-ack-result");
      lease.release();
      expect((await r.focus(c, ref, { focusSeq: 2, atSeq: 12 })).reply.type).toBe("focus-result");
    }));
});

describe("P2-B2 independent trace oracle sensitivity controls", () => {
  test("B2-11 CTRL-PREMATURE rejects grant without applied readiness", () => {
    const trace = {
      installed: true,
      applied: 10,
      grant: { epoch: 6, atSeq: 11, holder: { id: "A" } },
      fact: { epoch: 6, holder: { id: "A" } },
      inputReady: false,
      inputWrites: 0,
    };
    expect(() => readyOracle(trace)).not.toThrow();
    expect(() => readyOracle({ ...trace, inputReady: true, inputWrites: 1 })).toThrow(
      /premature readiness/,
    );
  });
  test("B2-11 CTRL-FOREIGN-RELEASE rejects unconditional obsolete holder release", () => {
    const current = { holder: { id: "B" }, epoch: 7, geometry };
    const command = {
      owner: current.holder,
      expectedEpoch: 7,
      nextEpoch: 7,
      holder: null,
      geometry,
    };
    expect(() => releaseOracle(command, current)).not.toThrow();
    expect(() =>
      releaseOracle({ ...command, owner: { id: "A" }, expectedEpoch: 6 }, current),
    ).toThrow(/foreign release holder/);
  });
  test("B2-11 CTRL-UNKNOWN-REPLAY rejects second handed-off identity", () => {
    expect(() => onceOracle([{ identity: "input-1" }], "input-1")).not.toThrow();
    expect(() => onceOracle([{ identity: "input-1" }, { identity: "input-1" }], "input-1")).toThrow(
      /input replay/,
    );
  });
  test("B2-11 CTRL-MISSING-ATSEQ rejects unbounded successful grant", () => {
    const command = { requestId: "focus-1", nextEpoch: 6 },
      result = { type: "focus-result", requestId: "focus-1", epoch: 6, atSeq: 11 };
    expect(() => grantOracle(result, command, 10)).not.toThrow();
    expect(() => grantOracle({ ...result, atSeq: undefined }, command, 10)).toThrow(
      /missing grant atSeq/,
    );
  });
  test("B2-11 CTRL-EARLY-BACKING rejects logical-retirement physical release", () => {
    expect(() =>
      backingOracle({ retained: 4352, backing: 4096, physicallyReleased: false }),
    ).not.toThrow();
    expect(() => backingOracle({ retained: 0, backing: 4096, physicallyReleased: false })).toThrow(
      /premature backing release/,
    );
  });
});

describe("P2-B2 independent finite boundary contrasts", () => {
  test("B2-09 maximum input and focus counter proof cannot wrap or disappear", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r, { focusSeq: Number.MAX_SAFE_INTEGER });
      const command = r.command("input", ref, { epoch, inputSeq: Number.MAX_SAFE_INTEGER });
      const p = c.service.handle(command, binary);
      await turns();
      r.accept(r.last("input"), { inputSeq: Number.MAX_SAFE_INTEGER, writtenBytes: 9 });
      expect((await p).writtenBytes).toBe(9);
      await recover(r, c, ref);
      const count = business(r).length;
      for (const inputSeq of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1])
        expect(
          (await c.service.handle(r.command("input", ref, { epoch, inputSeq }), binary)).type,
        ).toBe("error");
      expect(
        (
          await c.service.handle(
            r.command("focus", ref, { focusSeq: Number.MAX_SAFE_INTEGER, geometry }),
          )
        ).type,
      ).toBe("error");
      expect((await c.service.handle(command, binary)).type).toBe("error");
      expect(business(r)).toHaveLength(count);
    }));

  test("B2-10 negotiated input byte cap admits exactly cap and refuses cap plus one", async () =>
    withControl(async (r) => {
      const { c, ref, epoch } = await installedOperator(r);
      const cap = r.composition.budgets.inputQueueBytes;
      const refused = await c.service.handle(
        r.command("input", ref, { epoch, inputSeq: 1 }),
        new Uint8Array(cap + 1),
      );
      expect(refused).toMatchObject({ type: "error", error: { acceptance: "not-accepted" } });
      expect(r.count("input")).toBe(0);
      const payload = new Uint8Array(cap).fill(65),
        p = c.service.handle(r.command("input", ref, { epoch, inputSeq: 2 }), payload);
      await turns();
      expect(r.inputFrames()).toHaveLength(1);
      expect([...r.inputFrames()[0].payload]).toEqual([...payload]);
      r.accept(r.last("input"), { inputSeq: 2, writtenBytes: cap });
      expect((await p).writtenBytes).toBe(cap);
    }));

  test("B2-10 finite shared run job cap preserves reserved healthy progress", async () =>
    withControl(
      async (r) => {
        const a = r.primary,
          b = r.addConnection(),
          c = r.addConnection();
        const ar = await r.attach(a),
          br = await r.attach(b),
          cr = await r.attach(c);
        const p = a.service.handle(r.command("focus", ar, { focusSeq: 1, geometry }));
        const q = b.service.handle(r.command("focus", br, { focusSeq: 1, geometry }));
        await turns();
        expect(state(r).pending).toBe(2);
        const before = r.commands.length;
        expect(
          (await a.service.handle(r.command("focus", ar, { focusSeq: 2, geometry }))).error.kind,
        ).toBe("BUSY");
        expect(r.commands).toHaveLength(before);
        expect(state(r).pending).toBe(2);
        r.session.receive(r.event(cr, { type: "output", run, seq: 11 }, binary));
        expect((await r.ack(c, cr, 11)).type).toBe("applied-ack-result");
        r.status();
        await turns();
        r.accept(r.last("set-control"), { atSeq: 11 });
        await p;
        await turns();
        r.accept(r.last("set-control"), { atSeq: 12 });
        await q;
        expect(state(r).pending).toBe(0);
      },
      { budgets: { pendingWorkerCommands: 2 } },
    ));

  test("B2-03 unsent cleanup retries only after capacity and unknown release never retries", async () =>
    withControl(
      async (r) => {
        const { c, ref, epoch } = await installedOperator(r);
        const occupied = r.runtime.setAppearance({
          type: "appearance",
          worker: r.last("set-control").worker,
          run,
          requestId: r.requestId(),
          subscription: ref,
          epoch,
          appearance: DEFAULT_APPEARANCE,
        });
        await turns();
        const occupiedCommand = r.last("appearance");
        c.service.close();
        await turns();
        const before = r.count("set-control");
        expect(state(r).cleanup).toBe(1);
        r.arbiter.tick();
        await turns();
        expect(r.count("set-control")).toBe(before);
        r.accept(occupiedCommand, { atSeq: 11 });
        await occupied;
        r.arbiter.tick();
        await turns();
        const release = r.last("set-control");
        expect(release.holder).toBeNull();
        expect(r.count("set-control")).toBe(before + 1);
        r.accept(release, { outcome: "unknown" });
        await turns();
        expect(state(r).uncertain).toBe(true);
        r.arbiter.tick();
        r.arbiter.retire(ref);
        r.arbiter.tick();
        await turns();
        expect(r.count("set-control")).toBe(before + 1);
      },
      { budgets: { pendingWorkerCommands: 1 } },
    ));

  test("B2-10 held physical pipe bytes survive result and close until explicit carrier receipt", async () =>
    withControl(
      async (r) => {
        const { c, ref, epoch } = await installedOperator(r);
        r.setPipeWritable(false);
        const p = c.service.handle(r.command("input", ref, { epoch, inputSeq: 1 }), binary);
        await turns();
        const pc = r.last("input"),
          write = r.pipeWrites.findLast((w) => w.frames.some((x) => x.metadata.type === "input"));
        expect(write.released).toBe(false);
        const physical = r.session.snapshot().physicalBytes;
        expect(physical).toBeGreaterThan(0);
        r.accept(pc, { inputSeq: 1, writtenBytes: 9 });
        await p;
        c.service.close();
        await turns();
        expect(r.session.snapshot().physicalBytes).toBeGreaterThanOrEqual(
          write.encoded.buffer.byteLength,
        );
        const held = r.session.snapshot().physicalBytes;
        write.settled();
        expect(held - r.session.snapshot().physicalBytes).toBe(write.encoded.buffer.byteLength);
        const released = r.session.snapshot().physicalBytes;
        write.settled();
        expect(r.session.snapshot().physicalBytes).toBe(released);
        expect(r.inputFrames()).toHaveLength(1);
      },
      { pipeHold: true },
    ));

  test.each(["rejected", "unknown"])(
    "B2-07 valid current appearance %s keeps typed failure without success",
    async (outcome) =>
      withControl(async (r) => {
        const { c, ref, epoch } = await installedOperator(r);
        const p = c.service.handle(
          r.command("appearance", ref, {
            epoch,
            appearance: { palette: [], foreground: "aaaa/bbbb/cccc" },
          }),
        );
        await turns();
        const pc = r.last("appearance");
        expect(pc.appearance.foreground).toBe("aaaa/bbbb/cccc");
        r.accept(pc, { outcome });
        expect((await p).type).toBe("error");
        expect(c.transport.trace().some((x) => x.metadata.type === "appearance-result")).toBe(
          false,
        );
      }),
  );
});

describe("P2-B2 independent lifetime and uncertainty fences", () => {
  test("B2-01 reentrant close in B2 identity supplier publishes no control ownership", async () => {
    let rig,
      calls = 0;
    await withControl(
      async (r) => {
        rig = r;
        const ref = await r.attach(r.primary);
        expect(calls).toBe(3);
        const reply = await r.primary.service.handle(
          r.command("focus", ref, { focusSeq: 1, geometry }),
        );
        expect(reply.type).toBe("error");
        expect(r.count("set-control")).toBe(0);
        expect(r.count("status")).toBe(0);
        expect(state(r).runs).toBe(0);
        await turns();
        const unsubs = r.commands.filter((x) => x.type === "unsubscribe");
        expect(unsubs).toHaveLength(1);
        expect(unsubs[0].subscription).toEqual(ref);
        expect(r.count("stop")).toBe(0);
      },
      {
        createOpaqueId() {
          calls++;
          if (calls === 4) rig.primary.service.close();
          return `reentrant-owned-${calls}`;
        },
      },
    );
  });

  test("B2-02 unknown control requires fresh status inspection before next explicit focus", async () =>
    withControl(async (r) => {
      const c = r.primary,
        ref = await r.attach(c);
      const p = c.service.handle(r.command("focus", ref, { focusSeq: 1, geometry }));
      await turns();
      r.status();
      await turns();
      r.accept(r.last("set-control"), { outcome: "unknown" });
      expect((await p).error.acceptance).toBe("unknown");
      expect(state(r).uncertain).toBe(true);
      expect(r.count("set-control")).toBe(1);
      r.arbiter.tick();
      await turns();
      expect(r.count("set-control")).toBe(1);
      const q = c.service.handle(r.command("focus", ref, { focusSeq: 2, geometry }));
      await turns();
      expect(r.count("status")).toBe(2);
      expect(r.count("set-control")).toBe(1);
      r.status(r.last("status"), { epoch: 7, atSeq: 10, currentHolder: null });
      await turns();
      const command = r.last("set-control");
      expect(command).toMatchObject({ expectedEpoch: 7, nextEpoch: 8 });
      r.accept(command, { atSeq: 11 });
      expect((await q).epoch).toBe(8);
      expect(state(r).uncertain).toBe(false);
    }));
});

describe("P2-B2 independent F1 held-result close unsubscribe", () => {
  test.each(["focus", "input"])(
    "F1 owned unsubscribe precedes held %s result settlement",
    async (kind) => {
      const r = controlFixture({ pipeHold: true });
      const trace = { kind, steps: [] };
      const record = (phase) =>
        trace.steps.push({
          phase,
          commands: structuredClone(r.commands),
          primary: r.primary.service.snapshot(),
          arbiter: state(r),
          pipe: r.session.snapshot(),
          retained: r.account.snapshot(),
        });
      try {
        const c = r.primary;
        const operator = kind === "input" ? await installedOperator(r) : undefined;
        const ref = operator?.ref ?? (await r.attach(c));
        const watcher = r.addConnection();
        const watcherRef = await r.attach(watcher);
        const external = r.command(
          kind,
          ref,
          kind === "focus" ? { focusSeq: 1, geometry } : { inputSeq: 1, epoch: operator.epoch },
        );
        const pending = c.service.handle(external, kind === "input" ? binary : new Uint8Array());
        await turns();
        if (kind === "focus") {
          r.status();
          await turns();
        }
        const held = r.last(kind === "focus" ? "set-control" : "input");
        const physical = r.pipeWrites.findLast((w) =>
          w.frames.some((frame) => frame.metadata.requestId === held.requestId),
        );
        expect(physical.released).toBe(false);
        trace.held = held;
        trace.backingBytes = physical.encoded.buffer.byteLength;
        const newer =
          kind === "focus"
            ? watcher.service.handle(r.command("focus", watcherRef, { focusSeq: 1, geometry }))
            : undefined;
        await turns();
        record("held-before-close");
        c.service.close();
        expect(c.service.closed).toBe(true);
        expect(c.service.snapshot(ref.subscriptionId).route.phase).toBe("retired");
        const beforeRefusal = business(r).length;
        const refusal = await c.service.handle(
          r.command("input", ref, { epoch: 6, inputSeq: 2 }),
          binary,
        );
        expect(refusal.type).toBe("error");
        expect(refusal.error.acceptance).toBe("not-accepted");
        expect(business(r)).toHaveLength(beforeRefusal);
        await turns();
        const ownUnsubscribes = () =>
          r.commands.filter(
            (x) => x.type === "unsubscribe" && x.subscription.subscriptionId === ref.subscriptionId,
          );
        const immediate = structuredClone(ownUnsubscribes());
        trace.immediateOwnedUnsubscribes = immediate;
        record("closed-before-held-result");
        expect(
          r.commands.filter(
            (x) =>
              x.type === "unsubscribe" &&
              x.subscription.subscriptionId === watcherRef.subscriptionId,
          ),
        ).toHaveLength(0);
        expect(
          r.commands.filter((x) => x.type === "set-control" && x.holder === null),
        ).toHaveLength(0);
        expect(r.count("stop")).toBe(0);
        r.accept(
          held,
          kind === "focus" ? { atSeq: 11 } : { inputSeq: 1, writtenBytes: binary.length },
        );
        const reply = await pending;
        trace.heldReply = reply;
        expect(reply.type).toBe(kind === "focus" ? "error" : "input-result");
        expect(reply.writtenBytes).toBe(kind === "input" ? binary.length : undefined);
        await turns();
        record("held-result-settled");
        expect(
          c.transport.trace().filter((x) => x.metadata.requestId === external.requestId),
        ).toHaveLength(0);
        expect(r.session.snapshot().physicalBytes).toBeGreaterThanOrEqual(trace.backingBytes);
        const next = r.last("set-control");
        expect(next.holder).toEqual(kind === "focus" ? holder(watcherRef) : null);
        expect(next.expectedEpoch).toBe(6);
        expect(next.nextEpoch).toBe(kind === "focus" ? 7 : operator.epoch);
        expect(next.geometry).toEqual(geometry);
        if (kind === "input")
          releaseOracle(
            { ...next, owner: holder(ref) },
            { holder: holder(ref), epoch: operator.epoch, geometry },
          );
        r.accept(next, { atSeq: 12 });
        const newerReply = await newer;
        expect(newerReply?.epoch).toBe(kind === "focus" ? 7 : undefined);
        await turns();
        expect(ownUnsubscribes()).toHaveLength(1);
        expect(ownUnsubscribes()[0].subscription).toEqual(ref);
        r.accept(ownUnsubscribes()[0]);
        await turns();
        c.service.close();
        r.arbiter.retire(ref);
        r.arbiter.tick();
        await turns();
        expect(ownUnsubscribes()).toHaveLength(1);
        expect(
          r.commands.filter((x) => x.type === "set-control" && x.holder === null),
        ).toHaveLength(kind === "focus" ? 0 : 1);
        expect(state(r).boundary.holder).toEqual(kind === "focus" ? holder(watcherRef) : null);
        expect(watcher.service.snapshot(watcherRef.subscriptionId).route.phase).toBe("active");
        expect(
          r.commands.filter(
            (x) =>
              x.type === "unsubscribe" &&
              x.subscription.subscriptionId === watcherRef.subscriptionId,
          ),
        ).toHaveLength(0);
        expect(r.count("stop")).toBe(0);
        record("conditional-tail-settled");
        await r.stop();
        record("owned-carriers-released");
        // Compare the saved close-time observation after collecting settlement and cleanup evidence.
        expect(immediate, "owned unsubscribe must precede held B2 result settlement").toHaveLength(
          1,
        );
        expect(immediate[0].subscription).toEqual(ref);
      } finally {
        await r.stop();
        record("finally-owned-cleanup");
        console.info("F1_REGRESSION_TRACE " + JSON.stringify(trace));
      }
    },
  );
});

describe("P2-B2 independent shared worker progress capacity", () => {
  test("R2-F1 freed peer ACK slot dispatches owned teardown before held focus settles", async () => {
    const r = controlFixture({ pipeHold: true });
    const trace = { case: "peer-four-slots", steps: [] };
    const record = (phase) =>
      trace.steps.push({
        phase,
        commands: structuredClone(r.commands),
        primary: r.primary.service.snapshot(),
        peer: r.connections[1]?.service.snapshot(),
        arbiter: state(r),
        pipe: r.session.snapshot(),
        retained: r.account.snapshot(),
      });
    try {
      const a = r.primary,
        ar = await r.attach(a),
        b = r.addConnection();
      const focus = r.command("focus", ar, { focusSeq: 1, geometry });
      const held = a.service.handle(focus);
      await turns();
      r.status();
      await turns();
      const heldCommand = r.last("set-control");
      const peerRefs = [];
      for (let index = 0; index < 4; index++)
        peerRefs.push(await r.attach(b, { viewId: `r2-peer-${index}` }));
      const peerReplies = peerRefs.map((ref) =>
        b.service.handle(r.command("applied-ack", ref, { appliedSeq: 10 })),
      );
      await turns();
      const acknowledgements = r.commands.filter((x) => x.type === "applied-ack");
      expect(acknowledgements).toHaveLength(4);
      record("four-peer-ACKs-held");
      a.service.close();
      await turns();
      expect(a.service.snapshot(ar.subscriptionId).route.phase).toBe("retired");
      expect(r.count("unsubscribe")).toBe(0);
      const refused = await a.service.handle(
        r.command("input", ar, { inputSeq: 1, epoch: 6 }),
        binary,
      );
      expect(refused.type).toBe("error");
      expect(refused.error.acceptance).toBe("not-accepted");
      expect(r.count("input")).toBe(0);
      record("closed-under-shared-saturation");
      r.accept(acknowledgements[0]);
      expect((await peerReplies[0]).type).toBe("applied-ack-result");
      await turns();
      const freedSlotTeardown = structuredClone(r.commands.filter((x) => x.type === "unsubscribe"));
      trace.afterOneSharedSlotFreed = freedSlotTeardown;
      record("one-peer-slot-freed-before-focus-result");
      expect(r.commands.filter((x) => x.type === "set-control" && x.holder === null)).toHaveLength(
        0,
      );
      r.accept(heldCommand, { atSeq: 11 });
      trace.heldReply = await held;
      expect(trace.heldReply.type).toBe("error");
      expect(a.transport.trace().some((x) => x.metadata.type === "focus-result")).toBe(false);
      await turns();
      const release = r.last("set-control");
      releaseOracle({ ...release, owner: holder(ar) }, { holder: holder(ar), epoch: 6, geometry });
      r.accept(release, { atSeq: 12 });
      for (const acknowledgement of acknowledgements.slice(1)) r.accept(acknowledgement);
      const replies = await Promise.all(peerReplies);
      expect(replies.map((x) => x.type)).toEqual(Array(4).fill("applied-ack-result"));
      await turns();
      const actualTeardowns = r.commands.filter((x) => x.type === "unsubscribe");
      for (const command of actualTeardowns) {
        expect(command.subscription).toEqual(ar);
        r.accept(command);
      }
      await turns();
      a.service.close();
      r.arbiter.retire(ar);
      r.arbiter.tick();
      await turns();
      expect(r.count("unsubscribe")).toBeLessThanOrEqual(1);
      expect(r.count("stop")).toBe(0);
      expect(state(r).boundary.holder).toBeNull();
      for (const ref of peerRefs)
        expect(b.service.snapshot(ref.subscriptionId).route.phase).toBe("active");
      record("all-real-results-settled");
      await r.stop();
      record("owned-carriers-released");
      expect(
        freedSlotTeardown,
        "pending owned teardown must survive shared BUSY and enter the freed slot",
      ).toHaveLength(1);
      expect(freedSlotTeardown[0].subscription).toEqual(ar);
    } finally {
      await r.stop();
      record("finally-owned-cleanup");
      console.info("SHARED_PROGRESS_TRACE " + JSON.stringify(trace));
    }
  });

  test("R2-CAP active background unsubscribe occupies one original shared progress slot", async () => {
    const r = controlFixture({ pipeHold: true });
    const trace = { case: "background-one-slot", steps: [] };
    const record = (phase) =>
      trace.steps.push({
        phase,
        commands: structuredClone(r.commands),
        primary: r.primary.service.snapshot(),
        peer: r.connections[1]?.service.snapshot(),
        pipe: r.session.snapshot(),
        retained: r.account.snapshot(),
      });
    try {
      const a = r.primary,
        ar = await r.attach(a),
        b = r.addConnection();
      const peerRefs = [];
      for (let index = 0; index < 4; index++)
        peerRefs.push(await r.attach(b, { viewId: `r2-cap-peer-${index}` }));
      a.service.close();
      await turns();
      const background = r.last("unsubscribe");
      expect(background.subscription).toEqual(ar);
      expect(r.count("unsubscribe")).toBe(1);
      const replies = peerRefs.map((ref) =>
        b.service.handle(r.command("applied-ack", ref, { appliedSeq: 10 })),
      );
      await turns();
      const acknowledgements = r.commands.filter((x) => x.type === "applied-ack");
      expect(acknowledgements).toHaveLength(3);
      const refused = await replies[3];
      trace.fourthPeerReply = refused;
      expect(refused.type).toBe("error");
      expect(refused.error.kind).toBe("BUSY");
      expect(refused.error.acceptance).toBe("not-accepted");
      record("background-plus-three-ACKs-held-fourth-refused");
      r.accept(background);
      for (const acknowledgement of acknowledgements) r.accept(acknowledgement);
      expect((await Promise.all(replies.slice(0, 3))).map((x) => x.type)).toEqual(
        Array(3).fill("applied-ack-result"),
      );
      await turns();
      const teardowns = r.commands.filter((x) => x.type === "unsubscribe");
      expect(teardowns.map((x) => x.subscription)).toEqual([ar, peerRefs[3]]);
      expect(teardowns[0].requestId).toBe(background.requestId);
      const peerTeardown = teardowns[1];
      expect(peerTeardown.worker).toEqual(background.worker);
      expect(peerTeardown.run).toEqual(run);
      expect(new Set(teardowns.map((x) => x.requestId)).size).toBe(2);
      trace.peerTeardown = structuredClone(peerTeardown);
      record("exact-owned-teardowns-before-peer-receipt");
      r.accept(peerTeardown);
      await turns();
      a.service.close();
      r.advance(0);
      await turns();
      const completedTeardowns = r.commands.filter((x) => x.type === "unsubscribe");
      expect(completedTeardowns.map((x) => x.subscription)).toEqual([ar, peerRefs[3]]);
      expect(completedTeardowns.map((x) => x.requestId)).toEqual([
        background.requestId,
        peerTeardown.requestId,
      ]);
      expect(r.count("stop")).toBe(0);
      expect(r.count("set-control")).toBe(0);
      record("real-results-settled-without-cap-increase");
      await r.stop();
      record("owned-carriers-released");
    } finally {
      await r.stop();
      record("finally-owned-cleanup");
      console.info("SHARED_PROGRESS_TRACE " + JSON.stringify(trace));
    }
  });
});
