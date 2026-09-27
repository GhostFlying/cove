import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readVitestOwnedTestFiles,
  recordedCommand,
  prepareBrowserCleanupEvidence,
  verifyBrowserCleanupEvidence,
  requiredSuites,
  verifyDiscovery,
  verifyInventory,
  viewEvidenceCases,
} from "../../scripts/ci-test-gate.mjs";

const root = resolve(import.meta.dirname, "../..");
const first = "tests/tooling/project-references.test.ts";
const second = "tests/tooling/ci-test-gate.test.mjs";
const suites = [
  { project: "tooling", file: first, minimumTests: 2 },
  { project: "tooling", file: second, minimumTests: 8 },
];
const discoveredCases = [
  ...Array.from({ length: 2 }, (_, index) => ({
    projectName: "tooling",
    file: resolve(root, first),
    name: `project reference ${index}`,
  })),
  ...Array.from({ length: 8 }, (_, index) => ({
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
    numTotalTests: 10,
    numPassedTests: 10,
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
        assertionResults: Array(8).fill({ status: "passed" }),
      },
    ],
  };
}

function growingViewReport() {
  const viewSuites = requiredSuites.filter((suite) => suite.project === "terminal-web");
  const files = viewSuites.map((suite) => suite.file);
  const caseCount = (suiteIndex) => [7, 6, 10][suiteIndex];
  const discovered = viewSuites.flatMap((suite, suiteIndex) =>
    Array.from({ length: caseCount(suiteIndex) }, (_, index) => ({
      projectName: suite.project,
      file: resolve(root, suite.file),
      name: `case ${index}`,
    })),
  );
  const execution = {
    success: true,
    numTotalTests: 23,
    numPassedTests: 23,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: viewSuites.map((suite, suiteIndex) => ({
      name: resolve(root, suite.file),
      status: "passed",
      assertionResults: Array.from({ length: caseCount(suiteIndex) }, (_, index) => ({
        fullName: `case ${index}`,
        status: "passed",
      })),
    })),
  };
  return { viewSuites, files, discovered, execution };
}

test("rejects a required suite removed from discovery", () => {
  expect(() => verifyDiscovery(discoveredCases.slice(0, 2), [first], suites)).toThrow(
    /Required suite/,
  );
});

test("protocol registration and its actual test root are required", async () => {
  const protocolSuite = requiredSuites.find(
    ({ file }) => file === "packages/protocol/tests/metadata.test.mjs",
  );
  expect(protocolSuite).toMatchObject({ project: "protocol", minimumTests: 7 });
  expect(await readVitestOwnedTestFiles()).toContain(protocolSuite.file);
  expect(() => verifyDiscovery([], [protocolSuite.file], [protocolSuite])).toThrow(
    /Required suite protocol:/,
  );
});

test("query input browser suite is mandatory with eleven acceptance rows", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-web/probes/query-input.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-web-probes", minimumTests: 11 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-web-probes:/,
  );
});

test("all three V1 browser suites reject missing and empty discovery", async () => {
  const files = await readVitestOwnedTestFiles();
  for (const name of ["view-input", "view-recovery", "view-lifecycle"]) {
    const file = `packages/terminal-web/tests/${name}.test.mjs`;
    const suite = requiredSuites.find((item) => item.file === file);
    const minimumTests = name === "view-lifecycle" ? 10 : 6;
    expect(suite).toMatchObject({ project: "terminal-web", minimumTests });
    expect(files).toContain(file);
    expect(() => verifyDiscovery([], [file], [suite])).toThrow(
      `discovered 0 tests; needs ${minimumTests}`,
    );
    const short = Array.from({ length: minimumTests - 1 }, (_, index) => ({
      projectName: "terminal-web",
      file: resolve(root, file),
      name: `${name} ${index}`,
    }));
    expect(() => verifyDiscovery(short, [file], [suite])).toThrow(
      `discovered ${minimumTests - 1} tests; needs ${minimumTests}`,
    );
  }
});

test("terminal-web package test runs both registered probe and view projects", async () => {
  const pkg = JSON.parse(
    await readFile(resolve(root, "packages/terminal-web/package.json"), "utf8"),
  );
  const projects = [...pkg.scripts.test.matchAll(/(?:^|\s)--project\s+(\S+)/g)].map(
    (match) => match[1],
  );
  expect(projects).toEqual(["terminal-web-probes", "terminal-web"]);
});

test("browser cleanup evidence reset removes stale cases and binds the current source", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cove-browser-cleanup-gate-"));
  temporaryDirectories.push(directory);
  await writeFile(resolve(directory, "stale.json"), '{"browserExited":true}\n');
  const sourceCommit = "a".repeat(40);
  await prepareBrowserCleanupEvidence(sourceCommit, "local-42-1", directory);
  await expect(readFile(resolve(directory, "stale.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(JSON.parse(await readFile(resolve(directory, "run.json"), "utf8"))).toMatchObject({
    sourceCommit,
    runId: "local-42-1",
  });
  await expect(prepareBrowserCleanupEvidence("wrong", "local-42-2", directory)).rejects.toThrow(
    /identity/,
  );
});

test("browser cleanup artifact gate rejects incomplete, stale and unbounded records", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cove-browser-cleanup-records-"));
  temporaryDirectories.push(directory);
  const sourceCommit = "b".repeat(40);
  await prepareBrowserCleanupEvidence(sourceCommit, "local-43-1", directory);
  const path = resolve(directory, "42-1.json");
  const record = {
    schemaVersion: 1,
    final: true,
    caseId: "view-lifecycle.test.mjs:123",
    testName: "V1-L1 evidence",
    invocationId: "42-1",
    runId: "local-43-1",
    sourceCommit,
    sourceDirty: false,
    browserPid: 42,
    browserExited: true,
    profile: "query",
    primaryOutcome: "completed",
    primaryErrorName: null,
    listenerPort: 12345,
    browserExit: { code: 0, signal: null, observedMs: 14 },
    listenerClosed: true,
    graceful: {
      attempts: 1,
      startedMs: 2,
      phaseDeadlineMs: 4_500,
      phaseRemainingMs: 4_498,
      budgetMs: 2_000,
      elapsedMs: 12,
      outcome: "completed",
    },
    kill: {
      attempts: 0,
      startedMs: null,
      phaseDeadlineMs: 6_000,
      phaseRemainingMs: null,
      budgetMs: 0,
      elapsedMs: 0,
      outcome: "not-started",
    },
    listener: {
      attempts: 1,
      startedMs: 14,
      phaseDeadlineMs: 7_000,
      phaseRemainingMs: 6_986,
      budgetMs: 750,
      elapsedMs: 0,
      outcome: "completed",
    },
    pages: [
      {
        page: 1,
        shareMs: 3_499,
        dispose: { budgetMs: 1_500, elapsedMs: 1, outcome: "completed" },
        close: { attempts: 1, budgetMs: 3_499, elapsedMs: 1, outcome: "completed" },
      },
    ],
    disposedPages: 1,
    cleanupElapsedMs: 14,
    workBudgetMs: 32_000,
  };
  await writeFile(path, `${JSON.stringify(record)}\n`);
  expect(await verifyBrowserCleanupEvidence(directory, sourceCommit, 1)).toEqual({
    runId: "local-43-1",
    recordCount: 1,
  });
  await expect(verifyBrowserCleanupEvidence(directory, sourceCommit, 2)).rejects.toThrow(/count/);
  await writeFile(path, `${JSON.stringify({ ...record, final: false })}\n`);
  await expect(verifyBrowserCleanupEvidence(directory, sourceCommit, 1)).rejects.toThrow(
    /incomplete/,
  );
  await writeFile(path, `${JSON.stringify({ ...record, runId: "old-run" })}\n`);
  await expect(verifyBrowserCleanupEvidence(directory, sourceCommit, 1)).rejects.toThrow(
    /incomplete/,
  );
  await writeFile(
    path,
    `${JSON.stringify({ ...record, graceful: { ...record.graceful, budgetMs: 2_001 } })}\n`,
  );
  await expect(verifyBrowserCleanupEvidence(directory, sourceCommit, 1)).rejects.toThrow(
    /incomplete/,
  );
  await writeFile(path, `${JSON.stringify(record)}\n`);
  const secondPath = resolve(directory, "42-2.json");
  await writeFile(secondPath, `${JSON.stringify({ ...record, invocationId: "42-2" })}\n`);
  const expectedCases = ["V1-L1 evidence", "V1-L2 evidence"].map((name) => ({
    file: "packages/terminal-web/tests/view-lifecycle.test.mjs",
    name,
  }));
  await expect(
    verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases),
  ).rejects.toThrow(/executed cases/);
  await writeFile(
    secondPath,
    `${JSON.stringify({ ...record, invocationId: "42-2", caseId: "view-lifecycle.test.mjs:124", testName: "V1-L2 evidence" })}\n`,
  );
  expect(await verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases)).toMatchObject({
    recordCount: 2,
  });
  await writeFile(
    resolve(directory, "42-3.json"),
    `${JSON.stringify({ ...record, invocationId: "42-3", caseId: "view-lifecycle.test.mjs:125", testName: "V1-L2 evidence" })}\n`,
  );
  expect(await verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases)).toMatchObject({
    recordCount: 3,
  });
  for (const changed of [
    { graceful: { ...record.graceful, budgetMs: -1 } },
    { graceful: { ...record.graceful, outcome: "unknown" } },
    { graceful: { ...record.graceful, phaseDeadlineMs: 4_501 } },
    { graceful: { ...record.graceful, startedMs: 1_000, phaseRemainingMs: 4_500 } },
    { graceful: { ...record.graceful, startedMs: 3_500, phaseRemainingMs: 1_000 } },
    { kill: undefined },
    { kill: { ...record.kill, attempts: 1 } },
    { listener: undefined },
    { browserExit: undefined },
    { browserExit: { code: null, signal: null, observedMs: 14 } },
    { browserExit: { code: 0, signal: null, observedMs: -1 } },
    { primaryOutcome: "unknown" },
    { primaryErrorName: "secret" },
    { listenerPort: null },
    { pages: [{}], disposedPages: 1 },
    { pages: [], disposedPages: 0 },
    { browserExit: { code: 0, signal: null, observedMs: 15_000 } },
    {
      listener: {
        ...record.listener,
        startedMs: 7_000,
        phaseRemainingMs: 0,
        budgetMs: 1,
        elapsedMs: 30_000,
      },
    },
    { invocationId: "42-2" },
  ]) {
    await writeFile(path, `${JSON.stringify({ ...record, ...changed })}\n`);
    await expect(
      verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases),
    ).rejects.toThrow(/incomplete/);
  }
  await writeFile(path, `${JSON.stringify({ ...record, testName: "V1-L2 evidence" })}\n`);
  await expect(
    verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases),
  ).rejects.toThrow(/executed cases/);
  await writeFile(path, `${JSON.stringify(record)}\n`);
  await writeFile(
    secondPath,
    `${JSON.stringify({ ...record, invocationId: "42-2", caseId: "view-lifecycle.test.mjs:124" })}\n`,
  );
  await writeFile(
    resolve(directory, "42-3.json"),
    `${JSON.stringify({ ...record, invocationId: "42-3", caseId: "view-lifecycle.test.mjs:125" })}\n`,
  );
  await expect(
    verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases),
  ).rejects.toThrow(/executed cases/);
});

test("view evidence follows validated passing case growth above three suite floors", () => {
  const { viewSuites, files, discovered, execution } = growingViewReport();
  const inventory = verifyInventory(discovered, execution, files, viewSuites);
  expect(inventory.map((suite) => suite.passed)).toEqual([7, 6, 10]);
  expect(viewEvidenceCases(execution, inventory)).toHaveLength(23);
});

test("view evidence still rejects missing, short, pending, and mismatched suites", () => {
  const { viewSuites, files, discovered, execution } = growingViewReport();
  expect(() =>
    verifyInventory(
      discovered.filter((testCase) => testCase.file !== resolve(root, files[2])),
      execution,
      files,
      viewSuites,
    ),
  ).toThrow(/discovered 0 tests; needs 10/);
  expect(() =>
    verifyInventory(
      discovered.filter(
        (testCase) => testCase.file !== resolve(root, files[1]) || testCase.name !== "case 5",
      ),
      execution,
      files,
      viewSuites,
    ),
  ).toThrow(/discovered 5 tests; needs 6/);
  const pending = structuredClone(execution);
  pending.testResults[0].assertionResults[0].status = "pending";
  expect(() => verifyInventory(discovered, pending, files, viewSuites)).toThrow(/skipped, pending/);
  const inventory = verifyInventory(discovered, execution, files, viewSuites);
  expect(() => viewEvidenceCases(execution, inventory.slice(1))).toThrow(/suite evidence/);
  expect(() =>
    viewEvidenceCases(
      execution,
      inventory.map((suite, index) => (index === 0 ? { ...suite, passed: 6 } : suite)),
    ),
  ).toThrow(/suite evidence/);
});

test("supported terminal protocol suite is mandatory with compiled cases", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/protocol/tests/supported-terminal.test.mjs",
  );
  expect(suite).toMatchObject({ project: "protocol", minimumTests: 14 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(/Required suite protocol:/);
});

test("supported worker pipe suite is mandatory with compiled cases", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/protocol/tests/supported-pipe.test.mjs",
  );
  expect(suite).toMatchObject({ project: "protocol", minimumTests: 8 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(/Required suite protocol:/);
});

test("local admission and RPC suite is mandatory with compiled cases", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/protocol/tests/admission-rpc.test.mjs",
  );
  expect(suite).toMatchObject({ project: "protocol", minimumTests: 17 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(/Required suite protocol:/);
});

test("compiled protocol consumer journey suite is mandatory", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/protocol/tests/consumer-contracts.test.mjs",
  );
  expect(suite).toMatchObject({ project: "protocol", minimumTests: 12 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(/Required suite protocol:/);
});

test("recovery state suite is mandatory with actual discovered cases", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-engine/probes/recovery-state.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 7 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-engine-probes:/,
  );
});

test("recovery parser and query suites are mandatory", async () => {
  for (const name of ["recovery-parser", "recovery-query"]) {
    const suite = requiredSuites.find(
      ({ file }) => file === `packages/terminal-engine/probes/${name}.test.mjs`,
    );
    expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 3 });
    expect(await readVitestOwnedTestFiles()).toContain(suite.file);
    expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
      /Required suite terminal-engine-probes:/,
    );
  }
});

test("recovery boundary suite includes real diagnostic and transport cases", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-engine/probes/recovery-boundaries.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 10 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-engine-probes:/,
  );
});

test("final glyph checkpoint refresh suite is mandatory", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-engine/probes/recovery-join.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 3 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-engine-probes:/,
  );
});

test("combined recovery geometry suite is mandatory", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-engine/probes/recovery-geometry.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 3 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-engine-probes:/,
  );
});

test("source-derived recovery diagnostic suite is mandatory", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-engine/probes/recovery-source-derived.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 5 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-engine-probes:/,
  );
});

test("pragmatic logical-grid recovery suite is mandatory", async () => {
  const suite = requiredSuites.find(
    ({ file }) => file === "packages/terminal-engine/probes/recovery-pragmatic.test.mjs",
  );
  expect(suite).toMatchObject({ project: "terminal-engine-probes", minimumTests: 37 });
  expect(await readVitestOwnedTestFiles()).toContain(suite.file);
  expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
    /Required suite terminal-engine-probes:/,
  );
});

test("compiled terminal adapter suites are all mandatory", async () => {
  for (const [name, minimumTests] of [
    ["terminal-model", 11],
    ["engine-recovery", 9],
    ["engine-parser", 9],
    ["engine-query", 11],
    ["engine-preview", 6],
  ]) {
    const suite = requiredSuites.find(
      ({ file }) => file === `packages/terminal-engine/tests/${name}.test.mjs`,
    );
    expect(suite).toMatchObject({ project: "terminal-engine", minimumTests });
    expect(await readVitestOwnedTestFiles()).toContain(suite.file);
    expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(
      /Required suite terminal-engine:/,
    );
  }
});

test("compiled native worker qualification cannot disappear or become empty", async () => {
  const file = "packages/terminal-worker/tests/native-qualification.test.mjs";
  const suite = requiredSuites.find((item) => item.file === file);
  expect(suite).toMatchObject({ project: "terminal-worker", minimumTests: 4 });
  expect(await readVitestOwnedTestFiles()).toContain(file);
  expect(() => verifyDiscovery([], [file], [suite])).toThrow(/discovered 0 tests; needs 4/);
  expect(() =>
    verifyDiscovery(
      [{ projectName: "terminal-worker", file: resolve(root, file), name: "one" }],
      [file],
      [suite],
    ),
  ).toThrow(/discovered 1 tests; needs 4/);
});

test("bounded native writer owner and fd-reuse suites cannot disappear or shrink", async () => {
  for (const [name, minimumTests] of [
    ["native-write-owner", 12],
    ["native-write-reuse", 5],
    ["native-write-lifecycle", 2],
    ["native-write-rollback", 3],
    ["native-write-fault", 1],
    ["native-write-churn", 2],
    ["native-write-spawn-contract", 11],
    ["native-write-owned-stop", 10],
  ]) {
    const file = `packages/terminal-worker/tests/${name}.test.mjs`;
    const suite = requiredSuites.find((item) => item.file === file);
    expect(suite).toMatchObject({ project: "terminal-worker", minimumTests });
    expect(await readVitestOwnedTestFiles()).toContain(file);
    expect(() => verifyDiscovery([], [file], [suite])).toThrow(/Required suite terminal-worker:/);
  }
});

test("native adapter and run session suites cannot disappear or shrink", async () => {
  for (const [name, minimumTests] of [
    ["native-adapter-factory", 18],
    ["native-adapter-input", 7],
    ["native-adapter-real", 6],
    ["run-session", 12],
    ["run-session-real", 1],
  ]) {
    const file = `packages/terminal-worker/tests/${name}.test.mjs`;
    const suite = requiredSuites.find((item) => item.file === file);
    expect(suite).toMatchObject({ project: "terminal-worker", minimumTests });
    expect(await readVitestOwnedTestFiles()).toContain(file);
    expect(() => verifyDiscovery([], [file], [suite])).toThrow(/discovered 0 tests/);
    const short = Array.from({ length: minimumTests - 1 }, (_, index) => ({
      projectName: "terminal-worker",
      file: resolve(root, file),
      name: `case ${index}`,
    }));
    expect(() => verifyDiscovery(short, [file], [suite])).toThrow(
      `discovered ${minimumTests - 1} tests; needs ${minimumTests}`,
    );
  }
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

test("rejects removal of a gate test below the required floor", () => {
  const requiredGateSuites = requiredSuites.filter(({ file }) => file === first || file === second);
  const complete = [
    ...discoveredCases.slice(0, 2),
    ...Array.from({ length: 31 }, (_, index) => ({
      projectName: "tooling",
      file: resolve(root, second),
      name: `gate ${index}`,
    })),
  ];
  expect(() => verifyDiscovery(complete, [first, second], requiredGateSuites)).not.toThrow();
  expect(() => verifyDiscovery(complete.slice(0, -1), [first, second], requiredGateSuites)).toThrow(
    /discovered 30 tests; needs 31/,
  );
});

test("scans Vitest-owned tooling tests without capturing browser specs", async () => {
  const checkout = await mkdtemp(resolve(tmpdir(), "cove-ci-scan-"));
  temporaryDirectories.push(checkout);
  await mkdir(resolve(checkout, "tests/tooling"), { recursive: true });
  await mkdir(resolve(checkout, "tests/browser"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-engine/probes"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-engine/tests"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-worker/tests"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-web/probes"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-web/tests"), { recursive: true });
  await mkdir(resolve(checkout, "packages/protocol/tests"), { recursive: true });
  await writeFile(resolve(checkout, "tests/tooling/registered.test.ts"), "");
  await writeFile(resolve(checkout, "tests/tooling/excluded.spec.ts"), "");
  await writeFile(resolve(checkout, "tests/browser/terminal.spec.ts"), "");
  await writeFile(resolve(checkout, "packages/terminal-engine/probes/native.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-engine/tests/engine.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-worker/tests/native.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-web/probes/browser.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-web/tests/view-input.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/protocol/tests/metadata.test.mjs"), "");
  expect(await readVitestOwnedTestFiles(checkout)).toEqual([
    "packages/protocol/tests/metadata.test.mjs",
    "packages/terminal-engine/probes/native.test.mjs",
    "packages/terminal-engine/tests/engine.test.mjs",
    "packages/terminal-web/probes/browser.test.mjs",
    "packages/terminal-web/tests/view-input.test.mjs",
    "packages/terminal-worker/tests/native.test.mjs",
    "tests/tooling/excluded.spec.ts",
    "tests/tooling/registered.test.ts",
  ]);
});
