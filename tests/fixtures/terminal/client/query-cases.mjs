const bytes = (value) => Array.from(new TextEncoder().encode(value));

// These reply oracles are authored from the pinned xterm 6.0.0 handlers, never read from the adapted sink.
export const queryCases = [
  {
    caseId: "dsr-status",
    setupBytes: bytes(""),
    queryBytes: bytes("\x1b[5n"),
    expectedLiveReplies: [bytes("\x1b[0n")],
    continuationBytes: bytes("A"),
  },
  {
    caseId: "cpr",
    setupBytes: bytes("\x1b[3;4H"),
    queryBytes: bytes("\x1b[6n"),
    expectedLiveReplies: [bytes("\x1b[3;4R")],
    continuationBytes: bytes("B"),
  },
  {
    caseId: "dec-cpr",
    setupBytes: bytes("\x1b[3;4H"),
    queryBytes: bytes("\x1b[?6n"),
    expectedLiveReplies: [bytes("\x1b[?3;4R")],
    continuationBytes: bytes("C"),
  },
  {
    caseId: "da-primary",
    setupBytes: bytes(""),
    queryBytes: bytes("\x1b[c"),
    expectedLiveReplies: [bytes("\x1b[?1;2c")],
    continuationBytes: bytes("D"),
  },
  {
    caseId: "da-secondary",
    setupBytes: bytes(""),
    queryBytes: bytes("\x1b[>c"),
    expectedLiveReplies: [bytes("\x1b[>0;276;0c")],
    continuationBytes: bytes("E"),
  },
  {
    caseId: "mode-report",
    setupBytes: bytes("\x1b[?2004h"),
    queryBytes: bytes("\x1b[?2004$p"),
    expectedLiveReplies: [bytes("\x1b[?2004;1$y")],
    continuationBytes: bytes("F"),
  },
  {
    caseId: "mode-report-reset",
    setupBytes: bytes("\x1b[?2004l"),
    queryBytes: bytes("\x1b[?2004$p"),
    expectedLiveReplies: [bytes("\x1b[?2004;2$y")],
    continuationBytes: bytes("L"),
  },
  {
    caseId: "color-fg",
    setupBytes: bytes("\x1b]10;#112233\x07"),
    queryBytes: bytes("\x1b]10;?\x07"),
    expectedLiveReplies: [bytes("\x1b]10;rgb:1111/2222/3333\x1b\\")],
    continuationBytes: bytes("G"),
  },
  {
    caseId: "color-bg",
    setupBytes: bytes("\x1b]11;#445566\x1b\\"),
    queryBytes: bytes("\x1b]11;?\x1b\\"),
    expectedLiveReplies: [bytes("\x1b]11;rgb:4444/5555/6666\x1b\\")],
    continuationBytes: bytes("H"),
  },
  {
    caseId: "color-palette",
    setupBytes: bytes("\x1b]4;1;#778899\x07"),
    queryBytes: bytes("\x1b]4;1;?\x07"),
    expectedLiveReplies: [bytes("\x1b]4;1;rgb:7777/8888/9999\x1b\\")],
    continuationBytes: bytes("I"),
  },
  {
    caseId: "color-cursor",
    setupBytes: bytes("\x1b]12;#a1b2c3\x07"),
    queryBytes: bytes("\x1b]12;?\x1b\\"),
    expectedLiveReplies: [bytes("\x1b]12;rgb:a1a1/b2b2/c3c3\x1b\\")],
    continuationBytes: bytes("N"),
  },
  {
    caseId: "dcs-status",
    setupBytes: bytes(""),
    queryBytes: bytes("\x1bP$qm\x1b\\"),
    expectedLiveReplies: [bytes("\x1bP1$r0m\x1b\\")],
    continuationBytes: bytes("J"),
  },
  {
    caseId: "dcs-margins",
    setupBytes: bytes("\x1b[2;8r"),
    queryBytes: bytes("\x1bP$qr\x1b\\"),
    expectedLiveReplies: [bytes("\x1bP1$r2;8r\x1b\\")],
    continuationBytes: bytes("M"),
  },
  {
    caseId: "window-report",
    setupBytes: bytes(""),
    queryBytes: bytes("\x1b[18t"),
    expectedLiveReplies: [bytes("\x1b[8;10;40t")],
    continuationBytes: bytes("K"),
  },
];

export const mixedColor = {
  setupBytes: bytes("\x1b]4;1;#010203\x07"),
  queryBytes: bytes("\x1b]4;1;#aabbcc;1;?\x1b\\"),
  expectedLiveReplies: [bytes("\x1b]4;1;rgb:aaaa/bbbb/cccc\x1b\\")],
  expectedPalette: [170, 187, 204],
};
