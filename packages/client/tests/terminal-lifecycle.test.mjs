import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { createTerminalDecoder, encodeTerminalFrame } from "@cove/protocol/terminal";
import { TerminalLane } from "../dist/terminal-delivery.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const run = { serverId: "server-1", relayInstanceId: "instance-1", runId: "run-1" };
const connection = { connectionId: "connection-1", generation: 1 };
const a = { run, connection, subscriptionId: "subscription-a", viewId: "view-a" };
const b = { run, connection, subscriptionId: "subscription-b", viewId: "view-b" };

function laneFixture(onSend = () => "handed-off") {
  const sent = [];
  let sequence = 0;
  const lane = new TerminalLane(
    {
      binding: () => ({
        serverId: run.serverId,
        relayInstanceId: run.relayInstanceId,
        effectiveBudgets: M0_LIMITS,
      }),
      socket: () => ({
        send(bytes) {
          sent.push(bytes);
          return onSend(bytes, lane);
        },
      }),
      invalid: () => {
        throw new Error("unexpected invalid connection");
      },
      preview: () => "unrouteable",
      previewReply: () => "unrouteable",
    },
    { encode: (text) => encoder.encode(text), decodeFatal: (bytes) => decoder.decode(bytes) },
    { nowMs: () => 0, setTimer: () => ({ dispose() {} }), yieldTurn: async () => {} },
    () => `id-${++sequence}`,
  );
  return { lane, sent };
}

function input(requestId, subscription = a) {
  return {
    type: "input",
    requestId,
    run,
    subscription,
    epoch: 1,
    inputSeq: Number(requestId.slice(2)) || 1,
  };
}

function ack(requestId, subscription = b) {
  return {
    type: "applied-ack",
    requestId,
    run,
    subscription,
    appliedSeq: 0,
  };
}

function sentRequestId(bytes) {
  const parser = createTerminalDecoder();
  const read = parser.read(bytes);
  expect(read.frames).toHaveLength(1);
  expect(parser.finish().ok).toBe(true);
  return JSON.parse(decoder.decode(read.frames[0].metadata)).requestId;
}

function resultFrame(metadata) {
  const encoded = encodeTerminalFrame(
    2,
    encoder.encode(JSON.stringify(metadata)),
    new Uint8Array(),
  );
  if (!encoded.ok) throw new Error("invalid fixture result");
  return encoded.value;
}

describe("lane residual bounds — explicitly white-box compiled branch", () => {
  test("224 result-first preview joins retain ordinary slots and leave only 32 control slots", async () => {
    const { lane, sent } = laneFixture();
    const completedResults = [];
    for (let index = 1; index <= 224; index++) {
      const requestId = `preview-${index}`;
      completedResults.push(lane.send({ type: "preview", requestId, run }, 5_000));
      lane.receive(
        resultFrame({
          type: "preview-result",
          requestId,
          run,
          status: "transfer",
          version: 1,
          previewId: `p-${requestId}`,
        }),
        connection,
      );
    }
    expect(lane.pendingCount).toBe(224);
    expect(sent).toHaveLength(224);
    expect(
      await lane.send({ type: "preview", requestId: "preview-225", run }, 5_000),
    ).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
    });
    const progress = [];
    for (let index = 1; index <= 32; index++)
      progress.push(lane.send(ack(`held-ack-${index}`), 5_000));
    expect(lane.pendingCount).toBe(256);
    expect(await lane.send(ack("held-ack-33"), 5_000)).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
    });
    for (let index = 1; index <= 224; index++) lane.cancelPreview(`preview-${index}`);
    expect(lane.pendingCount).toBe(32);
    lane.close("transport");
    expect(lane.pendingCount).toBe(0);
    expect((await Promise.all(completedResults)).every((value) => value.ok)).toBe(true);
    expect((await Promise.all(progress)).every((value) => !value.ok)).toBe(true);
  });

  test("224 actual handed-off input frames leave 32 slots for progress and cap total at 256", async () => {
    // Controller input serialization cannot naturally expose all 224 lane slots.
    const { lane, sent } = laneFixture();
    const promises = [];
    for (let index = 1; index <= 224; index++)
      promises.push(
        lane.send(
          input(`in${index}`),
          5_000,
          undefined,
          undefined,
          undefined,
          new Uint8Array([65]),
        ),
      );
    expect(lane.pendingCount).toBe(224);
    expect(sent).toHaveLength(224);
    expect(
      await lane.send(input("in225"), 5_000, undefined, undefined, undefined, new Uint8Array([65])),
    ).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
      uncertain: false,
    });
    for (let index = 1; index <= 32; index++) promises.push(lane.send(ack(`ack${index}`), 5_000));
    expect(lane.pendingCount).toBe(256);
    expect(sent).toHaveLength(256);
    expect(await lane.send(ack("ack33"), 5_000)).toMatchObject({
      ok: false,
      error: { reason: "capacity" },
    });
    lane.close("transport");
    expect(lane.pendingCount).toBe(0);
    expect((await Promise.all(promises)).every((value) => !value.ok)).toBe(true);
  });

  test("a queued second route makes progress while the first route has pending work", async () => {
    const order = [];
    const pending = [];
    let queued = false;
    const { lane } = laneFixture((bytes, currentLane) => {
      order.push(sentRequestId(bytes));
      if (!queued) {
        queued = true;
        pending.push(
          currentLane.send(
            input("in2"),
            5_000,
            undefined,
            undefined,
            undefined,
            new Uint8Array([65]),
          ),
          currentLane.send(ack("ack1"), 5_000),
          currentLane.send(
            input("in3"),
            5_000,
            undefined,
            undefined,
            undefined,
            new Uint8Array([65]),
          ),
          currentLane.send(ack("ack2"), 5_000),
          currentLane.send({ type: "preview", requestId: "preview1", run }, 5_000),
        );
      }
      return "handed-off";
    });
    pending.push(
      lane.send(input("in1"), 5_000, undefined, undefined, undefined, new Uint8Array([65])),
    );
    expect(order).toEqual(["in1", "ack1", "in2", "ack2", "in3", "preview1"]);
    expect(lane.pendingCount).toBe(6);
    lane.close("transport");
    await Promise.all(pending);
  });

  test("counter exhaustion refuses new request identity without wrapping or sending", () => {
    const { lane, sent } = laneFixture();
    // Private TS fields are ordinary compiled properties; no production seeding API is added.
    lane.requestSequence = Number.MAX_SAFE_INTEGER;
    expect(lane.nextRequestId(1)).toBeNull();
    expect(sent).toHaveLength(0);
    lane.close("transport");
  });
});
