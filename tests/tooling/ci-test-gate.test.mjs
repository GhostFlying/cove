import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { recordedCommand, verifyDiscovery, verifyInventory } from "../../scripts/ci-test-gate.mjs";

const root = resolve(import.meta.dirname, "../..");
const first = "tests/tooling/project-references.test.ts";
const second = "tests/tooling/ci-test-gate.test.mjs";
const suites = [
  { project: "tooling", file: first, minimumTests: 2 },
  { project: "tooling", file: second, minimumTests: 4 },
];
const discoveredCases = [
  ...Array.from({ length: 2 }, (_, index) => ({
    projectName: "tooling",
    file: resolve(root, first),
    name: `project reference ${index}`,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    projectName: "tooling",
    file: resolve(root, second),
    name: `gate ${index}`,
  })),
];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function isolatedEvidence() {
  const directory = await mkdtemp(resolve(tmpdir(), "cove-ci-evidence-"));
  temporaryDirectories.push(directory);
  return resolve(directory, "execution.json");
}

function report() {
  return {
    success: true,
    numTotalTests: 6,
    numPassedTests: 6,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: resolve(root, first),
        status: "passed",
        assertionResults: Array(2).fill({ status: "passed" }),
      },
      {
        name: resolve(root, second),
        status: "passed",
        assertionResults: Array(4).fill({ status: "passed" }),
      },
    ],
  };
}

test("rejects a required suite removed from discovery", () => {
  expect(() => verifyDiscovery(discoveredCases.slice(0, 2), [first], suites)).toThrow(
    /Required suite/,
  );
});

test("rejects a test file excluded by the Vitest project", () => {
  expect(() =>
    verifyDiscovery(discoveredCases, [first, second, "tests/tooling/forgotten.test.ts"], suites),
  ).toThrow(/absent from Vitest discovery/);
});

test("rejects a skipped test despite a successful runner summary", () => {
  const result = report();
  result.testResults[1].assertionResults[0] = { status: "pending" };
  expect(() => verifyInventory(discoveredCases, result, [first, second], suites)).toThrow(
    /skipped, pending/,
  );
});

test("rejects a missing execution report and zero passed tests", () => {
  expect(() => verifyInventory(discoveredCases, null, [first, second], suites)).toThrow(/absent/);
  const result = report();
  result.numPassedTests = 0;
  expect(() => verifyInventory(discoveredCases, result, [first, second], suites)).toThrow(/totals/);
});

test("records a failed discovery command with exact argv and exit code", async () => {
  const output = await isolatedEvidence();
  const args = ["--eval", "process.exit(7)"];
  const result = await recordedCommand("discovery", process.execPath, args, output);
  expect(result.status).toBe(7);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
    {
      stage: "discovery",
      argv: [process.execPath, ...args],
      timeoutMs: 120_000,
      exitCode: 7,
      signal: null,
      errorCode: null,
      timedOut: false,
    },
  ]);
});

test("records spawn and timeout failures before propagating them", async () => {
  const output = await isolatedEvidence();
  const absent = resolve(dirname(output), "missing-command");
  await expect(recordedCommand("discovery", absent, [], output)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    recordedCommand(
      "vitest",
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      output,
      50,
    ),
  ).rejects.toMatchObject({ code: "ETIMEDOUT" });
  const attempts = JSON.parse(await readFile(output, "utf8"));
  expect(
    attempts.map(({ stage, errorCode, timedOut }) => ({ stage, errorCode, timedOut })),
  ).toEqual([
    { stage: "discovery", errorCode: "ENOENT", timedOut: false },
    { stage: "vitest", errorCode: "ETIMEDOUT", timedOut: true },
  ]);
});
