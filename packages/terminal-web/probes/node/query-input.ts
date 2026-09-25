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

function baseline(bytes: number[]): number[] {
  if (bytes.length > 65_536) throw new Error("Baseline exceeds 64 KiB");
  const chunks: number[][] = [];
  for (let start = 0; start < bytes.length; start += 17)
    chunks.push(bytes.slice(start, start + 17));
  if (!chunks.length) chunks.push([]);
  const received: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    received.push(
      ...frame(
        "baseline-chunk",
        {
          kind: "baseline-chunk",
          run,
          baselineId: "q1-baseline",
          atSeq: seq,
          chunkIndex: index,
          chunkCount: chunks.length,
          totalBytes: bytes.length,
        },
        chunk,
      ),
    );
  }
  if (received.length !== bytes.length || received.some((byte, index) => byte !== bytes[index]))
    throw new Error("Incomplete baseline assembly");
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
      await deliver(reference, item.continuationBytes, "continued");
      await deliver(adapted, item.continuationBytes, "continued");
      observations.push({
        caseId: item.caseId,
        phase,
        expected,
        reference: referenceBytes,
        adapted: adaptedBytes,
      });
    }
  }
  verifiedInput(await inspect(adapted), [], "adapted query-only stream");
  return observations;
}

async function keyboard(page: ProbePage): Promise<unknown> {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowUp");
  const held = pendingDeliver(page, Array.from(encoder.encode("\x1b]777;hold\x07\x1b[5n")), "live");
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  await page.keyboard.type("b");
  await page.keyboard.press("Control+C");
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await held.done;
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
  const concatenated = fixtures.queryCases
    .flatMap((item) => item.expectedLiveReplies)
    .map((bytes) => decoder.decode(Uint8Array.from(bytes)))
    .join("");
  await sendPaste(`é\n中${reply}`);
  await deliver(page, Array.from(encoder.encode("\x1b[?2004h")), "live");
  const held = pendingDeliver(page, Array.from(encoder.encode("\x1b]777;hold\x07\x1b[5n")), "live");
  await page.waitForFunction(
    "window.coveQuery.entries.some(e => e.kind === 'barrier-enter')",
    null,
    { timeout: 3_000 },
  );
  await sendPaste(concatenated);
  await page.evaluate<void>("window.coveQuery.releaseBarrier()");
  await held.done;
  await deliver(page, Array.from(encoder.encode("\x1b[?2004l")), "live");
  await sendPaste("x\r\ny\n");
  const expected = encoder.encode(`é\r中${reply}\x1b[200~${concatenated}\x1b[201~x\ry\r`);
  verifiedInput(await inspect(page), Array.from(expected), "paste bytes");
  return { expected: Array.from(expected), actual: flat((await inspect(page)).outbound) };
}

async function mouse(page: ProbePage): Promise<unknown> {
  await deliver(page, Array.from(encoder.encode("\x1b[?1000h\x1b[?1006h")), "live");
  const box = await page.locator(".xterm-screen").boundingBox();
  if (!box) throw new Error("Mouse target geometry absent");
  const x = box.x + box.width * (1.5 / 160);
  const y = box.y + box.height * (1.5 / 10);
  await page.mouse.click(x, y);
  const state = await inspect(page);
  if (!state.outbound.length) throw new Error("SGR mouse produced no input");
  await deliver(page, Array.from(encoder.encode("\x1b[?1006l")), "live");
  const highX = box.x + box.width * (99.5 / 160);
  await page.mouse.click(highX, y);
  const legacy = await inspect(page);
  if (
    !legacy.entries.some(
      (entry) => entry.kind === "onBinary" && (entry.bytes ?? []).some((byte) => byte > 127),
    )
  )
    throw new Error("Legacy binary mouse did not preserve a high byte");
  await deliver(page, Array.from(encoder.encode("\x1b[?1000l")), "live");
  const before = flat(legacy.outbound);
  await page.mouse.click(x, y);
  equal(flat((await inspect(page)).outbound), before, "mode-off mouse control");
  return { sgr: state.outbound, legacy: legacy.outbound.slice(state.outbound.length) };
}

async function splitMixed(
  page: ProbePage,
  publicPage: ProbePage,
  fixtures: FixtureModule,
): Promise<unknown> {
  const short = Array.from(encoder.encode("\x1b[5n"));
  for (let cut = 1; cut < short.length; cut++) {
    await deliver(page, short.slice(0, cut), "live");
    await deliver(page, short.slice(cut), "live");
  }
  const utf8 = Array.from(encoder.encode("é"));
  await deliver(page, utf8.slice(0, 1), "live");
  await deliver(page, utf8.slice(1), "live");
  await deliver(page, fixtures.mixedColor.setupBytes, "live");
  await deliver(publicPage, fixtures.mixedColor.setupBytes, "live");
  const originalPublic = (await inspect(publicPage)).snapshot.palette1;
  await deliver(page, fixtures.mixedColor.queryBytes, "live");
  await deliver(publicPage, fixtures.mixedColor.queryBytes, "live");
  const privateState = await inspect(page);
  const publicState = await inspect(publicPage);
  equal(
    privateState.snapshot.palette1,
    fixtures.mixedColor.expectedPalette,
    "mixed OSC setter state",
  );
  equal(publicState.snapshot.palette1, originalPublic, "public hook counterexample");
  verifiedInput(privateState, [], "split/mixed query stream");
  return {
    publicCounterexample: { before: originalPublic, after: publicState.snapshot.palette1 },
    privatePalette: privateState.snapshot.palette1,
    line: privateState.snapshot.line,
  };
}

async function lifetime(page: ProbePage): Promise<unknown> {
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
  const state = await inspect(page).catch(() => null);
  if (state && flat(state.outbound).length)
    throw new Error("Disposed fixture emitted outbound input");
  return { oldOutbound: state?.outbound ?? [], oldWriteDone: state?.writeDone ?? [] };
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
    } else if (scenario === "lifetime") value = await lifetime(adapted);
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
    const encoded = JSON.stringify(value);
    if (encoded.length > 256 * 1024) throw new Error("Query result exceeds 256 KiB");
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
