import type { ITheme } from "@xterm/xterm";
import { validateAppearance, type Appearance } from "@cove/protocol/profile";
import { domainError } from "@cove/protocol/errors";

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function cssColor(rgb16: string): string {
  const [red, green, blue] = rgb16
    .split("/")
    .map((component) => Math.round(Number.parseInt(component!, 16) / 257));
  return `rgb(${red}, ${green}, ${blue})`;
}

export function xtermTheme(input: Appearance): ITheme {
  const appearance = validateAppearance(input);
  if (!appearance) throw domainError("PROFILE_UNSUPPORTED");
  const theme: ITheme = {};
  if (appearance.foreground) theme.foreground = cssColor(appearance.foreground);
  if (appearance.background) theme.background = cssColor(appearance.background);
  let extended: string[] | undefined;
  for (const entry of appearance.palette) {
    const color = cssColor(entry.rgb);
    if (entry.index < ANSI_NAMES.length) theme[ANSI_NAMES[entry.index]!] = color;
    else {
      extended ??= [];
      extended[entry.index - ANSI_NAMES.length] = color;
    }
  }
  if (extended) theme.extendedAnsi = extended;
  return theme;
}
