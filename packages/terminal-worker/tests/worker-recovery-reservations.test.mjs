import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import { PreviewService } from "../dist/src/preview-service.js";
import { RecoverySubscriptions } from "../dist/src/recovery-subscription.js";
import { ReplayWindow, retainedFactCharge } from "../dist/src/replay-window.js";
import { WorkerRetainedBytes } from "../dist/src/worker-retained-bytes.js";

const worker = {
  serverId: "server",
  relayInstanceId: "relay",
  workerId: "worker",
  workerIncarnationId: "incarnation",
};
const run = { serverId: "server", relayInstanceId: "relay", runId: "run" };
const ref = {
  run,
  connection: { connectionId: "connection", generation: 1 },
  viewId: "view",
  subscriptionId: "subscription",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function observedReservations(account) {
  const receipts = [];
  return {
    receipts,
    reserve(bytes, owner) {
      const lease = account.reserve("worker", bytes);
      const receipt = { bytes, owner, held: lease ? bytes : 0, accepted: !!lease };
      receipts.push(receipt);
      if (!lease) return undefined;
      return {
        release() {
          lease.release();
          receipt.held = 0;
        },
        shrinkTo(next) {
          lease.shrinkTo(next);
          receipt.held = next;
        },
      };
    },
    check() {
      expect(receipts.reduce((sum, receipt) => sum + receipt.held, 0)).toBe(
        account.snapshot().workerBytes,
      );
    },
  };
}

function baseline() {
  return {
    status: "ready",
    baseline: {
      profile: PROFILE,
      encoding: BASELINE_ENCODING,
      checkpointSeq: 0,
      atSeq: 0,
      captureGeometry: { cols: 12, rows: 4 },
      currentGeometry: { cols: 12, rows: 4 },
      coverage: {
        normal: {
          historyLines: 0,
          includedHistoryLines: 0,
          trimmedBefore: false,
          resizeContext: "complete",
        },
        alternate: { included: true, resizeContext: "complete" },
      },
      vt: Uint8Array.from([65]),
      tail: new Uint8Array(),
      appearance: DEFAULT_APPEARANCE,
    },
  };
}

test("W2 replay tags actual fact and selection leases without changing their charges", () => {
  const account = new WorkerRetainedBytes(16_384, 4112);
  const observed = observedReservations(account);
  const replay = new ReplayWindow(4096, 4, observed.reserve);
  const fact = { event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([65]) };
  replay.append(fact);
  expect(observed.receipts[0]).toMatchObject({
    owner: "replay-fact",
    bytes: retainedFactCharge(fact),
    accepted: true,
  });
  const selected = replay.select(0, 1);
  expect(observed.receipts[1]).toMatchObject({
    owner: "replay-selected-references",
    bytes: 128,
    accepted: true,
  });
  observed.check();
  replay.clear();
  observed.check();
  selected.release();
  observed.check();
  expect(account.snapshot().workerBytes).toBe(0);

  const denied = observedReservations(new WorkerRetainedBytes(100, 0));
  const unavailable = new ReplayWindow(4096, 4, denied.reserve);
  unavailable.append(fact);
  expect(denied.receipts).toMatchObject([
    { owner: "replay-fact", bytes: retainedFactCharge(fact), accepted: false, held: 0 },
  ]);
  denied.check();
});

test("W2 recovery tags baseline, pinned and copied live facts, and sent debt exactly once", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const observed = observedReservations(account);
  const emitted = [];
  const replay = new ReplayWindow(4096, 4, observed.reserve);
  const recovery = new RecoverySubscriptions(worker, M0_LIMITS, observed.reserve, {
    enqueue(event, payload) {
      emitted.push(event);
      return 16 + new TextEncoder().encode(JSON.stringify(event)).byteLength + payload.length;
    },
    cancelUnsent() {},
  });
  let ordinal = 0;
  const command = (type, fields = {}) => ({
    type,
    worker,
    run,
    requestId: `tag-${++ordinal}`,
    subscription: ref,
    ...fields,
  });
  try {
    const subscribe = command("subscribe", { atSeq: 0 });
    const opened = await recovery.open(subscribe, {
      run,
      replay,
      captureBaseline: async (reserveDetached) => {
        expect(reserveDetached(4097)).toBe(true);
        return baseline();
      },
    });
    expect(opened.result.recoveryMode).toBe("baseline");
    recovery.markerEnqueued(subscribe, opened.result);
    await tick();
    const baselineId = emitted[0].terminal.descriptor.baselineId;
    expect(
      recovery.command(command("baseline-progress", { baselineId, lastParsedOrdinal: 0 })).result
        .outcome,
    ).toBe("accepted");
    expect(recovery.command(command("applied-ack", { appliedSeq: 0 })).result.outcome).toBe(
      "accepted",
    );
    expect(recovery.installed(ref)).toBe(true);
    const pinned = { event: { type: "output", run, seq: 1 }, bytes: Uint8Array.from([66]) };
    replay.append(pinned);
    recovery.onFact(run, pinned, replay);
    await tick();
    const copied = { event: { type: "output", run, seq: 2 }, bytes: Uint8Array.from([67]) };
    recovery.onFact(run, copied);
    await tick();
    expect(emitted.slice(3).map((event) => event.terminal.seq)).toEqual([1, 2]);
    observed.check();
    const byOwner = Object.groupBy(observed.receipts, (receipt) => receipt.owner);
    for (const owner of [
      "recovery-connection",
      "recovery-route",
      "recovery-baseline",
      "recovery-transfer-frames",
      "recovery-post-n-pin",
      "recovery-post-n-copy",
      "recovery-sent-ledger",
    ])
      expect(byOwner[owner]?.length).toBeGreaterThan(0);
    expect(byOwner["recovery-connection"][0].bytes).toBe(8320);
    expect(byOwner["recovery-route"][0].bytes).toBe(8320);
    expect(byOwner["recovery-baseline"][0].bytes).toBe(4097);
    expect(byOwner["recovery-post-n-pin"][0].bytes).toBe(128);
    expect(byOwner["recovery-post-n-copy"][0].bytes).toBe(retainedFactCharge(copied));
    expect(byOwner["recovery-sent-ledger"].every((receipt) => receipt.bytes === 256)).toBe(true);
  } finally {
    recovery.shutdown();
    replay.clear();
  }
  observed.check();
  expect(account.snapshot().workerBytes).toBe(0);
});

test("W2 preview transfer tag follows the existing lease lifetime", async () => {
  const account = new WorkerRetainedBytes(M0_LIMITS.workerBytes, M0_LIMITS.reservedControlBytes);
  const observed = observedReservations(account);
  const preview = new PreviewService(
    worker,
    M0_LIMITS,
    observed.reserve,
    { enqueue: () => false, cancelUnsent() {} },
    (_runId, operation) => operation(),
  );
  try {
    const pending = preview.refresh(
      { type: "preview-refresh", worker, run, requestId: "tag-preview" },
      run,
      async () => ({
        status: "ready",
        preview: { atSeq: 1, geometry: { cols: 12, rows: 4 }, vt: Uint8Array.from([65]) },
      }),
    );
    await tick();
    expect(observed.receipts).toMatchObject([
      {
        owner: "preview-transfer",
        bytes: M0_LIMITS.previewBytesPerRun + 3 * 4096,
        accepted: true,
      },
    ]);
    observed.check();
    preview.shutdown();
    expect((await pending).failure).toBe("RESULT_UNKNOWN");
  } finally {
    preview.shutdown();
  }
  observed.check();
  expect(account.snapshot().workerBytes).toBe(0);
});
