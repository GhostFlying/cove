import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const candidate = process.env.COVE_N1_PACKAGE_ROOT;
const { __createBoundedWriteStreamForTest: createWriter } = candidate
  ? require(`${candidate}/lib/unixTerminal.js`)
  : require("node-pty/lib/unixTerminal.js");

class WriteIo {
  constructor() {
    this.immediates = [];
    this.timers = [];
    this.writes = [];
    this.closes = [];
    this.onClose = undefined;
    this.closeError = undefined;
    this.throwNextWrite = undefined;
  }
  write(fd, buffer, offset, callback) {
    if (this.throwNextWrite) {
      const error = this.throwNextWrite;
      this.throwNextWrite = undefined;
      throw error;
    }
    this.writes.push({ fd, buffer, offset, callback });
  }
  close(fd) {
    this.closes.push(fd);
    this.onClose?.();
    if (this.closeError) throw this.closeError;
  }
  setImmediate(callback) {
    const handle = { callback, cleared: false };
    this.immediates.push(handle);
    return handle;
  }
  clearImmediate(handle) {
    if (handle) handle.cleared = true;
  }
  setTimeout(callback, delay) {
    const handle = { callback, delay, cleared: false };
    this.timers.push(handle);
    return handle;
  }
  clearTimeout(handle) {
    if (handle) handle.cleared = true;
  }
  turn() {
    const handle = this.immediates.shift();
    assert.ok(handle, "expected a scheduled turn");
    if (!handle.cleared) handle.callback();
  }
  complete(written, error = null) {
    const write = this.writes.shift();
    assert.ok(write, "expected an issued write");
    write.callback(error, written);
    return write;
  }
}

const bounded = (io, options = { maxAllocatedBytes: 8, maxTasks: 2 }) =>
  createWriter(41, "utf8", options, io);

test("bounded owner closes idle once and publishes after close", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  let outcome;
  stream.boundedWriteCompletion.then((value) => {
    outcome = value;
  });
  stream.dispose();
  stream.dispose();
  expect(io.closes).toEqual([41]);
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
  expect(outcome).toEqual({ kind: "closed" });
  expect(stream.writeBounded("x", () => {})).toEqual({ accepted: false, reason: "closed" });
});

test("issued write retains descriptor and allocation until its callback, then closes before FIFO settlement", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const events = [];
  io.onClose = () => events.push("close");
  expect(
    stream.writeBounded("abcd", (value) => {
      events.push("first");
      expect(value).toMatchObject({ status: "closed", writtenBytes: 2, remainingBytes: 2 });
      expect(stream.getBoundedState().allocatedBytes).toBe(8);
    }).accepted,
  ).toBe(true);
  stream.writeBounded("WXYZ", (value) => {
    events.push("second");
    expect(value).toMatchObject({ status: "closed", writtenBytes: 0, remainingBytes: 4 });
  });
  io.turn();
  stream.dispose();
  expect(io.closes).toEqual([]);
  expect(stream.getBoundedState().writeInFlight).toBe(true);
  io.complete(2);
  expect(events).toEqual(["close", "first", "second"]);
  expect(stream.getBoundedState()).toMatchObject({
    allocatedBytes: 0,
    remainingBytes: 0,
    tasks: 0,
    writeInFlight: false,
  });
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("a stale callback cannot consume the next issued write or close its descriptor", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const settlements = [];
  stream.writeBounded("abc", (value) => settlements.push(value));
  stream.writeBounded("d", (value) => settlements.push(value));
  io.turn();
  const stale = io.writes[0].callback;
  io.complete(1);
  io.turn();
  stale(null, 1);
  expect(io.closes).toEqual([]);
  expect(stream.getBoundedState()).toMatchObject({
    state: "error",
    tasks: 2,
    writeInFlight: true,
  });
  io.complete(2);
  expect(io.closes).toEqual([41]);
  expect(settlements.map((value) => [value.status, value.writtenBytes])).toEqual([
    ["written", 3],
    ["error", 0],
  ]);
  expect(stream.getBoundedState()).toMatchObject({ tasks: 0, allocatedBytes: 0 });
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("invalid completion after disposal still closes and settles the owner", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const settlements = [];
  stream.writeBounded("ab", (value) => settlements.push(value));
  io.turn();
  stream.dispose();
  io.complete(Number.NaN);
  expect(io.closes).toEqual([41]);
  expect(settlements).toMatchObject([
    { status: "error", originalBytes: 2, writtenBytes: 0, remainingBytes: 2, errorCode: "EIO" },
  ]);
  expect(stream.getBoundedState()).toMatchObject({ tasks: 0, allocatedBytes: 0 });
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("reentrant disposal cannot publish completion before the active settlement unwinds", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const events = [];
  io.onClose = () => events.push("close");
  stream.boundedWriteCompletion.then(() => events.push("complete"));
  stream.writeBounded("a", () => {
    events.push("settle-start");
    stream.dispose();
    expect(stream.getBoundedState().tasks).toBe(1);
    events.push("settle-end");
  });
  io.turn();
  io.complete(1);
  expect(events).toEqual(["settle-start", "close", "settle-end"]);
  await stream.boundedWriteCompletion;
  expect(events).toEqual(["settle-start", "close", "settle-end", "complete"]);
  expect(io.closes).toEqual([41]);
});

test("submission throw after a prefix preserves that prefix and settles all tickets", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const settlements = [];
  stream.writeBounded("abc", (value) => settlements.push(value));
  stream.writeBounded("d", (value) => settlements.push(value));
  io.turn();
  io.complete(1);
  const error = Object.assign(new Error("synthetic submit"), { code: "EIO" });
  io.throwNextWrite = error;
  io.turn();
  expect(io.closes).toEqual([41]);
  expect(settlements.map((value) => [value.status, value.writtenBytes])).toEqual([
    ["error", 1],
    ["error", 0],
  ]);
  expect(stream.getBoundedState()).toMatchObject({ writeInFlight: false, tasks: 0 });
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("callback exceptions do not skip other settlements or owner completion", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const events = [];
  stream.writeBounded("a", () => {
    events.push("first");
    throw new Error("callback");
  });
  stream.writeBounded("b", () => events.push("second"));
  io.turn();
  stream.dispose();
  expect(() => io.complete(0)).toThrow("callback");
  expect(events).toEqual(["first", "second"]);
  expect(io.closes).toEqual([41]);
  expect(stream.getBoundedState().tasks).toBe(0);
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("ambiguous close is never retried and retains a finite owner-ledger tombstone", async () => {
  const io = new WriteIo();
  io.closeError = Object.assign(new Error("ambiguous close"), { code: "EINTR" });
  const stream = bounded(io);
  const ownerLedger = { occupied: 1 };
  const result = stream.boundedWriteCompletion.then((value) => {
    if (value.kind === "closed") ownerLedger.occupied--;
    return value;
  });
  stream.dispose();
  stream.dispose();
  expect(io.closes).toEqual([41]);
  expect(await result).toEqual({ kind: "close-uncertain", error: "ambiguous close" });
  expect(ownerLedger.occupied).toBe(1);
  expect(ownerLedger.occupied < 1).toBe(false);
});

test("permanent callback error reports its returned prefix and cancels later work", async () => {
  const io = new WriteIo();
  const stream = bounded(io, { maxAllocatedBytes: 16, maxTasks: 2 });
  const settlements = [];
  stream.writeBounded("abcd", (value) => settlements.push(value));
  stream.writeBounded("later", (value) => settlements.push(value));
  io.turn();
  const error = Object.assign(new Error("synthetic write"), { code: "EIO" });
  io.complete(2, error);
  expect(io.writes).toHaveLength(0);
  expect(io.closes).toEqual([41]);
  expect(settlements.map((value) => [value.status, value.writtenBytes, value.errorCode])).toEqual([
    ["error", 2, "EIO"],
    ["error", 0, "EIO"],
  ]);
  expect(stream.writeBounded("x", () => {})).toEqual({ accepted: false, reason: "error" });
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("a successful settlement callback exception fences and closes the owner", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  const events = [];
  stream.writeBounded("a", () => {
    events.push("first");
    throw new Error("callback failure");
  });
  stream.writeBounded("b", () => events.push("second"));
  io.turn();
  expect(() => io.complete(1)).toThrow("callback failure");
  expect(events).toEqual(["first", "second"]);
  expect(io.closes).toEqual([41]);
  expect(stream.getBoundedState()).toMatchObject({ state: "error", tasks: 0 });
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("EAGAIN and zero progress pace retries and disposal cancels the timer", async () => {
  const io = new WriteIo();
  const stream = bounded(io);
  stream.writeBounded("xy", () => {});
  io.turn();
  io.complete(0, Object.assign(new Error("retry"), { code: "EAGAIN" }));
  expect(io.timers).toHaveLength(1);
  expect(io.timers[0].delay).toBe(1);
  io.timers.shift().callback();
  io.turn();
  io.complete(0);
  expect(io.timers).toHaveLength(1);
  stream.dispose();
  expect(io.timers[0].cleared).toBe(true);
  expect(io.closes).toEqual([41]);
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});

test("admission limits reject without copying while accepted buffers detach once", async () => {
  const io = new WriteIo();
  const stream = bounded(io, { maxAllocatedBytes: 4, maxTasks: 1 });
  expect(stream.writeBounded(Buffer.alloc(0), () => {})).toEqual({
    accepted: false,
    reason: "empty",
  });
  expect(stream.writeBounded("abcde", () => {})).toEqual({ accepted: false, reason: "byte-limit" });
  const source = Buffer.from("abcd");
  expect(stream.writeBounded(source, () => {})).toMatchObject({ accepted: true, byteLength: 4 });
  source.fill(0x78);
  expect(stream.writeBounded("z", () => {})).toEqual({ accepted: false, reason: "task-limit" });
  io.turn();
  expect(io.writes[0].buffer.toString()).toBe("abcd");
  io.complete(4);
  stream.dispose();
  expect(await stream.boundedWriteCompletion).toEqual({ kind: "closed" });
});
