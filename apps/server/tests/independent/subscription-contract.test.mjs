import { describe, expect, test } from "vitest";
import { domainError } from "@cove/protocol/errors";
import { MAX_FRAME_BYTES } from "@cove/protocol/terminal";
import { TerminalDeliveryCredit } from "../../dist/terminal/terminal-delivery-credit.js";
import { TerminalConnectionDelivery } from "../../dist/terminal/terminal-connection-delivery.js";
import {
  assertExactCreditReturn,
  assertMarkerBefore,
  assertOwnedTrace,
  attach,
  bytes,
  carrier,
  fixture,
  pipeFrame,
  resume,
  run,
  turns,
  worker,
} from "./subscription-byte-harness.mjs";

async function usingRig(options, exercise) {
  const rig = fixture(options);
  try {
    await exercise(rig);
  } finally {
    await rig.stop();
  }
}
const routeState = (rig, ref) => rig.service.snapshot(ref.subscriptionId).route;
async function commandReply(rig, ref, type, fields = {}) {
  const start = rig.commands.length;
  const promise = rig.service.handle(rig.routeCommand(type, ref, fields));
  const dispatched = rig.commands.slice(start).find((command) => command.type === type);
  if (dispatched) rig.accept(dispatched);
  const reply = await promise;
  await turns();
  return reply;
}

// These controls test oracle sensitivity; they are not production delivery evidence.
describe("P2-B1 independent trace oracle controls", () => {
  test("rejects missing or reordered accepted markers", () => {
    const marker = { metadata: { type: "recover-result", requestId: "control" } };
    const event = { metadata: { type: "run-event", event: { seq: 4 } } };
    const predicate = (metadata) => metadata.type === "run-event";
    expect(() => assertMarkerBefore([event], "control", predicate)).toThrow(
      "missing accepted marker",
    );
    expect(() => assertMarkerBefore([event, marker], "control", predicate)).toThrow("crossed");
    expect(() => assertMarkerBefore([marker, event], "control", predicate)).not.toThrow();
  });
  test("rejects forged encoded-byte credit and foreign full refs", () => {
    expect(() => assertExactCreditReturn(100, 0, [{ encodedBytes: 99 }])).toThrow("credit");
    const ref = {
      run,
      connection: { connectionId: "oracle", generation: 1 },
      viewId: "view",
      subscriptionId: "sub",
    };
    expect(() =>
      assertOwnedTrace([{ metadata: { subscription: { ...ref, viewId: "foreign" } } }], ref),
    ).toThrow("foreign");
  });
});

describe("P2-B1 actual compiled parser/runtime/subscription contracts", () => {
  test("F06-01 two connections retain distinct same-run routes and offered cursors", async () => {
    await usingRig({}, async (rig) => {
      const first = await attach(rig, { offered: resume(3), atSeq: 3 });
      const second = rig.addConnection({ connectionId: "other", generation: 2 });
      const command = rig.attachCommand({
        connection: second.connection,
        viewId: "other-view",
        offered: resume(7),
      });
      const pending = second.service.handle(command);
      const pipe = rig.lastCommand("subscribe");
      expect(pipe.atSeq).toBe(7);
      rig.accept(pipe, { recoveryMode: "replay", atSeq: 7 });
      const reply = await pending;
      rig.session.receive(rig.output(first.subscription, 4, "first"));
      rig.session.receive(rig.output(reply.subscription, 8, "second"));
      assertOwnedTrace(rig.transport.trace(), first.subscription);
      assertOwnedTrace(second.transport.trace(), reply.subscription);
      expect(first.pipe.atSeq).toBe(3);
      expect(rig.transport.trace().at(-1).payload).toEqual(bytes("first"));
      expect(second.transport.trace().at(-1).payload).toEqual(bytes("second"));
    });
  });

  test.each([
    "serverId",
    "relayInstanceId",
    "runId",
    "connectionId",
    "generation",
    "viewId",
    "subscriptionId",
  ])("F06-02 stale complete subscription field %s cannot dispatch", async (field) => {
    await usingRig({}, async (rig) => {
      const { subscription } = await attach(rig);
      const forged = structuredClone(subscription);
      if (field in forged.run) forged.run[field] = "foreign";
      else if (field in forged.connection)
        forged.connection[field] = field === "generation" ? 2 : "foreign";
      else forged[field] = "foreign";
      const before = rig.commands.length;
      const retained = rig.account.snapshot().total;
      const reply = await rig.service.handle(
        rig.routeCommand("applied-ack", forged, { appliedSeq: 3 }),
      );
      expect(reply.type).toBe("error");
      expect(rig.commands.length).toBe(before);
      expect(rig.account.snapshot().total).toBe(retained);
      expect(routeState(rig, subscription).phase).toBe("active");
    });
  });

  test.each(["workerId", "workerIncarnationId"])(
    "F06-02 foreign worker %s cannot publish",
    async (field) => {
      await usingRig({}, async (rig) => {
        const { subscription } = await attach(rig);
        const before = rig.transport.trace().length;
        rig.session.receive(
          pipeFrame(
            {
              type: "terminal-event",
              worker: { ...worker, [field]: "foreign" },
              run,
              subscription,
              terminal: { type: "output", run, seq: 4 },
            },
            bytes("foreign"),
          ),
        );
        expect(rig.transport.trace().length).toBe(before);
        expect(rig.session.closed).toBe(true);
        expect(rig.runtime.registry.get(run).status.status).not.toBe("exited");
      });
    },
  );

  test("F06-03 retired subscription tombstone refuses cap+1 without evicting proof", async () => {
    await usingRig({ identityLimit: 1 }, async (rig) => {
      const { subscription } = await attach(rig);
      const detached = rig.service.handle(rig.routeCommand("detach", subscription));
      rig.accept(rig.lastCommand("unsubscribe"));
      expect((await detached).type).toBe("detach-result");
      await turns();
      const before = rig.commands.length;
      const retained = rig.account.snapshot().total;
      expect((await rig.service.handle(rig.attachCommand({ viewId: "new-view" }))).error.kind).toBe(
        "BUSY",
      );
      expect(
        (await rig.service.handle(rig.routeCommand("recover", subscription, { reason: "expired" })))
          .type,
      ).toBe("error");
      expect(rig.commands.length).toBe(before);
      expect(rig.account.snapshot().total).toBe(retained);
      expect(rig.service.snapshot()).toMatchObject({ routes: 1, active: 0 });
    });
  });

  test("F06-03 fresh attach uses a new finite identity after detach", async () => {
    await usingRig({}, async (rig) => {
      const first = await attach(rig);
      const pending = rig.service.handle(rig.routeCommand("detach", first.subscription));
      rig.accept(rig.lastCommand("unsubscribe"));
      await pending;
      await turns();
      const second = await attach(rig, { viewId: "next-view" });
      expect(second.subscription.subscriptionId).not.toBe(first.subscription.subscriptionId);
    });
  });

  test("F06-03 request identity exhaustion refuses cap+1 and duplicate proof stays retained", async () => {
    await usingRig({ requestLimit: 1 }, async (rig) => {
      const attached = await attach(rig);
      const before = rig.commands.length;
      const retained = rig.account.snapshot().total;
      expect((await rig.service.handle(attached.command)).error.kind).toBe("COUNTER_EXHAUSTED");
      expect(
        (
          await rig.service.handle(
            rig.routeCommand("applied-ack", attached.subscription, { appliedSeq: 3 }),
          )
        ).error.kind,
      ).toBe("BUSY");
      expect(rig.commands.length).toBe(before);
      expect(rig.account.snapshot().total).toBe(retained);
      expect(rig.service.snapshot().identities).toBe(1);
    });
  });

  test("F07-01 absent resume requests baseline and valid full resume maps exact cursor", async () => {
    await usingRig({}, async (rig) => {
      const absent = await attach(rig, { offered: null, mode: "baseline", atSeq: 9 });
      expect(absent.pipe.atSeq).toBe(0);
      const offered = await attach(rig, {
        offered: resume(12),
        atSeq: 12,
        viewId: "retained-view",
      });
      expect(offered.pipe.atSeq).toBe(12);
      expect(offered.reply.mode).toBe("replay");
    });
  });

  test.each(["profile", "encoding", "geometry"])(
    "F07-02 invalid resume %s has no dispatch or allocation",
    async (field) => {
      await usingRig({}, async (rig) => {
        const offered = {
          ...resume(3),
          [field]: field === "geometry" ? { cols: 79, rows: 24 } : "invalid",
        };
        const count = rig.commands.length;
        const retained = rig.account.snapshot().total;
        expect((await rig.service.handle(rig.attachCommand({ offered }))).type).toBe("error");
        expect(rig.commands.length).toBe(count);
        expect(rig.account.snapshot().total).toBe(retained);
      });
    },
  );

  test.each(["replay-without-offer", "rollback"])(
    "F07-02 impossible %s result cannot activate",
    async (invalid) => {
      await usingRig({}, async (rig) => {
        const command = rig.attachCommand({ offered: invalid === "rollback" ? resume(7) : null });
        const pending = rig.service.handle(command);
        const pipe = rig.lastCommand("subscribe");
        rig.accept(pipe, { recoveryMode: "replay", atSeq: invalid === "rollback" ? 6 : 7 });
        expect((await pending).type).toBe("error");
        expect(
          rig.transport.trace().some(({ metadata }) => metadata.type === "attach-result"),
        ).toBe(false);
        expect(rig.service.snapshot().active).toBe(0);
      });
    },
  );

  test("F08-01 preceding ACK completes before recover reserves its next attempt", async () => {
    await usingRig({}, async (rig) => {
      const { subscription } = await attach(rig);
      rig.session.receive(rig.output(subscription, 4));
      const ack = rig.service.handle(
        rig.routeCommand("applied-ack", subscription, { appliedSeq: 4 }),
      );
      const ackPipe = rig.lastCommand("applied-ack");
      const recover = rig.service.handle(
        rig.routeCommand("recover", subscription, { reason: "expired", resume: resume(4) }),
      );
      expect(rig.commands.some((command) => command.type === "recover")).toBe(false);
      expect(routeState(rig, subscription).attempt).toBe(1);
      rig.accept(ackPipe);
      await ack;
      await turns();
      const recoveryPipe = rig.lastCommand("recover");
      expect(recoveryPipe.appliedSeq).toBe(4);
      expect(routeState(rig, subscription).attempt).toBe(2);
      rig.accept(recoveryPipe, { recoveryMode: "replay", atSeq: 4 });
      expect((await recover).type).toBe("recover-result");
    });
  });

  test("F08-01 recover cancels unsent frames while preserving old handed-off backing", async () => {
    const transport = carrier();
    await usingRig({ transport }, async (rig) => {
      const { subscription } = await attach(rig);
      transport.hold = true;
      transport.writable = false;
      rig.session.receive(rig.output(subscription, 4, "old-handed"));
      const oldIndex = transport.writes.length - 1;
      rig.session.receive(rig.output(subscription, 5, "old-unsent"));
      expect(rig.delivery.snapshot().queued).toBe(1);
      const oldBytes = rig.delivery.snapshot().physicalBytes;
      const command = rig.routeCommand("recover", subscription, {
        reason: "released-view",
        resume: resume(3),
      });
      const pending = rig.service.handle(command);
      rig.accept(rig.lastCommand("recover"), { recoveryMode: "replay", atSeq: 3 }, [
        rig.output(subscription, 4, "new-attempt"),
      ]);
      expect(rig.delivery.snapshot().physicalBytes).toBe(oldBytes);
      transport.writable = true;
      rig.delivery.drain();
      expect((await pending).subscription).toEqual(subscription);
      const trace = transport.trace();
      expect(
        trace.filter(({ payload }) => payload.byteLength).map(({ payload }) => [...payload]),
      ).toEqual([[...bytes("old-handed")], [...bytes("new-attempt")]]);
      assertMarkerBefore(
        trace.slice(oldIndex + 1),
        command.requestId,
        (metadata) => metadata.type === "run-event",
      );
      const physical = rig.delivery.snapshot().physicalBytes;
      transport.release(oldIndex);
      transport.release(oldIndex, new Error("late duplicate"));
      expect(rig.delivery.snapshot().physicalBytes).toBe(physical - oldBytes);
      expect(routeState(rig, subscription).phase).toBe("active");
    });
  });

  test("F08-02 equal-N new baseline cannot consume old ACK or physical callback", async () => {
    const transport = carrier();
    await usingRig({ transport }, async (rig) => {
      const { subscription } = await attach(rig);
      transport.hold = true;
      rig.session.receive(rig.output(subscription, 4));
      const index = transport.writes.length - 1;
      const command = rig.routeCommand("recover", subscription, { reason: "gap" });
      const pending = rig.service.handle(command);
      rig.accept(rig.lastCommand("recover"), { recoveryMode: "baseline", atSeq: 4 });
      await pending;
      await turns();
      const physical = rig.delivery.snapshot().physicalBytes;
      expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq: 4 })).type).toBe(
        "error",
      );
      expect(routeState(rig, subscription).credit).toMatchObject({
        attempt: 2,
        installed: false,
        debtBytes: 0,
      });
      transport.release(index);
      transport.release(index, new Error("late duplicate"));
      expect(rig.delivery.snapshot().physicalBytes).toBeLessThan(physical);
      expect(routeState(rig, subscription).phase).toBe("active");
      rig.emitBaseline(subscription, { atSeq: 4 });
      expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq: 4 })).type).toBe(
        "applied-ack-result",
      );
      expect(routeState(rig, subscription).credit.installed).toBe(true);
    });
  });

  test("F08-03 blocked detach fences late frames and does not stop execution", async () => {
    const transport = carrier();
    await usingRig({ transport }, async (rig) => {
      const { subscription } = await attach(rig);
      transport.hold = true;
      transport.writable = false;
      rig.session.receive(rig.output(subscription, 4));
      const index = transport.writes.length - 1;
      rig.session.receive(rig.output(subscription, 5));
      const pending = rig.service.handle(rig.routeCommand("detach", subscription));
      rig.accept(rig.lastCommand("unsubscribe"));
      await pending;
      await turns();
      rig.session.receive(rig.output(subscription, 6, "late"));
      transport.writable = true;
      rig.delivery.drain();
      transport.release(index);
      transport.release(index);
      const trace = transport.trace();
      const marker = trace.findIndex(({ metadata }) => metadata.type === "detach-result");
      expect(marker).toBeGreaterThan(0);
      expect(trace.slice(marker + 1).some(({ metadata }) => metadata.type === "run-event")).toBe(
        false,
      );
      expect(
        rig.commands.filter((command) => ["stop", "set-control", "input"].includes(command.type)),
      ).toEqual([]);
      expect(rig.commands.filter((command) => command.type === "unsubscribe")).toHaveLength(1);
    });
  });

  test("F09-01 result plus N+1 in one pipe chunk publishes marker synchronously first", async () => {
    await usingRig({}, async (rig) => {
      const command = rig.attachCommand();
      const pending = rig.service.handle(command);
      const pipe = rig.lastCommand("subscribe");
      rig.accept(pipe, { recoveryMode: "replay", atSeq: 3 }, [rig.output(pipe.subscription, 4)]);
      assertMarkerBefore(
        rig.transport.trace(),
        command.requestId,
        (metadata) => metadata.type === "run-event",
      );
      expect(routeState(rig, pipe.subscription).credit.debtBytes).toBe(
        rig.transport.trace().at(-1).encodedBytes,
      );
      await pending;
    });
  });

  test.each(["reentrant-close", "marker-capacity-refusal"])(
    "F09-02 %s cannot activate same-chunk delivery",
    async (variant) => {
      const transport = carrier({ hold: variant === "marker-capacity-refusal" });
      await usingRig({ transport, itemLimit: 5 }, async (rig) => {
        const admissions = [];
        if (variant === "reentrant-close")
          transport.onWrite = ({ frames }) => {
            if (frames[0].metadata.type === "attach-result") rig.service.close();
          };
        else
          for (let index = 0; index < 5; index++)
            admissions.push(
              rig.delivery.admit(
                {
                  type: "error",
                  requestId: `fill-${index}`,
                  run,
                  commandType: "attach",
                  error: domainError("BUSY"),
                },
                new Uint8Array(),
                { control: true },
              ),
            );
        expect(admissions).toEqual(
          variant === "marker-capacity-refusal" ? Array(5).fill(true) : [],
        );
        const command = rig.attachCommand();
        const pending = rig.service.handle(command);
        const pipe = rig.lastCommand("subscribe");
        rig.accept(pipe, { recoveryMode: "replay", atSeq: 3 }, [rig.output(pipe.subscription, 4)]);
        expect(rig.transport.trace().some(({ metadata }) => metadata.type === "run-event")).toBe(
          false,
        );
        expect((await pending).type).toBe("error");
        expect(rig.service.snapshot().active).toBe(0);
      });
    },
  );

  test("F09-02 same-route priority preserves marker while eligible peer progresses", async () => {
    await usingRig({}, async (rig) => {
      const { subscription } = await attach(rig);
      const transport = carrier();
      const delivery = new TerminalConnectionDelivery(rig.composition, {
        connection: rig.connection,
        transport,
        encodeUtf8: bytes,
        itemLimit: 12,
      });
      try {
        let admitted = false;
        const fence = { route: subscription.subscriptionId, attempt: 2, current: () => true };
        expect(
          delivery.admit(
            {
              type: "recover-result",
              requestId: "queued-marker",
              run,
              subscription,
              mode: "replay",
              atSeq: 3,
            },
            new Uint8Array(),
            {
              control: true,
              fence,
              prepare: () => ({ eligible: () => admitted, handoff: () => true }),
            },
          ),
        ).toBe(true);
        expect(
          delivery.admit(
            { type: "run-event", subscription, event: { type: "output", run, seq: 4 } },
            bytes("following"),
            { control: false, fence },
          ),
        ).toBe(true);
        const peer = { ...subscription, viewId: "peer-view", subscriptionId: "peer-sub" };
        expect(
          delivery.admit(
            { type: "run-event", subscription: peer, event: { type: "output", run, seq: 4 } },
            bytes("healthy"),
            { control: false, fence: { ...fence, route: peer.subscriptionId } },
          ),
        ).toBe(true);
        expect(
          transport.trace().map(({ metadata }) => metadata.subscription.subscriptionId),
        ).toEqual([peer.subscriptionId]);
        admitted = true;
        delivery.wake();
        assertMarkerBefore(
          transport.trace(),
          "queued-marker",
          (metadata) =>
            metadata.type === "run-event" &&
            metadata.subscription.subscriptionId === subscription.subscriptionId,
        );
      } finally {
        delivery.transportReleased();
      }
    });
  });

  test("F10-01 carrier callback frees physical backing without parsed credit", async () => {
    const transport = carrier();
    await usingRig({ transport }, async (rig) => {
      const { subscription } = await attach(rig);
      transport.hold = true;
      rig.session.receive(rig.output(subscription, 4, "éx"));
      const index = transport.writes.length - 1;
      const frame = transport.trace().at(-1);
      const retained = rig.account.snapshot().total;
      expect(routeState(rig, subscription).credit.debtBytes).toBe(frame.encodedBytes);
      expect(transport.writes[index].encoded.byteLength).toBe(frame.encodedBytes);
      transport.release(index);
      expect(rig.delivery.snapshot().physicalBytes).toBe(0);
      expect(retained - rig.account.snapshot().total).toBe(frame.encodedBytes + 256 + 512);
      expect(routeState(rig, subscription).credit.debtBytes).toBe(frame.encodedBytes);
    });
  });

  test("F10-02 duplicate stale future and unrecorded ACK cannot mint credit", async () => {
    await usingRig({}, async (rig) => {
      const { subscription } = await attach(rig);
      rig.session.receive(rig.output(subscription, 4));
      rig.session.receive(rig.output(subscription, 5));
      const events = rig.transport.trace().filter(({ metadata }) => metadata.type === "run-event");
      let debt = routeState(rig, subscription).credit.debtBytes;
      expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq: 6 })).type).toBe(
        "error",
      );
      expect(routeState(rig, subscription).credit.debtBytes).toBe(debt);
      expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq: 4 })).type).toBe(
        "applied-ack-result",
      );
      const current = routeState(rig, subscription).credit.debtBytes;
      assertExactCreditReturn(debt, current, [events[0]]);
      for (const appliedSeq of [4, 3]) {
        expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq })).type).toBe(
          "applied-ack-result",
        );
        expect(routeState(rig, subscription).credit.debtBytes).toBe(current);
      }
      expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq: 5 })).type).toBe(
        "applied-ack-result",
      );
      assertExactCreditReturn(current, routeState(rig, subscription).credit.debtBytes, [events[1]]);
      const credit = new TerminalDeliveryCredit(rig.composition, 99, "replay", 5, 3);
      expect(credit.ack(4)).toBe(false);
      credit.retire();
    });
  });

  test("F10-03 baseline progress returns exact ordinals without installation", async () => {
    await usingRig({}, async (rig) => {
      const { subscription } = await attach(rig, { mode: "baseline", offered: null });
      rig.emitBaseline(subscription);
      const frames = rig.transport
        .trace()
        .filter(({ metadata }) => metadata.type.startsWith("baseline-"));
      const debt = routeState(rig, subscription).credit.debtBytes;
      for (const fields of [
        { baselineId: "foreign", lastParsedOrdinal: 0 },
        { baselineId: "ind-baseline", lastParsedOrdinal: 2 },
      ])
        expect((await commandReply(rig, subscription, "baseline-progress", fields)).type).toBe(
          "error",
        );
      expect(
        (
          await commandReply(rig, subscription, "baseline-progress", {
            baselineId: "ind-baseline",
            lastParsedOrdinal: 0,
          })
        ).type,
      ).toBe("baseline-progress-result");
      const next = routeState(rig, subscription).credit;
      assertExactCreditReturn(debt, next.debtBytes, frames.slice(0, 2));
      expect(next.installed).toBe(false);
      await commandReply(rig, subscription, "baseline-progress", {
        baselineId: "ind-baseline",
        lastParsedOrdinal: 0,
      });
      expect(routeState(rig, subscription).credit.debtBytes).toBe(next.debtBytes);
      await commandReply(rig, subscription, "applied-ack", { appliedSeq: 3 });
      expect(routeState(rig, subscription).credit).toMatchObject({ installed: true, debtBytes: 0 });
    });
  });

  test("F10-04 baseline larger than minimum window advances with reserved progress", async () => {
    await usingRig(
      { budgets: { subscriptionCreditBytes: MAX_FRAME_BYTES, pendingWorkerCommands: 1 } },
      async (rig) => {
        const { subscription } = await attach(rig, { mode: "baseline", offered: null });
        rig.emitBaseline(subscription, { sizes: [65_536, 65_536] });
        expect(routeState(rig, subscription).credit.debtBytes).toBeLessThanOrEqual(MAX_FRAME_BYTES);
        expect(rig.delivery.snapshot().queued).toBeGreaterThan(0);
        expect((await commandReply(rig, subscription, "applied-ack", { appliedSeq: 3 })).type).toBe(
          "error",
        );
        await commandReply(rig, subscription, "baseline-progress", {
          baselineId: "ind-baseline",
          lastParsedOrdinal: 0,
        });
        expect(
          rig.transport.trace().filter(({ metadata }) => metadata.type === "baseline-chunk"),
        ).toHaveLength(2);
        await commandReply(rig, subscription, "baseline-progress", {
          baselineId: "ind-baseline",
          lastParsedOrdinal: 1,
        });
        expect(rig.transport.trace().some(({ metadata }) => metadata.type === "baseline-end")).toBe(
          true,
        );
        expect(routeState(rig, subscription).credit.installed).toBe(false);
        await commandReply(rig, subscription, "applied-ack", { appliedSeq: 3 });
        expect(routeState(rig, subscription).credit.debtBytes).toBe(0);
      },
    );
  });

  test("F10-05 full backing subarrays remain charged until the final independent lease", async () => {
    await usingRig({}, async (rig) => {
      const before = rig.account.snapshot().total;
      const backing = new Uint8Array(65_536);
      const first = rig.account.retainBacking(backing.subarray(0, 1));
      const second = rig.account.retainBacking(backing.subarray(1, 2));
      expect(rig.account.snapshot().total - before).toBe(backing.byteLength + 256);
      first.release();
      first.release();
      expect(rig.account.snapshot().total - before).toBe(backing.byteLength + 256);
      second.release();
      second.release();
      expect(rig.account.snapshot().total).toBe(before);
      const { subscription } = await attach(rig);
      const oversized = new Uint8Array(MAX_FRAME_BYTES + 1).subarray(0, 1);
      const retained = rig.account.snapshot().total;
      expect(
        rig.delivery.admit(
          { type: "run-event", subscription, event: { type: "output", run, seq: 4 } },
          oversized,
          { control: false },
        ),
      ).toBe(false);
      expect(rig.account.snapshot().total).toBe(retained);
    });
  });

  test("F11-01 overflow retains first route failure while a healthy route continues", async () => {
    await usingRig(
      { itemLimit: 5, budgets: { subscriptionCreditBytes: MAX_FRAME_BYTES } },
      async (rig) => {
        const slow = await attach(rig, { mode: "baseline", offered: null });
        const healthy = await attach(rig, { viewId: "healthy-view" });
        rig.emitBaseline(slow.subscription, { sizes: [65_536, 65_536] });
        expect(routeState(rig, slow.subscription).phase).toBe("retired");
        const cause = routeState(rig, slow.subscription).failure;
        rig.advance(15_001);
        rig.service.tick();
        expect(routeState(rig, slow.subscription).failure).toEqual(cause);
        rig.session.receive(rig.output(healthy.subscription, 4, "healthy"));
        expect(rig.transport.trace().at(-1).payload).toEqual(bytes("healthy"));
        expect(
          (await commandReply(rig, slow.subscription, "applied-ack", { appliedSeq: 3 })).error,
        ).toEqual(cause);
        expect(
          rig.transport.trace().filter(({ metadata }) => metadata.type === "error"),
        ).toHaveLength(1);
        expect(rig.commands.some((command) => command.type === "stop")).toBe(false);
      },
    );
  });

  test("F11-01 monotonic deadline expiry fences late delivery and preserves uncertainty", async () => {
    await usingRig({}, async (rig) => {
      const { subscription } = await attach(rig, { mode: "baseline", offered: null });
      rig.advance(14_999);
      rig.service.tick();
      expect(routeState(rig, subscription).phase).toBe("active");
      rig.advance(1);
      rig.service.tick();
      expect(routeState(rig, subscription).failure.kind).toBe("RECOVERY_EXPIRED");
      const before = rig.transport.trace().length;
      rig.emitBaseline(subscription);
      expect(rig.transport.trace().length).toBe(before);
      expect(
        (await commandReply(rig, subscription, "applied-ack", { appliedSeq: 3 })).error.kind,
      ).toBe("RECOVERY_EXPIRED");
      expect(rig.runtime.registry.get(run).status.status).not.toBe("exited");
    });
  });

  test("F11-01 unknown worker result retires only its route and preserves the first cause", async () => {
    await usingRig({}, async (rig) => {
      const healthy = await attach(rig);
      const pending = rig.service.handle(rig.attachCommand({ viewId: "uncertain-view" }));
      const pipe = rig.lastCommand("subscribe");
      rig.accept(pipe, { outcome: "unknown" });
      expect((await pending).error.kind).toBe("RESULT_UNKNOWN");
      const first = routeState(rig, pipe.subscription).failure;
      rig.advance(15_001);
      rig.service.tick();
      expect(
        (await commandReply(rig, pipe.subscription, "applied-ack", { appliedSeq: 3 })).error,
      ).toEqual(first);
      rig.session.receive(rig.output(healthy.subscription, 4, "still-live"));
      expect(rig.transport.trace().at(-1).payload).toEqual(bytes("still-live"));
      expect(rig.runtime.registry.get(run).status.status).not.toBe("exited");
    });
  });

  test("F11-02 close at route cap+1 waits for occupied progress slots and unsubscribes every owned route", async () => {
    await usingRig({}, async (rig) => {
      const routes = [];
      for (let index = 0; index < 7; index++)
        routes.push((await attach(rig, { viewId: `close-view-${index}` })).subscription);
      const pending = routes
        .slice(0, 4)
        .map((subscription) =>
          rig.service.handle(rig.routeCommand("applied-ack", subscription, { appliedSeq: 3 })),
        );
      const acknowledgements = rig.commands.filter((command) => command.type === "applied-ack");
      expect(acknowledgements).toHaveLength(4);
      rig.service.close();
      const outbound = rig.transport.trace().length;
      for (const command of acknowledgements) rig.accept(command);
      await Promise.all(pending);
      await turns();
      const replied = new Set();
      for (let pass = 0; pass < 20; pass++) {
        const teardown = rig.commands.filter(
          (command) => command.type === "unsubscribe" && !replied.has(command.requestId),
        );
        for (const command of teardown) {
          replied.add(command.requestId);
          rig.accept(command);
        }
        await turns();
      }
      const teardown = rig.commands.filter((command) => command.type === "unsubscribe");
      expect(teardown).toHaveLength(7);
      expect(new Set(teardown.map((command) => command.subscription.subscriptionId))).toEqual(
        new Set(routes.map((ref) => ref.subscriptionId)),
      );
      expect(replied.size).toBe(7);
      expect(rig.transport.trace().length).toBe(outbound);
      expect(
        rig.commands.some((command) => ["stop", "set-control", "input"].includes(command.type)),
      ).toBe(false);
      expect(rig.service.snapshot()).toMatchObject({ active: 0, pending: 0 });
    });
  });

  test("F11-02 accepted marker after close loses contact without publication or false exit", async () => {
    await usingRig({}, async (rig) => {
      const pending = rig.service.handle(rig.attachCommand());
      const pipe = rig.lastCommand("subscribe");
      rig.service.close();
      const outbound = rig.transport.trace().length;
      rig.accept(pipe, { recoveryMode: "replay", atSeq: 3 }, [rig.output(pipe.subscription, 4)]);
      expect((await pending).type).toBe("error");
      await turns();
      expect(rig.session.closed).toBe(true);
      expect(rig.transport.trace().length).toBe(outbound);
      expect(rig.commands.some((command) => ["stop", "set-control"].includes(command.type))).toBe(
        false,
      );
      expect(rig.runtime.registry.get(run).status.status).toBe("unverifiable");
      expect(rig.service.snapshot()).toMatchObject({ active: 0, pending: 0 });
    });
  });

  test("F11-02 closing pending attach fences late callbacks and issues only owned unsubscribe", async () => {
    await usingRig({}, async (rig) => {
      const pending = rig.service.handle(rig.attachCommand());
      const pipe = rig.lastCommand("subscribe");
      rig.service.close();
      const before = rig.transport.trace().length;
      rig.accept(pipe, { outcome: "unknown" }, [rig.output(pipe.subscription, 4)]);
      expect((await pending).type).toBe("error");
      await turns();
      expect(rig.session.ready).toBe(true);
      expect(rig.transport.trace().length).toBe(before);
      expect(rig.commands.filter((command) => command.type === "unsubscribe")).toHaveLength(1);
      expect(rig.commands.some((command) => ["stop", "set-control"].includes(command.type))).toBe(
        false,
      );
    });
  });
});
