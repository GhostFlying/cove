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
      const hidden = window.coveView.setHidden(true);
      return { small, large, hidden };
    }),
  );
  expect(result.small.logical).toMatchObject({ cols: 40, rows: 10 });
  expect(result.large.logical).toMatchObject({ cols: 40, rows: 10 });
  expect(result.small.measurement).not.toEqual(result.large.measurement);
  expect(result.hidden.measurement).toEqual(result.large.measurement);
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
      return { appearanceError, construction, exact, final: window.coveView.evidence() };
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
      window.coveView.dispose();
      return {
        deadline,
        cycled,
        beforeDispose,
        afterDispose: document.querySelectorAll("[data-cove-terminal-view]").length,
        children: document.querySelector("#terminal").childElementCount,
      };
    }),
  );
  expect(result.deadline).toEqual(["RECOVERY_EXPIRED"]);
  expect(result.cycled.children).toBe(1);
  expect(result.beforeDispose).toBe(1);
  expect(result.afterDispose).toBe(0);
  expect(result.children).toBe(0);
});
