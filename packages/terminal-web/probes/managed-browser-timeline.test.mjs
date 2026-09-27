import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import {
  BrowserCloseTimeline,
  observeBrowserVersion,
} from "../dist/probes/node/managed-browser.js";

function attachedTimeline() {
  const timeline = new BrowserCloseTimeline();
  const server = new EventEmitter();
  const process = new EventEmitter();
  const browser = new EventEmitter();
  browser.isConnected = () => true;
  timeline.attachServer(server, process);
  timeline.attachBrowser(browser);
  timeline.beginCleanup();
  timeline.beforeClose();
  return { timeline, server, process, browser };
}

test("public events may precede raw close settlement without claiming an ACK", async () => {
  const { timeline, server, process, browser } = attachedTimeline();
  let resolveClose;
  const close = timeline.invoke(
    "rawClose",
    () => new Promise((resolve) => (resolveClose = resolve)),
  );
  timeline.observeWrapper(close);
  browser.emit("disconnected");
  server.emit("close");
  process.emit("exit", 0, null);
  expect(timeline.record.rawClose.outcome).toBe("pending");
  expect(timeline.record.disconnected.count).toBe(1);
  expect(timeline.record.serverClose.count).toBe(1);
  expect(timeline.record.processExit.count).toBe(1);
  expect(timeline.record).not.toHaveProperty("protocolAck");
  resolveClose();
  await close;
  expect(timeline.record.rawClose.outcome).toBe("fulfilled");
  timeline.finalize();
  expect(browser.listenerCount("disconnected")).toBe(0);
  expect(server.listenerCount("close")).toBe(0);
  expect(process.listenerCount("exit")).toBe(0);
});

test("timeout, forced exit and late raw settlement keep a finite final snapshot", async () => {
  const { timeline, server, process, browser } = attachedTimeline();
  let resolveClose;
  const close = timeline.invoke(
    "rawClose",
    () => new Promise((resolve) => (resolveClose = resolve)),
  );
  timeline.observeWrapper(close);
  timeline.markWrapperTimeout();
  const kill = timeline.invoke("rawKill", () => Promise.resolve());
  process.emit("exit", null, "SIGKILL");
  await kill;
  timeline.finalize();
  const snapshot = structuredClone(timeline.record);
  resolveClose();
  await close;
  browser.emit("disconnected");
  server.emit("close");
  process.emit("exit", 0, null);
  expect(timeline.record).toEqual(snapshot);
  expect(snapshot.closeWrapper.timeoutObservedMs).not.toBeNull();
  expect(snapshot.rawClose.outcome).toBe("pending");
  expect(snapshot.rawKill.outcome).toBe("fulfilled");
});

test("an injected wrapper delay does not lengthen the observed raw close call", async () => {
  const { timeline } = attachedTimeline();
  const raw = timeline.invoke("rawClose", () => Promise.resolve());
  let releaseDelay;
  const wrapper = raw.then(() => new Promise((resolve) => (releaseDelay = resolve)));
  timeline.observeWrapper(wrapper);
  await raw;
  await Promise.resolve();
  expect(timeline.record.rawClose.outcome).toBe("fulfilled");
  expect(timeline.record.closeWrapper.outcome).toBe("pending");
  releaseDelay();
  await wrapper;
  timeline.finalize();
  expect(timeline.record.closeWrapper.outcome).toBe("fulfilled");
});

test("synchronous throw and asynchronous rejection are distinct and handled", async () => {
  const { timeline } = attachedTimeline();
  const original = new Error("original close failure");
  expect(() =>
    timeline.invoke("rawClose", () => {
      throw original;
    }),
  ).toThrow(original);
  expect(timeline.record.rawClose.outcome).toBe("threw");
  const rejected = timeline.invoke("rawKill", () => Promise.reject(original));
  await expect(rejected).rejects.toBe(original);
  expect(timeline.record.rawKill.outcome).toBe("rejected");
  timeline.finalize();
});

test("missing and repeated events remain bounded through failed connection cleanup", () => {
  const timeline = new BrowserCloseTimeline();
  const server = new EventEmitter();
  const process = new EventEmitter();
  timeline.attachServer(server, process);
  timeline.beginCleanup();
  for (let index = 0; index < 20; index++) server.emit("close");
  expect(timeline.record.serverClose.count).toBe(2);
  expect(timeline.record.disconnected).toEqual({ firstMs: null, count: 0 });
  expect(timeline.record.connectedAtFinal).toBeNull();
  timeline.finalize();
  expect(server.listenerCount("close")).toBe(0);
  expect(process.listenerCount("exit")).toBe(0);
});

test("public browser version remains observed when pin validation fails", () => {
  let observed = null;
  expect(() => {
    observed = observeBrowserVersion({ version: () => "152.0.0.0" }, "153.0.8010.12");
    if (!observed.pinMatched) throw new Error("version mismatch");
  }).toThrow("version mismatch");
  expect(observed).toEqual({ value: "152.0.0.0", pinMatched: false, truncated: false });

  observed = null;
  expect(() =>
    observeBrowserVersion(
      {
        version: () => {
          throw new Error("version unavailable");
        },
      },
      "153.0.8010.12",
    ),
  ).toThrow("version unavailable");
  expect(observed).toBeNull();
  expect(observeBrowserVersion({ version: () => "1".repeat(100) }, "153.0.8010.12")).toEqual({
    value: "1".repeat(80),
    pinMatched: false,
    truncated: true,
  });
});
