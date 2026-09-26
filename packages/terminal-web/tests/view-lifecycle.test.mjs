import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { withViewPage } from "./view-browser-runner.mjs";

test("V1-L1 rejects wrong profile and changed private ownership before further admission", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      const profile = await window.coveView.attemptInvalidInitialization();
      await window.coveView.ready();
      window.coveView.tamperOrigin();
      const surface = await window.coveView.attemptOutput([65]);
      return { profile, surface, evidence: window.coveView.evidence() };
    }),
  );
  expect(result.profile).toBe("PROFILE_UNSUPPORTED");
  expect(result.surface).toBe("PROFILE_UNSUPPORTED");
  expect(result.evidence.failures.map((item) => item.kind)).toEqual(["PROFILE_UNSUPPORTED"]);

  const directory = await mkdtemp(join(tmpdir(), "cove-view-version-"));
  const packageRoot = resolve(import.meta.dirname, "..");
  const browserRoot = join(directory, "browser");
  try {
    const built = spawnSync(
      process.execPath,
      [
        join(packageRoot, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        join(packageRoot, "tests/browser/vite.config.mjs"),
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          COVE_VIEW_BROWSER_OUT: browserRoot,
          COVE_VIEW_TEST_BUNDLED_XTERM_VERSION: "0.0.0",
        },
      },
    );
    expect(built.error).toBeUndefined();
    if (built.status !== 0)
      throw new Error(built.stderr || `V1 isolated build exited ${built.status}`);
    const script = `import { withViewPage } from ${JSON.stringify(import.meta.resolve("./view-browser-runner.mjs"))}; const result = await withViewPage(page => page.evaluate(() => window.coveView.attemptReset())); console.log(JSON.stringify(result));`;
    const mismatch = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, COVE_VIEW_BROWSER_ROOT: browserRoot },
    });
    expect(mismatch.error).toBeUndefined();
    if (mismatch.status !== 0)
      throw new Error(mismatch.stderr || `V1 mismatch probe exited ${mismatch.status}`);
    expect(JSON.parse(mismatch.stdout.trim())).toMatchObject({
      kind: "PROFILE_UNSUPPORTED",
      evidence: { failures: [{ kind: "PROFILE_UNSUPPORTED" }] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V1-L2 replacement generations settle old work once and admit only replacement input", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.holdNextParse();
      window.coveView.startHeldOutput([27, 93, 55, 55, 55, 59, 120, 7]);
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.input("r");
      window.coveView.releaseParse();
      await Promise.resolve();
      return { status: window.coveView.heldStatus(), evidence: window.coveView.evidence() };
    }),
  );
  expect(result.status).toBe("rejected");
  expect(result.evidence.inputs).toHaveLength(1);
  expect(result.evidence.inputs[0]).toMatchObject({ source: "keyboard", bytes: [114] });
  expect(result.evidence.inputs[0].viewGeneration).toBeGreaterThan(1);
});

test("V1-L3 measures unequal and hidden containers without changing authoritative geometry", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset({ cols: 40, rows: 10 });
      await window.coveView.ready();
      const small = window.coveView.setSize(320, 160);
      const large = window.coveView.setSize(1000, 600);
      const structural = window.coveView.structuralLayout();
      const hidden = window.coveView.setHidden(true);
      return { small, large, structural, hidden };
    }),
  );
  expect(result.small.logical).toMatchObject({ cols: 40, rows: 10 });
  expect(result.large.logical).toMatchObject({ cols: 40, rows: 10 });
  expect(result.small.measurement).not.toEqual(result.large.measurement);
  expect(result.hidden.measurement).toEqual(result.large.measurement);
  expect(result.structural).toMatchObject({
    rootPosition: "relative",
    viewportPosition: "absolute",
    screenPosition: "relative",
    textareaPosition: "absolute",
    textareaOpacity: "0",
  });
  expect(result.structural.screenWidth).toBeGreaterThan(0);
  expect(result.structural.screenHeight).toBeGreaterThan(0);
  for (const value of [result.small.measurement, result.large.measurement]) {
    expect(value.cols).toBeGreaterThanOrEqual(2);
    expect(value.cols).toBeLessThanOrEqual(120);
    expect(value.rows).toBeGreaterThanOrEqual(2);
    expect(value.rows).toBeLessThanOrEqual(40);
  }
});

test("V1-L4 publishes focus before input but not for selection scrolling appearance or show", async () => {
  const result = await withViewPage(async (page) => {
    await page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.setVisibility(false);
      window.coveView.setVisibility(true);
      window.coveView.setAppearance({ palette: [] });
    });
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.wheel(0, 100);
    const before = await page.evaluate(() => window.coveView.evidence());
    await page.evaluate(() => window.coveView.focus());
    await page.keyboard.type("x");
    const afterInput = await page.evaluate(() => window.coveView.evidence());
    await page.evaluate(() => window.coveView.setVisibility(false));
    const afterHide = await page.evaluate(() => window.coveView.evidence());
    return { before, afterInput, afterHide, box };
  });
  expect(result.before.focuses).toEqual([]);
  expect(result.afterInput.focuses.map((item) => item.focused)).toEqual([true]);
  expect(result.afterInput.inputs[0].bytes).toEqual([120]);
  expect(result.afterHide.focuses.map((item) => item.focused)).toEqual([true, false]);
});

test("V1-L5 validates appearance and rejects oversized input without truncating or losing the model", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready(Array.from(new TextEncoder().encode("MODEL")));
      let appearanceError;
      try {
        window.coveView.setAppearance({
          palette: [
            { index: 1, rgb: "0000/0000/0000" },
            { index: 1, rgb: "ffff/ffff/ffff" },
          ],
        });
      } catch (error) {
        appearanceError = error.kind;
      }
      window.coveView.setAppearance({
        foreground: "1234/5678/9abc",
        palette: [{ index: 200, rgb: "ffff/0000/ffff" }],
      });
      const construction = await window.coveView.attemptConstructionFailure();
      window.coveView.input("a".repeat(65536));
      const exact = window.coveView.evidence();
      window.coveView.input("b".repeat(65537));
      const final = window.coveView.evidence();
      await window.coveView.reset();
      await window.coveView.ready();
      const runtime = window.coveView.attemptRuntimeThemeFailure(true);
      return { appearanceError, construction, exact, final, runtime };
    }),
  );
  expect(result.appearanceError).toBe("PROFILE_UNSUPPORTED");
  expect(result.construction).toEqual({
    kind: "RECOVERY_UNAVAILABLE",
    failures: ["RECOVERY_UNAVAILABLE"],
  });
  expect(result.exact.inputs.at(-1).bytes).toHaveLength(65536);
  expect(result.final.inputs).toHaveLength(result.exact.inputs.length);
  expect(result.final.failures.at(-1).kind).toBe("INPUT_REJECTED");
  expect(result.final.rows.join("")).toContain("MODEL");
  expect(result.runtime).toMatchObject({
    kind: "RECOVERY_UNAVAILABLE",
    failures: ["RECOVERY_UNAVAILABLE"],
    disposeCalls: 1,
    repeated: "ok",
    children: 0,
  });
  expect(result.runtime.removeCalls).toBeGreaterThan(1);
  expect(result.runtime.errors).toEqual([
    "RECOVERY_UNAVAILABLE",
    "injected tracker cleanup failure",
  ]);
});

test("V1-L6 repeatedly creates and disposes one owned DOM tree", async () => {
  const result = await withViewPage(async (page) =>
    page.evaluate(async () => {
      await window.coveView.reset();
      await window.coveView.ready();
      window.coveView.holdNextParse();
      window.coveView.startHeldOutput([27, 93, 55, 55, 55, 59, 120, 7]);
      await window.coveView.awaitHeld();
      const deadline = window.coveView.evidence().failures.map((error) => error.kind);
      const cycled = await window.coveView.cycle(20);
      const beforeDispose = document.querySelectorAll("[data-cove-terminal-view]").length;
      const timerCleanup = window.coveView.disposeAfterPasteWithTimerProbe();
      return {
        deadline,
        cycled,
        beforeDispose,
        afterDispose: document.querySelectorAll("[data-cove-terminal-view]").length,
        children: document.querySelector("#terminal").childElementCount,
        timerCleanup,
      };
    }),
  );
  expect(result.deadline).toEqual(["RECOVERY_EXPIRED"]);
  expect(result.cycled.children).toBe(1);
  expect(result.beforeDispose).toBe(1);
  expect(result.afterDispose).toBe(0);
  expect(result.children).toBe(0);
  expect(result.timerCleanup.children).toBe(0);
  expect(result.timerCleanup.cleared).toBeGreaterThan(0);

  const directory = await mkdtemp(join(tmpdir(), "cove-view-cleanup-"));
  const evidence = join(directory, "cleanup.json");
  const previousFailure = process.env.COVE_QUERY_INJECT_CLEANUP_FAILURE;
  const previousEvidence = process.env.COVE_QUERY_CLEANUP_EVIDENCE;
  process.env.COVE_QUERY_INJECT_CLEANUP_FAILURE = "1";
  process.env.COVE_QUERY_CLEANUP_EVIDENCE = evidence;
  try {
    let failure;
    try {
      await withViewPage(async () => {
        throw new Error("injected V1 work failure");
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toEqual([
      "injected V1 work failure",
      "Injected query cleanup failure",
    ]);
    expect(failure.cause.message).toBe("injected V1 work failure");
    const cleanup = JSON.parse(await readFile(evidence, "utf8"));
    expect(cleanup).toMatchObject({ browserExited: true, listenerClosed: true, disposedPages: 1 });
    await expect(fetch(`http://127.0.0.1:${cleanup.listenerPort}/`)).rejects.toThrow(
      /fetch failed/,
    );
  } finally {
    if (previousFailure === undefined) delete process.env.COVE_QUERY_INJECT_CLEANUP_FAILURE;
    else process.env.COVE_QUERY_INJECT_CLEANUP_FAILURE = previousFailure;
    if (previousEvidence === undefined) delete process.env.COVE_QUERY_CLEANUP_EVIDENCE;
    else process.env.COVE_QUERY_CLEANUP_EVIDENCE = previousEvidence;
    await rm(directory, { recursive: true, force: true });
  }
});
