import { expect, test } from "vitest";
import { fitCount, renderedExtent } from "../../dist/src/xterm-view-geometry.js";

// xterm sizes its screen as round(deviceCell * count / devicePixelRatio) in both renderers, so the
// fitted count must be chosen from the device cell, not from the current grid's CSS cell.

test("the DOM case that oscillated when chosen from the current CSS cell has one answer", () => {
  // 8.43 px advance at ratio 1: 90 columns render 759 px and 89 columns 750 px.
  expect(renderedExtent(90, 8.43, 1)).toBe(759);
  expect(renderedExtent(89, 8.43, 1)).toBe(750);
  expect(fitCount(758.5, 8.43, 1, 2, 500)).toBe(89);
  expect(fitCount(759, 8.43, 1, 2, 500)).toBe(90);
});

test("a WebGL screen rounded up past the available width loses that column", () => {
  // A 9 device px cell at ratio 1.1: the quotient admits 91 columns, but they render 745 px.
  expect(Math.floor((744.6 * 1.1) / 9)).toBe(91);
  expect(renderedExtent(91, 9, 1.1)).toBe(745);
  expect(fitCount(744.6, 9, 1.1, 2, 500)).toBe(90);
});

test("the fitted count is the largest that fits, across cells, ratios and fractional widths", () => {
  const failures = [];
  for (const [deviceCell, ratio] of [
    [8.43, 1],
    [8.4296875 * 1.25, 1.25],
    [16.859375, 2],
    [9, 1.1],
    [8, 1],
    [21, 2.5],
    [17, 1],
  ])
    for (let tenths = 1000; tenths <= 8000; tenths++) {
      const available = tenths / 10;
      const count = fitCount(available, deviceCell, ratio, 2, 500);
      const fits = renderedExtent(count, deviceCell, ratio) <= available;
      const maximal = renderedExtent(count + 1, deviceCell, ratio) > available;
      if (!fits || !maximal) failures.push({ deviceCell, ratio, available, count });
    }
  expect(failures).toEqual([]);
});

test("the bounds still apply", () => {
  expect(fitCount(1, 8.43, 1, 2, 500)).toBe(2);
  expect(fitCount(100_000, 8.43, 1, 2, 500)).toBe(500);
});
