import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { model, output, resize, utf8, string } from "./driver.mjs";

test("V01 preview includes current normal viewport and excludes retained history", async () => {
  const engine = model();
  try {
    const history = Array.from({ length: 100 }, (_, i) => `OLD${i}\r\n`).join("");
    await engine.apply(output(1), utf8(`${history}LATEST`));
    const preview = await engine.capturePreview();
    expect(preview.status).toBe("ready");
    expect(preview.preview.atSeq).toBe(1);
    expect(string(preview.preview.vt)).toContain("LATEST");
    expect(string(preview.preview.vt)).not.toContain("OLD0");
  } finally {
    engine.dispose();
  }
});

test("V02 alternate preview omits hidden normal content", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("SECRET\u001b[?1049h\u001b[H VISIBLE"));
    const preview = await engine.capturePreview();
    expect(preview.status).toBe("ready");
    expect(string(preview.preview.vt)).toContain("VISIBLE");
    expect(string(preview.preview.vt)).not.toContain("SECRET");
  } finally {
    engine.dispose();
  }
});

test("V03 partial parser can preview settled cells during recovery wait", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("A\u001b[2;"));
    await engine.apply(resize(2, 10));
    expect((await engine.captureBaseline()).status).toBe("waiting-checkpoint");
    const preview = await engine.capturePreview();
    expect(preview.status).toBe("ready");
    expect(string(preview.preview.vt)).toContain("A");
  } finally {
    engine.dispose();
  }
});

test("V04 capture is ordered between writes and a resize", async () => {
  const engine = model();
  try {
    const first = engine.apply(output(1), utf8("A"));
    const before = engine.capturePreview();
    const second = engine.apply(resize(2, 10));
    const after = engine.capturePreview();
    await first;
    await second;
    expect((await before).preview).toMatchObject({ atSeq: 1, geometry: { cols: 12, rows: 4 } });
    expect((await after).preview).toMatchObject({ atSeq: 2, geometry: { cols: 10, rows: 4 } });
  } finally {
    engine.dispose();
  }
});

test("V05 preview cap fails whole output without truncating escape or UTF-8", async () => {
  const budgets = {
    ...M0_LIMITS,
    maxRuns: 1,
    listPage: 1,
    previewBytesPerRun: 64,
    previewGlobalBytes: 64,
  };
  const engine = model({ effectiveBudgets: budgets });
  try {
    await engine.apply(output(1), utf8("中\u001b[31mX"));
    const preview = await engine.capturePreview();
    expect(preview.status).toBe("unavailable");
    expect(preview).not.toHaveProperty("preview.vt");
    expect((await engine.captureBaseline()).status).toBe("ready");
  } finally {
    engine.dispose();
  }
});

test("V06 preview is detached and pure; disposal closes later capture", async () => {
  const replies = [];
  const engine = model({ onAutomaticOutput: (item) => replies.push(item) });
  await engine.apply(output(1), utf8("\u001b[32mA"));
  const before = await engine.captureBaseline();
  const first = await engine.capturePreview();
  expect(first.status).toBe("ready");
  const original = first.preview.vt.slice();
  first.preview.vt.fill(88);
  const second = await engine.capturePreview();
  expect(second.preview.vt).toEqual(original);
  expect((await engine.captureBaseline()).baseline).toEqual(before.baseline);
  expect(replies).toEqual([]);
  engine.dispose();
  expect((await engine.capturePreview()).status).toBe("disposed");
});
