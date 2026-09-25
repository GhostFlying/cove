import { resolve } from "node:path";
import { expect, test } from "vitest";
import { verifyDiscovery, verifyInventory } from "../../scripts/ci-test-gate.mjs";

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
