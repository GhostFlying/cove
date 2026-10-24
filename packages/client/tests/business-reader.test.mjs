import { expect, test } from "vitest";
import { openBusinessEvents } from "@cove/client";
import { BUSINESS_LIMITS } from "@cove/protocol/business-events";
import { bootstrapFailure } from "@cove/protocol/bootstrap";
import {
  batch,
  codec,
  config,
  cursor,
  eventPort,
  identity,
  manualClock,
  settle,
  snapshot,
} from "./business-fixture.mjs";

function reader(options = {}) {
  const clock = options.scheduler ?? manualClock();
  const events = eventPort();
  const received = [];
  const value = openBusinessEvents({
    target: identity,
    buildVersion: "fixture",
    credentials: () => ({ authorization: "fixture", terminalSecret: "s".repeat(43) }),
    scheduler: clock,
    codec,
    port: events.port,
    request: { type: "subscribe", filter: {} },
    frame: (frame) => received.push(frame),
    ...options,
  });
  return { value, events, received, clock };
}

test("reader accepts paged snapshot, concurrent ordered changes and filtered empty progress", async () => {
  const f = reader();
  await settle();
  const change = batch(cursor());
  for (const frame of [
    ...snapshot([config()]).slice(0, -1),
    change,
    { type: "ready", cursor: change.cursor },
  ])
    f.events.latest().emit(frame);
  await settle(100);
  expect(f.received.at(-1)).toEqual({ type: "ready", cursor: change.cursor });
  expect(f.events.latest().sent.map((message) => message.type)).toEqual([
    "cove-bootstrap",
    "subscribe",
  ]);
  f.value.dispose();
  expect(await f.value.done).toEqual({ kind: "disposed" });
  expect(f.events.latest().closed).toBe(1);
  expect(f.events.latest().cancelled).toBe(1);
});

test("dispose settles a pending credential lookup and its late result never opens a port", async () => {
  let resolve;
  let opened = 0;
  const credential = new Promise((done) => {
    resolve = done;
  });
  const f = reader({
    credentials: () => credential,
    port: {
      open() {
        opened++;
        throw new Error("must not open");
      },
    },
  });
  await settle();
  f.value.dispose();
  expect(await f.value.done).toEqual({ kind: "disposed" });
  resolve({ terminalSecret: "s".repeat(43) });
  await settle();
  expect(opened).toBe(0);
  expect(f.clock.pending).toBe(0);
});

test("reader preserves bootstrap refusal but never includes malformed private data in diagnostics", async () => {
  for (const [frame, expected] of [
    [bootstrapFailure("DEVICE_REVOKED"), "DEVICE_REVOKED"],
    ['{"private":"synthetic-sensitive"', "Invalid business event JSON"],
  ]) {
    const f = reader({
      port: {
        open(callbacks) {
          callbacks.onOpen({
            send() {
              queueMicrotask(() =>
                callbacks.onText(
                  codec.encode(typeof frame === "string" ? frame : JSON.stringify(frame)),
                ),
              );
              return "handed-off";
            },
            close() {},
            dispose() {},
          });
          return { cancel: () => "handed-off" };
        },
      },
    });
    const outcome = await f.value.done;
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain(expected);
    expect(outcome.message).not.toContain("synthetic-sensitive");
  }
});

test("reader enforces setup and callback deadlines while a ready idle stream needs no timer", async () => {
  const f = reader();
  await settle();
  for (const frame of snapshot()) f.events.latest().emit(frame);
  await settle(100);
  expect(f.clock.pending).toBe(0);
  f.clock.advance(BUSINESS_LIMITS.progressTimeoutMs * 2);
  expect(f.received.at(-1).type).toBe("ready");
  f.value.dispose();
  const waiting = reader({ credentials: () => new Promise(() => {}) });
  await settle();
  waiting.clock.advance(BUSINESS_LIMITS.progressTimeoutMs);
  expect((await waiting.value.done).message).toContain("credential unavailable");
  const blocked = reader({ frame: () => new Promise(() => {}) });
  await settle();
  blocked.events.latest().emit(snapshot()[0]);
  await settle();
  blocked.clock.advance(BUSINESS_LIMITS.progressTimeoutMs);
  expect((await blocked.value.done).kind).toBe("error");
});

test("bounded queue overflow settles even when output is stalled and late callbacks remain fenced", async () => {
  const f = reader({ frame: () => new Promise(() => {}) });
  await settle();
  f.events.latest().emit(snapshot()[0]);
  await settle();
  for (let index = 0; index < BUSINESS_LIMITS.queueItems; index++)
    f.events.latest().emit({ type: "ready", cursor: cursor() });
  const outcome = await f.value.done;
  expect(outcome.message).toContain("overflow");
  f.events.latest().callbacks.onClose();
  f.value.dispose();
  expect(f.clock.pending).toBe(0);
});

test("reset and refusal frames are delivered before their explicit terminal outcomes", async () => {
  for (const frame of [
    { type: "reset", reason: "gap" },
    { type: "error", reason: "busy" },
  ]) {
    const f = reader();
    await settle();
    f.events.latest().emit(frame);
    expect(await f.value.done).toEqual({
      kind: frame.type === "reset" ? "reset" : "refused",
      reason: frame.reason,
    });
    expect(f.received).toEqual([frame]);
  }
});

test("wrong cursor binding and missing snapshot pages fail rather than claiming ready", async () => {
  for (const frames of [
    [...snapshot().slice(0, 2), { ...snapshot()[2], pages: 2 }],
    [
      ...snapshot().slice(0, 2),
      { ...snapshot()[2], cursor: { ...cursor(), relayInstanceId: "other" } },
    ],
  ]) {
    const f = reader();
    await settle();
    for (const frame of frames) f.events.latest().emit(frame);
    expect((await f.value.done).kind).toBe("error");
    expect(f.received.some((frame) => frame.type === "ready")).toBe(false);
  }
});
