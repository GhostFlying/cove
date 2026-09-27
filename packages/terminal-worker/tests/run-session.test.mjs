import { expect, test } from "vitest";
import { createRunSession } from "../dist/src/run-session.js";

const encoder = new TextEncoder();

function start(name = "run", callbacks = {}) {
  const events = [];
  const writes = [];
  const state = { paused: 0, resumed: 0, stopped: 0, retired: 0 };
  let observer;
  const pty = {
    pid: 1,
    automaticOutputSink(output) {
      writes.push({ ...output, bytes: Buffer.from(output.bytes) });
      callbacks.onAutomaticOutput?.(output, observer);
    },
    pause() {
      state.paused++;
      callbacks.onPause?.(observer);
    },
    resume() {
      state.resumed++;
    },
    retireInput() {
      state.retired++;
    },
    stop() {
      state.stopped++;
      return Promise.resolve({ kind: "unverifiable", cause: "test", cleanup: {} });
    },
  };
  const factory = {
    spawn(_spec, value) {
      observer = value;
      callbacks.onSpawn?.(value);
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
    onFault: (fault) => faults.push(fault),
  });
  expect(result.kind).toBe("created");
  return { session: result.session, observer, events, writes, state, faults };
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
    expect(owned.session.snapshot()).toMatchObject({ parsedSeq: 2, faulted: false });
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
