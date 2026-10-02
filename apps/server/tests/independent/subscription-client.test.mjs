import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { M0_CAPABILITIES, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { BASELINE_ENCODING, DEFAULT_APPEARANCE, PROFILE } from "@cove/protocol/profile";
import {
  assertExactCreditReturn,
  assertMarkerBefore,
  bytes,
  carrier,
  decodeFrames,
  deferred,
  fixture,
  geometry,
  ids,
  run,
  turns,
} from "./subscription-byte-harness.mjs";

const clientPackage = new URL("../../../../packages/client/package.json", import.meta.url);
const clientManifest = JSON.parse(readFileSync(clientPackage, "utf8"));
const { createClient } = await import(
  new URL(clientManifest.exports["."].import, clientPackage).href
);

function controlledView() {
  const facts = [];
  const controls = { chunk: undefined, finish: undefined, event: undefined };
  const view = {
    async initialize(input) {
      facts.push(["initialize", input.viewGeneration]);
    },
    async beginBaseline(descriptor) {
      facts.push(["begin", descriptor.baselineId, descriptor.atSeq]);
    },
    async writeBaselineChunk(payload) {
      facts.push(["chunk", payload.byteLength]);
      await controls.chunk?.promise;
    },
    async finishBaseline() {
      facts.push(["finish"]);
      await controls.finish?.promise;
    },
    async applyEvent(event, payload) {
      facts.push(["event", event.seq, payload?.byteLength]);
      await controls.event?.promise;
    },
    measureGrid: () => geometry,
    setAppearance() {},
    setVisibility() {},
    onInputIntent: () => ({ dispose() {} }),
    onFocusIntent: () => ({ dispose() {} }),
    onFailure: () => ({ dispose() {} }),
    dispose() {
      facts.push(["dispose"]);
    },
  };
  return { view, controls, facts };
}

async function clientFixture() {
  let callbacks;
  let clientId = 0;
  const uplink = [];
  const handled = new Set();
  const transport = carrier({
    onWrite(entry) {
      callbacks.onBinary(entry.encoded);
    },
  });
  const rig = fixture({ transport });
  const bootstrap = (terminal) => ({
    type: "cove-bootstrap-result",
    bootstrapVersion: 1,
    ...ids,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: "ind-client-peer",
    capabilities: [...M0_CAPABILITIES],
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: rig.composition.budgets,
    ...(terminal ? { connection: rig.connection } : {}),
  });
  const client = createClient({
    expectedServerId: ids.serverId,
    expectedRelayInstanceId: ids.relayInstanceId,
    buildVersion: "ind-client",
    credentials: () => ({
      authorization: "Bearer independent-fixture",
      terminalSecret: "z".repeat(43),
    }),
    codec: {
      encode: bytes,
      decodeFatal: (encoded) => new TextDecoder("utf-8", { fatal: true }).decode(encoded),
    },
    createOpaqueId: () => `ind-client-${++clientId}`,
    scheduler: { nowMs: () => 0, setTimer: () => ({ dispose() {} }), yieldTurn: async () => {} },
    http: {
      post(_request, sink) {
        queueMicrotask(() =>
          sink.onResponse({
            status: 200,
            headers: {},
            body: bytes(JSON.stringify(bootstrap(false))),
          }),
        );
        return { cancel: () => "not-sent" };
      },
    },
    terminal: {
      open(sink) {
        callbacks = sink;
        sink.onOpen({
          send(message) {
            if (typeof message === "string") sink.onText(bytes(JSON.stringify(bootstrap(true))));
            else
              for (const frame of decodeFrames(message)) {
                uplink.push(frame);
                void rig.service.handle(frame.metadata);
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
  expect((await client.connect()).ok).toBe(true);
  const controlled = controlledView();
  const opened = client.openTerminal({
    run,
    viewId: "ind-client-view",
    view: controlled.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  return {
    ...rig,
    rig,
    client,
    uplink,
    controlled,
    controller: opened.value,
    uplinkCommands(type) {
      return uplink
        .filter(({ metadata }) => metadata.type === type)
        .map(({ metadata }) => metadata);
    },
    async acceptUplink(types = ["baseline-progress", "applied-ack", "unsubscribe"]) {
      for (let pass = 0; pass < 8; pass++) {
        await turns();
        const pending = rig.commands.filter(
          (command) => types.includes(command.type) && !handled.has(command.requestId),
        );
        if (!pending.length) return;
        for (const command of pending) {
          handled.add(command.requestId);
          rig.accept(command);
        }
      }
      throw new Error("uplink fixture did not quiesce");
    },
    async beginBaseline() {
      const pending = opened.value.attach();
      await turns();
      const subscribe = rig.lastCommand("subscribe");
      expect(subscribe.atSeq).toBe(0);
      rig.accept(subscribe, { recoveryMode: "baseline", atSeq: 3 });
      rig.emitBaseline(subscribe.subscription);
      return { pending, subscription: subscribe.subscription };
    },
    async stop() {
      client.dispose();
      for (const gate of Object.values(controlled.controls)) gate?.resolve();
      await rig.stop();
    },
  };
}

async function withClient(exercise) {
  const harness = await clientFixture();
  try {
    await exercise(harness);
  } finally {
    await harness.stop();
  }
}

describe("P2-B1 independent compiled public client composition", () => {
  test("F16-01 actual chunk parsing precedes progress and finish installation precedes ACK", async () => {
    await withClient(async (harness) => {
      const chunk = deferred();
      const finish = deferred();
      harness.controlled.controls.chunk = chunk;
      harness.controlled.controls.finish = finish;
      const { pending, subscription } = await harness.beginBaseline();
      await turns();
      expect(harness.controlled.facts.some(([type]) => type === "chunk")).toBe(true);
      expect(harness.uplinkCommands("baseline-progress")).toEqual([]);
      expect(harness.uplinkCommands("applied-ack")).toEqual([]);
      const debt = harness.service.snapshot(subscription.subscriptionId).route.credit.debtBytes;
      chunk.resolve();
      await turns();
      await harness.acceptUplink(["baseline-progress"]);
      expect(harness.controlled.facts.some(([type]) => type === "finish")).toBe(true);
      expect(
        harness.uplinkCommands("baseline-progress").map((command) => command.lastParsedOrdinal),
      ).toEqual([0, 1]);
      expect(harness.uplinkCommands("applied-ack")).toEqual([]);
      const credit = harness.service.snapshot(subscription.subscriptionId).route.credit;
      const parsed = harness.transport
        .trace()
        .filter(
          ({ metadata }) =>
            metadata.type === "baseline-start" || metadata.type === "baseline-chunk",
        );
      assertExactCreditReturn(debt, credit.debtBytes, parsed);
      expect(credit.installed).toBe(false);
      finish.resolve();
      await turns();
      expect((await pending).ok).toBe(true);
      await harness.acceptUplink();
      expect(harness.uplinkCommands("applied-ack").map((command) => command.appliedSeq)).toEqual([
        3,
      ]);
      expect(harness.controller.snapshot()).toMatchObject({
        phase: "ready",
        appliedSeq: 3,
        subscription,
      });
      expect(harness.service.snapshot(subscription.subscriptionId).route.credit).toMatchObject({
        installed: true,
        debtBytes: 0,
      });
      expect(
        harness.uplink.every(({ metadata }) =>
          ["attach", "baseline-progress", "applied-ack"].includes(metadata.type),
        ),
      ).toBe(true);
    });
  });

  test("F16-01 carrier settlement and held live apply cannot manufacture parsed ACK", async () => {
    await withClient(async (harness) => {
      const { pending, subscription } = await harness.beginBaseline();
      await turns();
      await harness.acceptUplink();
      expect((await pending).ok).toBe(true);
      const apply = deferred();
      harness.controlled.controls.event = apply;
      const ackCount = harness.uplinkCommands("applied-ack").length;
      harness.session.receive(harness.output(subscription, 4, "held"));
      await turns();
      expect(harness.delivery.snapshot().physicalBytes).toBe(0);
      expect(harness.uplinkCommands("applied-ack").length).toBe(ackCount);
      expect(harness.service.snapshot(subscription.subscriptionId).route.credit.debtBytes).toBe(
        harness.transport.trace().at(-1).encodedBytes,
      );
      expect(harness.controller.snapshot().appliedSeq).toBe(3);
      apply.resolve();
      await turns();
      await harness.acceptUplink();
      expect(harness.uplinkCommands("applied-ack").at(-1).appliedSeq).toBe(4);
      expect(harness.service.snapshot(subscription.subscriptionId).route.credit.debtBytes).toBe(0);
    });
  });

  test("F16-02 installed retained resume keeps stable refs and real marker precedes replay", async () => {
    await withClient(async (harness) => {
      const initial = await harness.beginBaseline();
      await turns();
      await harness.acceptUplink();
      await initial.pending;
      const recovered = harness.controller.recover("expired");
      await turns();
      const external = harness.uplinkCommands("recover").at(-1);
      expect(external.subscription).toEqual(initial.subscription);
      expect(external.resume.appliedSeq).toBe(3);
      const command = harness.lastCommand("recover");
      expect(command.appliedSeq).toBe(3);
      harness.accept(command, { recoveryMode: "replay", atSeq: 4 }, [
        harness.output(initial.subscription, 4, "replayed"),
      ]);
      assertMarkerBefore(
        harness.transport.trace(),
        external.requestId,
        (metadata) => metadata.type === "run-event" && metadata.event.seq === 4,
      );
      await turns();
      await harness.acceptUplink();
      expect((await recovered).ok).toBe(true);
      expect(harness.controller.snapshot()).toMatchObject({
        phase: "ready",
        appliedSeq: 4,
        subscription: initial.subscription,
      });
      expect(harness.uplinkCommands("attach")).toHaveLength(1);
    });
  });

  test("F16-02 equal-N gap recovery fences a deferred old parse completion", async () => {
    await withClient(async (harness) => {
      const initial = await harness.beginBaseline();
      await turns();
      await harness.acceptUplink();
      await initial.pending;
      const oldApply = deferred();
      harness.controlled.controls.event = oldApply;
      harness.session.receive(harness.output(initial.subscription, 4, "old-attempt"));
      await turns();
      const recovered = harness.controller.recover("gap");
      await turns();
      const external = harness.uplinkCommands("recover").at(-1);
      expect(external.resume).toBeUndefined();
      expect(harness.lastCommand("recover").appliedSeq).toBeUndefined();
      harness.accept(harness.lastCommand("recover"), { recoveryMode: "baseline", atSeq: 3 });
      const finish = deferred();
      harness.controlled.controls.finish = finish;
      harness.emitBaseline(initial.subscription, { baselineId: "new-baseline", atSeq: 3 });
      const oldAckCount = harness.uplinkCommands("applied-ack").length;
      oldApply.resolve();
      await turns();
      await harness.acceptUplink(["baseline-progress"]);
      expect(harness.uplinkCommands("applied-ack").length).toBe(oldAckCount);
      expect(
        harness
          .uplinkCommands("baseline-progress")
          .filter((command) => command.baselineId === "new-baseline").length,
      ).toBeGreaterThan(0);
      expect(
        harness.service.snapshot(initial.subscription.subscriptionId).route.credit,
      ).toMatchObject({ attempt: 2, installed: false });
      finish.resolve();
      await turns();
      await harness.acceptUplink();
      expect((await recovered).ok).toBe(true);
      expect(harness.uplinkCommands("applied-ack").at(-1).appliedSeq).toBe(3);
      expect(
        harness.uplinkCommands("applied-ack").some((command) => command.appliedSeq === 4),
      ).toBe(false);
      expect(harness.controller.snapshot().subscription).toEqual(initial.subscription);
    });
  });

  test("F16-03 detach retires server producer and fences held client parse without stopping run", async () => {
    await withClient(async (harness) => {
      const initial = await harness.beginBaseline();
      await turns();
      await harness.acceptUplink();
      await initial.pending;
      const oldApply = deferred();
      harness.controlled.controls.event = oldApply;
      harness.session.receive(harness.output(initial.subscription, 4, "held-before-detach"));
      await turns();
      const ackCount = harness.uplinkCommands("applied-ack").length;
      const detached = harness.controller.detach();
      await turns();
      await harness.acceptUplink(["unsubscribe"]);
      expect((await detached).ok).toBe(true);
      const traceCount = harness.transport.trace().length;
      harness.session.receive(harness.output(initial.subscription, 5, "late-after-detach"));
      oldApply.resolve();
      await turns();
      expect(harness.transport.trace().length).toBe(traceCount);
      expect(harness.uplinkCommands("applied-ack").length).toBe(ackCount);
      expect(harness.controller.snapshot().subscription).toBeUndefined();
      expect(harness.controller.snapshot().inputReady).toBe(false);
      expect(harness.controller.snapshot().appliedSeq).toBe(3);
      expect(harness.rig.commands.filter((command) => command.type === "unsubscribe")).toHaveLength(
        1,
      );
      expect(
        harness.rig.commands.some((command) =>
          ["stop", "set-control", "input"].includes(command.type),
        ),
      ).toBe(false);
      expect(harness.service.snapshot(initial.subscription.subscriptionId).route.phase).toBe(
        "retired",
      );
    });
  });
});
