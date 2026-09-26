import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import {
  model,
  output,
  resize,
  utf8,
  receiver,
  restore,
  write,
  observation,
  assertTransfer,
} from "./driver.mjs";

async function compare(setup, continuation, options = {}) {
  const geometry = options.geometry ?? { cols: 12, rows: 4 };
  const scrollback = options.scrollback ?? 1000;
  const authority = model({ geometry, ...options.modelOptions });
  const reference = receiver(geometry, scrollback);
  let recovered;
  try {
    await write(reference, setup);
    expect((await authority.apply(output(1), utf8(setup))).ok).toBe(true);
    const capture = await authority.captureBaseline();
    expect(capture.status).toBe("ready");
    expect(assertTransfer(capture.baseline)).toBe(true);
    recovered = await restore(capture.baseline, geometry, scrollback);
    expect(observation(recovered)).toEqual(observation(reference));
    await write(reference, continuation);
    await write(recovered, continuation);
    expect(observation(recovered)).toEqual(observation(reference));
    return capture.baseline;
  } finally {
    authority.dispose();
    reference.dispose();
    recovered?.dispose();
  }
}

test("R01 empty seq-0 checkpoint has complete public transfer metadata", async () => {
  const engine = model();
  try {
    const capture = await engine.captureBaseline();
    expect(capture.status).toBe("ready");
    expect(capture.baseline).toMatchObject({
      checkpointSeq: 0,
      atSeq: 0,
      captureGeometry: { cols: 12, rows: 4 },
      currentGeometry: { cols: 12, rows: 4 },
    });
    expect(assertTransfer(capture.baseline)).toBe(true);
  } finally {
    engine.dispose();
  }
});

test("R02 saved position, current pen and ordinary suffix restore visibly", async () => {
  expect(
    await compare("\u001b[2;3H\u001b[31m\u001b7\u001b[4;9H\u001b[34m", "C\u001b8S\u001b[4;9HX"),
  ).toHaveProperty("vt");
});

test("R03 alternate screen preserves hidden normal on exit", async () => {
  expect(
    await compare("normal\u001b[2;3H\u001b7\u001b[?47hALT\u001b[32m", "Z\u001b[?47l\u001b8Q"),
  ).toHaveProperty("vt");
});

test("R04 wrap, wide/combining glyphs, REP and current modes continue", async () => {
  expect(
    await compare("123456789ABC\u001b[?1h\u001b=\u001b[?2004h\u001b[2;8H中e\u0301", "😀\u001b[b"),
  ).toHaveProperty("vt");
});

test("R05 configured retained history is included with honest coverage", async () => {
  for (const historyLines of [3, 1000]) {
    const setup = Array.from({ length: historyLines + 6 }, (_, i) => `L${i}\r\n`).join("");
    const budgets = { ...M0_LIMITS, historyLines };
    const baseline = await compare(setup, "tail\u001b[2;2HX", {
      scrollback: historyLines,
      modelOptions: { effectiveBudgets: budgets },
    });
    expect(baseline.coverage.normal.historyLines).toBe(historyLines);
    expect(baseline.coverage.normal.includedHistoryLines).toBe(historyLines);
    expect(baseline.coverage.normal.resizeContext).toBe("requires-baseline");
  }
});

test("R06 sustained printable output replaces checkpoints beyond raw-tail cap", async () => {
  const engine = model();
  try {
    for (let seq = 1; seq <= 20; seq++) {
      expect((await engine.apply(output(seq), utf8("x".repeat(4096)))).ok).toBe(true);
      const capture = await engine.captureBaseline();
      expect(capture.status).toBe("ready");
      expect(capture.baseline.atSeq).toBe(seq);
      expect(capture.baseline.tail.length).toBeLessThanOrEqual(M0_LIMITS.baselineTailBytes);
    }
  } finally {
    engine.dispose();
  }
});

test("R07 same-size resize keeps baseline while real resize rebuilds at new geometry", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("hello"));
    const before = await engine.captureBaseline();
    expect((await engine.apply(resize(2, 12, 4))).ok).toBe(true);
    const same = await engine.captureBaseline();
    expect(same.status).toBe("ready");
    expect(same.baseline.captureGeometry).toEqual(before.baseline.captureGeometry);
    expect((await engine.apply(resize(3, 10, 4))).ok).toBe(true);
    const changed = await engine.captureBaseline();
    expect(changed.status).toBe("ready");
    expect(changed.baseline).toMatchObject({
      atSeq: 3,
      captureGeometry: { cols: 10, rows: 4 },
      currentGeometry: { cols: 10, rows: 4 },
    });
    expect(assertTransfer(changed.baseline)).toBe(true);
  } finally {
    engine.dispose();
  }
});

test("R08 returned snapshot is detached and capture emits no live reply", async () => {
  const replies = [];
  const engine = model({ onAutomaticOutput: (item) => replies.push(item) });
  try {
    await engine.apply(output(1), utf8("A"));
    const first = await engine.captureBaseline();
    const original = first.baseline.vt.slice();
    first.baseline.vt.fill(88);
    first.baseline.tail.fill(88);
    const second = await engine.captureBaseline();
    expect(second.baseline.vt).toEqual(original);
    expect(replies).toEqual([]);
  } finally {
    engine.dispose();
  }
});

test("R09 failed candidate under a small VT cap preserves the prior checkpoint and raw tail", async () => {
  const engine = model({ effectiveBudgets: { ...M0_LIMITS, baselineVtBytes: 300 } });
  try {
    const initial = await engine.captureBaseline();
    expect(initial.status).toBe("ready");
    expect(initial.baseline.vt.length).toBeLessThanOrEqual(300);
    const bytes = utf8("\u001b[31mHello");
    expect((await engine.apply(output(1), bytes)).ok).toBe(true);
    const capture = await engine.captureBaseline();
    expect(capture.status).toBe("ready");
    expect(capture.baseline.checkpointSeq).toBe(0);
    expect(capture.baseline.atSeq).toBe(1);
    expect(capture.baseline.vt).toEqual(initial.baseline.vt);
    expect(capture.baseline.tail).toEqual(bytes);
    expect(assertTransfer(capture.baseline)).toBe(true);
  } finally {
    engine.dispose();
  }
});
