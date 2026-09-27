import { expect, test, vi } from "vitest";
import { PtyInputController, SharedNativeInputBudget } from "../dist/src/pty-input.js";

function controller(options = {}) {
  const faults = [];
  const writer = {
    writeBounded: options.writeBounded ?? vi.fn(() => ({ accepted: false, reason: "closed" })),
    disposeBoundedWrite: vi.fn(() => true),
  };
  const shared = options.shared ?? new SharedNativeInputBudget(8, 2);
  const input = new PtyInputController({
    writer,
    sharedBudget: shared,
    maxBytes: options.maxBytes ?? 8,
    maxTasks: options.maxTasks ?? 2,
    onFault: (fault) => faults.push(fault),
  });
  return { input, writer, shared, faults };
}

test("two-level byte and task caps reject before native entry and rollback zero-write rejection", () => {
  const settlements = [];
  let held;
  let ticket = 1;
  const first = controller({
    maxBytes: 4,
    maxTasks: 1,
    writeBounded: vi.fn((bytes, callback) => {
      held = callback;
      return { accepted: true, ticket: ticket++, byteLength: bytes.byteLength };
    }),
  });
  expect(
    first.input.submit(Buffer.from("ABCD"), "user", (value) => settlements.push(value)),
  ).toEqual({
    kind: "accepted",
    ticket: 1,
    byteLength: 4,
    origin: "user",
  });
  expect(first.input.submit(Buffer.from("E"), "query", vi.fn())).toEqual({
    kind: "rejected",
    reason: "pty-task-limit",
    writtenBytes: 0,
  });
  expect(first.writer.writeBounded).toHaveBeenCalledTimes(1);
  expect(first.input.snapshot()).toMatchObject({ allocatedBytes: 4, tasks: 1 });
  expect(first.shared.snapshot()).toMatchObject({ allocatedBytes: 4, tasks: 1 });
  held({ ticket: 1, status: "written", originalBytes: 4, writtenBytes: 4, remainingBytes: 0 });
  expect(settlements).toEqual([
    {
      kind: "written",
      ticket: 1,
      status: "written",
      originalBytes: 4,
      writtenBytes: 4,
      remainingBytes: 0,
    },
  ]);
  expect(first.input.snapshot()).toMatchObject({
    allocatedBytes: 0,
    tasks: 0,
    peakAllocatedBytes: 4,
  });

  const rejected = controller({
    shared: first.shared,
    writeBounded: vi.fn(() => ({ accepted: false, reason: "byte-limit" })),
  });
  expect(rejected.input.submit(Buffer.from("12"), "focus", vi.fn())).toEqual({
    kind: "rejected",
    reason: "native-byte-limit",
    writtenBytes: 0,
  });
  expect(rejected.input.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
  expect(first.shared.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
});

test("factory byte and task caps apply across independent PTY controllers", () => {
  const shared = new SharedNativeInputBudget(8, 2);
  const callbacks = [];
  let ticket = 1;
  const writeBounded = vi.fn((bytes, onSettled) => {
    const currentTicket = ticket++;
    callbacks.push({ currentTicket, bytes: bytes.byteLength, onSettled });
    return { accepted: true, ticket: currentTicket, byteLength: bytes.byteLength };
  });
  const first = controller({ shared, writeBounded });
  const second = controller({ shared, writeBounded });
  const third = controller({ shared, writeBounded });

  expect(first.input.submit(Buffer.alloc(6), "user", vi.fn()).kind).toBe("accepted");
  expect(second.input.submit(Buffer.alloc(3), "query", vi.fn())).toEqual({
    kind: "rejected",
    reason: "factory-byte-limit",
    writtenBytes: 0,
  });
  expect(second.input.submit(Buffer.alloc(2), "focus", vi.fn()).kind).toBe("accepted");
  expect(third.input.submit(Buffer.alloc(1), "user", vi.fn())).toEqual({
    kind: "rejected",
    reason: "factory-task-limit",
    writtenBytes: 0,
  });
  expect(writeBounded).toHaveBeenCalledTimes(2);
  expect(shared.snapshot()).toMatchObject({
    allocatedBytes: 8,
    tasks: 2,
    peakAllocatedBytes: 8,
    peakTasks: 2,
  });

  for (const { currentTicket, bytes, onSettled } of callbacks) {
    onSettled({
      ticket: currentTicket,
      status: "written",
      originalBytes: bytes,
      writtenBytes: bytes,
      remainingBytes: 0,
    });
  }
  expect(shared.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
});

test("settlement observer reentry sees the whole original allocation until finally", () => {
  let callback;
  const session = controller({
    maxBytes: 2,
    maxTasks: 1,
    writeBounded: vi.fn((bytes, onSettled) => {
      callback = onSettled;
      return { accepted: true, ticket: 7, byteLength: bytes.byteLength };
    }),
  });
  const reentered = [];
  session.input.submit(Buffer.from("A"), "user", () => {
    reentered.push(session.input.submit(Buffer.from("B"), "query", vi.fn()));
  });
  callback({ ticket: 7, status: "written", originalBytes: 1, writtenBytes: 1, remainingBytes: 0 });
  expect(reentered).toEqual([{ kind: "rejected", reason: "pty-task-limit", writtenBytes: 0 }]);
  expect(session.input.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
});

test("partial settlement reports exact unknown, fences input, and never retries", () => {
  let callback;
  const settled = [];
  const session = controller({
    writeBounded: vi.fn((bytes, onSettled) => {
      callback = onSettled;
      return { accepted: true, ticket: 3, byteLength: bytes.byteLength };
    }),
  });
  expect(
    session.input.submit(Buffer.from("ABCD"), "user", (value) => settled.push(value)).kind,
  ).toBe("accepted");
  callback({
    ticket: 3,
    status: "error",
    originalBytes: 4,
    writtenBytes: 2,
    remainingBytes: 2,
    errorCode: "EIO",
  });
  expect(settled).toEqual([
    {
      kind: "unknown",
      ticket: 3,
      status: "error",
      originalBytes: 4,
      writtenBytes: 2,
      remainingBytes: 2,
      errorCode: "EIO",
    },
  ]);
  expect(session.faults).toMatchObject([{ reason: "native-settlement-unknown" }]);
  expect(session.writer.disposeBoundedWrite).toHaveBeenCalledOnce();
  expect(session.input.submit(Buffer.from("ABCD"), "user", vi.fn())).toEqual({
    kind: "rejected",
    reason: "fenced",
    writtenBytes: 0,
  });
  expect(session.writer.writeBounded).toHaveBeenCalledTimes(1);
});

test("synchronous settlement before admission is bound once and duplicate settlement faults", () => {
  const settled = [];
  let nativeCallback;
  const session = controller({
    writeBounded: vi.fn((bytes, callback) => {
      nativeCallback = callback;
      callback({
        ticket: 9,
        status: "written",
        originalBytes: 2,
        writtenBytes: 2,
        remainingBytes: 0,
      });
      return { accepted: true, ticket: 9, byteLength: bytes.byteLength };
    }),
  });
  expect(session.input.submit(Buffer.from("AB"), "focus", (value) => settled.push(value))).toEqual({
    kind: "accepted",
    ticket: 9,
    byteLength: 2,
    origin: "focus",
  });
  expect(settled).toHaveLength(1);
  nativeCallback({
    ticket: 9,
    status: "written",
    originalBytes: 2,
    writtenBytes: 2,
    remainingBytes: 0,
  });
  expect(settled).toHaveLength(1);
  expect(session.faults).toMatchObject([{ reason: "native-settlement-duplicate" }]);
});

test("possible handoff throw retains allocation until a later one-shot settlement", () => {
  let nativeCallback;
  const settled = [];
  const session = controller({
    writeBounded: vi.fn((_bytes, callback) => {
      nativeCallback = callback;
      throw new Error("possible handoff");
    }),
  });
  expect(
    session.input.submit(Buffer.from("AB"), "user", (value) => settled.push(value)),
  ).toMatchObject({
    kind: "unknown",
    reason: "native-call-threw",
    byteLength: 2,
  });
  expect(session.input.snapshot()).toMatchObject({ allocatedBytes: 2, tasks: 1 });
  expect(session.shared.snapshot()).toMatchObject({ allocatedBytes: 2, tasks: 1 });
  expect(session.writer.disposeBoundedWrite).toHaveBeenCalledOnce();
  nativeCallback({
    ticket: 11,
    status: "error",
    originalBytes: 2,
    writtenBytes: 1,
    remainingBytes: 1,
  });
  expect(settled).toMatchObject([
    { kind: "unknown", ticket: 11, writtenBytes: 1, remainingBytes: 1 },
  ]);
  expect(session.input.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
});

test("observer throw cannot skip release and retirement remains one-shot", () => {
  let callback;
  const session = controller({
    writeBounded: vi.fn((bytes, onSettled) => {
      callback = onSettled;
      return { accepted: true, ticket: 12, byteLength: bytes.byteLength };
    }),
  });
  session.input.submit(Buffer.from("AB"), "user", () => {
    throw new Error("observer");
  });
  callback({ ticket: 12, status: "written", originalBytes: 2, writtenBytes: 2, remainingBytes: 0 });
  expect(session.input.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
  expect(session.shared.snapshot()).toMatchObject({ allocatedBytes: 0, tasks: 0 });
  expect(session.faults).toMatchObject([{ reason: "settlement-observer-threw" }]);
  session.input.retire();
  session.input.retire();
  expect(session.writer.disposeBoundedWrite).toHaveBeenCalledTimes(1);
});
