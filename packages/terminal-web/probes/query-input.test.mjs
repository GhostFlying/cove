import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = fileURLToPath(import.meta.resolve("@cove/terminal-web/probes/query-input"));
const root = resolve(import.meta.dirname, "../../..");

async function run(scenario) {
  const result = spawnSync(process.execPath, [entry, scenario], {
    cwd: root,
    encoding: "utf8",
    timeout: 40_000,
    maxBuffer: 512 * 1024,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0)
    throw new Error(result.stderr || `Q1 ${scenario} exited ${result.status}`);
  const record = JSON.parse(result.stdout.trim());
  expect(record.scenario).toBe(scenario);
  expect(record.browser.browserVersion).toBe("153.0.8010.12");
  expect(record.browser.browserRevision).toBe("1243");
  await expect(fetch(`http://127.0.0.1:${record.browser.listenerPort}/`)).rejects.toThrow(
    /fetch failed/,
  );
  const evidenceDirectory = resolve(root, ".cache/ci/smoke");
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = join(evidenceDirectory, `query-input-${scenario}.json`);
  await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
  expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual(record);
  return record.evidence;
}

test("query-only live, baseline and replay have exact unadapted replies and zero adapted input", async () => {
  const evidence = await run("queries");
  expect(evidence.cases).toHaveLength(42);
  expect(new Set(evidence.cases.map((item) => item.caseId)).size).toBe(14);
  expect(new Set(evidence.cases.map((item) => item.phase))).toEqual(
    new Set(["live", "baseline", "replay"]),
  );
  for (const item of evidence.cases) {
    expect(item.reference).toEqual(item.expected);
    expect(item.adapted).toEqual([]);
  }
  expect(evidence.barriers.reference).toEqual(evidence.barriers.expected);
  expect(evidence.barriers.adapted).toEqual([]);
});

test("real focused keyboard input survives a held parser and application cursor mode", async () => {
  const evidence = await run("keyboard");
  expect(evidence.snapshot.applicationCursor).toBe(true);
  expect(
    evidence.entries.some(
      (entry) => entry.kind === "automatic-data" && entry.bytes.join() === "27,91,48,110",
    ),
  ).toBe(true);
  expect(evidence.outbound.flat()).toEqual([97, 13, 127, 27, 91, 65, 98, 3, 27, 79, 65]);
});

test("DOM paste preserves Unicode, reply-shaped data and bracketed mode across a held parser", async () => {
  const evidence = await run("paste");
  expect(evidence.actual).toEqual(evidence.expected);
  expect(evidence.actual).toContain(195);
  expect(evidence.actual).toContain(27);
});

test("real SGR and legacy mouse actions preserve high binary coordinate bytes", async () => {
  const evidence = await run("mouse");
  const sgr = ["\x1b[<0;100;4M", "\x1b[<0;100;4m", "\x1b[<64;100;4M"].map((value) =>
    Array.from(new TextEncoder().encode(value)),
  );
  expect(evidence.sgr).toEqual(sgr);
  expect(evidence.alternate).toEqual(sgr);
  expect(evidence.legacy).toEqual([
    [27, 91, 77, 32, 132, 36],
    [27, 91, 77, 35, 132, 36],
  ]);
});

test("split queries and mixed OSC retain text and color while the public hook counterexample loses the setter", async () => {
  const evidence = await run("split-mixed");
  expect(evidence.publicCounterexample.before).toEqual([1, 2, 3]);
  expect(evidence.publicCounterexample.after).toEqual([1, 2, 3]);
  expect(evidence.privatePalette).toEqual([170, 187, 204]);
  expect(evidence.resetPalette).toEqual([1, 2, 3]);
  expect(evidence.line).toBe("Aé€😀Z");
  expect(Object.values(evidence.cuts).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(50);
});

test("disposing a held parser releases its callback without outbound input", async () => {
  const evidence = await run("lifetime");
  expect(evidence.oldOutbound).toEqual([]);
  expect(evidence.oldWriteDone).toEqual([1]);
  expect(evidence.replacementOutbound).toEqual([[114]]);
  expect(evidence.conformance).toMatchObject({
    duplicateRejected: true,
    wrongVersionRejected: true,
    missingSurfaceRejected: true,
    oldWrapperDetached: true,
    nestedBytes: ["x", "y", "z"],
  });
});

test("focus reports remain separate from query hooks", async () => {
  const evidence = await run("focus");
  expect(evidence.automatic).toEqual([
    [27, 91, 73],
    [27, 91, 79],
  ]);
  expect(evidence.outbound).toEqual([]);
});

test("compiled protocol delivery rejects wrong identity and invalid baseline chunks before browser writes", async () => {
  const evidence = await run("transport-rejection");
  expect(evidence.rejected).toEqual([
    "wrong-serverId",
    "wrong-relayInstanceId",
    "wrong-runId",
    "missing-chunk",
    "duplicate-chunk",
    "reordered-chunk",
    "wrong-baseline-id",
    "wrong-at-seq",
    "wrong-total",
    "oversized-baseline",
    "overfull-declared-baseline",
    "overfull-maximum-baseline",
    "oversized-output",
    "fatal-utf8",
  ]);
  expect(evidence.delivered).toBe(0);
});

test("held parser timeout, late page errors, result bounds and thrown work close owned resources", async () => {
  const unicodeResult = JSON.stringify({ detail: "é".repeat(140_000) });
  expect(unicodeResult.length).toBeLessThan(256 * 1024);
  expect(Buffer.byteLength(unicodeResult, "utf8")).toBeGreaterThan(256 * 1024);
  const directory = await mkdtemp(join(tmpdir(), "cove-query-cleanup-"));
  try {
    for (const [scenario, extra, expected, disposedPages] of [
      ["held-timeout", {}, /Intentional held parser timed out/, 1],
      ["late-page-error", {}, /Injected late page error/, 1],
      [
        "late-page-error",
        { COVE_QUERY_INJECT_CLEANUP_FAILURE: "1" },
        /Injected late page error.*Injected query cleanup failure/s,
        1,
      ],
      ["unicode-result-limit", {}, /Query result exceeds 256 KiB/, 1],
      [
        "queries",
        { COVE_QUERY_INJECT_WORK_FAILURE: "1", COVE_QUERY_INJECT_CLEANUP_FAILURE: "1" },
        /Injected query work failure.*Injected query cleanup failure/s,
        0,
      ],
    ]) {
      const evidence = join(directory, `${scenario}.json`);
      const result = spawnSync(process.execPath, [entry, scenario], {
        cwd: root,
        encoding: "utf8",
        timeout: 40_000,
        env: { ...process.env, ...extra, COVE_QUERY_CLEANUP_EVIDENCE: evidence },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(expected);
      const cleanup = JSON.parse(await readFile(evidence, "utf8"));
      expect(cleanup.browserPid).toBeGreaterThan(0);
      expect(cleanup.browserExited).toBe(true);
      expect(cleanup.listenerClosed).toBe(true);
      expect(cleanup.disposedPages).toBe(disposedPages);
      await expect(fetch(`http://127.0.0.1:${cleanup.listenerPort}/`)).rejects.toThrow(
        /fetch failed/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a changed bundled xterm manifest version fails before browser input admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-query-version-"));
  const browserOut = join(directory, "browser");
  const packageRoot = resolve(import.meta.dirname, "..");
  try {
    const built = spawnSync(
      process.execPath,
      [
        join(packageRoot, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        join(packageRoot, "probes/vite.config.mjs"),
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          COVE_PROBE_BROWSER_OUT: browserOut,
          COVE_PROBE_TEST_BUNDLED_XTERM_VERSION: "0.0.0",
        },
      },
    );
    expect(built.error).toBeUndefined();
    if (built.status !== 0)
      throw new Error(built.stderr || `Isolated browser build exited ${built.status}`);
    const evidence = join(directory, "cleanup.json");
    const result = spawnSync(process.execPath, [entry, "queries"], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        COVE_QUERY_BROWSER_ROOT: browserOut,
        COVE_QUERY_CLEANUP_EVIDENCE: evidence,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unsupported xterm version: 0\.0\.0/);
    const cleanup = JSON.parse(await readFile(evidence, "utf8"));
    expect(cleanup.browserExited).toBe(true);
    expect(cleanup.listenerClosed).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
