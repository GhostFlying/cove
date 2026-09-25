import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  sameRunRef,
  validateTerminalFrame,
  type TerminalMetadata,
} from "@cove/protocol/provisional/terminal";
import { openQueryPage, withManagedBrowser, within, type ProbePage } from "./managed-browser.js";

type Phase = "live" | "baseline" | "replay" | "continued";
type Case = {
  caseId: string;
  setupBytes: number[];
  queryBytes: number[];
  expectedLiveReplies: number[][];
  continuationBytes: number[];
};
type FixtureModule = {
  queryCases: Case[];
  mixedColor: {
    setupBytes: number[];
    queryBytes: number[];
    expectedLiveReplies: number[][];
    expectedPalette: number[];
  };
};
type Entry = { kind: string; bytes?: number[]; phase: Phase; occurrence: number; detail?: string };
type Snapshot = {
  line: string;
  cursorX: number;
  cursorY: number;
  bracketedPaste: boolean;
  applicationCursor: boolean;
  foreground: number[];
  background: number[];
  palette1: number[];
};
type BaselinePart = {
  baselineId: string;
  atSeq: number;
  chunkIndex: number;
  chunkCount: number;
  totalBytes: number;
  payload: number[];
};

const run = { serverId: "q1-server", relayInstanceId: "q1-relay", runId: "q1-run" };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let seq = 0;
let occurrence = 0;
const fixturesUrl = new URL(
  "../../../../../tests/fixtures/terminal/client/query-cases.mjs",
  import.meta.url,
);

function must<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
}

function frame(
  kind: TerminalMetadata["kind"],
  metadata: TerminalMetadata,
  payload: number[],
): number[] {
  if (payload.length > 65_536) throw new Error("Query fixture exceeds 64 KiB");
  const bytes = must(
    encodeTerminalFrame(kind, encoder.encode(JSON.stringify(metadata)), Uint8Array.from(payload)),
    "encode",
  );
  const stream = createTerminalDecoder();
  const first = stream.read(bytes.subarray(0, Math.min(7, bytes.length)));
  const second = stream.read(bytes.subarray(first.consumedBytes));
  if (
    first.status === "error" ||
    second.status === "error" ||
    second.frames.length !== 1 ||
    second.consumedBytes !== bytes.length - first.consumedBytes
  )
    throw new Error("Terminal frame was not completely decoded");
  must(stream.finish(), "finish");
  const decoded = second.frames[0]!;
  const checked = must(
    validateTerminalFrame(decoded, JSON.parse(decoder.decode(decoded.metadata))),
    "validate",
  );
  if (checked.kind !== kind || !sameRunRef(checked.run, run))
    throw new Error("Wrong query fixture kind or run");
  return Array.from(decoded.payload);
}

function output(bytes: number[]): number[] {
  return frame("output", { kind: "output", run, seq: seq++ }, bytes);
}

function assembleBaseline(parts: BaselinePart[]): number[] {
  const first = parts[0];
  if (!first || first.totalBytes > 65_536 || first.chunkCount !== parts.length)
    throw new Error("Incomplete or oversized baseline assembly");
  const received: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (
      part.chunkIndex !== index ||
      part.chunkCount !== first.chunkCount ||
      part.baselineId !== first.baselineId ||
      part.atSeq !== first.atSeq ||
      part.totalBytes !== first.totalBytes
    )
      throw new Error("Duplicate, reordered or mismatched baseline chunk");
    if (received.length + part.payload.length > first.totalBytes)
      throw new Error(`Baseline assembly exceeds declared bytes before chunk ${index}`);
    const decoded = frame(
      "baseline-chunk",
      {
        kind: "baseline-chunk",
        run,
        baselineId: part.baselineId,
        atSeq: part.atSeq,
        chunkIndex: part.chunkIndex,
        chunkCount: part.chunkCount,
        totalBytes: part.totalBytes,
      },
      part.payload,
    );
    if (received.length + decoded.length > first.totalBytes)
      throw new Error(`Baseline assembly exceeds declared bytes before chunk ${index}`);
    received.push(...decoded);
  }
  if (received.length !== first.totalBytes) throw new Error("Incomplete baseline assembly");
  return received;
}

function baseline(bytes: number[]): number[] {
  if (bytes.length > 65_536) throw new Error("Baseline exceeds 64 KiB");
  const chunks: number[][] = [];
  for (let start = 0; start < bytes.length; start += 17)
    chunks.push(bytes.slice(start, start + 17));
  if (!chunks.length) chunks.push([]);
  const parts = chunks.map((payload, chunkIndex) => ({
    baselineId: "q1-baseline",
    atSeq: seq,
    chunkIndex,
    chunkCount: chunks.length,
    totalBytes: bytes.length,
    payload,
  }));
  const received = assembleBaseline(parts);
  if (received.some((byte, index) => byte !== bytes[index]))
    throw new Error("Baseline byte mismatch");
  return received;
}

async function deliver(page: ProbePage, bytes: number[], phase: Phase): Promise<number> {
  const id = ++occurrence;
  const delivered = phase === "baseline" ? baseline(bytes) : output(bytes);
  await page.evaluate<void>(
    `window.coveQuery.deliver(${JSON.stringify(delivered)},${JSON.stringify(phase)},${id})`,
  );
  return id;
}

function pendingDeliver(
  page: ProbePage,
  bytes: number[],
  phase: Phase,
): { id: number; done: Promise<void> } {
  const id = ++occurrence;
  const delivered = output(bytes);
  return {
    id,
    done: page.evaluate<void>(
      `window.coveQuery.deliver(${JSON.stringify(delivered)},${JSON.stringify(phase)},${id})`,
    ),
  };
}

async function inspect(
  page: ProbePage,
): Promise<{ entries: Entry[]; outbound: number[][]; writeDone: number[]; snapshot: Snapshot }> {
  return page.evaluate(
    "({ entries: window.coveQuery.entries, outbound: window.coveQuery.outbound, writeDone: window.coveQuery.writeDone, snapshot: window.coveQuery.snapshot() })",
  );
}

function flat(chunks: number[][]): number[] {
  return chunks.flat();
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `${label}: actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
}
function requireHook(observation: Awaited<ReturnType<typeof inspect>>, id: number): void {
  if (!observation.entries.some((entry) => entry.kind === "query-hook" && entry.occurrence === id))
    throw new Error(`Query hook absent for occurrence ${id}`);
  if (!observation.writeDone.includes(id))
    throw new Error(`Write callback absent for occurrence ${id}`);
}
function verifiedInput(
  observation: Awaited<ReturnType<typeof inspect>>,
  expected: number[],
  label: string,
): void {
  const actual = flat(observation.outbound);
  equal(actual, expected, label);
  for (const bytes of observation.outbound)
    frame("input", { kind: "input", run, requestId: `input-${++occurrence}` }, bytes);
}

async function queryOnly(
  reference: ProbePage,
  adapted: ProbePage,
  fixtures: FixtureModule,
): Promise<unknown> {
  const observations: {
    caseId: string;
    phase: Phase;
    expected: number[];
    reference: number[];
    adapted: number[];
  }[] = [];
  for (const phase of ["live", "baseline", "replay"] as const) {
    if (phase === "baseline") {
      for (const [page, adapter] of [
        [reference, "reference"],
        [adapted, "private"],
      ] as const) {
        const origin = await page.evaluate<string>("location.origin");
        await page.goto(`${origin}/?fixture=query-input&adapter=${adapter}`, {
          waitUntil: "networkidle",
          timeout: 5_000,
        });
        await page.waitForFunction("window.coveQuery?.ready === true", null, { timeout: 3_000 });
      }
    }
    for (const item of fixtures.queryCases) {
      for (const page of [reference, adapted]) {
        if (item.setupBytes.length) await deliver(page, item.setupBytes, phase);
      }
      const referenceBefore = flat((await inspect(reference)).outbound).length;
      const adaptedBefore = flat((await inspect(adapted)).outbound).length;
      const referenceId = await deliver(reference, item.queryBytes, phase);
      const adaptedId = await deliver(adapted, item.queryBytes, phase);
      const referenceState = await inspect(reference);
      const adaptedState = await inspect(adapted);
      const expected = flat(item.expectedLiveReplies);
      const referenceBytes = flat(referenceState.outbound).slice(referenceBefore);
      const adaptedBytes = flat(adaptedState.outbound).slice(adaptedBefore);
      equal(referenceBytes, expected, `${phase}/${item.caseId} reference reply`);
      equal(adaptedBytes, [], `${phase}/${item.caseId} adapted output`);
      requireHook(referenceState, referenceId);
      requireHook(adaptedState, adaptedId);
      const beforeContinuation = adaptedState.snapshot;
      await deliver(reference, item.continuationBytes, "continued");
      await deliver(adapted, item.continuationBytes, "continued");
      const referenceAfter = (await inspect(reference)).snapshot;
      const adaptedAfter = (await inspect(adapted)).snapshot;
      equal(adaptedAfter, referenceAfter, `${phase}/${item.caseId} continued display and modes`);
      if (beforeContinuation.cursorX < 39) {
        const cell = await adapted.evaluate<string>(
          `window.coveQuery.readCell(${beforeContinuation.cursorX},${beforeContinuation.cursorY})`,
        );
        equal(
          cell,
          decoder.decode(Uint8Array.from(item.continuationBytes)),
          `${phase}/${item.caseId} continuation cell`,
        );
      }
      observations.push({
        caseId: item.caseId,
        phase,
        expected,
        reference: referenceBytes,
        adapted: adaptedBytes,
      });
    }
  }
  const allQueries = fixtures.queryCases.flatMap((item) => [
    ...item.setupBytes,
    ...item.queryBytes,
  ]);
  const expectedBatch = flat(fixtures.queryCases.flatMap((item) => item.expectedLiveReplies));
  const marker = Array.from(encoder.encode("\x1b]777;hold\x07"));
  const barriers: { reference: number[]; adapted: number[]; expected: number[] } = {
    reference: [],
    adapted: [],
    expected: [
      ...expectedBatch,
      ...expectedBatch,
      ...fixtures.queryCases.find((item) => item.caseId === "da-secondary")!
        .expectedLiveReplies[0]!,
    ],
  };
  for (const [page, role] of [
    [reference, "reference"],
    [adapted, "adapted"],
  ] as const) {
    const before = flat((await inspect(page)).outbound).length;
    const held = pendingDeliver(page, [...allQueries, ...marker, ...allQueries], "replay");
    await page.waitForFunction(
      "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
      null,
      { timeout: 3_000 },
    );
    const queued = pendingDeliver(page, Array.from(encoder.encode("\x1b[>c")), "live");
    await page.evaluate<void>("window.coveQuery.releaseBarrier()");
    await held.done;
    await queued.done;
    const state = await inspect(page);
    if (!state.writeDone.includes(held.id) || !state.writeDone.includes(queued.id))
      throw new Error("Queued query write callback absent");
    barriers[role] = flat(state.outbound).slice(before);
  }
  equal(barriers.reference, barriers.expected, "queued reference replies");
  equal(barriers.adapted, [], "queued adapted replies");
  verifiedInput(await inspect(adapted), [], "adapted query-only stream");
  return { cases: observations, barriers };
}

async function keyboard(page: ProbePage): Promise<unknown> {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowUp");
  const held = pendingDeliver(
    page,
    Array.from(encoder.encode("\x1b[5n\x1b]777;hold\x07\x1b[6n")),
    "live",
  );
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  await page.keyboard.type("b");
  await page.keyboard.press("Control+C");
  const queued = pendingDeliver(page, Array.from(encoder.encode("\x1b[>c")), "live");
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await held.done;
  await queued.done;
  await deliver(page, Array.from(encoder.encode("\x1b[?1h")), "live");
  await page.keyboard.press("ArrowUp");
  verifiedInput(
    await inspect(page),
    Array.from(encoder.encode("a\r\x7f\x1b[Ab\x03\x1bOA")),
    "keyboard bytes",
  );
  return inspect(page);
}

async function paste(page: ProbePage, fixtures: FixtureModule): Promise<unknown> {
  const sendPaste = (value: string) =>
    page.evaluate<void>(
      `(() => { const transfer = new DataTransfer(); transfer.setData('text/plain', ${JSON.stringify(value)}); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }); document.querySelector('.xterm-helper-textarea').dispatchEvent(event); })()`,
    );
  const reply = new TextDecoder().decode(
    Uint8Array.from(fixtures.queryCases[0]!.expectedLiveReplies[0]!),
  );
  const replyValues = fixtures.queryCases
    .flatMap((item) => item.expectedLiveReplies)
    .map((bytes) => decoder.decode(Uint8Array.from(bytes)));
  const concatenated = replyValues.join("");
  await sendPaste(`é\n中${reply}`);
  for (const value of replyValues) await sendPaste(value);
  await deliver(page, Array.from(encoder.encode("\x1b[?2004h")), "live");
  const held = pendingDeliver(page, Array.from(encoder.encode("\x1b]777;hold\x07\x1b[5n")), "live");
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  await sendPaste(`prefix\x1b[?${concatenated}suffix`);
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await held.done;
  await deliver(page, Array.from(encoder.encode("\x1b[?2004l")), "live");
  await sendPaste("x\r\ny\n");
  const expected = encoder.encode(
    `é\r中${reply}${concatenated}\x1b[200~prefix\x1b[?${concatenated}suffix\x1b[201~x\ry\r`,
  );
  verifiedInput(await inspect(page), Array.from(expected), "paste bytes");
  return { expected: Array.from(expected), actual: flat((await inspect(page)).outbound) };
}

async function mouse(page: ProbePage): Promise<unknown> {
  const box = await page.locator(".xterm-screen").boundingBox();
  if (!box) throw new Error("Mouse target geometry absent");
  const x = box.x + box.width * (99.5 / 160);
  const y = box.y + box.height * (3.5 / 10);
  await page.mouse.click(x, y);
  equal(flat((await inspect(page)).outbound), [], "mouse mode-off control before tracking");
  await deliver(page, Array.from(encoder.encode("\x1b[?1000h\x1b[?1006h")), "live");
  const firstHeld = pendingDeliver(
    page,
    Array.from(encoder.encode("\x1b[5n\x1b]777;hold\x07\x1b[6n")),
    "live",
  );
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  await page.mouse.click(x, y);
  await page.mouse.wheel(0, -120);
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await firstHeld.done;
  const state = await inspect(page);
  const sgr = state.outbound;
  const expectedSgr = [
    Array.from(encoder.encode("\x1b[<0;100;4M")),
    Array.from(encoder.encode("\x1b[<0;100;4m")),
    Array.from(encoder.encode("\x1b[<64;100;4M")),
  ];
  equal(sgr, expectedSgr, "SGR mouse bytes");
  await deliver(page, Array.from(encoder.encode("\x1b[?1049h")), "live");
  const secondHeld = pendingDeliver(
    page,
    Array.from(encoder.encode("\x1b]777;hold\x07\x1b[5n")),
    "replay",
  );
  await page.waitForFunction(
    `window.coveQuery.entries.filter(e => e.kind === 'barrier-enter').length >= 2`,
    null,
    { timeout: 3_000 },
  );
  await page.mouse.click(x, y);
  await page.mouse.wheel(0, -120);
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await secondHeld.done;
  const alternate = (await inspect(page)).outbound.slice(sgr.length);
  equal(alternate, expectedSgr, "alternate-buffer SGR mouse bytes");
  await deliver(page, Array.from(encoder.encode("\x1b[?1049l")), "live");
  await deliver(page, Array.from(encoder.encode("\x1b[?1006l")), "live");
  const thirdHeld = pendingDeliver(
    page,
    Array.from(encoder.encode("\x1b]777;hold\x07\x1b[5n")),
    "live",
  );
  await page.waitForFunction(
    `window.coveQuery.entries.filter(e => e.kind === 'barrier-enter').length >= 3`,
    null,
    { timeout: 3_000 },
  );
  await page.mouse.click(x, y);
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await thirdHeld.done;
  const legacy = await inspect(page);
  const legacyBytes = legacy.outbound.slice(sgr.length + alternate.length);
  equal(
    legacyBytes,
    [
      [27, 91, 77, 32, 132, 36],
      [27, 91, 77, 35, 132, 36],
    ],
    "legacy binary mouse bytes",
  );
  if (legacy.entries.filter((entry) => entry.kind === "onBinary").length !== 2)
    throw new Error("Legacy mouse did not use exactly two binary events");
  await deliver(page, Array.from(encoder.encode("\x1b[?1000l")), "live");
  const before = flat(legacy.outbound);
  await page.mouse.click(x, y);
  equal(flat((await inspect(page)).outbound), before, "mode-off mouse control");
  verifiedInput(
    await inspect(page),
    flat([...expectedSgr, ...expectedSgr, ...legacyBytes]),
    "complete mouse stream",
  );
  return { sgr, alternate, legacy: legacyBytes };
}

async function splitMixed(
  page: ProbePage,
  publicPage: ProbePage,
  fixtures: FixtureModule,
): Promise<unknown> {
  await deliver(page, Array.from(encoder.encode("A")), "live");
  for (const character of ["é", "€", "😀"]) {
    const utf8 = Array.from(encoder.encode(character));
    for (const byte of utf8) await deliver(page, [byte], "live");
  }
  await deliver(page, Array.from(encoder.encode("Z")), "live");
  const unicodeLine = (await inspect(page)).snapshot.line;
  equal(unicodeLine, "Aé€😀Z", "split UTF-8 surrounding text");
  const cuts: Record<string, number> = {};
  for (const item of fixtures.queryCases) {
    if (item.setupBytes.length) await deliver(page, item.setupBytes, "live");
    for (let cut = 1; cut < item.queryBytes.length; cut++) {
      const beforeHooks = (await inspect(page)).entries.filter(
        (entry) => entry.kind === "query-hook",
      ).length;
      await deliver(page, item.queryBytes.slice(0, cut), "live");
      await deliver(page, item.queryBytes.slice(cut), "live");
      const afterHooks = (await inspect(page)).entries.filter(
        (entry) => entry.kind === "query-hook",
      ).length;
      if (afterHooks !== beforeHooks + 1)
        throw new Error(`Split ${item.caseId} cut ${cut} did not finish once`);
    }
    cuts[item.caseId] = item.queryBytes.length - 1;
  }
  await deliver(page, fixtures.mixedColor.setupBytes, "live");
  await deliver(publicPage, fixtures.mixedColor.setupBytes, "live");
  const originalPublic = (await inspect(publicPage)).snapshot.palette1;
  const held = pendingDeliver(
    page,
    [...fixtures.mixedColor.queryBytes, ...Array.from(encoder.encode("\x1b]777;hold\x07"))],
    "replay",
  );
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  equal(
    (await inspect(page)).snapshot.palette1,
    fixtures.mixedColor.expectedPalette,
    "mixed OSC setter before barrier release",
  );
  await deliver(publicPage, fixtures.mixedColor.queryBytes, "live");
  const publicState = await inspect(publicPage);
  equal(publicState.snapshot.palette1, originalPublic, "public hook counterexample");
  const reset = pendingDeliver(page, Array.from(encoder.encode("\x1b]104;1\x1b\\")), "continued");
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await held.done;
  await reset.done;
  const privateState = await inspect(page);
  equal(privateState.snapshot.palette1, [1, 2, 3], "mixed OSC reset state");
  verifiedInput(privateState, [], "split/mixed query stream");
  const origin = await publicPage.evaluate<string>("location.origin");
  await publicPage.goto(`${origin}/?fixture=query-input&adapter=reference`, {
    waitUntil: "networkidle",
    timeout: 5_000,
  });
  await publicPage.waitForFunction("window.coveQuery?.ready === true", null, { timeout: 3_000 });
  await deliver(publicPage, fixtures.mixedColor.setupBytes, "live");
  await deliver(publicPage, fixtures.mixedColor.queryBytes, "live");
  equal(
    flat((await inspect(publicPage)).outbound),
    flat(fixtures.mixedColor.expectedLiveReplies),
    "unadapted mixed OSC reply",
  );
  return {
    publicCounterexample: { before: originalPublic, after: publicState.snapshot.palette1 },
    privatePalette: fixtures.mixedColor.expectedPalette,
    resetPalette: privateState.snapshot.palette1,
    cuts,
    line: unicodeLine,
  };
}

async function lifetime(
  page: ProbePage,
  context: Parameters<typeof openQueryPage>[0],
): Promise<unknown> {
  const conformance = await page.evaluate<{
    duplicateRejected: boolean;
    wrongVersionRejected: boolean;
    missingSurfaceRejected: boolean;
    oldWrapperDetached: boolean;
    nestedBytes: string[];
  }>("window.coveQuery.conformance()");
  if (
    !conformance.duplicateRejected ||
    !conformance.wrongVersionRejected ||
    !conformance.missingSurfaceRejected ||
    !conformance.oldWrapperDetached
  )
    throw new Error(`Adapter conformance failed: ${JSON.stringify(conformance)}`);
  equal(conformance.nestedBytes, ["x", "y", "z"], "nested callback and reattach bytes");
  const held = pendingDeliver(
    page,
    Array.from(encoder.encode("\x1b]777;hold\x07\x1b[5n")),
    "replay",
  );
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  await page.evaluate<void>("window.coveQuery.dispose()");
  await held.done;
  const state = await page.evaluate<{ outbound: number[][]; writeDone: number[] }>(
    "({ outbound: window.coveQuery.outbound, writeDone: window.coveQuery.writeDone })",
  );
  if (flat(state.outbound).length) throw new Error("Disposed fixture emitted outbound input");
  const replacement = await openQueryPage(context, "private");
  await replacement.locator(".xterm-helper-textarea").focus();
  await replacement.keyboard.type("r");
  await deliver(replacement, Array.from(encoder.encode("\x1b[5n")), "continued");
  verifiedInput(await inspect(replacement), [114], "replacement input generation");
  equal(flat(state.outbound), [], "old generation after replacement");
  return {
    conformance,
    oldOutbound: state.outbound,
    oldWriteDone: state.writeDone,
    replacementOutbound: (await inspect(replacement)).outbound,
  };
}

async function focus(page: ProbePage): Promise<unknown> {
  await deliver(page, Array.from(encoder.encode("\x1b[?1004h")), "live");
  const before = (await inspect(page)).entries.filter(
    (entry) => entry.kind === "automatic-data",
  ).length;
  await page.locator(".xterm-helper-textarea").focus();
  await page.mouse.click(1, 1);
  const state = await inspect(page);
  const automatic = state.entries
    .filter((entry) => entry.kind === "automatic-data")
    .slice(before)
    .map((entry) => entry.bytes);
  equal(
    automatic,
    [Array.from(encoder.encode("\x1b[I")), Array.from(encoder.encode("\x1b[O"))],
    "focus reports are separate automatic events",
  );
  verifiedInput(state, [], "focus report policy");
  if (state.entries.some((entry) => entry.kind === "query-hook"))
    throw new Error("Focus report was mislabeled as a query hook");
  return { automatic, outbound: state.outbound };
}

async function transportRejection(page: ProbePage): Promise<unknown> {
  const rejected: string[] = [];
  const expectReject = (label: string, action: () => unknown, message?: RegExp) => {
    let failure: unknown;
    try {
      action();
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) throw new Error(`Malformed delivery was accepted: ${label}`);
    if (message && !message.test(failure.message))
      throw new Error(`Wrong rejection for ${label}: ${failure.message}`);
    rejected.push(label);
  };
  for (const key of ["serverId", "relayInstanceId", "runId"] as const) {
    expectReject(`wrong-${key}`, () =>
      frame("output", { kind: "output", run: { ...run, [key]: `wrong-${key}` }, seq: 1 }, [65]),
    );
  }
  const first: BaselinePart = {
    baselineId: "base",
    atSeq: 4,
    chunkIndex: 0,
    chunkCount: 2,
    totalBytes: 2,
    payload: [65],
  };
  const second: BaselinePart = { ...first, chunkIndex: 1, payload: [66] };
  equal(assembleBaseline([first, second]), [65, 66], "valid baseline assembly control");
  expectReject("missing-chunk", () => assembleBaseline([first]));
  expectReject("duplicate-chunk", () => assembleBaseline([first, first]));
  expectReject("reordered-chunk", () => assembleBaseline([second, first]));
  expectReject("wrong-baseline-id", () =>
    assembleBaseline([first, { ...second, baselineId: "other" }]),
  );
  expectReject("wrong-at-seq", () => assembleBaseline([first, { ...second, atSeq: 5 }]));
  expectReject("wrong-total", () => assembleBaseline([first, { ...second, totalBytes: 3 }]));
  expectReject("oversized-baseline", () =>
    assembleBaseline([{ ...first, chunkCount: 1, totalBytes: 65_537, payload: [] }]),
  );
  expectReject(
    "overfull-declared-baseline",
    () =>
      assembleBaseline([
        { ...first, totalBytes: 3, payload: [65, 66] },
        { ...second, totalBytes: 3, payload: [67, 68] },
      ]),
    /before chunk 1/,
  );
  expectReject(
    "overfull-maximum-baseline",
    () =>
      assembleBaseline([
        { ...first, totalBytes: 65_536, payload: Array(65_535).fill(65) },
        { ...second, totalBytes: 65_536, payload: Array(65_535).fill(66) },
      ]),
    /before chunk 1/,
  );
  expectReject("oversized-output", () => output(Array(65_537).fill(65)));
  expectReject("fatal-utf8", () => decoder.decode(Uint8Array.of(0xff)));
  const state = await inspect(page);
  equal(state.writeDone, [], "rejected delivery callbacks");
  verifiedInput(state, [], "rejected delivery outbound");
  equal(state.snapshot.line, "", "rejected delivery buffer");
  return { rejected, delivered: state.writeDone.length };
}

export async function runQueryInputProbe(scenario: string): Promise<unknown> {
  const fixture = (await import(fixturesUrl.href)) as FixtureModule;
  const installed = JSON.parse(
    await readFile(
      new URL("../../../node_modules/@xterm/xterm/package.json", import.meta.url),
      "utf8",
    ),
  ) as { version?: string };
  if (installed.version !== "6.0.0")
    throw new Error(`Unsupported installed xterm: ${installed.version}`);
  const result = await withManagedBrowser(async (context) => {
    const adapted = await openQueryPage(context, "private", scenario === "mouse" ? 160 : 40);
    let value: unknown;
    if (scenario === "queries") {
      const reference = await openQueryPage(context, "reference");
      value = await queryOnly(reference, adapted, fixture);
    } else if (scenario === "keyboard") value = await keyboard(adapted);
    else if (scenario === "paste") value = await paste(adapted, fixture);
    else if (scenario === "mouse") value = await mouse(adapted);
    else if (scenario === "split-mixed") {
      const publicPage = await openQueryPage(context, "public");
      value = await splitMixed(adapted, publicPage, fixture);
    } else if (scenario === "lifetime") value = await lifetime(adapted, context);
    else if (scenario === "focus") value = await focus(adapted);
    else if (scenario === "transport-rejection") value = await transportRejection(adapted);
    else if (scenario === "late-page-error") {
      const observed = new Promise<void>((resolveError) =>
        adapted.on("pageerror", () => resolveError()),
      );
      await adapted.evaluate<void>(
        "setTimeout(() => { throw new Error('Injected late page error'); }, 0)",
      );
      await within(observed, context.remaining(2_000, "late page error"), "late page error");
      value = { injected: true };
    } else if (scenario === "unicode-result-limit") value = { detail: "é".repeat(140_000) };
    else if (scenario === "held-timeout") {
      const held = pendingDeliver(adapted, Array.from(encoder.encode("\x1b]777;hold\x07")), "live");
      await adapted.waitForFunction(
        "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
        null,
        { timeout: 3_000 },
      );
      await within(held.done, 250, "Intentional held parser");
      throw new Error("Held parser unexpectedly completed");
    } else throw new Error(`Unknown Q1 scenario: ${scenario}`);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024)
      throw new Error("Query result exceeds 256 KiB");
    return value;
  });
  return { scenario, browser: result.context, evidence: result.value };
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runQueryInputProbe(process.argv[2] ?? "queries")
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
