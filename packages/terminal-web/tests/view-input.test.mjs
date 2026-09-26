import { expect, test } from "vitest";
import { withViewPage } from "./view-browser-runner.mjs";

const esc = (...values) => Array.from(new TextEncoder().encode(values.join("")));

test("V1-I1 suppresses every supported query in live, baseline, and replay", async () => {
  const result = await withViewPage(async (page) => {
    const phases = {};
    for (const phase of ["live", "baseline", "replay"])
      phases[phase] = await page.evaluate((value) => window.coveView.queryCorpus(value), phase);
    return phases;
  });
  for (const cases of Object.values(result)) {
    expect(cases).toHaveLength(9);
    for (const item of cases) {
      expect(item.reference).toEqual(item.expected);
      expect(item.adapted).toEqual([]);
    }
  }
});

test("V1-I2 preserves real keyboard bytes while parsing is pending", async () => {
  const result = await withViewPage(async (page) => {
    await page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.holdNextParse();
      window.coveView.startHeldOutput([27, 93, 55, 55, 55, 59, 120, 7]);
      window.coveView.focus();
    });
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Control+c");
    const pending = await page.evaluate(() => window.coveView.heldStatus());
    await page.evaluate(() => window.coveView.releaseParse());
    await page.evaluate(() => window.coveView.awaitHeld());
    return { pending, evidence: await page.evaluate(() => window.coveView.evidence()) };
  });
  expect(result.pending).toBe("pending");
  expect(result.evidence.inputs.map((item) => item.source)).toEqual([
    "keyboard",
    "keyboard",
    "keyboard",
    "keyboard",
  ]);
  expect(result.evidence.inputs.flatMap((item) => item.bytes)).toEqual([97, 13, 127, 3]);
  expect(result.evidence.focuses[0].focused).toBe(true);
});

test("V1-I3 preserves browser paste normalization and bracket wrappers", async () => {
  const result = await withViewPage(async (page) => {
    await page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
    });
    const plain = await page.evaluate(() => window.coveView.paste("line1\n颜色\x1b[0n"));
    await page.evaluate((bytes) => window.coveView.output(bytes, 2), esc("\x1b[?2004h"));
    const bracketed = await page.evaluate(() => window.coveView.paste("x\ny"));
    return { plain, bracketed };
  });
  expect(result.plain.inputs[0].source).toBe("paste");
  expect(result.plain.inputs[0].bytes).toEqual(esc("line1\r颜色\x1b[0n"));
  expect(result.bracketed.inputs.at(-1)).toEqual(
    expect.objectContaining({ source: "paste", bytes: esc("\x1b[200~x\ry\x1b[201~") }),
  );
});

test("V1-I4 preserves SGR mouse press release and wheel with mouse origin", async () => {
  const result = await withViewPage(async (page) => {
    await page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
    });
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.click(box.x + 40, box.y + 30);
    const disabled = (await page.evaluate(() => window.coveView.evidence())).inputs;
    await page.evaluate(async (bytes) => {
      await window.coveView.reset();
      await window.coveView.ready();
      await window.coveView.output(bytes);
    }, esc("\x1b[?1000h\x1b[?1006h"));
    await page.mouse.click(box.x + 40, box.y + 30);
    await page.mouse.move(box.x + 40, box.y + 30);
    await page.mouse.wheel(0, 100);
    const normal = (await page.evaluate(() => window.coveView.evidence())).inputs;
    await page.evaluate((bytes) => window.coveView.output(bytes, 2), esc("\x1b[?1049h"));
    await page.mouse.click(box.x + 40, box.y + 30);
    await page.mouse.wheel(0, -100);
    const alternate = (await page.evaluate(() => window.coveView.evidence())).inputs.slice(
      normal.length,
    );
    return { disabled, normal, alternate };
  });
  expect(result.disabled).toEqual([]);
  expect(result.normal.length).toBeGreaterThanOrEqual(3);
  expect(result.alternate.length).toBeGreaterThanOrEqual(3);
  for (const inputs of [result.normal, result.alternate]) {
    expect(inputs.map((item) => item.source)).toEqual(inputs.map(() => "mouse"));
    expect(inputs.every((item) => item.bytes[0] === 27 && item.bytes[1] === 91)).toBe(true);
  }
});

test("V1-I5 preserves legacy high-coordinate binary bytes exactly once", async () => {
  const inputs = await withViewPage(async (page) => {
    await page.evaluate(async (bytes) => {
      window.coveView.setSize(1400, 300);
      await window.coveView.reset({ cols: 120, rows: 10 });
      await window.coveView.ready();
      await window.coveView.output(bytes);
    }, esc("\x1b[?1000h\x1b[?1006l"));
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.click(box.x + box.width * (99.5 / 120), box.y + box.height * (3.5 / 10));
    return (await page.evaluate(() => window.coveView.evidence())).inputs;
  });
  expect(inputs).toHaveLength(2);
  expect(inputs.every((item) => item.source === "mouse")).toBe(true);
  expect(inputs.flatMap((item) => item.bytes).some((byte) => byte > 127)).toBe(true);
});

test("V1-I6 never grammar-classifies reply-shaped genuine input", async () => {
  const evidence = await withViewPage(async (page) => {
    await page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.input("\x1b[0n");
      window.coveView.paste("\x1b[?1;2c");
    });
    return page.evaluate(() => window.coveView.evidence());
  });
  expect(evidence.inputs.map((item) => item.source)).toEqual(["keyboard", "paste"]);
  expect(evidence.inputs.map((item) => item.bytes)).toEqual([esc("\x1b[0n"), esc("\x1b[?1;2c")]);
});
