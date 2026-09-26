import { expect, test } from "vitest";
import { TerminalModel } from "@cove/terminal-engine";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { RUN, model, output, resize, utf8, string, assertTransfer } from "./driver.mjs";

test("M01 compiled root owns one model and a protocol-valid seq-0 capture", async () => {
  const engine = model();
  try {
    expect(engine).toBeInstanceOf(TerminalModel);
    const state = await engine.barrier();
    expect(state).toMatchObject({ ok: true, value: { receivedSeq: 0, parsedSeq: 0 } });
    const capture = await engine.captureBaseline();
    expect(capture.status).toBe("ready");
    expect(assertTransfer(capture.baseline)).toBe(true);
  } finally {
    engine.dispose();
  }
});

test("M02 invalid factory and event input leave accepted sequence unchanged", async () => {
  expect(() => model({ geometry: { cols: 1, rows: 4 } })).toThrow(/Invalid terminal model options/);
  expect(() => model({ effectiveBudgets: { ...M0_LIMITS, workerBytes: Number.NaN } })).toThrow(
    /Invalid terminal model options/,
  );
  expect(() => model({ run: { ...RUN, runId: "?" } })).toThrow(/Invalid terminal model options/);
  const engine = model();
  try {
    expect((await engine.apply(output(1), new Uint8Array())).ok).toBe(false);
    expect((await engine.apply(output(1), utf8("A"))).ok).toBe(true);
    expect((await engine.barrier()).value.parsedSeq).toBe(1);
  } finally {
    engine.dispose();
  }
});

test("M03 admitted bytes and emitted reply bytes are detached", async () => {
  const replies = [];
  const engine = model({ onAutomaticOutput: (item) => replies.push(item) });
  try {
    const input = utf8("A\u001b[5n");
    const pending = engine.apply(output(1), input);
    input.fill(88);
    expect((await pending).ok).toBe(true);
    expect(string(replies[0].bytes)).toBe("\u001b[0n");
    replies[0].bytes.fill(88);
    const captured = await engine.captureBaseline();
    expect(captured.status).toBe("ready");
    expect(string(captured.baseline.vt)).toContain("A");
  } finally {
    engine.dispose();
  }
});

test("M04 FIFO barrier and capture sit between admitted writes", async () => {
  const engine = model();
  try {
    const first = engine.apply(output(1), utf8("A"));
    const between = engine.captureBaseline();
    const second = engine.apply(output(2), utf8("B"));
    const after = engine.barrier();
    expect((await first).value.parsedSeq).toBe(1);
    expect((await between).baseline.atSeq).toBe(1);
    expect((await second).value.parsedSeq).toBe(2);
    expect((await after).value.parsedSeq).toBe(2);
  } finally {
    engine.dispose();
  }
});

test("M05 received sequence may precede parsed sequence while FIFO drains", async () => {
  const engine = model();
  try {
    const pending = engine.apply(output(1), utf8("A"));
    const next = engine.apply(output(2), utf8("B"));
    const first = await pending;
    expect(first).toMatchObject({ ok: true, value: { receivedSeq: 2, parsedSeq: 1 } });
    expect((await next).value.parsedSeq).toBe(2);
  } finally {
    engine.dispose();
  }
});

test("M06 gaps, duplicates and wrong run cannot consume the next sequence", async () => {
  const engine = model();
  try {
    for (const event of [output(2), output(1, { ...RUN, runId: "other" })])
      expect((await engine.apply(event, utf8("bad"))).ok).toBe(false);
    expect((await engine.apply(output(1), utf8("A"))).ok).toBe(true);
    expect((await engine.apply(output(1), utf8("dup"))).ok).toBe(false);
    expect((await engine.barrier()).value.parsedSeq).toBe(1);
  } finally {
    engine.dispose();
  }
});

test("M07 exact payload and queue bounds reject before sequence consumption", async () => {
  const engine = model();
  try {
    expect((await engine.apply(output(1), new Uint8Array(65_537))).error.code).toBe("invalid");
    expect((await engine.apply(output(1), new Uint8Array(65_536))).ok).toBe(true);
    expect((await engine.apply(output(2), utf8("B"))).ok).toBe(true);
  } finally {
    engine.dispose();
  }
});

test("M08 unpublished continuation fences events and capture without reusing seq", async () => {
  const replies = [];
  const engine = model({ onAutomaticOutput: (item) => replies.push(string(item.bytes)) });
  try {
    expect((await engine.apply(output(1), utf8("A"))).ok).toBe(true);
    expect((await engine.continueUnpublishedOutput(utf8("\u001b[5n"))).ok).toBe(true);
    expect(replies).toContain("\u001b[0n");
    expect((await engine.apply(output(2), utf8("B"))).ok).toBe(false);
    expect((await engine.captureBaseline()).status).toBe("unavailable");
    expect((await engine.barrier()).value.parsedSeq).toBe(1);
  } finally {
    engine.dispose();
  }
});

test("M09 dispose settles queued work and rejects late calls", async () => {
  const replies = [];
  const engine = model({ onAutomaticOutput: (item) => replies.push(item) });
  const pending = engine.apply(output(1), utf8("A\u001b[5n"));
  const queued = engine.apply(resize(2, 10));
  engine.dispose();
  engine.dispose();
  expect((await pending).error.code).toBe("disposed");
  expect((await queued).error.code).toBe("disposed");
  expect((await engine.barrier()).error.code).toBe("disposed");
  expect((await engine.captureBaseline()).status).toBe("disposed");
  expect(replies).toEqual([]);
});
