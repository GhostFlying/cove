import { describe, it, expect } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { fixture, run, geometry, decode } from "./terminal-control-byte-peer.mjs";
const turns = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const command = (type, subscription, requestId, rest = {}) => ({
  type,
  run,
  subscription,
  requestId,
  ...rest,
});
const status = (epoch = 0, controlHolder = null) => ({
  run,
  status: "live",
  geometry,
  controlEpoch: epoch,
  controlHolder,
  receivedSeq: 0,
  parsedSeq: 0,
  recovery: "ready",
  exitCode: null,
  signal: null,
});
const holder = (ref) => ({
  connection: ref.connection,
  viewId: ref.viewId,
  subscriptionId: ref.subscriptionId,
});
const controls = (f) =>
  f.pipeWrites
    .map((value) => decode(value.data, true).metadata)
    .filter((value) => value.type === "set-control");
async function initialStatus(f) {
  await turns();
  expect(f.latest().type).toBe("status");
  f.session.receive(f.reply(f.latest(), { runStatus: status() }));
  await turns();
}
async function focus(f, a, ref, id = "focus", focusSeq = 1, atSeq = 0) {
  const pending = a.service.handle(command("focus", ref, id, { focusSeq, geometry }));
  await turns();
  if (f.latest().type === "status") await initialStatus(f);
  const sent = f.latest();
  expect(sent.type).toBe("set-control");
  f.session.receive(f.reply(sent, { atSeq }));
  await turns();
  return await pending;
}
async function apply(f, a, ref, seq, epoch) {
  f.session.receive(
    f.event(ref, { type: "control", run, seq, epoch, holder: holder(ref), geometry }),
  );
  const pending = a.service.handle(command("applied-ack", ref, `ack-${seq}`, { appliedSeq: seq }));
  await turns();
  f.session.receive(f.reply());
  await pending;
}

describe("private shared terminal control and binary input", () => {
  it("requires installed applied recovery and complete refs before control admission", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a, null)).subscription;
      const before = f.pipeWrites.length;
      expect(
        (await a.service.handle(command("focus", ref, "early", { focusSeq: 1, geometry }))).error
          .kind,
      ).toBe("RESYNC_REQUIRED");
      expect(
        (
          await a.service.handle(
            command("focus", { ...ref, viewId: "foreign" }, "wrong", { focusSeq: 2, geometry }),
          )
        ).error.kind,
      ).toBe("STALE_CONNECTION");
      expect(f.pipeWrites).toHaveLength(before);
      expect(f.arbiter.snapshot(run.runId).runs).toBe(0);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("serializes same-run focus by accepted order with one same-grid command and no fabricated status", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    try {
      const ar = (await f.attach(a)).subscription;
      const br = (await f.attach(b)).subscription;
      const ap = a.service.handle(command("focus", ar, "a-focus", { focusSeq: 1, geometry }));
      await initialStatus(f);
      const ac = f.latest();
      const bp = b.service.handle(command("focus", br, "b-focus", { focusSeq: 1, geometry }));
      await turns();
      expect(controls(f)).toHaveLength(1);
      expect(ac).toMatchObject({ expectedEpoch: 0, nextEpoch: 1, holder: holder(ar), geometry });
      f.session.receive(f.reply(ac, { atSeq: 1 }));
      await turns();
      const bc = f.latest();
      expect(bc).toMatchObject({ expectedEpoch: 1, nextEpoch: 2, holder: holder(br) });
      f.session.receive(f.reply(bc, { atSeq: 2 }));
      expect(await ap).toMatchObject({ type: "focus-result", epoch: 1, atSeq: 1 });
      expect(await bp).toMatchObject({ type: "focus-result", epoch: 2, atSeq: 2 });
      expect(f.runtime.registry.get(run).status.controlEpoch).toBe(0);
      expect(f.pipeWrites.map((x) => decode(x.data, true).metadata.type)).not.toContain("resize");
      expect(
        (await a.service.handle(command("focus", ar, "lower", { focusSeq: 1, geometry }))).error
          .kind,
      ).toBe("COUNTER_EXHAUSTED");
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("refuses foreign/current-epoch and own/old-epoch blur but exact current blur preserves the grid", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    try {
      const ar = (await f.attach(a)).subscription;
      const br = (await f.attach(b)).subscription;
      await focus(f, a, ar);
      const before = controls(f).length;
      expect(
        (await b.service.handle(command("blur", br, "foreign-blur", { epoch: 1 }))).error.kind,
      ).toBe("STALE_CONTROL");
      expect(
        (await a.service.handle(command("blur", ar, "old-blur", { epoch: 2 }))).error.kind,
      ).toBe("STALE_CONTROL");
      expect(controls(f)).toHaveLength(before);
      const pending = a.service.handle(command("blur", ar, "own-blur", { epoch: 1 }));
      await turns();
      const release = f.latest();
      expect(release).toMatchObject({
        type: "set-control",
        holder: null,
        expectedEpoch: 1,
        nextEpoch: 1,
        geometry,
      });
      expect(release.appearance).toBeUndefined();
      f.session.receive(f.reply(release, { atSeq: 0 }));
      expect(await pending).toMatchObject({ type: "blur-result", epoch: 1 });
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("withholds late closed focus grant and releases only after real commitment", async () => {
    const f = fixture();
    const a = f.connect("a");
    try {
      const ref = (await f.attach(a)).subscription;
      const pending = a.service.handle(command("focus", ref, "focus", { focusSeq: 1, geometry }));
      await initialStatus(f);
      const sent = f.latest();
      a.service.close();
      await turns();
      expect(controls(f)).toHaveLength(1);
      expect((await pending).type).toBe("error");
      f.session.receive(f.reply(sent, { atSeq: 1 }));
      await turns();
      expect(controls(f)).toHaveLength(2);
      const release = controls(f)[1];
      expect(release).toMatchObject({ holder: null, expectedEpoch: 1, nextEpoch: 1, geometry });
      expect(a.writes.map((x) => decode(x.data).metadata.type)).not.toContain("focus-result");
      f.session.receive(f.reply(release, { atSeq: 2 }));
      await turns();
      a.service.close();
      f.arbiter.tick();
      await turns();
      expect(controls(f)).toHaveLength(2);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("late closed A focus cannot release newer accepted B holder", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    try {
      const ar = (await f.attach(a)).subscription;
      const br = (await f.attach(b)).subscription;
      const ap = a.service.handle(command("focus", ar, "a-focus", { focusSeq: 1, geometry }));
      await initialStatus(f);
      const ac = f.latest();
      const bp = b.service.handle(command("focus", br, "b-focus", { focusSeq: 1, geometry }));
      a.service.close();
      f.session.receive(f.reply(ac, { atSeq: 1 }));
      await turns();
      const bc = controls(f)[1];
      expect(bc.holder).toEqual(holder(br));
      f.session.receive(f.reply(bc, { atSeq: 2 }));
      await turns();
      expect((await ap).type).toBe("error");
      expect((await bp).epoch).toBe(2);
      expect(controls(f)).toHaveLength(2);
      expect(f.arbiter.snapshot(run.runId).boundary.holder).toEqual(holder(br));
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("holds input until grant fact is applied then forwards exact binary bytes once and reports the written prefix", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      await focus(f, a, ref, "focus", 1, 1);
      const bytes = new Uint8Array([0, 255, 27, 91, 65]);
      expect(
        (
          await a.service.handle(
            command("input", ref, "too-early", { epoch: 1, inputSeq: 1 }),
            bytes,
          )
        ).error.kind,
      ).toBe("RESYNC_REQUIRED");
      await apply(f, a, ref, 1, 1);
      const pending = a.service.handle(
        command("input", ref, "input", { epoch: 1, inputSeq: 2 }),
        bytes,
      );
      bytes.fill(66);
      await turns();
      const sent = f.latest();
      expect(sent).toMatchObject({ type: "input", epoch: 1, inputSeq: 2 });
      expect([...decode(f.pipeWrites.at(-1).data, true).payload]).toEqual([0, 255, 27, 91, 65]);
      f.session.receive(f.reply(sent, { inputSeq: 2, writtenBytes: 2 }));
      expect(await pending).toMatchObject({
        type: "input-result",
        status: "written",
        writtenBytes: 2,
        epoch: 1,
        inputSeq: 2,
      });
      expect(
        (
          await a.service.handle(
            command("input", ref, "duplicate", { epoch: 1, inputSeq: 2 }),
            bytes,
          )
        ).error.kind,
      ).toBe("COUNTER_EXHAUSTED");
      expect(
        f.pipeWrites.map((x) => decode(x.data, true).metadata).filter((x) => x.type === "input"),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("unknown handed-off input remains inspect-run with one actual pipe write after timeout and contact loss", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      await focus(f, a, ref);
      const pending = a.service.handle(
        command("input", ref, "unknown", { epoch: 1, inputSeq: 1 }),
        new Uint8Array([65]),
      );
      await turns();
      expect(f.latest().type).toBe("input");
      f.clock(1000);
      f.session.tick();
      expect(await pending).toMatchObject({
        type: "error",
        error: {
          kind: "RESULT_UNKNOWN",
          acceptance: "unknown",
          subject: "input",
          nextAction: "inspect-run",
        },
      });
      const recovery = a.service.handle(
        command("recover", ref, "recover", {
          reason: "expired",
          resume: {
            appliedSeq: 0,
            profile: "pragmatic-logical-grid-v1",
            encoding: "vt-checkpoint-tail-v1",
            geometry,
          },
        }),
      );
      await turns();
      expect((await recovery).error.kind).toBe("WORKER_UNAVAILABLE");
      expect(
        (
          await a.service.handle(
            command("input", ref, "retry-identity", { epoch: 1, inputSeq: 1 }),
            new Uint8Array([65]),
          )
        ).error.kind,
      ).toBe("WORKER_UNAVAILABLE");
      a.service.tick();
      await turns();
      expect(
        f.pipeWrites.map((x) => decode(x.data, true).metadata).filter((x) => x.type === "input"),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("keeps watcher detach passive and own detach conditional without stopping PTY", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    try {
      const ar = (await f.attach(a)).subscription;
      const br = (await f.attach(b)).subscription;
      await focus(f, a, ar);
      const bp = b.service.handle(command("detach", br, "watcher-detach"));
      await turns();
      const unsub = f.latest();
      expect(unsub.type).toBe("unsubscribe");
      f.session.receive(f.reply(unsub));
      await bp;
      expect(controls(f)).toHaveLength(1);
      const ap = a.service.handle(command("detach", ar, "holder-detach"));
      await turns();
      const emitted = f.pipeWrites.map((x) => decode(x.data, true).metadata);
      const release = controls(f).at(-1);
      expect(release.holder).toBeNull();
      const ownUnsub = emitted.findLast(
        (x) => x.type === "unsubscribe" && x.subscription.subscriptionId === ar.subscriptionId,
      );
      expect(a.service.snapshot(ar.subscriptionId).route.phase).toBe("retired");
      f.session.receive(f.reply(release, { atSeq: 0 }));
      f.session.receive(f.reply(ownUnsub));
      await ap;
      expect(emitted.map((x) => x.type)).not.toContain("stop");
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("rejects oversized full backing and exhausted epoch without business effects or leaked reservations", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      await focus(f, a, ref);
      const count = f.pipeWrites.length;
      const before = f.bytes.snapshot().total;
      const refused = await a.service.handle(
        command("input", ref, "oversized", { epoch: 1, inputSeq: 1 }),
        new Uint8Array(100_000).subarray(0, 1),
      );
      expect(refused.error.kind).toBe("INPUT_REJECTED");
      expect(f.pipeWrites).toHaveLength(count);
      a.writes.at(-1).settled();
      expect(f.bytes.snapshot().total).toBe(before);
      f.session.receive(
        f.event(ref, {
          type: "control",
          run,
          seq: 1,
          epoch: Number.MAX_SAFE_INTEGER,
          holder: holder(ref),
          geometry,
        }),
      );
      expect(
        (await a.service.handle(command("focus", ref, "exhausted", { focusSeq: 2, geometry })))
          .error.kind,
      ).toBe("COUNTER_EXHAUSTED");
      expect(controls(f)).toHaveLength(1);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("retains attempted focus and input counters across live stable-ref recovery", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      await focus(f, a, ref);
      const input = a.service.handle(
        command("input", ref, "written", { epoch: 1, inputSeq: 3 }),
        new Uint8Array([65]),
      );
      await turns();
      f.session.receive(f.reply(f.latest(), { inputSeq: 3, writtenBytes: 1 }));
      await input;
      const recovery = a.service.handle(
        command("recover", ref, "recover", {
          reason: "gap",
          resume: {
            appliedSeq: 0,
            profile: "pragmatic-logical-grid-v1",
            encoding: "vt-checkpoint-tail-v1",
            geometry,
          },
        }),
      );
      await turns();
      f.session.receive(f.reply(f.latest(), { recoveryMode: "replay", atSeq: 0 }));
      expect((await recovery).subscription).toEqual(ref);
      const count = f.pipeWrites.length;
      expect(
        (
          await a.service.handle(
            command("input", ref, "lower-input", { epoch: 1, inputSeq: 2 }),
            new Uint8Array([65]),
          )
        ).error.kind,
      ).toBe("COUNTER_EXHAUSTED");
      expect(
        (await a.service.handle(command("focus", ref, "lower-focus", { focusSeq: 1, geometry })))
          .error.kind,
      ).toBe("COUNTER_EXHAUSTED");
      expect(f.pipeWrites).toHaveLength(count);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("keeps geometry and appearance under installed holder authority with negotiated size checks", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    const appearance = DEFAULT_APPEARANCE;
    try {
      const ar = (await f.attach(a)).subscription;
      const br = (await f.attach(b)).subscription;
      await focus(f, a, ar);
      const count = f.pipeWrites.length;
      expect(
        (
          await b.service.handle(
            command("resize", br, "foreign", { epoch: 1, geometry: { cols: 90, rows: 25 } }),
          )
        ).error.kind,
      ).toBe("STALE_CONTROL");
      expect(
        (
          await a.service.handle(
            command("resize", ar, "oversize", { epoch: 1, geometry: { cols: 121, rows: 25 } }),
          )
        ).error.kind,
      ).toBe("CAPABILITY_UNAVAILABLE");
      expect(f.pipeWrites).toHaveLength(count);
      const resize = a.service.handle(
        command("resize", ar, "resize", { epoch: 1, geometry: { cols: 90, rows: 25 } }),
      );
      await turns();
      expect(f.latest()).toMatchObject({
        type: "resize",
        epoch: 1,
        geometry: { cols: 90, rows: 25 },
      });
      f.session.receive(f.reply(f.latest(), { atSeq: 0 }));
      expect((await resize).type).toBe("resize-result");
      const ap = a.service.handle(
        command("appearance", ar, "appearance", { epoch: 1, appearance }),
      );
      await turns();
      expect(f.latest().type).toBe("appearance");
      f.session.receive(f.reply(f.latest(), { atSeq: 0 }));
      expect((await ap).type).toBe("appearance-result");
      const blur = a.service.handle(command("blur", ar, "blur", { epoch: 1 }));
      await turns();
      expect(f.latest().geometry).toEqual({ cols: 90, rows: 25 });
      f.session.receive(f.reply(f.latest(), { atSeq: 0 }));
      await blur;
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("reserves full backing until settlement and admits cap bytes while refusing cap plus one", async () => {
    const f = fixture({ inputQueueBytes: 3 });
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      await focus(f, a, ref);
      const before = f.bytes.snapshot().total;
      const count = f.pipeWrites.length;
      expect(
        (
          await a.service.handle(
            command("input", ref, "cap-plus-one", { epoch: 1, inputSeq: 1 }),
            new Uint8Array(4),
          )
        ).error.kind,
      ).toBe("INPUT_REJECTED");
      a.writes.at(-1).settled();
      expect(f.bytes.snapshot().total).toBe(before);
      expect(f.pipeWrites).toHaveLength(count);
      const original = new Uint8Array(60_000);
      original.set([65, 0, 255]);
      const input = a.service.handle(
        command("input", ref, "cap", { epoch: 1, inputSeq: 1 }),
        original.subarray(0, 3),
      );
      await turns();
      expect([...decode(f.pipeWrites.at(-1).data, true).payload]).toEqual([65, 0, 255]);
      expect(f.bytes.snapshot().total - before).toBeGreaterThan(60_000);
      f.session.receive(f.reply(f.latest(), { inputSeq: 1, writtenBytes: 3 }));
      expect((await input).writtenBytes).toBe(3);
      expect(f.bytes.snapshot().total - before).toBeLessThan(60_000);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("preserves a real written receipt when its route closes during input settlement", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      await focus(f, a, ref);
      const input = a.service.handle(
        command("input", ref, "input-close", { epoch: 1, inputSeq: 1 }),
        new Uint8Array([65, 66]),
      );
      let settled = false;
      input.then(() => {
        settled = true;
      });
      await turns();
      const sent = f.latest();
      expect(sent.type).toBe("input");
      a.service.close();
      await turns();
      expect(settled).toBe(false);
      f.session.receive(f.reply(sent, { inputSeq: 1, writtenBytes: 1 }));
      expect(await input).toMatchObject({ type: "input-result", writtenBytes: 1 });
      expect(a.writes.map((x) => decode(x.data).metadata.type)).not.toContain("input-result");
      expect(
        f.pipeWrites.map((x) => decode(x.data, true).metadata).filter((x) => x.type === "input"),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
  it("ordinary reservation saturation refuses control while existing ACK progress continues", async () => {
    const f = fixture();
    const a = f.connect();
    let saturation;
    try {
      const ref = (await f.attach(a)).subscription;
      const ledger = f.bytes.snapshot();
      saturation = f.bytes.reserve(ledger.limit - ledger.controlReserve - ledger.ordinary);
      expect(saturation).not.toBeNull();
      const count = f.pipeWrites.length;
      expect(
        (await a.service.handle(command("focus", ref, "saturated", { focusSeq: 1, geometry })))
          .error.kind,
      ).toBe("BUSY");
      expect(f.pipeWrites).toHaveLength(count);
      expect(f.arbiter.snapshot(run.runId).runs).toBe(0);
      const ack = a.service.handle(command("applied-ack", ref, "reserved-ack", { appliedSeq: 0 }));
      await turns();
      expect(f.latest().type).toBe("applied-ack");
      f.session.receive(f.reply());
      expect((await ack).type).toBe("applied-ack-result");
      saturation.release();
      saturation = undefined;
      expect((await focus(f, a, ref)).type).toBe("focus-result");
    } finally {
      saturation?.release();
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
});
