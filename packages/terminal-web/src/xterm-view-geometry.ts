import type { Terminal } from "@xterm/xterm";
import { M0_LIMITS } from "@cove/protocol/budgets";
import type { Geometry } from "@cove/protocol/profile";

interface RenderSurface {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width?: number; height?: number } } };
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

export function measureTerminalGrid(
  terminal: Terminal,
  container: HTMLElement,
  fallback: Geometry,
): Geometry {
  // The renderer owns the actual glyph metrics. Reading them is intentionally confined here so
  // an xterm upgrade cannot silently turn a viewport estimate into an authoritative resize.
  const cell = (terminal as unknown as RenderSurface)._core?._renderService?.dimensions?.css?.cell;
  const style = container.ownerDocument.defaultView?.getComputedStyle(container);
  const px = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
  // Use the fractional layout box: clientWidth rounds to whole pixels and can round a partial
  // pixel up, which would admit a column that does not fit. Grid sizes are always floored, so a
  // PTY never wraps at a column the user cannot see.
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
    !Number.isFinite(cell.width) ||
    !Number.isFinite(cell.height) ||
    cell.width! <= 0 ||
    cell.height! <= 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    container.getClientRects().length === 0
  )
    return fallback;
  return {
    cols: clamp(Math.floor(width / cell.width!), 2, M0_LIMITS.maxCols),
    rows: clamp(Math.floor(height / cell.height!), 2, M0_LIMITS.maxRows),
  };
}
