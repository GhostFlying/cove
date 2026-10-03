import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  controlledView,
  deferred,
  frames,
  geometry,
  hash,
  record,
  turns,
  untilTurn,
  utf8,
  withWorkerLink,
} from "./current-worker-byte-link.mjs";

const commandTypes = (rig) =>
  rig.commands.filter((value) => value.type !== "hello").map((value) => value.type);
const external = (peer, type) =>
  peer.uplink.filter((value) => value.metadata.type === type).map((value) => value.metadata);
const actualPreview = (rig) => {
  const chunks = rig.received.filter(
    (value) =>
      value.metadata.type === "terminal-event" && value.metadata.terminal.type === "preview-chunk",
  );
  const lastId = chunks.at(-1)?.metadata.terminal.previewId;
  return Buffer.concat(
    chunks
      .filter((value) => value.metadata.terminal.previewId === lastId)
      .map((value) => Buffer.from(frames(Buffer.from(value.rawHex, "hex"))[0].payload)),
  );
};
async function installed(peer) {
  const opened = await peer.terminal();
  assert((await opened.controller.attach()).ok);
  await untilTurn(
    () =>
      peer.service.snapshot(opened.controller.snapshot().subscription.subscriptionId).route.credit
        .installed,
    "actual worker/client final ACK",
  );
  return opened;
}
function orderedMarker(trace, requestId) {
  const marker = trace.findIndex(
    (value) => value.metadata.type === "result" && value.metadata.requestId === requestId,
  );
  const baseline = trace.findIndex(
    (value) =>
      value.metadata.type === "terminal-event" && value.metadata.terminal.type === "baseline-start",
  );
  assert(marker >= 0 && baseline > marker, "result-before-activation marker");
}

describe("W2 current server and public client", () => {
  it("W2C-C01 actual worker preview bytes reach current cache and built public client", async () => {
    await withWorkerLink(async (rig) => {
      await rig.emit(utf8("W2-C01"));
      const peer = await rig.peer();
      const before = rig.endpoint.execution.snapshot();
      const outcome = await peer.client.getPreview(rig.run);
      assert(outcome.ok && outcome.status === "transfer");
      assert.equal(outcome.version, 1);
      assert.equal(outcome.atSeq, 1);
      assert.deepEqual(outcome.geometry, geometry);
      assert.deepEqual(Buffer.from(outcome.bytes), actualPreview(rig));
      const reader = rig.runtime.previews.cache.acquire(rig.run);
      assert(reader);
      try {
        assert.deepEqual(Buffer.from(reader.picture.vt), actualPreview(rig));
        assert.deepEqual(reader.picture.run, rig.run);
        assert.deepEqual(reader.picture.worker, rig.worker);
      } finally {
        reader.release();
      }
      assert(
        commandTypes(rig).every((type) => ["spawn", "status", "preview-refresh"].includes(type)),
      );
      assert.equal(rig.endpoint.native.owners[0].tasks.length, 0);
      assert.equal(rig.endpoint.execution.snapshot().inputIdentities, before.inputIdentities);
      assert.equal(peer.service.snapshot().active, 0);
      record("W2C-C01", {
        outcome: {
          ...outcome,
          bytes: undefined,
          sha256: hash(outcome.bytes),
          length: outcome.bytes.length,
        },
        commands: rig.commands,
        received: rig.received,
        cache: rig.runtime.previews.cache.getRecord(rig.run),
        owners: [...rig.live.values()],
      });
    });
  });

  it("W2C-C02 owned status reuse and empty-cache same-hint requests produce truthful results", async () => {
    await withWorkerLink(async (rig) => {
      await rig.emit(utf8("W2-C02"));
      const peer = await rig.peer();
      rig.capture("C02-first-before");
      const first = await peer.client.getPreview(rig.run);
      rig.capture("C02-first-returned", { first });
      assert(first.ok && first.status === "transfer");
      const captures = rig.commands.filter((value) => value.type === "preview-refresh").length;
      rig.time.advance(51);
      rig.capture("C02-same-before", { first, captures });
      const same = await peer.client.getPreview(rig.run, first.version);
      rig.capture("C02-same-returned", { first, same, captures });
      assert.deepEqual(same, { ok: true, status: "unchanged", version: first.version });
      assert.equal(
        rig.commands.filter((value) => value.type === "preview-refresh").length,
        captures,
      );
      assert(rig.commands.filter((value) => value.type === "status").length >= 2);
      const old = rig.runtime.previews.cache.getRecord(rig.run);
      rig.capture("C02-owned-cache-before-assertions", { old });
      assert.equal(old.preview.checkedAtMs, 1051);
      assert.equal(rig.time.now(), 51);
      assert(Number.isSafeInteger(old.preview.generatedAtMs));
      await rig.emit(utf8("+changed"));
      rig.time.advance(102);
      const changed = await peer.client.getPreview(rig.run, first.version);
      rig.capture("C02-changed-returned", { changed });
      assert(changed.ok && changed.status === "transfer");
      assert.equal(changed.version, 2);
      assert.deepEqual(Buffer.from(changed.bytes), actualPreview(rig));
      const opened = await installed(peer);
      const focus = await opened.controller.requestFocus(geometry);
      rig.capture("C02-focus-returned", { focus });
      assert(focus.ok);
      await turns(4);
      const resize = await opened.controller.requestResize({ cols: 13, rows: 4 });
      rig.capture("C02-resize-returned", { resize });
      assert(resize.ok);
      await turns(4);
      rig.time.advance(153);
      const resized = await peer.client.getPreview(rig.run, changed.version);
      rig.capture("C02-resized-returned", { resized });
      assert(resized.ok && resized.status === "transfer");
      assert.deepEqual(resized.geometry, { cols: 13, rows: 4 });
      assert.equal(resized.version, 4);
      assert.deepEqual(Buffer.from(resized.bytes), actualPreview(rig));
      record("W2C-C02-owned", {
        same,
        changed: { ...changed, bytes: undefined, sha256: hash(changed.bytes) },
        localClock: rig.time.now(),
        workerDiagnosticWall: old.preview.generatedAtMs,
        cache: rig.runtime.previews.cache.getRecord(rig.run),
        commands: rig.commands,
      });
    });
    await withWorkerLink(async (rig) => {
      await rig.emit(utf8("W2-C02"));
      const a = await rig.peer();
      const b = await rig.peer();
      const empty = rig.runtime.previews.cache.snapshot();
      rig.capture("C02-empty-before", { empty });
      assert.equal(empty.entries, 0);
      const pendingA = a.client.getPreview(rig.run, 1);
      const pendingB = b.client.getPreview(rig.run, 1);
      const results = await Promise.all([pendingA, pendingB]);
      rig.capture("C02-empty-returned", { results });
      for (const value of results) {
        assert(value.ok && value.status === "transfer");
        assert.equal(value.version, 1);
        assert.deepEqual(Buffer.from(value.bytes), actualPreview(rig));
      }
      const ids = [a, b].map(
        (peer) =>
          peer.downlink.find((value) => value.metadata.type === "preview-start").metadata.previewId,
      );
      assert.notEqual(ids[0], ids[1]);
      assert.equal(rig.commands.filter((value) => value.type === "preview-refresh").length, 1);
      assert.equal(
        rig.commands.find((value) => value.type === "preview-refresh").knownVersion,
        undefined,
      );
      record("W2C-C02-empty", {
        ids,
        commands: rig.commands,
        downlink: [a.downlink, b.downlink],
        results: results.map((value) => ({
          ...value,
          bytes: undefined,
          sha256: hash(value.bytes),
        })),
      });
    });
  });

  it("W2C-C03 actual worker recovery crosses B1 mapper and client parse before ACK", async () => {
    await withWorkerLink(
      async (rig) => {
        await rig.emit(utf8("W2-C03"));
        const peer = await rig.peer();
        const view = controlledView();
        view.controls.chunk = deferred();
        view.controls.finish = deferred();
        const { controller } = await peer.terminal(view);
        const attached = controller.attach();
        await untilTurn(
          () => view.facts.some((fact) => fact.type === "chunk"),
          "actual mapped chunk reaches held public view",
        );
        assert.equal(external(peer, "baseline-progress").length, 0);
        assert.equal(external(peer, "applied-ack").length, 0);
        const subscription = controller.snapshot().subscription;
        assert(subscription);
        assert.equal(
          peer.service.snapshot(subscription.subscriptionId).route.credit.installed,
          false,
        );
        const subscribe = rig.commands.find((value) => value.type === "subscribe");
        orderedMarker(rig.received, subscribe.requestId);
        const realOrder = rig.received.slice();
        const marker = realOrder.find(
          (value) =>
            value.metadata.requestId === subscribe.requestId && value.metadata.type === "result",
        );
        assert.throws(() =>
          orderedMarker(
            realOrder.filter((value) => value !== marker),
            subscribe.requestId,
          ),
        );
        const without = realOrder.filter((value) => value !== marker);
        assert.throws(() => orderedMarker([...without, marker], subscribe.requestId));
        view.controls.chunk.resolve();
        await untilTurn(
          () => view.facts.some((fact) => fact.type === "finish"),
          "parse reaches final held installation",
        );
        assert(external(peer, "baseline-progress").length > 0);
        assert.equal(external(peer, "applied-ack").length, 0);
        const oldBaseline = view.facts.find((fact) => fact.type === "begin").descriptor.baselineId;
        view.controls.finish.resolve();
        assert((await attached).ok);
        await untilTurn(
          () => peer.service.snapshot(subscription.subscriptionId).route.credit.installed,
          "parsed final ACK installs actual source",
        );
        const before = view.facts.filter((fact) => fact.type === "begin").length;
        assert((await controller.recover("gap")).ok);
        await untilTurn(
          () => peer.service.snapshot(subscription.subscriptionId).route.credit.installed,
          "equal-N new baseline final ACK",
        );
        const starts = view.facts.filter((fact) => fact.type === "begin");
        assert.equal(starts.length, before + 1);
        assert.equal(starts.at(-1).descriptor.atSeq, starts[0].descriptor.atSeq);
        assert.notEqual(starts.at(-1).descriptor.baselineId, oldBaseline);
        assert.deepEqual(controller.snapshot().subscription, subscription);
        const oldProgress = external(peer, "baseline-progress").find(
          (value) => value.baselineId === oldBaseline,
        );
        assert(oldProgress);
        const stale = await peer.service.handle({
          ...oldProgress,
          requestId: "consumer-stale-baseline-counter",
        });
        assert.equal(stale.type, "error");
        await rig.emit(utf8("suffix"));
        await untilTurn(
          () => controller.snapshot().appliedSeq === 2,
          "live suffix parsed after final ACK",
        );
        assert.equal(
          view.facts.filter((fact) => fact.type === "event" && fact.event.seq === 2).length,
          1,
        );
        assert.equal(rig.endpoint.native.owners[0].tasks.length, 0);
        assert(!commandTypes(rig).includes("input"));
        record("W2C-C03", {
          subscription,
          view: view.facts,
          uplink: peer.uplink,
          workerFrames: rig.received,
          stale,
          worker: rig.endpoint.execution.snapshot(),
        });
      },
      { pendingWorkerCommands: 1 },
    );
    for (const mutation of ["marker-removed", "marker-reordered"])
      await withWorkerLink(
        async (rig) => {
          await rig.emit(utf8("W2-C03"));
          const peer = await rig.peer();
          const { controller, controlled } = await peer.terminal();
          rig.setMutation(mutation);
          const pending = controller.attach();
          await turns(16);
          assert(
            rig.endpoint.frames.some(
              (value) =>
                value.metadata.type === "terminal-event" &&
                value.metadata.terminal.type === "baseline-start",
            ),
            "actual producer emitted a baseline for mutation",
          );
          assert.equal(
            controlled.facts.some((value) => value.type === "begin"),
            false,
          );
          rig.time.advance(15001);
          rig.session.tick();
          peer.service.tick();
          await turns(4);
          assert.equal((await pending).ok, false);
          assert.notEqual(controller.snapshot().phase, "ready");
          assert.equal(external(peer, "applied-ack").length, 0);
          record("W2C-C03-marker-fault", {
            mutation,
            actualProducer: rig.endpoint.frames.map((value) => value.metadata),
            observed: rig.received,
            controller: controller.snapshot(),
          });
        },
        { pendingWorkerCommands: 1 },
      );
  });

  it("W2C-C04 held connection debt and close isolate peer progress without stopping source", async () => {
    await withWorkerLink(async (rig) => {
      await rig.emit(utf8("W2-C04"));
      const held = await rig.peer({ hold: true });
      const healthy = await rig.peer();
      const a = await installed(held);
      const b = await installed(healthy);
      assert(held.delivery.snapshot().physicalBytes > 0);
      const physical = held.delivery.snapshot().physicalBytes;
      const ownCallbacks = [...held.physical];
      const liveBefore = new Set(rig.live.keys());
      held.close();
      assert.equal(held.delivery.snapshot().physicalBytes, physical);
      assert(ownCallbacks.every((item) => held.physical.has(item)));
      rig.endpoint.hold();
      await rig.emit(utf8("LIVE"));
      await untilTurn(
        () => rig.endpoint.callbacks.length > 0,
        "actual source physical callback held",
      );
      assert(rig.endpoint.pipe.snapshot().transportBytes > 0);
      const sourceHeld = rig.endpoint.pipe.snapshot();
      rig.endpoint.hold(false);
      while (rig.endpoint.callbacks.length) rig.endpoint.release();
      await untilTurn(
        () => b.controller.snapshot().appliedSeq === 2,
        "healthy peer parsed current source after callback",
      );
      const pending = healthy.client.getPreview(rig.run);
      const preview = await pending;
      assert(preview.ok && preview.status === "transfer");
      assert.equal(rig.registry.get(rig.run).status.status, "live");
      assert(!commandTypes(rig).includes("stop"));
      assert.equal(held.delivery.snapshot().physicalBytes, physical);
      const leasesBefore = new Set(rig.live.keys());
      held.settle();
      assert.equal(held.delivery.snapshot().physicalBytes, 0);
      assert([...leasesBefore].some((id) => !rig.live.has(id)));
      assert.equal(held.physical.size, 0);
      assert.equal(b.controller.snapshot().phase, "ready");
      assert.equal(a.controller.snapshot().phase, "disposed");
      record("W2C-C04", {
        physical,
        sourceHeld,
        exactBefore: [...liveBefore],
        callbacks: ownCallbacks.length,
        leases: rig.leaseEvents,
        worker: rig.endpoint.execution.snapshot(),
        healthy: b.controller.snapshot(),
        preview: { ...preview, bytes: undefined, sha256: hash(preview.bytes) },
      });
    });
  });

  it("W2C-C05 result-before-end mutation is refused while identical result-last succeeds", async () => {
    for (const mutation of ["preview-result-before-end", "preview-coalesced"])
      await withWorkerLink(async (rig) => {
        await rig.emit(utf8("W2-C05"));
        const peer = await rig.peer();
        const initial = await peer.client.getPreview(rig.run);
        assert(initial.ok && initial.status === "transfer");
        const good = rig.runtime.previews.cache.acquire(rig.run);
        assert(good);
        const originalHash = hash(good.picture.vt);
        good.release();
        await rig.emit(utf8("+changed"));
        rig.time.advance(51);
        rig.setMutation(mutation);
        const failed = await peer.client.getPreview(rig.run);
        assert.equal(failed.ok, false);
        assert.equal(failed.error.kind, "RECOVERY_UNAVAILABLE");
        assert.equal(rig.mutations.length, 1);
        const retained = rig.runtime.previews.cache.acquire(rig.run);
        assert(retained);
        try {
          assert.equal(hash(retained.picture.vt), originalHash);
          assert.equal(retained.picture.version, 1);
          assert.equal(retained.picture.stale, true);
        } finally {
          retained.release();
        }
        await turns(4);
        assert.equal(rig.runtime.previews.cache.getRecord(rig.run).preview.version, 1);
        assert.equal(rig.runtime.previews.cache.getRecord(rig.run).preview.stale, true);
        const mutatedPayload = actualPreview(rig);
        rig.setMutation(undefined);
        rig.time.advance(102);
        const valid = await peer.client.getPreview(rig.run);
        assert(valid.ok && valid.status === "transfer");
        assert.equal(valid.version, 2);
        assert.deepEqual(Buffer.from(valid.bytes), mutatedPayload);
        assert.deepEqual(Buffer.from(valid.bytes), actualPreview(rig));
        record("W2C-C05", {
          mutation,
          rawMutation: rig.mutations,
          failed,
          valid: { ...valid, bytes: undefined, sha256: hash(valid.bytes) },
          lastGoodHash: originalHash,
          commands: rig.commands,
          byteOrder: rig.received,
        });
      });
  });
});
