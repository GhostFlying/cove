import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { parserSequences } from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { model, output, resize, utf8, receiver, restore, write, observation } from "./driver.mjs";

async function cutCase(sequence, cut, chunked) {
  const engine = model();
  const reference = receiver();
  let recovered;
  try {
    const prefix = sequence.subarray(0, cut);
    const suffix = Uint8Array.from([...sequence.subarray(cut), 33]);
    let seq = 0;
    const pieces = chunked ? [...prefix].map((byte) => Uint8Array.of(byte)) : [prefix];
    const accepted = [];
    for (const piece of pieces) {
      seq++;
      accepted.push((await engine.apply(output(seq), piece)).ok);
      await write(reference, piece);
    }
    expect(accepted.every(Boolean)).toBe(true);
    const captured = await engine.captureBaseline();
    expect(captured.status).toBe("ready");
    recovered = await restore(captured.baseline);
    expect(observation(recovered)).toEqual(observation(reference));
    await write(reference, suffix);
    await write(recovered, suffix);
    expect(observation(recovered)).toEqual(observation(reference));
  } finally {
    engine.dispose();
    reference.dispose();
    recovered?.dispose();
  }
}

test("P01 all 138 UTF-8/CSI/OSC/DCS/ESC interior cuts restore and continue", async () => {
  let checked = 0;
  for (const [, bytes] of parserSequences)
    for (let cut = 1; cut < bytes.length; cut++)
      for (const chunked of [false, true]) {
        await cutCase(bytes, cut, chunked);
        checked++;
      }
  expect(checked).toBe(138);
});

test("P02 seven C0-in-CSI effects are represented exactly once", async () => {
  const c0 = ["\n", "\r", "\b", "\t", "\u000f", "\u000e", "\u0007"];
  for (const control of c0) {
    const engine = model();
    const reference = receiver();
    let recovered;
    try {
      await engine.apply(output(1), utf8("\u001b[2;3H"));
      await write(reference, "\u001b[2;3H");
      await engine.apply(output(2), utf8(`\u001b[1${control}`));
      await write(reference, `\u001b[1${control}`);
      const baseline = await engine.captureBaseline();
      expect(baseline.status).toBe("ready");
      recovered = await restore(baseline.baseline);
      expect(observation(recovered)).toEqual(observation(reference));
      await write(reference, ";2H!");
      await write(recovered, ";2H!");
      expect(observation(recovered)).toEqual(observation(reference));
    } finally {
      engine.dispose();
      reference.dispose();
      recovered?.dispose();
    }
  }
});

test("P03 parser-incomplete capture retains a pre-tail checkpoint", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("A"));
    await engine.apply(output(2), utf8("\u001b[12;"));
    const capture = await engine.captureBaseline();
    expect(capture.status).toBe("ready");
    expect(capture.baseline.checkpointSeq).toBe(0);
    expect(capture.baseline.atSeq).toBe(2);
    expect(capture.baseline.tail).toEqual(utf8("A\u001b[12;"));
  } finally {
    engine.dispose();
  }
});

test("P04 split CSI through real resize waits then obtains new-grid checkpoint", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("\u001b[2;"));
    await engine.apply(resize(2, 10));
    expect((await engine.captureBaseline()).status).toBe("waiting-checkpoint");
    await engine.apply(output(3), utf8("3HX"));
    const captured = await engine.captureBaseline();
    expect(captured.status).toBe("ready");
    expect(captured.baseline).toMatchObject({ atSeq: 3, currentGeometry: { cols: 10, rows: 4 } });
  } finally {
    engine.dispose();
  }
});

test("P05 tail cap overflow is explicit and a later safe checkpoint restores availability", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("\u001b]2;"));
    let seq = 1;
    for (let n = 0; n < 9; n++) await engine.apply(output(++seq), utf8("x".repeat(8192)));
    expect((await engine.captureBaseline()).status).toBe("unavailable");
    await engine.apply(output(++seq), utf8("\u0007Z"));
    const captured = await engine.captureBaseline();
    expect(captured.status).toBe("ready");
    expect(captured.baseline.atSeq).toBe(seq);
  } finally {
    engine.dispose();
  }
});

test("P06 finite payload and geometry limits reject before mutating parser", async () => {
  const engine = model();
  try {
    expect(
      (await engine.apply(output(1), new Uint8Array(M0_LIMITS.baselineTailBytes + 1))).error.code,
    ).toBe("invalid");
    expect((await engine.apply(resize(1, 121))).error.code).toBe("invalid");
    expect((await engine.apply(output(1), utf8("A"))).ok).toBe(true);
  } finally {
    engine.dispose();
  }
});
