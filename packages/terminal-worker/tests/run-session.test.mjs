import { expect, test, vi } from "vitest";
import * as execution from "@cove/terminal-worker/execution";

const encoder = new TextEncoder();
const { createRunSession } = execution;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function start(name = "run", callbacks = {}) {
  const events = [];
  const writes = [];
  const state = {
    paused: 0,
    resumed: 0,
    stopped: 0,
    retired: 0,
    flowPaused: false,
    exited: false,
    writer: "pending",
  };
  let observer;
  const writerCompletion = callbacks.writerCompletion ?? Promise.resolve({ kind: "closed" });
  void Promise.resolve(writerCompletion).then(
    (result) => {
      state.writer =
        result?.kind === "closed" || result?.kind === "close-uncertain" ? result.kind : "invalid";
    },
    () => {
      state.writer = "invalid";
    },
  );
  const pty = {
    pid: 1,
    writerCompletion,
    submit() {
      throw new Error("Unexpected input admission in the first worker slice");
    },
    automaticOutputSink(output) {
      writes.push({ ...output, bytes: Buffer.from(output.bytes) });
      callbacks.onAutomaticOutput?.(output, observer);
    },
    pause() {
      state.paused++;
      state.flowPaused = true;
      callbacks.onPause?.(observer);
    },
    resume() {
      state.resumed++;
      state.flowPaused = false;
      callbacks.onResume?.(observer);
    },
    resize() {
      throw new Error("Unexpected resize in the first worker slice");
    },
    retireInput() {
      state.retired++;
      callbacks.onRetire?.(observer);
    },
    stop() {
      state.stopped++;
      callbacks.onStop?.(observer);
      return (
        callbacks.stopResult ??
        Promise.resolve({
          kind: "unverifiable",
          cause: "test",
          cleanup: {
            scope: "initial-process-group",
            verified: false,
            graceful: { kind: "not-attempted", reason: "deadline-not-reached" },
            force: { kind: "not-attempted", reason: "deadline-not-reached" },
          },
        })
      );
    },
    snapshot() {
      return {
        pid: 1,
        exited: state.exited,
        writer: state.writer,
        input: {
          allocatedBytes: 0,
          tasks: 0,
          peakAllocatedBytes: 0,
          peakTasks: 0,
          maxBytes: 64 * 1024,
          maxTasks: 256,
        },
        earlyOutputBytes: 0,
        paused: state.flowPaused,
      };
    },
  };
  const factory = {
    spawn(_spec, value) {
      observer = {
        ...value,
        onExit(exit) {
          state.exited = true;
          value.onExit(exit);
        },
      };
      callbacks.onSpawn?.(observer);
      return { kind: "created", pty };
    },
  };
  const run = { serverId: "server", relayInstanceId: "relay", runId: name };
  const faults = [];
  const result = createRunSession({
    run,
    geometry: { cols: 12, rows: 4 },
    spawn: { file: "unused", args: [], cwd: "/", env: {} },
    factory,
    onFact: callbacks.onFact ?? ((fact) => events.push(fact)),
    onFault: (fault) => {
      faults.push(fault);
      return callbacks.onFault?.(fault);
    },
  });
  expect(result.kind).toBe("created");
  return { session: result.session, observer, pty, events, writes, state, faults };
}

test("copies native callback bytes before reuse and preserves split UTF-8/NUL order", async () => {
  const owned = start();
  try {
    const first = Buffer.from([0x41, 0x00, 0xe2, 0x82]);
    owned.observer.onData(first);
    first.fill(0x58);
    owned.observer.onData(Buffer.from([0xac, 0xff]));
    owned.observer.onExit({ exitCode: 23 });
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(owned.events.map(({ event }) => [event.type, event.seq])).toEqual([
      ["output", 1],
      ["output", 2],
      ["exit", 3],
    ]);
    expect([...owned.events[0].bytes]).toEqual([0x41, 0x00, 0xe2, 0x82]);
    expect([...owned.events[1].bytes]).toEqual([0xac, 0xff]);
    expect(owned.session.snapshot()).toMatchObject({ parsedSeq: 3, exited: true, queuedBytes: 0 });
  } finally {
    await owned.session.dispose();
  }
});

test("answers an automatic query on the native FIFO with no published observer", async () => {
  const owned = start("query", { onFact() {} });
  try {
    owned.observer.onData(Buffer.from(encoder.encode("\u001b[5n")));
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(owned.writes.map(({ atSeq, kind, bytes }) => [atSeq, kind, bytes.toString()])).toEqual([
      [1, "query", "\u001b[0n"],
    ]);
    expect(owned.session.snapshot().parsedSeq).toBe(1);
  } finally {
    await owned.session.dispose();
  }
});

test("a synchronous early native callback is retained until its writer is attached", async () => {
  const owned = start("early", {
    onSpawn(observer) {
      observer.onData(Buffer.from(encoder.encode("\u001b[5n")));
    },
  });
  try {
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(owned.writes.map(({ bytes }) => bytes.toString())).toEqual(["\u001b[0n"]);
  } finally {
    await owned.session.dispose();
  }
});

test("automatic-output rejection fences publication and retires the input path", async () => {
  const owned = start("rejected", {
    onAutomaticOutput(_output, observer) {
      observer.onFault({
        kind: "automatic-output",
        reason: "rejected",
        admission: { kind: "rejected" },
      });
    },
  });
  try {
    owned.observer.onData(Buffer.from(encoder.encode("\u001b[5n")));
    expect((await owned.session.barrier()).ok).toBe(false);
    expect(owned.events).toEqual([]);
    expect(owned.session.snapshot().faulted).toBe(true);
    expect(owned.state.retired).toBe(1);
  } finally {
    await owned.session.dispose();
  }
});

test("hard parse cap fences before retaining an oversized callback", async () => {
  const owned = start("cap");
  try {
    owned.observer.onData(Buffer.alloc(1024 * 1024 + 1, 65));
    expect(owned.session.snapshot()).toMatchObject({ faulted: true, queuedBytes: 0 });
    expect(owned.state.stopped).toBe(1);
    expect(owned.events).toEqual([]);
  } finally {
    await owned.session.dispose();
  }
});

test("high-water pause and low-water resume account copied pending bytes", async () => {
  const owned = start("watermarks");
  try {
    owned.observer.onData(Buffer.alloc(9 * 65_536, 65));
    expect(owned.session.snapshot()).toMatchObject({
      queuedBytes: 9 * 65_536,
      peakQueuedBytes: 9 * 65_536,
      paused: true,
    });
    expect(owned.state.paused).toBe(1);
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(owned.session.snapshot()).toMatchObject({ queuedBytes: 0, paused: false });
    expect(owned.state.resumed).toBe(1);
  } finally {
    await owned.session.dispose();
  }
});

test("a synchronous native pause fault retires once without recursive pause", async () => {
  const owned = start("pause-fault", {
    onPause(observer) {
      observer.onFault({ kind: "io", reason: "pause-failed" });
    },
  });
  try {
    owned.observer.onData(Buffer.alloc(9 * 65_536, 65));
    expect(owned.session.snapshot()).toMatchObject({ faulted: true, paused: false });
    expect(owned.state).toMatchObject({ paused: 1, retired: 1, stopped: 1 });
    expect((await owned.session.barrier()).ok).toBe(false);
  } finally {
    await owned.session.dispose();
  }
});

test("a throwing parsed consumer is fenced while the authoritative model continues", async () => {
  let delivered = 0;
  const owned = start("consumer", {
    onFact() {
      delivered++;
      throw new Error("consumer failed");
    },
  });
  try {
    owned.observer.onData(Buffer.from("A"));
    owned.observer.onData(Buffer.from(encoder.encode("\u001b[5n")));
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(delivered).toBe(1);
    expect(owned.writes.map(({ bytes }) => bytes.toString())).toEqual(["\u001b[0n"]);
    expect(owned.faults).toEqual([{ kind: "consumer", reason: "parsed-fact-observer-failed" }]);
    expect(owned.session.snapshot()).toMatchObject({
      parsedSeq: 2,
      faulted: false,
      consumerFenced: true,
    });
  } finally {
    await owned.session.dispose();
  }
});

test("fault delivered during native spawn stops the returned owner before parsing", async () => {
  const owned = start("early-fault", {
    onSpawn(observer) {
      observer.onFault({ kind: "binding", reason: "fixture-fault" });
      observer.onData(Buffer.from("unpublished"));
    },
  });
  try {
    expect(owned.session.snapshot()).toMatchObject({ faulted: true, parsedSeq: 0 });
    expect(owned.state.stopped).toBe(1);
    expect(owned.events).toEqual([]);
  } finally {
    await owned.session.dispose();
  }
});

test("early copied output is released when spawn faults before owner attachment", async () => {
  const owned = start("early-queued-fault", {
    onSpawn(observer) {
      observer.onData(Buffer.from("queued"));
      observer.onFault({ kind: "binding", reason: "fixture-fault" });
    },
  });
  try {
    expect(owned.session.snapshot()).toMatchObject({
      faulted: true,
      queuedBytes: 0,
      queuedItems: 0,
    });
    expect(owned.state.stopped).toBe(1);
    expect(owned.events).toEqual([]);
  } finally {
    await owned.session.dispose();
  }
});

test("two sessions progress independently while one drains several output chunks", async () => {
  const order = [];
  const first = start("first", { onFact: ({ event }) => order.push(`first:${event.seq}`) });
  const second = start("second", { onFact: ({ event }) => order.push(`second:${event.seq}`) });
  try {
    first.observer.onData(Buffer.alloc(4 * 65_536, 65));
    second.observer.onData(Buffer.from("B"));
    expect(await Promise.all([first.session.barrier(), second.session.barrier()])).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(order).toContain("second:1");
    expect(order.indexOf("second:1")).toBeLessThan(order.indexOf("first:4"));
  } finally {
    await Promise.all([first.session.dispose(), second.session.dispose()]);
  }
});

test("dispose fences queued and later native callbacks", async () => {
  const owned = start("dispose");
  owned.observer.onData(Buffer.from("before"));
  const barrier = owned.session.barrier();
  await owned.session.dispose();
  owned.observer.onData(Buffer.from("after"));
  owned.observer.onExit({ exitCode: 0 });
  expect((await barrier).ok).toBe(false);
  expect(owned.events).toEqual([]);
  expect(owned.session.snapshot()).toMatchObject({ disposed: true, queuedBytes: 0 });
});

test("public facade has no constructor, native ingress, or replacement path", async () => {
  const owned = start("facade");
  expect(Object.getPrototypeOf(owned.session)).toBeNull();
  expect(Object.keys(owned.session).sort()).toEqual(["barrier", "dispose", "snapshot"]);
  expect(Object.isFrozen(owned.session)).toBe(true);
  expect(owned.session.constructor).toBeUndefined();
  expect(Reflect.get(execution, "RunSession")).toBeUndefined();
  expect(owned.session.attach).toBeUndefined();
  expect(owned.session.onData).toBeUndefined();
  await owned.session.dispose();
  expect(owned.state.stopped).toBe(1);
});

test("reentrant disposal returns one promise and preserves stop, exit, and writer facts", async () => {
  const writer = deferred();
  const stop = deferred();
  let session;
  let reentrant;
  const owned = start("receipt", {
    writerCompletion: writer.promise,
    stopResult: stop.promise,
    onStop() {
      reentrant = session.dispose();
    },
  });
  session = owned.session;
  const receiptPromise = session.dispose();
  expect(reentrant).toBe(receiptPromise);
  expect(session.dispose()).toBe(receiptPromise);
  expect(owned.state.stopped).toBe(1);
  owned.observer.onExit({ exitCode: 0 });
  writer.resolve({ kind: "closed" });
  stop.resolve({
    kind: "exited",
    exit: { exitCode: 0 },
    cleanup: {
      scope: "initial-process-group",
      verified: false,
      graceful: { kind: "not-attempted", reason: "already-exited" },
      force: { kind: "not-attempted", reason: "already-exited" },
    },
  });
  const receipt = await receiptPromise;
  expect(receipt).toMatchObject({
    stop: { kind: "observed", result: { kind: "exited" } },
    leader: { kind: "exit-observed", exit: { exitCode: 0 } },
    writer: { kind: "closed" },
    ownershipEvidence: "closure-proven",
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(owned.session.snapshot()).toMatchObject({ ownershipEvidence: "closure-proven" });
});

test("deadline freezes unresolved receipt while later owned facts improve only snapshot", async () => {
  vi.useFakeTimers();
  try {
    const writer = deferred();
    const stop = deferred();
    const owned = start("late", { writerCompletion: writer.promise, stopResult: stop.promise });
    const initial = owned.session.snapshot();
    expect(Object.isFrozen(initial.writer)).toBe(true);
    expect(Object.isFrozen(initial.stop)).toBe(true);
    expect(Reflect.set(initial.writer, "kind", "closed")).toBe(false);
    expect(Reflect.set(initial.stop, "kind", "observed")).toBe(false);
    expect(owned.session.snapshot()).toMatchObject({
      writer: { kind: "pending-at-deadline" },
      stop: { kind: "pending-at-deadline" },
      ownershipEvidence: "unresolved",
    });
    const pending = owned.session.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    const receipt = await pending;
    expect(receipt).toMatchObject({
      stop: { kind: "pending-at-deadline" },
      leader: { kind: "not-observed" },
      writer: { kind: "pending-at-deadline" },
      ownershipEvidence: "unresolved",
    });
    expect(Object.isFrozen(receipt.writer)).toBe(true);
    expect(Object.isFrozen(receipt.stop)).toBe(true);
    expect(Reflect.set(receipt.writer, "kind", "closed")).toBe(false);
    expect(Reflect.set(receipt.stop, "kind", "observed")).toBe(false);
    owned.observer.onExit({ exitCode: 0 });
    writer.resolve({ kind: "closed" });
    stop.resolve({
      kind: "unverifiable",
      cause: "late",
      cleanup: {
        scope: "initial-process-group",
        verified: false,
        graceful: { kind: "not-attempted", reason: "deadline-not-reached" },
        force: { kind: "not-attempted", reason: "deadline-not-reached" },
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(receipt.writer.kind).toBe("pending-at-deadline");
    expect(owned.session.dispose()).toBe(pending);
    expect(owned.session.snapshot()).toMatchObject({
      leader: { kind: "exit-observed" },
      writer: { kind: "closed" },
      ownershipEvidence: "closure-proven",
    });
  } finally {
    vi.useRealTimers();
  }
});

test("close-uncertain remains charged evidence despite actual exit", async () => {
  const writer = deferred();
  const owned = start("uncertain", { writerCompletion: writer.promise });
  const pending = owned.session.dispose();
  owned.observer.onExit({ exitCode: 0 });
  writer.resolve({ kind: "close-uncertain", error: "EIO" });
  expect(await pending).toMatchObject({
    leader: { kind: "exit-observed" },
    writer: { kind: "close-uncertain", error: "EIO" },
    ownershipEvidence: "retained-uncertain",
  });
});

test("writer-first stop uncertainty retains signal detail until actual exit arrives", async () => {
  const writer = deferred();
  const stop = deferred();
  const owned = start("writer-first", {
    writerCompletion: writer.promise,
    stopResult: stop.promise,
  });
  const pending = owned.session.dispose();
  writer.resolve({ kind: "closed" });
  stop.resolve({
    kind: "unverifiable",
    cause: "leader-unseen",
    signalFailure: { phase: "graceful", cause: "EPERM" },
    cleanup: {
      scope: "initial-process-group",
      verified: false,
      graceful: { kind: "unverifiable", reason: "signal-failed", errorCode: "EPERM" },
      force: { kind: "not-attempted", reason: "deadline-not-reached" },
    },
  });
  const receipt = await pending;
  expect(receipt).toMatchObject({
    stop: {
      kind: "observed",
      result: { kind: "unverifiable", signalFailure: { phase: "graceful", cause: "EPERM" } },
    },
    writer: { kind: "closed" },
    leader: { kind: "not-observed" },
    ownershipEvidence: "unresolved",
  });
  owned.observer.onExit({ exitCode: 0 });
  expect(owned.session.snapshot().ownershipEvidence).toBe("closure-proven");
  expect(receipt.ownershipEvidence).toBe("unresolved");
});

test("an exited stop cannot claim closure while the writer never completes", async () => {
  vi.useFakeTimers();
  try {
    const writer = deferred();
    const owned = start("held-writer", {
      writerCompletion: writer.promise,
      stopResult: Promise.resolve({
        kind: "exited",
        exit: { exitCode: 0 },
        cleanup: {
          scope: "initial-process-group",
          verified: false,
          graceful: { kind: "not-attempted", reason: "already-exited" },
          force: { kind: "not-attempted", reason: "already-exited" },
        },
      }),
    });
    const pending = owned.session.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    const receipt = await pending;
    expect(receipt).toMatchObject({
      stop: { kind: "observed", result: { kind: "exited" } },
      leader: { kind: "exit-observed" },
      writer: { kind: "pending-at-deadline" },
      ownershipEvidence: "unresolved",
    });
    writer.resolve({ kind: "closed" });
    await Promise.resolve();
    expect(owned.session.snapshot().ownershipEvidence).toBe("closure-proven");
    expect(receipt.ownershipEvidence).toBe("unresolved");
  } finally {
    vi.useRealTimers();
  }
});

test("a rejected stop still records independent writer closure and actual exit", async () => {
  const owned = start("rejected-stop", {
    writerCompletion: Promise.resolve({ kind: "closed" }),
    stopResult: Promise.reject(new Error("stop rejected")),
  });
  const pending = owned.session.dispose();
  owned.observer.onExit({ exitCode: 0 });
  expect(await pending).toMatchObject({
    stop: { kind: "failed-to-observe" },
    leader: { kind: "exit-observed" },
    writer: { kind: "closed" },
    ownershipEvidence: "closure-proven",
  });
});

test("synchronous retire and stop throws preserve independently observed exit and writer closure", async () => {
  const writer = deferred();
  const owned = start("sync-cleanup", {
    writerCompletion: writer.promise,
    onRetire() {
      throw new Error("retire failed");
    },
    onStop() {
      throw new Error("stop failed");
    },
  });
  expect(Object.keys(owned.pty).sort()).toEqual([
    "automaticOutputSink",
    "pause",
    "pid",
    "resize",
    "resume",
    "retireInput",
    "snapshot",
    "stop",
    "submit",
    "writerCompletion",
  ]);
  expect(owned.pty.snapshot()).toMatchObject({
    pid: 1,
    exited: false,
    writer: "pending",
    input: { allocatedBytes: 0, tasks: 0 },
  });
  const pending = owned.session.dispose();
  expect(owned.session.dispose()).toBe(pending);
  owned.observer.onExit({ exitCode: 0 });
  writer.resolve({ kind: "closed" });
  expect(await pending).toMatchObject({
    stop: { kind: "failed-to-observe" },
    leader: { kind: "exit-observed" },
    writer: { kind: "closed" },
    ownershipEvidence: "closure-proven",
  });
  expect(owned.pty.snapshot()).toMatchObject({ exited: true, writer: "closed" });
  expect(owned.state).toMatchObject({ retired: 1, stopped: 1 });
});

test("rejected writer completion remains uncertain despite stop and actual exit", async () => {
  const writer = deferred();
  const owned = start("rejected-writer", {
    writerCompletion: writer.promise,
    stopResult: Promise.resolve({
      kind: "exited",
      exit: { exitCode: 0 },
      cleanup: {
        scope: "initial-process-group",
        verified: false,
        graceful: { kind: "not-attempted", reason: "already-exited" },
        force: { kind: "not-attempted", reason: "already-exited" },
      },
    }),
  });
  const pending = owned.session.dispose();
  owned.observer.onExit({ exitCode: 0 });
  writer.reject(new Error("writer failed"));
  expect(await pending).toMatchObject({
    stop: { kind: "observed", result: { kind: "exited" } },
    leader: { kind: "exit-observed" },
    writer: { kind: "invalid" },
    ownershipEvidence: "retained-uncertain",
  });
  expect(owned.session.dispose()).toBe(pending);
  expect(owned.state.stopped).toBe(1);
});

test("consumer and diagnostic thenables fence once without blocking query parsing", async () => {
  let delivered = 0;
  const owned = start("thenable", {
    onFact() {
      delivered++;
      return Promise.reject(new Error("consumer rejected"));
    },
    onFault() {
      return Promise.reject(new Error("diagnostic rejected"));
    },
  });
  try {
    owned.observer.onData(Buffer.from("A"));
    owned.observer.onData(Buffer.from(encoder.encode("\u001b[5n")));
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(delivered).toBe(1);
    expect(owned.faults).toEqual([{ kind: "consumer", reason: "parsed-fact-observer-failed" }]);
    expect(owned.session.snapshot()).toMatchObject({
      parsedSeq: 2,
      consumerFenced: true,
      diagnosticFenced: true,
      faulted: false,
    });
    expect(owned.writes.map(({ bytes }) => bytes.toString())).toEqual(["\u001b[0n"]);
  } finally {
    await owned.session.dispose();
  }
});

test("throwing then getter and pending diagnostic fence without halting the model", async () => {
  let delivered = 0;
  const owned = start("then-getter", {
    onFact() {
      delivered++;
      return Object.defineProperty({}, "then", {
        get() {
          throw new Error("then getter failed");
        },
      });
    },
    onFault() {
      return new Promise(() => {});
    },
  });
  try {
    owned.observer.onData(Buffer.from("A"));
    owned.observer.onData(Buffer.from(encoder.encode("\u001b[5n")));
    expect(await owned.session.barrier()).toMatchObject({ ok: true });
    expect(delivered).toBe(1);
    expect(owned.session.snapshot()).toMatchObject({
      parsedSeq: 2,
      consumerFenced: true,
      diagnosticFenced: true,
      faulted: false,
    });
    expect(owned.writes.map(({ bytes }) => bytes.toString())).toEqual(["\u001b[0n"]);
  } finally {
    await owned.session.dispose();
  }
});

test("resolved and throwing-call thenables violate the synchronous consumer boundary", async () => {
  const resolved = start("resolved-then", { onFact: () => Promise.resolve() });
  const throwing = start("throwing-then", {
    onFact: () => ({
      then() {
        throw new Error("then call failed");
      },
    }),
  });
  try {
    resolved.observer.onData(Buffer.from("A"));
    throwing.observer.onData(Buffer.from("B"));
    expect(await Promise.all([resolved.session.barrier(), throwing.session.barrier()])).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(resolved.session.snapshot()).toMatchObject({ consumerFenced: true, faulted: false });
    expect(throwing.session.snapshot()).toMatchObject({ consumerFenced: true, faulted: false });
    expect(resolved.faults).toHaveLength(1);
    expect(throwing.faults).toHaveLength(1);
  } finally {
    await Promise.all([resolved.session.dispose(), throwing.session.dispose()]);
  }
});

test("invalid writer and rejected stop cannot be labeled as released ownership", async () => {
  const owned = start("invalid-completion", {
    writerCompletion: Promise.resolve({ kind: "invalid-native-result" }),
    stopResult: Promise.reject(new Error("stop failed")),
  });
  const receipt = await owned.session.dispose();
  expect(receipt).toMatchObject({
    stop: { kind: "failed-to-observe" },
    writer: { kind: "invalid" },
    leader: { kind: "not-observed" },
    ownershipEvidence: "retained-uncertain",
  });
  expect(owned.state.stopped).toBe(1);
});

test("fact consumer disposal at low water never resumes a retired PTY", async () => {
  let session;
  let receipt;
  let delivered = 0;
  let remainingAtDispose;
  const owned = start("paused-dispose", {
    onFact() {
      if (++delivered === 7) {
        remainingAtDispose = session.snapshot().queuedBytes;
        receipt = session.dispose();
      }
    },
  });
  session = owned.session;
  owned.observer.onData(Buffer.alloc(9 * 65_536, 65));
  expect(owned.state.paused).toBe(1);
  const barrier = session.barrier();
  expect((await barrier).ok).toBe(false);
  await receipt;
  expect(delivered).toBe(7);
  expect(remainingAtDispose).toBe(2 * 65_536);
  expect(owned.state).toMatchObject({ resumed: 0, stopped: 1 });
  expect(session.snapshot()).toMatchObject({ disposed: true, queuedBytes: 0 });
});
