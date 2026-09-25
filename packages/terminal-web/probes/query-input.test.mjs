import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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
  return record.evidence;
}

test("query-only live, baseline and replay have exact unadapted replies and zero adapted input", async () => {
  const evidence = await run("queries");
  expect(evidence).toHaveLength(33);
  expect(new Set(evidence.map((item) => item.caseId)).size).toBe(11);
  expect(new Set(evidence.map((item) => item.phase))).toEqual(
    new Set(["live", "baseline", "replay"]),
  );
  for (const item of evidence) {
    expect(item.reference).toEqual(item.expected);
    expect(item.adapted).toEqual([]);
  }
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
  expect(evidence.sgr).toEqual([
    [27, 91, 60, 48, 59, 50, 59, 50, 77],
    [27, 91, 60, 48, 59, 50, 59, 50, 109],
  ]);
  expect(evidence.legacy).toEqual([
    [27, 91, 77, 32, 132, 34],
    [27, 91, 77, 35, 132, 34],
  ]);
});

test("split queries and mixed OSC retain text and color while the public hook counterexample loses the setter", async () => {
  const evidence = await run("split-mixed");
  expect(evidence.publicCounterexample.before).toEqual([1, 2, 3]);
  expect(evidence.publicCounterexample.after).toEqual([1, 2, 3]);
  expect(evidence.privatePalette).toEqual([170, 187, 204]);
  expect(evidence.line).toBe("é");
});

test("disposing a held parser releases its callback without outbound input", async () => {
  const evidence = await run("lifetime");
  expect(evidence.oldOutbound).toEqual([]);
  expect(evidence.oldWriteDone).toEqual([1]);
});
