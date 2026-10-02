import { describe, it, expect } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { MAX_FRAME_BYTES } from "@cove/protocol/terminal";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { TerminalConnectionDelivery } from "../../dist/terminal/terminal-connection-delivery.js";
import { TerminalDeliveryCredit } from "../../dist/terminal/terminal-delivery-credit.js";
import { baseline, codec, run, decode } from "./subscription-byte-peer.mjs";

function fixture(changes = {}, itemLimit = 128) {
  const budgets = { ...M0_LIMITS, ...changes };
  const bytes = new RuntimeRetainedBytes(budgets.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", budgets, bytes);
  const connection = { connectionId: "connection", generation: 0 };
  const subscription = { run, connection, subscriptionId: "subscription", viewId: "view" };
  const writes = [];
  let blocked = false;
  let onWrite;
  const delivery = new TerminalConnectionDelivery(composition, {
    connection,
    encodeUtf8: codec.encode,
    itemLimit,
    transport: {
      write: (data, settled) => {
        writes.push({ data, settled });
        onWrite?.();
        return !blocked;
      },
    },
  });
  const token = { current: true };
  const fence = { route: "subscription", attempt: 1, current: () => token.current };
  const credit = new TerminalDeliveryCredit(composition, 1, "replay", 0, 0);
  const output = (seq, size = 1, route = subscription) => ({
    metadata: { type: "run-event", subscription: route, event: { type: "output", run, seq } },
    payload: new Uint8Array(size),
  });
  const send = ({ metadata, payload }, ledger = credit, selected = fence) =>
    delivery.admit(metadata, payload, {
      control: false,
      fence: selected,
      prepare: (size) => {
        const record = ledger.record(metadata, size, payload.length);
        return record
          ? { eligible: () => ledger.eligible(record), handoff: () => ledger.handoff(record) }
          : null;
      },
    });
  const marker = (requestId, selected = fence) =>
    delivery.admit(
      { type: "recover-result", requestId, run, subscription, mode: "replay", atSeq: 0 },
      new Uint8Array(),
      { control: true, fence: selected },
    );
  return {
    composition,
    bytes,
    delivery,
    credit,
    subscription,
    writes,
    token,
    fence,
    output,
    send,
    marker,
    block: () => {
      blocked = true;
    },
    unblock: () => {
      blocked = false;
      delivery.drain();
    },
    onWrite: (callback) => {
      onWrite = callback;
    },
    close: () => {
      token.current = false;
      credit.retire();
      delivery.transportReleased();
    },
  };
}

describe("bounded external delivery and parsed credit", () => {
  it("uses actual external encoded lengths, keeps debt after socket callbacks and rejects forged future credit", () => {
    const f = fixture();
    try {
      expect(f.send(f.output(1, 64))).toBe(true);
      expect(f.credit.snapshot().debtBytes).toBe(f.writes[0].data.byteLength);
      expect(f.credit.snapshot().debtBytes).toBeGreaterThan(64 + 16);
      f.writes[0].settled();
      expect(f.delivery.snapshot().physicalBytes).toBe(0);
      const debt = f.credit.snapshot().debtBytes;
      expect(f.credit.ack(2)).toBe(false);
      expect(f.credit.snapshot().debtBytes).toBe(debt);
      expect(f.credit.ack(1)).toBe(true);
      expect(f.credit.snapshot().debtBytes).toBe(0);
      expect(f.credit.ack(1)).toBe(true);
      expect(f.credit.snapshot().debtBytes).toBe(0);
    } finally {
      f.close();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("preserves a blocked FIFO across cancel, new marker and same-sequence new attempt", () => {
    const f = fixture();
    let next;
    try {
      f.block();
      f.send(f.output(1));
      f.send(f.output(2));
      const handed = f.writes[0];
      const physical = f.delivery.snapshot().physicalBytes;
      f.delivery.cancel(f.fence);
      f.token.current = false;
      f.credit.retire();
      const newFence = { route: "subscription", attempt: 2, current: () => true };
      next = new TerminalDeliveryCredit(f.composition, 2, "replay", 0, 0);
      f.marker("recover", newFence);
      f.send(f.output(1), next, newFence);
      expect(f.delivery.snapshot().physicalBytes).toBe(physical);
      expect(f.writes).toHaveLength(1);
      f.unblock();
      expect(f.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "run-event",
        "recover-result",
        "run-event",
      ]);
      const newDebt = next.snapshot().debtBytes;
      handed.settled();
      handed.settled(new Error("obsolete"));
      expect(next.snapshot().debtBytes).toBe(newDebt);
      expect(f.delivery.closed).toBe(false);
    } finally {
      next?.retire();
      f.close();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("does not let a same-route result bypass credit blocking while a different healthy route can proceed", () => {
    const f = fixture({ subscriptionCreditBytes: MAX_FRAME_BYTES });
    let other;
    try {
      f.send(f.output(1, 65_536));
      f.writes[0].settled();
      expect(f.send(f.output(2, 65_536))).toBe(true);
      f.marker("same-route");
      const ref = { ...f.subscription, subscriptionId: "other" };
      other = new TerminalDeliveryCredit(f.composition, 1, "replay", 0, 0);
      f.send(f.output(1, 1, ref), other, { route: "other", attempt: 1, current: () => true });
      expect(f.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "run-event",
        "run-event",
      ]);
      expect(decode(f.writes[1].data).metadata.subscription.subscriptionId).toBe("other");
      f.credit.ack(1);
      f.delivery.wake();
      expect(f.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "run-event",
        "run-event",
        "run-event",
        "recover-result",
      ]);
    } finally {
      other?.retire();
      f.close();
    }
  });

  it("allows a legal baseline larger than minimum credit by exact parsed progress without installing N early", () => {
    const f = fixture({ subscriptionCreditBytes: MAX_FRAME_BYTES });
    const credit = new TerminalDeliveryCredit(f.composition, 2, "baseline", 5);
    const descriptor = baseline(f.subscription, 5, 3, 3 * 65_536);
    const send = (metadata, payload = new Uint8Array()) => f.send({ metadata, payload }, credit);
    try {
      expect(send({ type: "baseline-start", run, descriptor })).toBe(true);
      f.writes[0].settled();
      expect(
        send(
          {
            type: "baseline-chunk",
            run,
            subscription: f.subscription,
            baselineId: "baseline",
            ordinal: 0,
          },
          new Uint8Array(65_536),
        ),
      ).toBe(true);
      f.writes.at(-1).settled();
      expect(credit.ack(5)).toBe(false);
      for (let ordinal = 1; ordinal < 3; ordinal++) {
        expect(
          send(
            {
              type: "baseline-chunk",
              run,
              subscription: f.subscription,
              baselineId: "baseline",
              ordinal,
            },
            new Uint8Array(65_536),
          ),
        ).toBe(true);
        expect(f.writes).toHaveLength(ordinal + 1);
        expect(credit.progress("baseline", ordinal - 1)).toBe(true);
        f.delivery.wake();
        f.writes.at(-1).settled();
        expect(credit.ack(5)).toBe(false);
      }
      const before = credit.snapshot().debtBytes;
      expect(credit.progress("other", 2)).toBe(false);
      expect(credit.progress("baseline", 3)).toBe(false);
      expect(credit.snapshot().debtBytes).toBe(before);
      expect(credit.progress("baseline", 2)).toBe(true);
      expect(credit.progress("baseline", 1)).toBe(true);
      expect(credit.snapshot().debtBytes).toBe(0);
      expect(
        send({
          type: "baseline-end",
          run,
          subscription: f.subscription,
          baselineId: "baseline",
          chunkCount: 3,
          totalBytes: 3 * 65_536,
          atSeq: 5,
        }),
      ).toBe(true);
      expect(credit.snapshot().installed).toBe(false);
      expect(credit.ack(5)).toBe(true);
      expect(credit.snapshot()).toMatchObject({ installed: true, debtBytes: 0 });
    } finally {
      credit.retire();
      f.close();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("reserves control positions at smallest ordinary cap and refuses cap plus one without evicting ownership", () => {
    const f = fixture({}, 5);
    try {
      f.block();
      expect(f.send(f.output(1))).toBe(true);
      expect(f.send(f.output(2))).toBe(false);
      for (let index = 0; index < 4; index++) expect(f.marker(`control-${index}`)).toBe(true);
      const before = f.bytes.snapshot();
      expect(f.marker("cap-plus-one")).toBe(false);
      expect(f.bytes.snapshot()).toEqual(before);
      expect(f.delivery.snapshot()).toMatchObject({ queued: 4, handed: 1 });
    } finally {
      f.close();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("retains handed backing through close until one definitive callback and never resends after drain", () => {
    const f = fixture();
    f.block();
    f.send(f.output(1));
    f.send(f.output(2));
    f.token.current = false;
    f.credit.retire();
    f.delivery.close();
    expect(f.delivery.snapshot()).toMatchObject({ queued: 0, handed: 1 });
    expect(f.bytes.snapshot().total).toBeGreaterThan(0);
    f.delivery.drain();
    expect(f.writes).toHaveLength(1);
    f.writes[0].settled();
    f.writes[0].settled(new Error("late"));
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("fences reentrant closure during admitted marker and releases synchronous backing exactly once", () => {
    const f = fixture();
    f.onWrite(() => {
      f.token.current = false;
      f.delivery.close();
      f.writes[0].settled();
    });
    expect(f.marker("reentrant")).toBe(false);
    f.close();
    expect(f.bytes.snapshot().total).toBe(0);
  });
});
