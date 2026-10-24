import { expect, test } from "vitest";
import { withViewPage } from "./view-browser-runner.mjs";

const esc = (...values) => Array.from(new TextEncoder().encode(values.join("")));

test("Mobile native committed trace survives both legacy timer orders on actual xterm6", async () => {
  const result = await withViewPage(async (page) => {
    const traces = [];
    for (const order of ["before-insertion", "after-insertion", "after-input"])
      traces.push(
        await page.evaluate((value) => window.coveView.nativeCommittedTrace(value), order),
      );
    const composition = await page.evaluate(() => window.coveView.nativeComposition());
    await page.evaluate(async () => {
      await window.coveView.reset(undefined, { nativeCommittedInput: true });
      await window.coveView.ready();
      window.coveView.focus();
    });
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    const keyboard = await page.evaluate(() => window.coveView.evidence());
    const queries = [];
    for (const phase of ["live", "baseline", "replay"])
      queries.push(await page.evaluate((value) => window.coveView.queryCorpus(value, true), phase));
    return { traces, composition, keyboard, queries };
  });
  for (const trace of result.traces) {
    expect(trace.inputs.flatMap((item) => item.bytes)).toEqual(esc("cove-t5-diag"));
    expect(trace.failures).toEqual([]);
  }
  expect(result.composition.inputs.flatMap((item) => item.bytes)).toEqual(esc("色"));
  expect(result.keyboard.inputs.flatMap((item) => item.bytes)).toEqual([97, 13, 127]);
  for (const cases of result.queries) for (const item of cases) expect(item.adapted).toEqual([]);
});

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
    await page.mouse.wheel(0, -120);
    const disabled = (await page.evaluate(() => window.coveView.evidence())).inputs;
    await page.evaluate(async (bytes) => {
      window.coveView.setSize(760, 420);
      await window.coveView.reset({ cols: 40, rows: 10 });
      await window.coveView.ready();
      await window.coveView.output(bytes);
    }, esc("\x1b[?1000h\x1b[?1006h"));
    const activeBox = await page.locator(".xterm-screen").boundingBox();
    const x = activeBox.x + activeBox.width * (4.5 / 40);
    const y = activeBox.y + activeBox.height * (2.5 / 10);
    await page.mouse.click(x, y);
    await page.mouse.wheel(0, -120);
    const normal = (await page.evaluate(() => window.coveView.evidence())).inputs;
    await page.evaluate((bytes) => window.coveView.output(bytes, 2), esc("\x1b[?1049h"));
    await page.mouse.click(x, y);
    await page.mouse.wheel(0, -120);
    const alternate = (await page.evaluate(() => window.coveView.evidence())).inputs.slice(
      normal.length,
    );
    await page.evaluate((bytes) => window.coveView.output(bytes, 3), esc("\x1b[?1000l\x1b[?1006l"));
    await page.mouse.wheel(0, -120);
    const alternateWheel = (await page.evaluate(() => window.coveView.evidence())).inputs.slice(
      normal.length + alternate.length,
    );
    return { disabled, normal, alternate, alternateWheel };
  });
  expect(result.disabled).toEqual([]);
  const expected = [esc("\x1b[<0;5;3M"), esc("\x1b[<0;5;3m"), esc("\x1b[<64;5;3M")];
  for (const inputs of [result.normal, result.alternate]) {
    expect(inputs.map((item) => item.source)).toEqual(["mouse", "mouse", "mouse"]);
    expect(inputs.map((item) => item.bytes)).toEqual(expected);
  }
  expect(result.alternateWheel).toEqual([
    { viewGeneration: expect.any(Number), source: "mouse", bytes: esc("\x1b[A") },
  ]);
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
  expect(inputs.map((item) => ({ source: item.source, bytes: item.bytes }))).toEqual([
    { source: "mouse", bytes: [27, 91, 77, 32, 132, 36] },
    { source: "mouse", bytes: [27, 91, 77, 35, 132, 36] },
  ]);
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

// A baseline rebuilds the xterm. Keys typed while it installs must still reach the view, so a
// rebuild hands keyboard focus to the new xterm when the old one had it (#114). It moves DOM
// focus only: the rebuild publishes no focus intent, and the next key publishes one as usual.
// Focus elsewhere on the page, or nowhere, is left where it is.
test("V1-I7 a rebuilt xterm keeps the keyboard focus the old one had, and takes no other", async () => {
  const result = await withViewPage(async (page) => {
    const cases = {};
    for (const rebuild of ["initialize", "baseline"]) {
      const item = await page.evaluate(
        (how) => window.coveView.rebuildWithFocus("view", how),
        rebuild,
      );
      await page.keyboard.type("k");
      const after = await page.evaluate(() => window.coveView.evidence());
      cases[`view-${rebuild}`] = { ...item, inputs: after.inputs, focusesAfter: after.focuses };
    }
    for (const focus of ["elsewhere", "none"])
      cases[focus] = await page.evaluate(
        (where) => window.coveView.rebuildWithFocus(where, "initialize"),
        focus,
      );
    return cases;
  });
  for (const rebuild of ["initialize", "baseline"]) {
    const item = result[`view-${rebuild}`];
    expect(item.rebuilt).toBe(true);
    expect(item.active).toBe("view");
    expect(item.focuses).toEqual([]);
    expect(item.inputs).toEqual([
      { viewGeneration: item.generation, source: "keyboard", bytes: [107] },
    ]);
    // The key published the focus intent; the rebuild did not.
    expect(item.focusesAfter.at(-1)).toMatchObject({
      viewGeneration: item.generation,
      focused: true,
    });
  }
  expect(result.elsewhere).toMatchObject({ rebuilt: true, active: "elsewhere", focuses: [] });
  expect(result.none).toMatchObject({ rebuilt: true, active: "body", focuses: [] });
});

// The focus handoff's re-entry matrix (terminal-architecture 4.4.8). Handing focus to a rebuilt
// xterm runs page focus listeners synchronously; each action below is taken by one of them, or
// Terminal.focus() throws after taking it. `error` is the rebuild's result, `nested` that of the
// listener's own call, and `installs` whether a baseline then still installs into the view.
const ok = {
  reached: 1,
  rebuilt: true,
  focuses: 0,
  failures: [],
  error: undefined,
  nested: undefined,
  installs: undefined,
  hidden: false,
  active: "view",
  ownedRoots: 1,
};
const handoffOutcomes = (rebuild) => ({
  // A successor initialized by the listener survives, keeps focus and installs a baseline; the
  // superseded rebuild rejects RESYNC_REQUIRED.
  initialize: { ...ok, error: "RESYNC_REQUIRED" },
  // Disposed: the rebuild rejects RESYNC_REQUIRED, publishes nothing and leaves no root.
  dispose: {
    ...ok,
    error: "RESYNC_REQUIRED",
    installs: "RESYNC_REQUIRED",
    active: "body",
    ownedRoots: 0,
  },
  // Hidden: the rebuild completes and the hidden view gives up the focus it was handed.
  hide: { ...ok, hidden: true, active: "body" },
  // Focus the page moved on stays where the page put it.
  "focus-elsewhere": { ...ok, active: "elsewhere" },
  // An initialize commits only its xterm, so its listener may begin the baseline. A baseline
  // commits its state before the handoff, so a nested baseline is refused and the outer installs.
  baseline: rebuild === "initialize" ? ok : { ...ok, nested: "RESYNC_REQUIRED" },
  // Output cannot be applied to a view that is not ready.
  output: { ...ok, nested: "RESYNC_REQUIRED" },
  // A throw while the rebuild owns the view retires the xterm and fails the view.
  throw: {
    ...ok,
    error: "RECOVERY_UNAVAILABLE",
    installs: "RESYNC_REQUIRED",
    failures: ["RECOVERY_UNAVAILABLE"],
    active: "body",
    ownedRoots: 0,
  },
  // A throw after the listener initialized a successor belongs to nobody current: the rebuild
  // rejects RESYNC_REQUIRED and the successor survives without a failure.
  "initialize-then-throw": { ...ok, error: "RESYNC_REQUIRED", active: "body" },
});

test("V1-I8 a focus handoff listener cannot corrupt the rebuild or its successor", async () => {
  const expected = {};
  for (const rebuild of ["initialize", "baseline"])
    for (const [action, outcome] of Object.entries(handoffOutcomes(rebuild)))
      expected[`${rebuild}/${action}`] = outcome;
  const result = await withViewPage(async (page) => {
    const cases = {};
    for (const key of Object.keys(expected))
      cases[key] = await page.evaluate(
        ([how, what]) => window.coveView.focusHandoffReentry(how, what),
        key.split("/"),
      );
    return cases;
  });
  expect(result).toEqual(expected);
});
