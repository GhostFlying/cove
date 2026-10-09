import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { model, output, resize, utf8, string } from "./driver.mjs";
import { createScreenPreview } from "../dist/src/terminal-preview.js";

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

test("V07 scratch denial precedes preview construction and leaves existing model leases intact", async () => {
  let current = 0;
  let denyPreview = false;
  const requests = [];
  const engine = model({
    reserveRetainedBytes(bytes) {
      requests.push(bytes);
      if (denyPreview && bytes === M0_LIMITS.previewBytesPerRun + 512 * 12 * 4 + 256)
        return undefined;
      current += bytes;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          current -= bytes;
        },
      };
    },
  });
  try {
    const existing = current;
    denyPreview = true;
    expect((await engine.capturePreview()).status).toBe("unavailable");
    expect(current).toBe(existing);
    denyPreview = false;
    expect((await engine.capturePreview()).status).toBe("ready");
    expect(current).toBe(existing);
    expect(requests).toContain(M0_LIMITS.previewBytesPerRun + 512 * 12 * 4 + 256);
  } finally {
    engine.dispose();
  }
  expect(current).toBe(0);
});

test("V08 streaming preview rejects an oversized existing cell before row staging", () => {
  const cell = {
    getWidth: () => 1,
    getChars: () => `A${"\u0301".repeat(40_000)}`,
    getFgColorMode: () => 0,
    getBgColorMode: () => 0,
    isBold: () => false,
    isDim: () => false,
    isItalic: () => false,
    isUnderline: () => false,
    isBlink: () => false,
    isInverse: () => false,
    isInvisible: () => false,
    isStrikethrough: () => false,
    isOverline: () => false,
  };
  const terminal = {
    cols: 1,
    rows: 1,
    buffer: {
      active: {
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: () => ({ getCell: () => cell }),
      },
    },
  };
  expect(() => createScreenPreview(terminal, 65_536)).toThrow("preview exceeds byte cap");
});

test("V09 detached baseline reservation precedes copies and denial or throw preserves authority", async () => {
  const engine = model();
  try {
    await engine.apply(output(1), utf8("LIVE"));
    const original = await engine.captureBaseline();
    expect(original.status).toBe("ready");
    const size = original.baseline.vt.byteLength + original.baseline.tail.byteLength + 4096;
    const calls = [];
    expect(
      (
        await engine.captureBaseline((bytes) => {
          calls.push(bytes);
          return false;
        })
      ).status,
    ).toBe("unavailable");
    expect(
      (
        await engine.captureBaseline((bytes) => {
          calls.push(bytes);
          throw new Error("reservation failed");
        })
      ).status,
    ).toBe("unavailable");
    expect(calls).toEqual([size, size]);
    expect((await engine.captureBaseline()).baseline).toEqual(original.baseline);
  } finally {
    engine.dispose();
  }
});

test("V10 exact baseline lease remains caller-owned while reentrant work waits behind capture", async () => {
  const engine = model();
  try {
    let charged = 0;
    let later;
    const first = await engine.captureBaseline((bytes) => {
      charged = bytes;
      later = engine.captureBaseline();
      return true;
    });
    expect(first.status).toBe("ready");
    expect(charged).toBe(first.baseline.vt.byteLength + first.baseline.tail.byteLength + 4096);
    expect((await later).baseline).toEqual(first.baseline);
    expect(charged).toBeGreaterThan(0);
  } finally {
    engine.dispose();
  }
});

test("V11 callback disposal stops detached baseline copies after reservation", async () => {
  const engine = model();
  let called = 0;
  const result = await engine.captureBaseline((bytes) => {
    expect(bytes).toBeGreaterThan(4096);
    called++;
    engine.dispose();
    return true;
  });
  expect(called).toBe(1);
  expect(result).toMatchObject({ status: "disposed" });
  expect(result).not.toHaveProperty("baseline.vt");
  expect((await engine.captureBaseline()).status).toBe("disposed");
});

test("V12 preview above the 120x40 cell bound is unavailable without a scratch reservation", async () => {
  const requests = [];
  const engine = model({
    reserveRetainedBytes(bytes) {
      requests.push(bytes);
      return { release() {} };
    },
  });
  try {
    await engine.apply(resize(1, 121, 40));
    requests.length = 0;
    const preview = await engine.capturePreview();
    expect(preview.status).toBe("unavailable");
    expect(requests.filter((bytes) => bytes >= M0_LIMITS.previewBytesPerRun)).toEqual([]);
    await engine.apply(resize(2, 120, 40));
    expect((await engine.capturePreview()).status).toBe("ready");
  } finally {
    engine.dispose();
  }
});
