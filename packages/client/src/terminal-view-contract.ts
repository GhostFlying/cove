import type { TerminalView } from "@cove/protocol/view";

const VIEW_PORTS = [
  "initialize",
  "beginBaseline",
  "writeBaselineChunk",
  "finishBaseline",
  "applyEvent",
  "measureGrid",
  "setAppearance",
  "setVisibility",
  "onInputIntent",
  "onFocusIntent",
  "onFailure",
  "dispose",
] as const;

export function completeTerminalView(value: unknown): value is TerminalView {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return VIEW_PORTS.every(
      (port) => typeof (value as Record<string, unknown>)[port] === "function",
    );
  } catch {
    return false;
  }
}
