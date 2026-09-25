const encoder = new TextEncoder();

export const bytes = (value) => encoder.encode(value);
export const hex = (value) => Buffer.from(value).toString("hex");

export const dimensions = Object.freeze({ cols: 12, rows: 4, scrollback: 10 });

export const savedState = {
  caseId: "R1-saved-state",
  ...dimensions,
  setupBytes: bytes("\u001b[2;3H\u001b[31m\u001b7\u001b[4;9H\u001b[34m"),
  tailBytes: bytes(""),
  continuationBytes: bytes("\u001b8X"),
};

export const bothBuffers = {
  caseId: "R3-both-buffers",
  ...dimensions,
  setupBytes: bytes(
    "NORMAL\u001b[2;3H\u001b[31m\u001b7\u001b[?47hALT\u001b[3;5H\u001b[32m\u001b7\u001b[4;9H\u001b[34m",
  ),
  tailBytes: bytes(""),
  continuationBytes: bytes("\u001b8X\u001b[?47l\u001b8Y"),
};

export const queryBytes = Object.freeze({
  "dsr-status": bytes("\u001b[5n"),
  cpr: bytes("\u001b[6n"),
  "dec-cpr": bytes("\u001b[?6n"),
  "da-primary": bytes("\u001b[c"),
  "da-secondary": bytes("\u001b[>c"),
  "mode-report": bytes("\u001b[?2004$p"),
  "color-fg": bytes("\u001b]10;?\u0007"),
  "color-bg": bytes("\u001b]11;?\u0007"),
  "color-palette": bytes("\u001b]4;1;?\u0007"),
});

export const expectedLiveReplies = Object.freeze({
  "dsr-status": bytes("\u001b[0n"),
  cpr: bytes("\u001b[1;1R"),
  "dec-cpr": bytes("\u001b[?1;1R"),
  "da-primary": bytes("\u001b[?1;2c"),
  "da-secondary": bytes("\u001b[>0;276;0c"),
  "mode-report": bytes("\u001b[?2004;2$y"),
  "color-fg": bytes("\u001b]10;rgb:ffff/ffff/ffff\u001b\\"),
  "color-bg": bytes("\u001b]11;rgb:0000/0000/0000\u001b\\"),
  "color-palette": bytes("\u001b]4;1;rgb:cccc/0000/0000\u001b\\"),
});

export const appearance = Object.freeze({
  foreground: "ffff/ffff/ffff",
  background: "0000/0000/0000",
  palette1: "cccc/0000/0000",
});

export const parserSequences = Object.freeze([
  ["utf8-2", bytes("\u00a2")],
  ["utf8-3", bytes("\u4e2d")],
  ["utf8-4", bytes("\ud83d\ude00")],
  ["csi-parameters", bytes("\u001b[12;3H")],
  ["csi-intermediates", bytes("\u001b[?2004$p")],
  ["osc-bel", bytes("\u001b]2;T\u0007")],
  ["osc-st", bytes("\u001b]2;T\u001b\\")],
  ["dcs-status", bytes("\u001bP$qm\u001b\\")],
  ["esc-esc", bytes("\u001b\u001b[2C")],
  ["esc-can", bytes("\u001b\u0018X")],
  ["esc-sub", bytes("\u001b\u001aX")],
  ["osc-can", bytes("\u001b]2;T\u0018X")],
  ["osc-sub", bytes("\u001b]2;T\u001aX")],
  ["dcs-can", bytes("\u001bP$qm\u0018X")],
  ["dcs-sub", bytes("\u001bP$qm\u001aX")],
]);
