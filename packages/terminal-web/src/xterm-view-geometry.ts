import type { Terminal } from "@xterm/xterm";
import { M0_LIMITS } from "@cove/protocol/budgets";
import type { Geometry } from "@cove/protocol/profile";

interface RenderSurface {
  _core?: {
    _renderService?: {
      dimensions?: { device?: { cell?: { width?: number; height?: number } } };
    };
  };
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

// xterm 6 overlays its vertical scrollbar on the right edge of the terminal, inside the host,
// whenever the terminal keeps scrollback. Its width is `overviewRuler.width` or this default
// (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH in xterm 6.0.0). Cells under it are hidden by the
// scrollbar, so they are not part of the visible grid. @xterm/addon-fit reserves the same width.
const DEFAULT_SCROLLBAR_WIDTH = 14;

function scrollbarWidth(terminal: Terminal): number {
  if (terminal.options.scrollback === 0) return 0;
  return terminal.options.overviewRuler?.width || DEFAULT_SCROLLBAR_WIDTH;
}

// The CSS extent xterm 6.0.0 gives `count` cells: both the DOM renderer and the WebGL renderer
// compute `round(deviceCell * count / devicePixelRatio)` for the screen (DomRenderer and
// WebglRenderer `_updateDimensions`). The device cell does not depend on the grid size, but the
// rounded total does, so `css.cell.width` (the total divided by the current count) changes with
// the current grid and must not be used to choose the next one: doing so oscillates between two
// sizes and can admit a column whose rounded screen no longer fits.
export function renderedExtent(count: number, deviceCell: number, devicePixelRatio: number) {
  return Math.round((deviceCell * count) / devicePixelRatio);
}

// The largest count whose rendered extent fits `available` CSS pixels. It depends only on the
// device cell, the pixel ratio and the available space, never on the current grid, so applying
// the result and measuring again yields the same result.
export function fitCount(
  available: number,
  deviceCell: number,
  devicePixelRatio: number,
  lower: number,
  upper: number,
): number {
  let count = clamp(Math.floor((available * devicePixelRatio) / deviceCell), lower, upper);
  while (count < upper && renderedExtent(count + 1, deviceCell, devicePixelRatio) <= available)
    count++;
  while (count > lower && renderedExtent(count, deviceCell, devicePixelRatio) > available) count--;
  return count;
}

// The renderer's device cell, which xterm derives from the font metrics and the pixel ratio only.
export function deviceCell(terminal: Terminal): { width: number; height: number } | undefined {
  // Reading renderer internals is intentionally confined here so an xterm upgrade cannot silently
  // turn a viewport estimate into an authoritative resize.
  const cell = (terminal as unknown as RenderSurface)._core?._renderService?.dimensions?.device
    ?.cell;
  if (
    !cell ||
    !Number.isFinite(cell.width) ||
    !Number.isFinite(cell.height) ||
    cell.width! <= 0 ||
    cell.height! <= 0
  )
    return undefined;
  return { width: cell.width!, height: cell.height! };
}

export function measureTerminalGrid(
  terminal: Terminal,
  container: HTMLElement,
  fallback: Geometry,
): Geometry {
  const cell = deviceCell(terminal);
  const view = container.ownerDocument.defaultView;
  // xterm reads the same window property for its pixel ratio.
  const devicePixelRatio = view?.devicePixelRatio ?? 1;
  const style = view?.getComputedStyle(container);
  const px = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
  // Use the fractional layout box: clientWidth rounds to whole pixels and can round a partial
  // pixel up, which would admit a column that does not fit.
  const box = container.getBoundingClientRect();
  const width =
    box.width -
    px(style?.borderLeftWidth) -
    px(style?.borderRightWidth) -
    px(style?.paddingLeft) -
    px(style?.paddingRight) -
    scrollbarWidth(terminal);
  const height =
    box.height -
    px(style?.borderTopWidth) -
    px(style?.borderBottomWidth) -
    px(style?.paddingTop) -
    px(style?.paddingBottom);
  if (
    !cell ||
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    container.getClientRects().length === 0
  )
    return fallback;
  return {
    cols: fitCount(width, cell.width, devicePixelRatio, 2, M0_LIMITS.maxCols),
    rows: fitCount(height, cell.height, devicePixelRatio, 2, M0_LIMITS.maxRows),
  };
}
