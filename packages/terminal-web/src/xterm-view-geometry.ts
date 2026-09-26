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

export function measureTerminalGrid(
  terminal: Terminal,
  container: HTMLElement,
  fallback: Geometry,
): Geometry {
  // The renderer owns the actual glyph metrics. Reading them is intentionally confined here so
  // an xterm upgrade cannot silently turn a viewport estimate into an authoritative resize.
  const cell = (terminal as unknown as RenderSurface)._core?._renderService?.dimensions?.css?.cell;
  const style = container.ownerDocument.defaultView?.getComputedStyle(container);
  const horizontalPadding =
    Number.parseFloat(style?.paddingLeft ?? "0") + Number.parseFloat(style?.paddingRight ?? "0");
  const verticalPadding =
    Number.parseFloat(style?.paddingTop ?? "0") + Number.parseFloat(style?.paddingBottom ?? "0");
  const width = container.clientWidth - horizontalPadding;
  const height = container.clientHeight - verticalPadding;
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
