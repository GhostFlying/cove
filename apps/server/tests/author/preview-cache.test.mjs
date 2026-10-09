import { describe, it, expect } from "vitest";
import { RPC_METHODS } from "@cove/protocol/rpc";
import { fixture, run, geometry, coalesce, pump, decode } from "./preview-byte-peer.mjs";

async function cleaned(f) {
  await f.dispose();
  expect(f.bytes.snapshot().total).toBe(0);
}

describe("bounded server preview cache", () => {
  it("author preview seals complete transfer at result ingress", async () => {
    const f = fixture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending);
    const t = f.transfer(command, new Uint8Array([65, 66]), 1);
    f.session.receive(coalesce(t.start, t.chunk, t.end));
    expect(f.runtime.previews.cache.snapshot().entries).toBe(0);
    f.session.receive(t.result);
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    expect(await pending).toEqual({ ok: true });
    const reader = f.runtime.previews.cache.acquire(run);
    expect([...reader.picture.vt]).toEqual([65, 66]);
    expect(reader.picture.atSeq).toBe(1);
    reader.release();
    await cleaned(f);
  });

  it("author preview rejects coalesced early result and late bytes", async () => {
    const f = fixture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending);
    const t = f.transfer(command);
    f.session.receive(coalesce(t.start, t.chunk, t.result, t.end));
    expect((await pending).ok).toBe(false);
    expect(f.runtime.previews.cache.snapshot().entries).toBe(0);
    f.session.receive(t.start);
    expect(f.runtime.previews.cache.snapshot().entries).toBe(0);
    await cleaned(f);
  });

  it("author preview never fabricates unchanged without a picture", async () => {
    const f = fixture();
    const c = f.connect();
    const pending = c.preview("first", 7);
    const { command } = await f.toPreview(pending, 7);
    expect(command.type).toBe("preview-refresh");
    expect(command.knownVersion).toBeUndefined();
    f.session.receive(f.reply(command, { previewVersion: 7 }));
    expect((await pending).type).toBe("error");
    expect(c.events().filter((e) => e.metadata.type === "preview-result")).toHaveLength(0);
    expect(c.service.snapshot().routes).toBe(0);
    await cleaned(f);
  });

  it("author preview reuses owned bytes only after current status proof", async () => {
    const f = fixture();
    expect(await f.capture()).toEqual({ ok: true });
    const before = f.runtime.previews.cache.acquire(run);
    f.wall(500);
    const pending = f.runtime.previews.refresh(run);
    await f.toPreview(pending, 1);
    expect(await pending).toEqual({ ok: true });
    expect(f.commands().filter((command) => command.type === "preview-refresh")).toHaveLength(1);
    const after = f.runtime.previews.cache.acquire(run);
    expect(after.picture.vt).toBe(before.picture.vt);
    expect(after.picture.generatedAtMs).toBe(20);
    expect(after.picture.checkedAtMs).toBe(500);
    before.release();
    after.release();
    await cleaned(f);
  });

  it("author preview retains last picture after incomplete transfer", async () => {
    const f = fixture();
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending, 2);
    const t = f.transfer(command, new Uint8Array([66]), 3);
    f.session.receive(coalesce(t.start, t.chunk, t.result));
    expect((await pending).ok).toBe(false);
    const reader = f.runtime.previews.cache.acquire(run);
    expect([...reader.picture.vt]).toEqual([65]);
    expect(reader.picture.stale).toBe(true);
    reader.release();
    await cleaned(f);
  });

  it("author preview rejects duplicate chunk while preserving owned cache", async () => {
    const f = fixture();
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending, 2);
    const t = f.transfer(command, new Uint8Array([66]), 3);
    f.session.receive(coalesce(t.start, t.chunk, t.chunk, t.end, t.result));
    expect((await pending).ok).toBe(false);
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    await cleaned(f);
  });

  it("author preview applies effective per-run byte boundary", async () => {
    const f = fixture({ previewBytesPerRun: 32, previewGlobalBytes: 4096 });
    expect(await f.capture(new Uint8Array(32).fill(65), 1)).toEqual({ ok: true });
    expect((await f.capture(new Uint8Array(33).fill(66), 3)).ok).toBe(false);
    expect(f.runtime.previews.cache.getRecord(run).preview.byteLength).toBe(32);
    await cleaned(f);
  });

  it("author preview exchanges cache without releasing held old backing", async () => {
    const f = fixture();
    await f.capture(new Uint8Array([65, 65]), 1);
    const reader = f.runtime.previews.cache.acquire(run);
    await f.capture(new Uint8Array([66, 66, 66]), 3);
    expect([...reader.picture.vt]).toEqual([65, 65]);
    expect(f.runtime.previews.cache.getRecord(run).preview.byteLength).toBe(3);
    const before = f.bytes.snapshot().total;
    reader.release();
    reader.release();
    expect(before - f.bytes.snapshot().total).toBe(2 + 256 + 4096);
    await cleaned(f);
  });

  it("author preview refused exchange preserves old bytes under shared pressure", async () => {
    const f = fixture();
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending, 2);
    const account = f.bytes.snapshot();
    const pressure = f.bytes.reserve(
      account.limit - account.controlReserve - account.ordinary - 1024,
    );
    expect(pressure).not.toBeNull();
    const t = f.transfer(command, new Uint8Array([66]), 3);
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect((await pending).ok).toBe(false);
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    pressure.release();
    await cleaned(f);
  });

  it("author preview bounds active jobs and same-run waiters", async () => {
    const f = fixture({}, { waiterLimit: 2 });
    const first = f.runtime.previews.request(run);
    const second = f.runtime.previews.request(run);
    expect((await f.runtime.previews.refresh(run)).error.kind).toBe("BUSY");
    expect(f.runtime.previews.snapshot().active).toBe(1);
    expect(f.runtime.previews.snapshot().waiters).toBe(2);
    for (let i = 1; i <= 3; i++) {
      const target = { ...run, runId: "run-" + i };
      f.runtime.reserveRun(target, geometry);
      const waiter = f.runtime.previews.request(target);
      waiter.cancel();
    }
    const fifth = { ...run, runId: "run-4" };
    f.runtime.reserveRun(fifth, geometry);
    expect((await f.runtime.previews.refresh(fifth)).error.kind).toBe("BUSY");
    expect(f.runtime.previews.snapshot().active).toBe(4);
    first.cancel();
    second.cancel();
    await cleaned(f);
  });

  it("author preview stagger visits all registered runs without subscriptions", async () => {
    const f = fixture();
    f.runtime.reserveRun({ ...run, runId: "hidden" }, geometry);
    f.runtime.reserveRun({ ...run, runId: "never" }, geometry);
    f.runtime.tickPreviews();
    await pump();
    expect(f.commands()).toHaveLength(1);
    f.clock(49);
    f.runtime.tickPreviews();
    await pump();
    expect(f.commands()).toHaveLength(1);
    f.session.receive(f.reply(f.latest(), { runStatus: f.status(0, f.latest().run) }));
    await pump();
    f.clock(50);
    f.runtime.tickPreviews();
    await pump();
    f.session.receive(f.reply(f.latest(), { runStatus: f.status(0, f.latest().run) }));
    await pump();
    f.clock(100);
    f.runtime.tickPreviews();
    await pump();
    expect(new Set(f.commands().map((command) => command.run.runId))).toEqual(
      new Set(["hidden", "never", "run"]),
    );
    expect(f.commands().filter((command) => command.type === "status")).toHaveLength(3);
    expect(f.commands().filter((command) => command.type === "preview-refresh")).toHaveLength(2);
    await cleaned(f);
  });

  it("author preview list and get are bounded metadata reads", async () => {
    const f = fixture();
    await f.capture();
    f.runtime.reserveRun({ ...run, runId: "z" }, geometry);
    const before = f.commands().length;
    const first = f.runtime.previews.cache.list({ limit: 1 });
    const second = f.runtime.previews.cache.list({ limit: 1, afterRunId: first.nextAfterRunId });
    expect(RPC_METHODS["terminal.list"].result.safeParse(first).success).toBe(true);
    expect(
      RPC_METHODS["terminal.get"].result.safeParse({
        record: f.runtime.previews.cache.getRecord(run),
      }).success,
    ).toBe(true);
    expect(first.runs.map((record) => record.run.runId)).toEqual(["run"]);
    expect(second.runs.map((record) => record.run.runId)).toEqual(["z"]);
    expect(second.runs[0].preview).toEqual({
      version: null,
      generatedAtMs: null,
      checkedAtMs: null,
      stale: true,
      byteLength: 0,
    });
    expect(f.commands().length).toBe(before);
    expect(f.runtime.previews.cache.getRecord({ ...run, relayInstanceId: "foreign" })).toBeNull();
    await cleaned(f);
  });

  it("author preview expiry fences late result until retirement barrier", async () => {
    const f = fixture({}, { expiryMs: 100 });
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending);
    const t = f.transfer(command);
    f.session.receive(coalesce(t.start, t.chunk));
    f.clock(100);
    f.runtime.tickPreviews();
    expect((await pending).error.kind).toBe("RECOVERY_EXPIRED");
    expect(f.runtime.previews.snapshot().active).toBe(1);
    expect((await f.runtime.previews.refresh(run)).error.kind).toBe("BUSY");
    f.session.receive(coalesce(t.end, t.result));
    await pump();
    expect(f.runtime.previews.snapshot().active).toBe(0);
    expect(f.runtime.previews.cache.snapshot().entries).toBe(0);
    await cleaned(f);
  });

  it("author preview equal deadline result-first seals before later tick", async () => {
    const f = fixture({}, { expiryMs: 50 });
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending, 2);
    const t = f.transfer(command, new Uint8Array([66]), 2);
    f.clock(50);
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(2);
    f.runtime.tickPreviews();
    expect(await pending).toEqual({ ok: true });
    expect(f.runtime.previews.cache.getRecord(run).preview.stale).toBe(false);
    await cleaned(f);
  });

  it("author preview equal deadline tick-first preserves expiry and old bytes", async () => {
    const f = fixture({}, { expiryMs: 50 });
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending, 2);
    const t = f.transfer(command, new Uint8Array([66]), 2);
    f.session.receive(coalesce(t.start, t.chunk, t.end));
    f.clock(50);
    f.runtime.tickPreviews();
    expect((await pending).error.kind).toBe("RECOVERY_EXPIRED");
    expect((await f.runtime.previews.refresh(run)).error.kind).toBe("BUSY");
    f.session.receive(t.result);
    await pump();
    expect(f.runtime.previews.snapshot().active).toBe(0);
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    expect(f.runtime.previews.cache.getRecord(run).preview.stale).toBe(true);
    await cleaned(f);
  });

  it("author preview strictly late result refuses without an expiry tick", async () => {
    const f = fixture({}, { expiryMs: 50 });
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(pending, 2);
    const t = f.transfer(command, new Uint8Array([66]), 2);
    f.clock(51);
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect((await pending).error.kind).toBe("RECOVERY_EXPIRED");
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    expect(f.runtime.previews.cache.getRecord(run).preview.stale).toBe(true);
    await cleaned(f);
  });

  it("author preview cached post-status seal succeeds at equality before tick", async () => {
    const f = fixture({}, { expiryMs: 50 });
    await f.capture();
    const before = f.runtime.previews.cache.acquire(run);
    const pending = f.runtime.previews.refresh(run);
    await pump();
    f.clock(50);
    f.wall(600);
    f.session.receive(f.reply(f.latest(), { runStatus: f.status(1) }));
    await pump();
    f.runtime.tickPreviews();
    expect(await pending).toEqual({ ok: true });
    const after = f.runtime.previews.cache.acquire(run);
    expect(after.picture.vt).toBe(before.picture.vt);
    expect(after.picture.generatedAtMs).toBe(before.picture.generatedAtMs);
    expect(after.picture.checkedAtMs).toBe(600);
    expect(after.picture.stale).toBe(false);
    expect(f.commands().filter((c) => c.type === "preview-refresh")).toHaveLength(1);
    before.release();
    after.release();
    await cleaned(f);
  });

  it("author preview cached expiry tick wins between status ingress and async seal", async () => {
    const f = fixture({}, { expiryMs: 50 });
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    await pump();
    f.clock(50);
    f.session.receive(f.reply(f.latest(), { runStatus: f.status(1) }));
    f.runtime.tickPreviews();
    expect((await pending).error.kind).toBe("RECOVERY_EXPIRED");
    await pump();
    const reader = f.runtime.previews.cache.acquire(run);
    expect(reader.picture.checkedAtMs).toBe(100);
    expect(reader.picture.stale).toBe(true);
    expect(f.commands().filter((c) => c.type === "preview-refresh")).toHaveLength(1);
    reader.release();
    await cleaned(f);
  });

  it("author preview cached strictly late status refuses without a tick", async () => {
    const f = fixture({}, { expiryMs: 50 });
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    await pump();
    f.clock(51);
    f.session.receive(f.reply(f.latest(), { runStatus: f.status(1) }));
    expect((await pending).error.kind).toBe("RECOVERY_EXPIRED");
    expect(f.runtime.previews.cache.getRecord(run).preview.stale).toBe(true);
    expect(f.commands().filter((c) => c.type === "preview-refresh")).toHaveLength(1);
    await cleaned(f);
  });

  it("author preview empty admission hint still publishes complete new picture", async () => {
    const f = fixture();
    const c = f.connect();
    const pending = c.preview("fresh-hint", 7);
    const { command } = await f.toPreview(pending, 7);
    expect(command.knownVersion).toBeUndefined();
    const t = f.transfer(command, new Uint8Array([65, 66]), 7);
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect((await pending).status).toBe("transfer");
    expect(c.events().map((e) => e.metadata.type)).toEqual([
      "preview-start",
      "preview-chunk",
      "preview-end",
      "preview-result",
    ]);
    expect([...c.events()[1].payload]).toEqual([65, 66]);
    expect(c.service.snapshot().routes).toBe(0);
    await cleaned(f);
  });

  it("author preview concurrent empty admissions transfer then owned admission reuses", async () => {
    const f = fixture();
    const c = f.connect();
    const first = c.preview("empty-one", 7);
    const second = c.preview("empty-two", 7);
    const { command } = await f.toPreview(first, 7);
    const t = f.transfer(command, new Uint8Array([65]), 7);
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect((await first).status).toBe("transfer");
    expect((await second).status).toBe("transfer");
    expect(c.events()[0].metadata.previewId).not.toBe(c.events()[4].metadata.previewId);
    const later = c.preview("owned-three", 7);
    await f.toPreview(later, 7);
    expect((await later).status).toBe("unchanged");
    expect(c.events().filter((e) => e.metadata.type === "preview-start")).toHaveLength(2);
    expect(f.commands().filter((c) => c.type === "preview-refresh")).toHaveLength(1);
    await cleaned(f);
  });

  it("author preview publishes FIFO bytes with fresh transfer identities", async () => {
    const f = fixture();
    await f.capture();
    const c = f.connect();
    const p = c.preview("one");
    await f.toPreview(p, 1);
    expect((await p).status).toBe("transfer");
    expect(c.events().map((item) => item.metadata.type)).toEqual([
      "preview-start",
      "preview-chunk",
      "preview-end",
      "preview-result",
    ]);
    expect([...c.events()[1].payload]).toEqual([65]);
    const p2 = c.preview("two");
    await f.toPreview(p2, 1);
    await p2;
    expect(c.events()[0].metadata.previewId).not.toBe(c.events()[4].metadata.previewId);
    const unchanged = c.preview("three", 1);
    await f.toPreview(unchanged, 1);
    expect((await unchanged).status).toBe("unchanged");
    expect(c.service.snapshot().routes).toBe(0);
    expect(
      f
        .commands()
        .some((command) =>
          ["subscribe", "set-control", "input", "resize", "stop"].includes(command.type),
        ),
    ).toBe(false);
    expect((await c.preview("three", 1)).error.kind).toBe("COUNTER_EXHAUSTED");
    await cleaned(f);
  });

  // identityLimit bounds concurrent refresh/transfer identities, never the lifetime total;
  // a lifetime cap left every preview permanently stale after identityLimit refreshes.
  it("author preview keeps refreshing past the identity limit", async () => {
    const f = fixture({}, { identityLimit: 2 });
    // Odd versions keep each status ahead of the cached picture, forcing a real transfer.
    for (let version = 1; version <= 11; version += 2) {
      expect(await f.capture(new Uint8Array([64 + version]), version)).toEqual({ ok: true });
      expect(f.runtime.previews.snapshot().transferIds).toBe(0);
    }
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(11);
    await cleaned(f);
  });

  it("author preview close cancels waiter while shared refresh continues", async () => {
    const f = fixture();
    const c = f.connect();
    const closed = c.preview("closing");
    const healthy = f.runtime.previews.refresh(run);
    const { command } = await f.toPreview(healthy);
    c.service.close();
    expect((await closed).error.kind).toBe("STALE_CONNECTION");
    const t = f.transfer(command);
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect(await healthy).toEqual({ ok: true });
    expect(c.writes).toHaveLength(0);
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    await cleaned(f);
  });

  it("author preview close preserves physically held publication debt", async () => {
    const f = fixture();
    await f.capture();
    const c = f.connect();
    c.block();
    const pending = c.preview("held");
    await f.toPreview(pending, 1);
    await pending;
    expect(c.writes).toHaveLength(1);
    expect(decode(c.writes[0].data, false).metadata.type).toBe("preview-start");
    c.service.close();
    await pump();
    expect(c.delivery.snapshot().queued).toBe(0);
    expect(c.delivery.snapshot().physicalBytes).toBeGreaterThan(0);
    const before = f.bytes.snapshot().total;
    c.writes[0].settled();
    c.writes[0].settled();
    expect(c.delivery.snapshot().physicalBytes).toBe(0);
    expect(f.bytes.snapshot().total).toBeLessThan(before);
    await cleaned(f);
  });

  it("author preview preserves actual unknown status cause and last picture", async () => {
    const f = fixture();
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    await pump();
    f.session.loseContact();
    const outcome = await pending;
    expect(outcome.error.kind).toBe("RESULT_UNKNOWN");
    expect(outcome.error.acceptance).toBe("unknown");
    expect(f.runtime.previews.cache.getRecord(run).status).toBe("unverifiable");
    expect(f.runtime.previews.cache.getRecord(run).preview.version).toBe(1);
    await cleaned(f);
  });

  it("author preview geometry changes require fresh producer bytes", async () => {
    const f = fixture();
    await f.capture();
    const pending = f.runtime.previews.refresh(run);
    const nextGeometry = { cols: 90, rows: 24 };
    const { command } = await f.toPreview(pending, 1, { geometry: nextGeometry });
    expect(command.type).toBe("preview-refresh");
    expect(command.knownVersion).toBeUndefined();
    const t = f.transfer(command, new Uint8Array([66]), 2, { geometry: nextGeometry });
    f.session.receive(coalesce(t.start, t.chunk, t.end, t.result));
    expect(await pending).toEqual({ ok: true });
    const reader = f.runtime.previews.cache.acquire(run);
    expect(reader.picture.geometry).toEqual(nextGeometry);
    reader.release();
    await cleaned(f);
  });

  it("author preview rejects future external version with valid counterpart", async () => {
    const f = fixture();
    await f.capture();
    const c = f.connect();
    const future = c.preview("future", 2);
    await f.toPreview(future, 1);
    expect((await future).error.kind).toBe("RESYNC_REQUIRED");
    const valid = c.preview("valid", 1);
    await f.toPreview(valid, 1);
    expect((await valid).status).toBe("unchanged");
    expect(c.events().filter((event) => event.metadata.type === "preview-start")).toHaveLength(0);
    await cleaned(f);
  });
});
