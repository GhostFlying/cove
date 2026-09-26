import type { Terminal } from "@xterm/headless";
import type {
  AttributeState,
  PrivateBufferState,
  PrivateRecoveryState,
} from "./xterm-recovery-state.js";

// Promoted from the pinned T1 checkpoint experiment; packed modes are P16, P256, RGB.
export function sgr(attr: AttributeState): string {
  const codes = ["0"];
  for (const [name, code] of [
    ["bold", "1"],
    ["dim", "2"],
    ["italic", "3"],
    ["underline", "4"],
    ["blink", "5"],
    ["inverse", "7"],
    ["invisible", "8"],
    ["strikethrough", "9"],
    ["overline", "53"],
  ] as const)
    if (attr[name]) codes.push(code);
  for (const [packed, base] of [
    [attr.fg, 30],
    [attr.bg, 40],
  ] as const) {
    const mode = (packed >>> 24) & 3;
    const color = packed & 0xffffff;
    if (mode === 0) continue;
    if (mode === 1) {
      if (color < 8) codes.push(String(base + color));
      else if (color < 16) codes.push(String(base + 60 + color - 8));
      else throw new Error(`P16 color ${color} is out of range`);
    } else if (mode === 2) codes.push(String(base === 30 ? 38 : 48), "5", String(color));
    else if (mode === 3)
      codes.push(
        String(base === 30 ? 38 : 48),
        "2",
        String((color >> 16) & 255),
        String((color >> 8) & 255),
        String(color & 255),
      );
    else throw new Error(`Unrepresentable SGR color mode ${mode}`);
  }
  return `\u001b[${codes.join(";")}m`;
}

export function absolutePosition(x: number, y: number): string {
  return `\u001b[${y + 1};${x + 1}H`;
}

export function savedState(
  state: PrivateBufferState,
  cols: number,
  rows: number,
  currentAttr: AttributeState,
  restoreOrigin: boolean,
  charset: PrivateRecoveryState["charset"],
  finalActive: boolean,
  allowPendingCurrentX = false,
  preservePriorSave = false,
): string {
  const savedY = Math.max(0, state.savedY - state.ybase);
  if ((state.x >= cols && !allowPendingCurrentX) || state.savedX >= cols || savedY >= rows)
    throw new Error("VT saved-state candidate cannot address a pending-wrap cursor");
  let vt = "\u001b[?6l";
  vt += `\u001b[${state.scrollTop + 1};${state.scrollBottom + 1}r`;
  vt += "\u001b[3g";
  for (const tab of state.tabs)
    if (tab >= 0 && tab < cols) vt += `${absolutePosition(tab, 0)}\u001bH`;
  if (!preservePriorSave) {
    vt += absolutePosition(state.savedX, savedY);
    vt += sgr(state.savedAttr);
    vt += `\u001b(${state.savedCharset}\u000f\u001b7`;
  }
  if (finalActive) {
    vt += `\u001b(${charset.g0}\u001b)${charset.g1}${charset.glevel === 1 ? "\u000e" : "\u000f"}`;
    if (charset.current !== (charset.glevel === 1 ? charset.g1 : charset.g0)) {
      if (charset.current !== state.savedCharset)
        throw new Error("Current charset is not reconstructible from saved or designated map");
      vt += "\u001b8";
    }
  } else vt += "\u001b(B\u001b)B\u000f";
  if (restoreOrigin) {
    if (state.y < state.scrollTop || state.y > state.scrollBottom)
      throw new Error("Origin-mode cursor is outside scroll margins");
    vt += "\u001b[?6h";
    vt += absolutePosition(Math.min(state.x, cols - 1), state.y - state.scrollTop);
  } else vt += absolutePosition(Math.min(state.x, cols - 1), state.y);
  vt += sgr(currentAttr);
  return vt;
}

type PublicLine = NonNullable<ReturnType<Terminal["buffer"]["normal"]["getLine"]>>;
type PublicCell = NonNullable<ReturnType<PublicLine["getCell"]>>;

export function cellAttr(cell: PublicCell): AttributeState {
  const fgMode = cell.getFgColorMode();
  const bgMode = cell.getBgColorMode();
  return {
    fg: fgMode === 0 ? 0 : fgMode + cell.getFgColor(),
    bg: bgMode === 0 ? 0 : bgMode + cell.getBgColor(),
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    blink: !!cell.isBlink(),
    inverse: !!cell.isInverse(),
    invisible: !!cell.isInvisible(),
    strikethrough: !!cell.isStrikethrough(),
    overline: !!cell.isOverline(),
  };
}

export function sameAttr(left: AttributeState, right: AttributeState): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof AttributeState] === right[key as keyof AttributeState],
  );
}
