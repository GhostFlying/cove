import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
const clientManifestUrl = new URL("../../../../packages/client/package.json", import.meta.url);
const clientManifest = JSON.parse(await readFile(clientManifestUrl, "utf8"));
const { createClient } = await import(
  new URL(clientManifest.exports["."].import, clientManifestUrl).href
);
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import {
  fixture,
  decode,
  coalesce,
  baseline,
  codec,
  run,
  profile,
  encoding,
  geometry,
} from "./subscription-byte-peer.mjs";

const turns = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
const command = (type, ref, requestId, rest = {}) => ({
  type,
  run,
  subscription: ref,
  requestId,
  ...rest,
});

describe("private terminal subscription delivery", () => {
  it("translates full resume and routes same-run connections independently before coalesced output", async () => {
    const f = fixture();
    const a = f.connect("a");
    const b = f.connect("b");
    try {
      const pa = a.service.handle(a.attach("a-attach", 4));
      const ca = f.latest();
      expect(ca).toMatchObject({ type: "subscribe", atSeq: 4 });
      const pb = b.service.handle(b.attach("b-attach", 9));
      const cb = f.latest();
      f.session.receive(
        coalesce(f.reply(ca, { recoveryMode: "replay", atSeq: 4 }), f.output(ca.subscription, 5)),
      );
      f.session.receive(
        coalesce(f.reply(cb, { recoveryMode: "replay", atSeq: 9 }), f.output(cb.subscription, 10)),
      );
      expect((await pa).subscription.connection.connectionId).toBe("a");
      expect((await pb).subscription.connection.connectionId).toBe("b");
      expect(a.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "attach-result",
        "run-event",
      ]);
      expect(b.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "attach-result",
        "run-event",
      ]);
      expect(a.service.snapshot(ca.subscription.subscriptionId).route.credit.debtBytes).toBe(
        a.writes[1].data.byteLength,
      );
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("requires baseline without a resume and rejects replay without its offer", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const promise = a.service.handle(a.attach("absent"));
      const sent = f.latest();
      expect(sent.atSeq).toBe(0);
      f.session.receive(f.reply(sent, { recoveryMode: "replay", atSeq: 0 }));
      expect((await promise).error.kind).toBe("RESULT_UNKNOWN");
      expect(a.writes.map((item) => decode(item.data).metadata.type)).not.toContain(
        "attach-result",
      );
    } finally {
      await f.dispose();
    }
  });

  it("refuses each foreign complete ref, profile and geometry without a worker command", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ready = await f.attach(a);
      const ref = ready.subscription;
      const variants = [
        { ...ref, connection: { ...ref.connection, generation: 1 } },
        { ...ref, connection: { ...ref.connection, connectionId: "foreign" } },
        { ...ref, viewId: "foreign" },
        { ...ref, subscriptionId: "foreign" },
        { ...ref, run: { ...run, runId: "foreign" } },
        { ...ref, run: { ...run, relayInstanceId: "foreign" } },
        { ...ref, run: { ...run, serverId: "foreign" } },
      ];
      const count = f.pipeWrites.length;
      for (let index = 0; index < variants.length; index++)
        expect(
          (
            await a.service.handle(
              command("recover", variants[index], `bad-${index}`, { reason: "gap" }),
            )
          ).type,
        ).toBe("error");
      const badGrid = a.attach("grid", 0);
      badGrid.resume.geometry = { cols: 81, rows: 24 };
      expect((await a.service.handle(badGrid)).type).toBe("error");
      const badProfile = a.attach("profile", 0);
      badProfile.resume.profile = "unknown";
      expect((await a.service.handle(badProfile)).type).toBe("error");
      expect(f.pipeWrites).toHaveLength(count);
    } finally {
      await f.dispose();
    }
  });

  it("keeps handed-off old backing but cancels unsent old output before a stable-ref recover marker", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      a.writes[0].settled();
      a.block();
      f.session.receive(f.output(ref, 1));
      const held = a.writes[1];
      f.session.receive(f.output(ref, 2));
      const before = a.delivery.snapshot().physicalBytes;
      const recovery = a.service.handle(
        command("recover", ref, "recover", {
          reason: "gap",
          resume: { appliedSeq: 0, profile, encoding, geometry },
        }),
      );
      const sent = f.latest();
      expect(sent.type).toBe("recover");
      f.session.receive(
        coalesce(f.reply(sent, { recoveryMode: "replay", atSeq: 0 }), f.output(ref, 1)),
      );
      expect((await recovery).subscription).toEqual(ref);
      expect(a.delivery.snapshot().physicalBytes).toBe(before);
      expect(a.service.snapshot(ref.subscriptionId).route.credit.queuedBytes).toBeGreaterThan(0);
      a.unblock();
      expect(a.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "attach-result",
        "run-event",
        "recover-result",
        "run-event",
      ]);
      expect(
        a.writes
          .filter((item) => decode(item.data).metadata.type === "run-event")
          .map((item) => decode(item.data).metadata.event.seq),
      ).toEqual([1, 1]);
      const debt = a.service.snapshot(ref.subscriptionId).route.credit.debtBytes;
      held.settled();
      held.settled(new Error("obsolete"));
      expect(a.service.snapshot(ref.subscriptionId).route.credit.debtBytes).toBe(debt);
      expect(a.service.closed).toBe(false);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("serializes recover after the preceding ACK result and never creates physical credit", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      f.session.receive(f.output(ref, 1));
      a.writes[1].settled();
      expect(a.service.snapshot(ref.subscriptionId).route.credit.debtBytes).toBe(
        a.writes[1].data.byteLength,
      );
      const ack = a.service.handle(command("applied-ack", ref, "ack", { appliedSeq: 1 }));
      const sentAck = f.latest();
      const recover = a.service.handle(
        command("recover", ref, "recover", {
          reason: "gap",
          resume: { appliedSeq: 1, profile, encoding, geometry },
        }),
      );
      expect(f.latest().type).toBe("applied-ack");
      f.session.receive(f.reply(sentAck));
      await ack;
      await turns();
      const sentRecover = f.latest();
      expect(sentRecover.type).toBe("recover");
      expect(sentRecover.appliedSeq).toBe(1);
      f.session.receive(f.reply(sentRecover, { recoveryMode: "replay", atSeq: 1 }));
      await recover;
      expect(a.service.snapshot(ref.subscriptionId).route.attempt).toBe(2);
    } finally {
      await f.dispose();
    }
  });

  it("rejects future and unrecorded ACK and makes duplicate ACK a zero-credit boundary", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      f.session.receive(f.output(ref, 1));
      f.session.receive(f.output(ref, 2));
      const credit = () => a.service.snapshot(ref.subscriptionId).route.credit.debtBytes;
      const initial = credit();
      expect(
        (await a.service.handle(command("applied-ack", ref, "future", { appliedSeq: 3 }))).type,
      ).toBe("error");
      expect(credit()).toBe(initial);
      const ack = a.service.handle(command("applied-ack", ref, "ack", { appliedSeq: 1 }));
      await turns();
      f.session.receive(f.reply());
      await ack;
      expect(credit()).toBe(a.writes[2].data.byteLength);
      const duplicate = a.service.handle(
        command("applied-ack", ref, "duplicate", { appliedSeq: 1 }),
      );
      await turns();
      f.session.receive(f.reply());
      await duplicate;
      expect(credit()).toBe(a.writes[2].data.byteLength);
    } finally {
      await f.dispose();
    }
  });

  it("fences reentrant marker closure and never exposes a same-chunk new event", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      a.onWrite(() => a.service.close());
      const pending = a.service.handle(a.attach("attach", 0));
      const sent = f.latest();
      f.session.receive(
        coalesce(
          f.reply(sent, { recoveryMode: "replay", atSeq: 0 }),
          f.output(sent.subscription, 1),
        ),
      );
      expect((await pending).type).toBe("error");
      expect(a.writes.map((item) => decode(item.data).metadata.type)).toEqual(["attach-result"]);
      expect(f.session.closed).toBe(true);
    } finally {
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });

  it("retires only an expired route and reports its first cause on the next correlated command", async () => {
    const f = fixture({ recoveryDeadlineMs: 20 });
    const a = f.connect("a");
    const b = f.connect("b");
    try {
      const aRef = (await f.attach(a, null, "baseline")).subscription;
      const bRef = (await f.attach(b, 0, "replay")).subscription;
      f.clock(20);
      a.service.tick();
      expect(a.service.snapshot(aRef.subscriptionId).route.failure.kind).toBe("RECOVERY_EXPIRED");
      f.session.receive(f.output(bRef, 1));
      expect(b.writes.map((item) => decode(item.data).metadata.type)).toEqual([
        "attach-result",
        "run-event",
      ]);
      const reply = await a.service.handle(command("recover", aRef, "late", { reason: "expired" }));
      expect(reply).toMatchObject({
        type: "error",
        requestId: "late",
        error: { kind: "RECOVERY_EXPIRED" },
      });
      expect(f.pipeWrites.map((item) => decode(item.data, true).metadata.type)).not.toContain(
        "stop",
      );
    } finally {
      await f.dispose();
    }
  });

  it("refuses lifetime tombstone cap plus one and detaches without stopping the run", async () => {
    const f = fixture({}, { identityLimit: 1 });
    const a = f.connect();
    try {
      const ref = (await f.attach(a)).subscription;
      const detach = a.service.handle(command("detach", ref, "detach"));
      const sent = f.latest();
      expect(sent.type).toBe("unsubscribe");
      f.session.receive(f.reply(sent));
      expect((await detach).type).toBe("detach-result");
      const count = f.pipeWrites.length;
      expect((await a.service.handle(a.attach("next", 0))).error.kind).toBe("BUSY");
      expect(
        (await a.service.handle(command("recover", ref, "reuse", { reason: "gap" }))).type,
      ).toBe("error");
      f.session.receive(f.output(ref, 1));
      expect(a.writes.map((item) => decode(item.data).metadata.type)).not.toContain("run-event");
      expect(f.pipeWrites).toHaveLength(count);
      expect(f.runtime.registry.get(run).capacityOwned).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it("requires current baseline progress and final handed-off end before ACK N installation", async () => {
    const f = fixture();
    const a = f.connect();
    try {
      const ref = (await f.attach(a, null)).subscription;
      const descriptor = baseline(ref, 0);
      f.session.receive(f.event(ref, { type: "baseline-start", run, descriptor }));
      f.session.receive(
        f.event(
          ref,
          { type: "baseline-chunk", run, subscription: ref, baselineId: "baseline", ordinal: 0 },
          new Uint8Array([65]),
        ),
      );
      expect(
        (await a.service.handle(command("applied-ack", ref, "early", { appliedSeq: 0 }))).type,
      ).toBe("error");
      expect(
        (
          await a.service.handle(
            command("baseline-progress", ref, "wrong", {
              baselineId: "wrong",
              lastParsedOrdinal: 0,
            }),
          )
        ).type,
      ).toBe("error");
      const progress = a.service.handle(
        command("baseline-progress", ref, "progress", {
          baselineId: "baseline",
          lastParsedOrdinal: 0,
        }),
      );
      await turns();
      f.session.receive(f.reply());
      await progress;
      expect(a.service.snapshot(ref.subscriptionId).route.credit.installed).toBe(false);
      f.session.receive(
        f.event(ref, {
          type: "baseline-end",
          run,
          subscription: ref,
          baselineId: "baseline",
          chunkCount: 1,
          totalBytes: 1,
          atSeq: 0,
        }),
      );
      const ack = a.service.handle(command("applied-ack", ref, "final", { appliedSeq: 0 }));
      await turns();
      f.session.receive(f.reply());
      await ack;
      expect(a.service.snapshot(ref.subscriptionId).route.credit).toMatchObject({
        installed: true,
        debtBytes: 0,
      });
    } finally {
      await f.dispose();
    }
  });

  it("binds the public compiled client to production B1 bytes and withholds ACK N until controlled view finish", async () => {
    const f = fixture();
    const a = f.connect();
    let callbacks;
    let clientId = 0;
    let finish;
    const finishGate = new Promise((resolve) => {
      finish = resolve;
    });
    const uplink = [];
    let pipeCursor = 1;
    const bootstrap = (terminal = false) => ({
      type: "cove-bootstrap-result",
      bootstrapVersion: 1,
      serverId: run.serverId,
      relayInstanceId: run.relayInstanceId,
      protocolVersion: PROTOCOL_VERSION,
      buildVersion: "peer",
      capabilities: [...M0_CAPABILITIES],
      profile,
      encoding,
      effectiveBudgets: f.budgets,
      ...(terminal ? { connection: a.connection } : {}),
    });
    const client = createClient({
      expectedServerId: run.serverId,
      expectedRelayInstanceId: run.relayInstanceId,
      buildVersion: "client",
      credentials: () => ({ authorization: "Bearer fixture", terminalSecret: "a".repeat(43) }),
      codec: { encode: codec.encode, decodeFatal: codec.decode },
      createOpaqueId: () => `client-${++clientId}`,
      scheduler: { nowMs: () => 0, setTimer: () => ({ dispose() {} }), yieldTurn: async () => {} },
      http: {
        post(_request, cb) {
          queueMicrotask(() =>
            cb.onResponse({
              status: 200,
              headers: {},
              body: codec.encode(JSON.stringify(bootstrap())),
            }),
          );
          return { cancel: () => "not-sent" };
        },
      },
      terminal: {
        open(cb) {
          callbacks = cb;
          cb.onOpen({
            send(message) {
              if (typeof message === "string")
                cb.onText(codec.encode(JSON.stringify(bootstrap(true))));
              else {
                const value = decode(message).metadata;
                uplink.push(value);
                void a.service.handle(value);
              }
              return "handed-off";
            },
            close() {},
            dispose() {},
          });
          return { cancel: () => "not-sent" };
        },
      },
    });
    a.onWrite((data) => {
      callbacks.onBinary(data);
      a.writes.at(-1).settled();
    });
    async function settleControls() {
      for (let round = 0; round < 8; round++) {
        await turns();
        while (pipeCursor < f.pipeWrites.length) {
          const value = decode(f.pipeWrites[pipeCursor++].data, true).metadata;
          if (["applied-ack", "baseline-progress", "unsubscribe"].includes(value.type))
            f.session.receive(f.reply(value));
        }
      }
    }
    try {
      expect((await client.connect()).ok).toBe(true);
      const opened = client.openTerminal({
        run,
        viewId: "client-view",
        initialAppearance: DEFAULT_APPEARANCE,
        view: {
          initialize: async () => {},
          beginBaseline: async () => {},
          writeBaselineChunk: async () => {},
          finishBaseline: async () => {
            await finishGate;
          },
          applyEvent: async () => {},
          measureGrid: () => geometry,
          setAppearance() {},
          setVisibility() {},
          onInputIntent: () => ({ dispose() {} }),
          onFocusIntent: () => ({ dispose() {} }),
          onFailure: () => ({ dispose() {} }),
          dispose() {},
        },
      });
      expect(opened.ok).toBe(true);
      const controller = opened.value;
      const attach = controller.attach();
      await turns();
      const sent = f.latest();
      expect(sent.type).toBe("subscribe");
      f.session.receive(f.reply(sent, { recoveryMode: "baseline", atSeq: 1 }));
      const ref = sent.subscription;
      const descriptor = baseline(ref, 1);
      f.session.receive(f.event(ref, { type: "baseline-start", run, descriptor }));
      f.session.receive(
        f.event(
          ref,
          { type: "baseline-chunk", run, subscription: ref, baselineId: "baseline", ordinal: 0 },
          new Uint8Array([65]),
        ),
      );
      f.session.receive(
        f.event(ref, {
          type: "baseline-end",
          run,
          subscription: ref,
          baselineId: "baseline",
          chunkCount: 1,
          totalBytes: 1,
          atSeq: 1,
        }),
      );
      await settleControls();
      expect(uplink.some((value) => value.type === "applied-ack")).toBe(false);
      expect(a.service.snapshot(ref.subscriptionId).route.credit.installed).toBe(false);
      finish();
      await settleControls();
      expect((await attach).ok).toBe(true);
      expect(uplink.find((value) => value.type === "applied-ack").appliedSeq).toBe(1);
      expect(a.service.snapshot(ref.subscriptionId).route.credit.installed).toBe(true);
      const recover = controller.recover("expired");
      await turns();
      const recovery = f.latest();
      expect(recovery).toMatchObject({ type: "recover", subscription: ref, appliedSeq: 1 });
      f.session.receive(f.reply(recovery, { recoveryMode: "replay", atSeq: 1 }));
      await settleControls();
      expect((await recover).ok).toBe(true);
      const detach = controller.detach();
      await settleControls();
      expect((await detach).ok).toBe(true);
      expect(uplink.map((value) => value.type)).not.toContain("input");
      expect(f.pipeWrites.map((item) => decode(item.data, true).metadata.type)).not.toContain(
        "stop",
      );
    } finally {
      finish();
      client.dispose();
      await f.dispose();
    }
    expect(f.bytes.snapshot().total).toBe(0);
  });
});
