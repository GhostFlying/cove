import { createHash } from "node:crypto";
import { fstatSync, readFileSync } from "node:fs";
import filesystem, { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  readVitestOwnedTestFiles,
  recordedCommand,
  prepareBrowserCleanupEvidence,
  prepareWorkerQualificationEvidence,
  verifyBrowserCleanupEvidence,
  validBrowserCloseTimeline,
  validateBrowserCloseDiagnosticInvocation,
  verifyBrowserCloseDiagnosticEvidence,
  verifyBrowserCloseDiagnosticSelection,
  verifyBrowserCloseDiagnosticReport,
  bindDiagnosticBrowserVersion,
  validDiagnosticBrowserProvenance,
  writeBrowserCloseDiagnosticManifest,
  writeNoConclusionDiagnosticFailure,
  requiredSuites,
  finiteRuntimeExpansions,
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
  vi.restoreAllMocks();
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
  const caseCount = (suiteIndex) => [7, 6, 17][suiteIndex];
  const discovered = viewSuites.flatMap((suite, suiteIndex) =>
    Array.from({ length: caseCount(suiteIndex) }, (_, index) => ({
      projectName: suite.project,
      file: resolve(root, suite.file),
      name: `case ${index}`,
    })),
  );
  const execution = {
    success: true,
    numTotalTests: 30,
    numPassedTests: 30,
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

test("server author and independent suites are fail-closed and fully owned by Vitest", async () => {
  const files = await readVitestOwnedTestFiles();
  const registrations = [
    ["author", "runtime-admission", 21],
    ["author", "local-entry", 50],
    ["independent", "qualified-local-admission", 4],
    ["author", "worker-pipe-session", 11],
    ["author", "operation-receipts", 15],
    ["author", "terminal-subscriptions", 14],
    ["author", "terminal-connection-delivery", 7],
    ["independent", "subscription-contract", 30],
    ["independent", "subscription-client", 5],
    ["author", "terminal-control", 14],
    ["independent", "terminal-control-contract", 34],
    ["independent", "terminal-control-client", 7],
    ["author", "preview-cache", 27],
    ["independent", "preview-contract", 15],
    ["independent", "preview-client", 4],
  ].map(([directory, name, minimumTests]) => {
    const file = `apps/server/tests/${directory}/${name}.test.mjs`;
    const suite = requiredSuites.find((item) => item.file === file);
    expect(suite).toMatchObject({ project: "server", minimumTests });
    expect(files).toContain(file);
    return suite;
  });
  for (const suite of registrations) {
    expect(() => verifyDiscovery([], [suite.file], [suite])).toThrow(/Required suite server:/);
    const complete = Array.from({ length: suite.minimumTests }, (_, index) => ({
      projectName: "server",
      file: resolve(root, suite.file),
      name: `${suite.file} ${index}`,
    }));
    expect(() => verifyDiscovery(complete.slice(0, -1), [suite.file], [suite])).toThrow(
      `discovered ${suite.minimumTests - 1} tests; needs ${suite.minimumTests}`,
    );
    expect(verifyDiscovery(complete, [suite.file], [suite]).found.get(`server:${suite.file}`)).toBe(
      suite.minimumTests,
    );
    expect(() => verifyDiscovery([...complete, complete[0]], [suite.file], [suite])).toThrow(
      /Duplicate discovered identity/,
    );
    const execution = {
      success: true,
      numTotalTests: complete.length,
      numPassedTests: complete.length - 1,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
      testResults: [
        {
          name: resolve(root, suite.file),
          status: "passed",
          assertionResults: complete.map((_, index) => ({
            status: index === 0 ? "pending" : "passed",
          })),
        },
      ],
    };
    expect(() => verifyInventory(complete, execution, [suite.file], [suite])).toThrow(
      /skipped, pending/,
    );
  }
  for (const directory of ["author", "independent"]) {
    const extra = `apps/server/tests/${directory}/unregistered.test.mjs`;
    expect(() =>
      verifyDiscovery(
        [{ projectName: "server", file: resolve(root, extra), name: "extra" }],
        [extra],
        registrations,
      ),
    ).toThrow(/Unregistered Vitest suite/);
  }
});

test("client public-contract suites reject missing and short discovery", async () => {
  const files = await readVitestOwnedTestFiles();
  for (const [name, minimumTests] of [
    ["connection-rpc", 59],
    ["compiled-client", 4],
    ["terminal-recovery", 46],
    ["terminal-state", 11],
    ["terminal-control-input", 62],
    ["terminal-budgets-preview", 33],
    ["terminal-lifecycle", 5],
  ]) {
    const file = `packages/client/tests/${name}.test.mjs`;
    const suite = requiredSuites.find((item) => item.file === file);
    expect(suite).toMatchObject({ project: "client", minimumTests });
    expect(files).toContain(file);
    expect(() => verifyDiscovery([], [file], [suite])).toThrow(/Required suite client:/);
    const short = Array.from({ length: minimumTests - 1 }, (_, index) => ({
      projectName: "client",
      file: resolve(root, file),
      name: `${name} ${index}`,
    }));
    expect(() => verifyDiscovery(short, [file], [suite])).toThrow(
      `discovered ${minimumTests - 1} tests; needs ${minimumTests}`,
    );
  }
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
    const minimumTests = name === "view-lifecycle" ? 17 : 6;
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

test("terminal-web package test runs its registered unit, probe and view projects", async () => {
  const pkg = JSON.parse(
    await readFile(resolve(root, "packages/terminal-web/package.json"), "utf8"),
  );
  const projects = [...pkg.scripts.test.matchAll(/(?:^|\s)--project\s+(\S+)/g)].map(
    (match) => match[1],
  );
  expect(projects).toEqual(["terminal-web-unit", "terminal-web-probes", "terminal-web"]);
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

test("worker qualification evidence keeps one run's receipts and rejects stale reuse", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cove-worker-qualification-"));
  temporaryDirectories.push(directory);
  const provenance = {
    sourceCommit: "a".repeat(40),
    tree: "b".repeat(40),
    sourceDirty: false,
    runId: "github-42-1",
    githubRunId: "42",
    githubRunAttempt: "1",
    githubSha: "a".repeat(40),
    node: "26.10.0",
    pnpm: "12.6.0",
    nodeAbi: "147",
    platform: "linux",
    arch: "x64",
  };
  const runDirectory = await prepareWorkerQualificationEvidence(provenance, directory);
  expect(JSON.parse(await readFile(resolve(runDirectory, "run.json"), "utf8"))).toEqual(provenance);
  await writeFile(resolve(runDirectory, "receipt.json"), '{"final":true}\n');
  await expect(prepareWorkerQualificationEvidence(provenance, directory)).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(resolve(runDirectory, "receipt.json"), "utf8")).toBe('{"final":true}\n');
  for (const invalid of [
    { sourceDirty: true },
    { runId: "../escape" },
    { githubRunAttempt: "2" },
    { githubSha: "c".repeat(40) },
    { tree: "wrong" },
  ]) {
    await expect(
      prepareWorkerQualificationEvidence({ ...provenance, ...invalid }, directory),
    ).rejects.toThrow(/identity is invalid/);
  }
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
    browserVersion: "153.0.8010.12",
    browserVersionPinMatched: true,
    browserVersionTruncated: false,
    browserExited: true,
    profile: "query",
    primaryOutcome: "completed",
    primaryErrorName: null,
    listenerPort: 12345,
    browserExit: { code: 0, signal: null, observedMs: 14 },
    closeTimeline: {
      finalized: true,
      invocationId: "42-1",
      runId: "local-43-1",
      sourceCommit,
      cleanupStartedMs: 0,
      finalMs: 14,
      connectedBeforeClose: true,
      connectedAtFinal: false,
      disconnected: { firstMs: 12, count: 1 },
      serverClose: { firstMs: 14, count: 1 },
      processExit: { firstMs: 14, count: 1 },
      rawClose: { calledMs: 2, settledMs: 14, outcome: "fulfilled" },
      closeWrapper: { calledMs: 2, settledMs: 14, outcome: "fulfilled", timeoutObservedMs: null },
      rawKill: { calledMs: null, settledMs: null, outcome: "not-called" },
    },
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
  const forInvocation = (invocationId, changes = {}) => ({
    ...record,
    ...changes,
    invocationId,
    closeTimeline: { ...record.closeTimeline, invocationId },
  });
  await writeFile(path, `${JSON.stringify(record)}\n`);
  expect(await verifyBrowserCleanupEvidence(directory, sourceCommit, 1)).toEqual({
    runId: "local-43-1",
    recordCount: 1,
  });
  const diagnosticDirectory = await mkdtemp(resolve(tmpdir(), "cove-browser-close-diagnostic-"));
  temporaryDirectories.push(diagnosticDirectory);
  const diagnosticName =
    "V1-L4 publishes focus before input but not for selection scrolling appearance or show";
  const reportPath = resolve(diagnosticDirectory, "vitest-results.json");
  const passingReport = {
    success: true,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 0,
    testResults: [
      {
        name: resolve(root, "packages/terminal-web/tests/view-lifecycle.test.mjs"),
        status: "passed",
        assertionResults: [
          { fullName: diagnosticName, status: "passed" },
          { fullName: "other V1 case", status: "skipped" },
        ],
      },
    ],
  };
  const selectedRecord = { ...record, testName: diagnosticName };
  await writeFile(reportPath, `${JSON.stringify(passingReport)}\n`);
  await writeFile(path, `${JSON.stringify(selectedRecord)}\n`);
  expect(
    (
      await verifyBrowserCloseDiagnosticEvidence(
        diagnosticDirectory,
        directory,
        sourceCommit,
        "local-43-1",
        0,
      )
    ).outcome,
  ).toBe("passed");
  const failedRecord = {
    ...selectedRecord,
    browserExit: { code: null, signal: "SIGKILL", observedMs: 2_300 },
    graceful: { ...record.graceful, outcome: "timed-out", elapsedMs: 2_200 },
    kill: {
      attempts: 1,
      startedMs: 2_200,
      phaseDeadlineMs: 6_000,
      phaseRemainingMs: 3_800,
      budgetMs: 1_500,
      elapsedMs: 100,
      outcome: "completed",
    },
    listener: { ...record.listener, startedMs: 2_300, phaseRemainingMs: 4_700 },
    closeTimeline: {
      ...record.closeTimeline,
      finalMs: 2_300,
      disconnected: { firstMs: 2_200, count: 1 },
      serverClose: { firstMs: 2_300, count: 1 },
      processExit: { firstMs: 2_300, count: 1 },
      rawClose: { calledMs: 2, settledMs: null, outcome: "pending" },
      closeWrapper: {
        calledMs: 2,
        settledMs: null,
        outcome: "pending",
        timeoutObservedMs: 2_002,
      },
      rawKill: { calledMs: 2_200, settledMs: 2_300, outcome: "fulfilled" },
    },
    cleanupElapsedMs: 2_300,
  };
  const failingReport = structuredClone(passingReport);
  failingReport.success = false;
  failingReport.numPassedTests = 0;
  failingReport.numFailedTests = 1;
  failingReport.testResults[0].status = "failed";
  failingReport.testResults[0].assertionResults[0].status = "failed";
  await writeFile(path, `${JSON.stringify(failedRecord)}\n`);
  await writeFile(reportPath, `${JSON.stringify(failingReport)}\n`);
  const validatedFailure = await verifyBrowserCloseDiagnosticEvidence(
    diagnosticDirectory,
    directory,
    sourceCommit,
    "local-43-1",
    1,
  );
  expect(validatedFailure.outcome).toBe("failed");
  const identity = { sourceCommit, tree: "c".repeat(40), ref: "refs/heads/diagnostic" };
  await writeFile(resolve(diagnosticDirectory, "identity.json"), `${JSON.stringify(identity)}\n`);
  await writeFile(resolve(diagnosticDirectory, "execution.json"), '[{"exitCode":1}]\n');
  await writeFile(resolve(diagnosticDirectory, "environment.json"), '{"node":"26.10.0"}\n');
  const manifest = await writeBrowserCloseDiagnosticManifest({
    diagnosticDirectory,
    cleanupDirectory: directory,
    environmentPath: resolve(diagnosticDirectory, "environment.json"),
    identity,
    runId: "local-43-1",
    verified: validatedFailure,
    exitStatus: 1,
    provenance: {
      ...identity,
      runId: "local-43-1",
      playwright: "1.63.0",
      playwrightCore: "1.63.0",
      chromiumRevision: "1243",
      chromiumVersion: "153.0.8010.12",
      browserReportedVersion: "153.0.8010.12",
    },
  });
  expect(manifest).toMatchObject({ outcome: "failed", vitestExitCode: 1, evidenceValidated: true });
  expect(Object.keys(manifest.hashes)).toContain("browser-cleanup/42-1.json");
  expect(JSON.parse(await readFile(resolve(diagnosticDirectory, "failure.json"), "utf8"))).toEqual({
    classification: "validated-test-failure",
    vitestExitCode: 1,
  });
  await writeFile(
    path,
    `${JSON.stringify({
      ...failedRecord,
      primaryOutcome: "rejected",
      primaryErrorName: "Error",
      browserVersion: "152.0.0.0",
      browserVersionPinMatched: false,
    })}\n`,
  );
  const observedMismatch = await verifyBrowserCloseDiagnosticEvidence(
    diagnosticDirectory,
    directory,
    sourceCommit,
    "local-43-1",
    1,
  );
  expect(observedMismatch.record.browserVersion).toBe("152.0.0.0");
  expect(() =>
    bindDiagnosticBrowserVersion({ chromiumVersion: "153.0.8010.12" }, observedMismatch.record),
  ).toThrow(/differs/);
  await writeFile(path, `${JSON.stringify(failedRecord)}\n`);
  await expect(
    verifyBrowserCloseDiagnosticEvidence(
      diagnosticDirectory,
      directory,
      sourceCommit,
      "local-43-1",
      0,
    ),
  ).rejects.toThrow(/disagree/);
  await rm(resolve(diagnosticDirectory, "result.json"));
  await rm(resolve(diagnosticDirectory, "failure.json"));
  await writeFile(reportPath, "{not-json}\n");
  await expect(
    verifyBrowserCloseDiagnosticEvidence(
      diagnosticDirectory,
      directory,
      sourceCommit,
      "local-43-1",
      1,
    ),
  ).rejects.toThrow(/JSON/);
  expect(
    await writeNoConclusionDiagnosticFailure(diagnosticDirectory, new SyntaxError("invalid JSON")),
  ).toEqual({ classification: "no-conclusion", errorName: "SyntaxError" });
  await expect(readFile(resolve(diagnosticDirectory, "result.json"), "utf8")).rejects.toMatchObject(
    {
      code: "ENOENT",
    },
  );
  await rm(reportPath);
  await expect(
    verifyBrowserCloseDiagnosticEvidence(
      diagnosticDirectory,
      directory,
      sourceCommit,
      "local-43-1",
      1,
    ),
  ).rejects.toThrow(/ENOENT/);
  await writeFile(reportPath, `${JSON.stringify(failingReport)}\n`);
  await writeFile(
    resolve(directory, "42-2.json"),
    `${JSON.stringify(forInvocation("42-2", { testName: diagnosticName }))}\n`,
  );
  await expect(
    verifyBrowserCloseDiagnosticEvidence(
      diagnosticDirectory,
      directory,
      sourceCommit,
      "local-43-1",
      1,
    ),
  ).rejects.toThrow(/invocation identity/);
  await rm(resolve(directory, "42-2.json"));
  await rm(path);
  await expect(
    verifyBrowserCloseDiagnosticEvidence(
      diagnosticDirectory,
      directory,
      sourceCommit,
      "local-43-1",
      1,
    ),
  ).rejects.toThrow(/count/);
  await writeFile(path, `${JSON.stringify({ ...failedRecord, final: false })}\n`);
  await expect(
    verifyBrowserCloseDiagnosticEvidence(
      diagnosticDirectory,
      directory,
      sourceCommit,
      "local-43-1",
      1,
    ),
  ).rejects.toThrow(/incomplete/);
  await writeFile(path, `${JSON.stringify(record)}\n`);
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
  await writeFile(secondPath, `${JSON.stringify(forInvocation("42-2"))}\n`);
  const expectedCases = ["V1-L1 evidence", "V1-L2 evidence"].map((name) => ({
    file: "packages/terminal-web/tests/view-lifecycle.test.mjs",
    name,
  }));
  await expect(
    verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases),
  ).rejects.toThrow(/executed cases/);
  await writeFile(
    secondPath,
    `${JSON.stringify(forInvocation("42-2", { caseId: "view-lifecycle.test.mjs:124", testName: "V1-L2 evidence" }))}\n`,
  );
  expect(await verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases)).toMatchObject({
    recordCount: 2,
  });
  await writeFile(
    resolve(directory, "42-3.json"),
    `${JSON.stringify(forInvocation("42-3", { caseId: "view-lifecycle.test.mjs:125", testName: "V1-L2 evidence" }))}\n`,
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
    `${JSON.stringify(forInvocation("42-2", { caseId: "view-lifecycle.test.mjs:124" }))}\n`,
  );
  await writeFile(
    resolve(directory, "42-3.json"),
    `${JSON.stringify(forInvocation("42-3", { caseId: "view-lifecycle.test.mjs:125" }))}\n`,
  );
  await expect(
    verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases),
  ).rejects.toThrow(/executed cases/);
});

test("view evidence follows validated passing case growth above three suite floors", () => {
  const { viewSuites, files, discovered, execution } = growingViewReport();
  const inventory = verifyInventory(discovered, execution, files, viewSuites);
  expect(inventory.map((suite) => suite.passed)).toEqual([7, 6, 17]);
  expect(viewEvidenceCases(execution, inventory)).toHaveLength(30);
});

test("diagnostic dispatch requires exact branch, SHA, mode and allowlisted source", () => {
  const input = {
    eventName: "workflow_dispatch",
    mode: "browser-close-v1-l4",
    ref: "refs/heads/p/luchengxuan/m0-browser-close-diagnostic",
    expectedSha: "a".repeat(40),
    head: "a".repeat(40),
    githubSha: "a".repeat(40),
    dirty: false,
    baseIsAncestor: true,
    changedFiles: ["packages/terminal-web/probes/node/managed-browser.ts"],
  };
  expect(validateBrowserCloseDiagnosticInvocation(input).sourceCommit).toBe(input.head);
  for (const changed of [
    { eventName: "pull_request" },
    { mode: "" },
    { expectedSha: "b".repeat(40) },
    { ref: "refs/heads/main" },
    { dirty: true },
    { baseIsAncestor: false },
    { changedFiles: ["packages/terminal-web/src/client.ts"] },
  ]) {
    expect(() => validateBrowserCloseDiagnosticInvocation({ ...input, ...changed })).toThrow(
      /identity or source scope/,
    );
  }
});

test("single diagnostic result cannot satisfy ordinary suite inventory", () => {
  const execution = {
    success: true,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 0,
    testResults: [
      {
        name: resolve(root, "packages/terminal-web/tests/view-lifecycle.test.mjs"),
        status: "passed",
        assertionResults: [
          {
            fullName:
              "V1-L4 publishes focus before input but not for selection scrolling appearance or show",
            status: "passed",
          },
          { fullName: "V1-L5 skipped", status: "skipped" },
        ],
      },
    ],
  };
  expect(verifyBrowserCloseDiagnosticReport(execution)).toHaveLength(1);
  expect(() => verifyInventory([], execution, [], requiredSuites)).toThrow(/Required suite/);
  expect(() => verifyBrowserCloseDiagnosticReport({ ...execution, numTotalTests: 3 })).toThrow(
    /exactly V1-L4/,
  );
  const failure = structuredClone(execution);
  failure.success = false;
  failure.numPassedTests = 0;
  failure.numFailedTests = 1;
  failure.testResults[0].status = "failed";
  failure.testResults[0].assertionResults[0].status = "failed";
  expect(verifyBrowserCloseDiagnosticSelection(failure)).toMatchObject({ outcome: "failed" });
  expect(() => verifyBrowserCloseDiagnosticReport(failure)).toThrow(/did not pass/);
  expect(() => verifyBrowserCloseDiagnosticSelection({ ...failure, numFailedTests: 2 })).toThrow(
    /exactly V1-L4/,
  );
  const extra = structuredClone(failure);
  extra.testResults[0].assertionResults[1].status = "failed";
  expect(() => verifyBrowserCloseDiagnosticSelection(extra)).toThrow(/exactly V1-L4/);
});

test("diagnostic provenance rejects observed pin failures without treating them as unobserved", () => {
  const installed = {
    sourceCommit: "a".repeat(40),
    tree: "b".repeat(40),
    runId: "github-42-1",
    githubRunId: "42",
    githubRunAttempt: "1",
    playwright: "1.63.0",
    playwrightCore: "1.63.0",
    chromiumRevision: "1243",
    chromiumVersion: "153.0.8010.12",
    browserReportedVersion: null,
  };
  const unobserved = {
    browserVersion: null,
    browserVersionPinMatched: null,
    browserVersionTruncated: null,
  };
  const matched = {
    browserVersion: "153.0.8010.12",
    browserVersionPinMatched: true,
    browserVersionTruncated: false,
  };
  expect(bindDiagnosticBrowserVersion(installed, unobserved)).toMatchObject({
    browserReportedVersion: null,
  });
  expect(bindDiagnosticBrowserVersion(installed, matched)).toMatchObject({
    browserReportedVersion: "153.0.8010.12",
  });
  const mismatch = {
    browserVersion: "152.0.0.0",
    browserVersionPinMatched: false,
    browserVersionTruncated: false,
  };
  expect(() => bindDiagnosticBrowserVersion(installed, mismatch)).toThrow(/differs/);
  expect(() =>
    bindDiagnosticBrowserVersion(installed, { ...matched, browserVersionPinMatched: false }),
  ).toThrow(/differs/);
  expect(() =>
    bindDiagnosticBrowserVersion(installed, { ...matched, browserVersionTruncated: true }),
  ).toThrow(/differs/);
  expect(() =>
    bindDiagnosticBrowserVersion(installed, { ...unobserved, browserVersionPinMatched: false }),
  ).toThrow(/differs/);
  expect(() => bindDiagnosticBrowserVersion(installed, {})).toThrow(/differs/);
  const observed = bindDiagnosticBrowserVersion(installed, matched);
  expect(
    validDiagnosticBrowserProvenance(
      observed,
      { sourceCommit: installed.sourceCommit, tree: installed.tree },
      installed.runId,
      matched,
    ),
  ).toBe(true);
  expect(
    validDiagnosticBrowserProvenance(
      observed,
      { sourceCommit: "wrong", tree: installed.tree },
      installed.runId,
      matched,
    ),
  ).toBe(false);
});

test("timeline gate rejects missing final, invalid time and mismatched invocation", () => {
  const record = {
    invocationId: "42-1",
    runId: "local-43-1",
    sourceCommit: "b".repeat(40),
    cleanupElapsedMs: 14,
    graceful: { attempts: 1, outcome: "completed" },
    kill: { attempts: 0 },
    browserExit: { observedMs: 14 },
  };
  const event = { firstMs: null, count: 0 };
  const unused = { calledMs: null, settledMs: null, outcome: "not-called" };
  const timeline = {
    finalized: true,
    invocationId: record.invocationId,
    runId: record.runId,
    sourceCommit: record.sourceCommit,
    cleanupStartedMs: 0,
    finalMs: 14,
    connectedBeforeClose: true,
    connectedAtFinal: false,
    disconnected: event,
    serverClose: event,
    processExit: { firstMs: 14, count: 1 },
    rawClose: { calledMs: 2, settledMs: 14, outcome: "fulfilled" },
    closeWrapper: { calledMs: 2, settledMs: 14, outcome: "fulfilled", timeoutObservedMs: null },
    rawKill: unused,
  };
  expect(validBrowserCloseTimeline(timeline, record)).toBe(true);
  for (const changed of [
    { finalized: false },
    { invocationId: "42-2" },
    { finalMs: null },
    { processExit: { firstMs: 15, count: 1 } },
    { serverClose: { firstMs: 15, count: 1 } },
    { rawClose: { calledMs: 2, settledMs: 15, outcome: "fulfilled" } },
    { closeWrapper: { ...timeline.closeWrapper, outcome: "threw" } },
    { disconnected: { firstMs: null, count: 0, endpoint: "unexpected" } },
  ])
    expect(validBrowserCloseTimeline({ ...timeline, ...changed }, record)).toBe(false);
});

test("workflow registers diagnostic only on explicit manual selection", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/check.yml"), "utf8");
  expect(workflow).toContain("browser-close-diagnostic:");
  expect(workflow).toContain("--diagnostic-identity");
  expect(workflow).toContain("--browser-close-diagnostic");
  expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow).toContain("inputs.diagnostic == 'browser-close-v1-l4'");
  expect(workflow).toContain("os: [ubuntu-latest, macos-latest]");
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
  ).toThrow(/discovered 0 tests; needs 17/);
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
  expect(suite).toMatchObject({ project: "protocol", minimumTests: 21 });
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
  expect(suite).toMatchObject({ project: "protocol", minimumTests: 22 });
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
    ["terminal-model", 13],
    ["engine-recovery", 9],
    ["engine-parser", 9],
    ["engine-query", 11],
    ["engine-preview", 11],
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

test("native adapter and worker execution suites cannot disappear or shrink", async () => {
  for (const [name, minimumTests] of [
    ["native-adapter-factory", 22],
    ["native-adapter-input", 14],
    ["native-adapter-real", 6],
    ["run-session", 36],
    ["worker-execution", 35],
    ["run-session-real", 1],
    ["pipe-endpoint", 34],
    ["main-shutdown", 1],
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

test("compiled worker qualification suites cannot disappear or shrink", async () => {
  for (const [name, minimumTests] of [
    ["public-delivery", 1],
    ["qualification-identity", 23],
    ["fifo-reader-ownership", 3],
    ["qualification-bulk-control", 1],
    ["pipe-main-real", 6],
    ["qualification-finite", 7],
    ["physical-stall", 1],
    ["worker-fairness-real", 1],
  ]) {
    const file = `tests/integration/terminal-worker/${name}.test.mjs`;
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

test("W1 evidence suites reject missing, short, duplicate and unknown identities", async () => {
  for (const [name, minimumTests] of [
    ["worker-native-spawn-failure", 1],
    ["worker-query-observation", 2],
    ["worker-timing", 7],
  ]) {
    const file = `tests/integration/terminal-worker/${name}.test.mjs`;
    const suite = requiredSuites.find((item) => item.file === file);
    expect(suite).toMatchObject({ project: "terminal-worker", minimumTests });
    expect(await readVitestOwnedTestFiles()).toContain(file);
    const cases = Array.from({ length: minimumTests }, (_, index) => ({
      projectName: "terminal-worker",
      file: resolve(root, file),
      name: `case ${index}`,
    }));
    expect(() => verifyDiscovery([], [file], [suite])).toThrow(/discovered 0 tests/);
    expect(() => verifyDiscovery(cases.slice(0, -1), [file], [suite])).toThrow(/needs/);
    expect(verifyDiscovery(cases, [file], [suite]).found.get(`terminal-worker:${file}`)).toBe(
      minimumTests,
    );
    expect(() => verifyDiscovery([...cases, cases[0]], [file], [suite])).toThrow(
      /Duplicate discovered identity/,
    );
    expect(() =>
      verifyDiscovery(
        [...cases, { ...cases[0], name: "unknown", file: resolve(root, "other.test.mjs") }],
        [file],
        [suite],
      ),
    ).toThrow(/Unregistered Vitest suite/);
  }
});

test("finite registered templates require every exact expanded runtime identity", () => {
  const groups = Map.groupBy(finiteRuntimeExpansions, ({ project, file }) => `${project}:${file}`);
  for (const expansions of groups.values()) {
    const { project, file } = expansions[0];
    const suite = { project, file, minimumTests: expansions.length };
    const discovered = expansions.map((expansion) => ({
      projectName: project,
      file: resolve(root, file),
      name: expansion.template,
    }));
    const names = expansions.flatMap((expansion) => expansion.names);
    const assertion = (name) => {
      const parts = name.split(" > ");
      return {
        ancestorTitles: parts.slice(0, -1),
        title: parts.at(-1),
        fullName: parts.join(" "),
        status: "passed",
      };
    };
    const execution = {
      success: true,
      numTotalTests: names.length,
      numPassedTests: names.length,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: resolve(root, file),
          status: "passed",
          assertionResults: names.map(assertion),
        },
      ],
    };
    expect(verifyInventory(discovered, execution, [file], [suite])).toEqual([
      {
        project,
        file,
        discovered: expansions.length,
        passed: names.length,
      },
    ]);
    const missing = structuredClone(execution);
    missing.testResults[0].assertionResults.pop();
    expect(() => verifyInventory(discovered, missing, [file], [suite])).toThrow(
      /Parameterized runtime identities differ/,
    );
    const extra = structuredClone(execution);
    extra.testResults[0].assertionResults.push(assertion("unregistered extra parameter"));
    expect(() => verifyInventory(discovered, extra, [file], [suite])).toThrow(
      /Parameterized runtime identities differ/,
    );
    const duplicate = structuredClone(execution);
    duplicate.testResults[0].assertionResults[
      duplicate.testResults[0].assertionResults.length - 1
    ] = assertion(names[0]);
    expect(() => verifyInventory(discovered, duplicate, [file], [suite])).toThrow(
      /Parameterized runtime identities differ/,
    );
    const renamed = structuredClone(execution);
    renamed.testResults[0].assertionResults[renamed.testResults[0].assertionResults.length - 1] =
      assertion("unregistered parameter");
    expect(() => verifyInventory(discovered, renamed, [file], [suite])).toThrow(
      /Parameterized runtime identities differ/,
    );
    const renamedTemplate = discovered.map((test, index) =>
      index === 0 ? { ...test, name: "renamed template" } : test,
    );
    expect(() => verifyInventory(renamedTemplate, execution, [file], [suite])).toThrow(
      /Missing parameterized declaration/,
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
    ...Array.from({ length: 4 }, (_, index) => ({
      projectName: "tooling",
      file: resolve(root, first),
      name: `project reference ${index}`,
    })),
    ...Array.from({ length: 38 }, (_, index) => ({
      projectName: "tooling",
      file: resolve(root, second),
      name: `gate ${index}`,
    })),
  ];
  expect(() => verifyDiscovery(complete, [first, second], requiredGateSuites)).not.toThrow();
  expect(() => verifyDiscovery(complete.slice(0, -1), [first, second], requiredGateSuites)).toThrow(
    /discovered 37 tests; needs 38/,
  );
});

test("scans Vitest-owned tooling tests without capturing browser specs", async () => {
  const checkout = await mkdtemp(resolve(tmpdir(), "cove-ci-scan-"));
  temporaryDirectories.push(checkout);
  await mkdir(resolve(checkout, "tests/tooling"), { recursive: true });
  await mkdir(resolve(checkout, "apps/cli/tests"), { recursive: true });
  await mkdir(resolve(checkout, "apps/server/tests/author"), { recursive: true });
  await mkdir(resolve(checkout, "apps/server/tests/independent"), { recursive: true });
  await mkdir(resolve(checkout, "tests/browser"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-engine/probes"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-engine/tests"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-worker/tests"), { recursive: true });
  await mkdir(resolve(checkout, "tests/integration/terminal-worker"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-web/probes"), { recursive: true });
  await mkdir(resolve(checkout, "packages/terminal-web/tests"), { recursive: true });
  await mkdir(resolve(checkout, "packages/protocol/tests"), { recursive: true });
  await mkdir(resolve(checkout, "packages/client/tests"), { recursive: true });
  await writeFile(resolve(checkout, "tests/tooling/registered.test.ts"), "");
  await writeFile(resolve(checkout, "apps/cli/tests/scenarios.test.mjs"), "");
  await writeFile(resolve(checkout, "apps/server/tests/author/runtime.test.mjs"), "");
  await writeFile(resolve(checkout, "apps/server/tests/independent/contract.test.mjs"), "");
  await writeFile(resolve(checkout, "tests/tooling/excluded.spec.ts"), "");
  await writeFile(resolve(checkout, "tests/browser/terminal.spec.ts"), "");
  await writeFile(resolve(checkout, "packages/terminal-engine/probes/native.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-engine/tests/engine.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-worker/tests/native.test.mjs"), "");
  await writeFile(resolve(checkout, "tests/integration/terminal-worker/real.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-web/probes/browser.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/terminal-web/tests/view-input.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/protocol/tests/metadata.test.mjs"), "");
  await writeFile(resolve(checkout, "packages/client/tests/contract.test.mjs"), "");
  expect(await readVitestOwnedTestFiles(checkout)).toEqual([
    "apps/cli/tests/scenarios.test.mjs",
    "apps/server/tests/author/runtime.test.mjs",
    "apps/server/tests/independent/contract.test.mjs",
    "packages/client/tests/contract.test.mjs",
    "packages/protocol/tests/metadata.test.mjs",
    "packages/terminal-engine/probes/native.test.mjs",
    "packages/terminal-engine/tests/engine.test.mjs",
    "packages/terminal-web/probes/browser.test.mjs",
    "packages/terminal-web/tests/view-input.test.mjs",
    "packages/terminal-worker/tests/native.test.mjs",
    "tests/integration/terminal-worker/real.test.mjs",
    "tests/tooling/excluded.spec.ts",
    "tests/tooling/registered.test.ts",
  ]);
});

test("W2 retained and current suites reject missing, short, duplicate and unknown discovery", async () => {
  for (const [project, file, minimumTests] of [
    ["terminal-engine", "packages/terminal-engine/tests/engine-preview.test.mjs", 11],
    ["terminal-worker", "packages/terminal-worker/tests/pipe-endpoint.test.mjs", 34],
    ["terminal-worker", "packages/terminal-worker/tests/worker-execution.test.mjs", 35],
    ["terminal-worker", "packages/terminal-worker/tests/worker-flow.test.mjs", 16],
    ["terminal-worker", "packages/terminal-worker/tests/worker-preview.test.mjs", 5],
    ["terminal-worker", "packages/terminal-worker/tests/worker-recovery-clock.test.mjs", 3],
    ["terminal-worker", "packages/terminal-worker/tests/worker-recovery-reservations.test.mjs", 5],
    ["terminal-worker", "packages/terminal-worker/tests/worker-recovery.test.mjs", 9],
    ["terminal-worker", "packages/terminal-worker/tests/independent/current-recovery.test.mjs", 13],
    ["terminal-worker", "packages/terminal-worker/tests/independent/current-preview.test.mjs", 7],
    [
      "terminal-worker",
      "packages/terminal-worker/tests/independent/current-retention-input.test.mjs",
      10,
    ],
    ["terminal-engine", "packages/terminal-engine/tests/independent/current-capture.test.mjs", 4],
    ["server", "apps/server/tests/independent/current-worker-consumer.test.mjs", 5],
    [
      "terminal-worker",
      "packages/terminal-worker/tests/independent/current-shared-native-input.test.mjs",
      2,
    ],
  ]) {
    const suite = requiredSuites.find((item) => item.file === file);
    expect(suite).toMatchObject({ project, minimumTests });
    expect(await readVitestOwnedTestFiles()).toContain(file);
    const cases = Array.from({ length: minimumTests }, (_, index) => ({
      projectName: project,
      file: resolve(root, file),
      name: `case ${index}`,
    }));
    expect(() => verifyDiscovery([], [file], [suite])).toThrow(/discovered 0 tests/);
    expect(() => verifyDiscovery(cases.slice(0, -1), [file], [suite])).toThrow(/needs/);
    expect(verifyDiscovery(cases, [file], [suite]).found.get(`${project}:${file}`)).toBe(
      minimumTests,
    );
    expect(() => verifyDiscovery([...cases, cases[0]], [file], [suite])).toThrow(
      /Duplicate discovered identity/,
    );
    expect(() =>
      verifyDiscovery(
        [...cases, { ...cases[0], name: "unknown", file: resolve(root, "other.test.mjs") }],
        [file],
        [suite],
      ),
    ).toThrow(/Unregistered Vitest suite/);
  }
});

function binaryControlProgram(directory, bytes, exitCode = 0, tail = "") {
  return `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(resolve(directory, "birth.json"))}, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv}));
    const pattern = Buffer.from([0,255,195,169,226,130,172,128,65]);
    for (const fd of [1,2]) {
      const data = Buffer.alloc(${bytes});
      for (let i=0; i<data.length; i++) data[i] = pattern[fd === 1 ? i % pattern.length : pattern.length - 1 - i % pattern.length];
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    }
    ${tail}
    process.exit(${exitCode});
  `;
}

async function binaryReplaySink(path, metadataFile) {
  const handle = await open(path, "wx");
  const observations = {
    chunks: 0,
    maxChunk: 0,
    backpressure: 0,
    drains: 0,
    metadataBeforeReplay: null,
  };
  const destination = new Writable({
    highWaterMark: 1024,
    write(chunk, encoding, callback) {
      if (observations.metadataBeforeReplay === null && metadataFile) {
        observations.metadataBeforeReplay = JSON.parse(readFileSync(metadataFile, "utf8"));
      }
      observations.chunks++;
      observations.maxChunk = Math.max(observations.maxChunk, chunk.length);
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("Control replay write made no progress");
          offset += bytesWritten;
        }
      })().then(() => callback(), callback);
    },
  });
  const write = destination.write;
  destination.write = function (...args) {
    const accepted = write.apply(this, args);
    if (!accepted) observations.backpressure++;
    return accepted;
  };
  destination.on("drain", () => observations.drains++);
  return { destination, observations, close: () => handle.close() };
}

async function preserveBinaryControl(name, directory, observations) {
  let record;
  try {
    record = JSON.parse(await readFile(resolve(directory, "execution.json"), "utf8"))[0];
  } catch {
    try {
      record = JSON.parse(await readFile(resolve(directory, "check.json"), "utf8"));
    } catch {
      record = observations.attempt;
    }
  }
  observations.descriptors = {};
  for (const stream of ["stdout", "stderr"]) {
    const fd = record?.outputCapture?.[stream]?.fd;
    if (fd === null || fd === undefined) continue;
    try {
      fstatSync(fd);
      observations.descriptors[stream] = { fd, state: "OPEN" };
    } catch (error) {
      observations.descriptors[stream] = { fd, errorCode: error.code };
    }
  }
  if (record?.childPid > 0) {
    try {
      process.kill(record.childPid, 0);
      observations.child = { pid: record.childPid, state: "LIVE" };
    } catch (error) {
      observations.child = { pid: record.childPid, errorCode: error.code };
    }
  }
  await writeFile(
    resolve(directory, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  if (process.env.COVE_CI_CAPTURE_CONTROL_OUTPUT) {
    const target = resolve(process.env.COVE_CI_CAPTURE_CONTROL_OUTPUT, name);
    await mkdir(dirname(target), { recursive: true });
    await cp(directory, target, { recursive: true, errorOnExist: true, force: false });
  }
}

function binaryControlExpected(bytes, reverse = false) {
  const pattern = [0, 255, 195, 169, 226, 130, 172, 128, 65];
  return Buffer.from(
    Array.from({ length: bytes }, (_, i) => pattern[reverse ? 8 - (i % 9) : i % 9]),
  );
}

function assertCapturedDescriptorsClosed(capture) {
  for (const stream of ["stdout", "stderr"]) {
    expect(capture[stream].closed).toBe(true);
    expect(() => fstatSync(capture[stream].fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  }
}

test("ordinary Vitest preserves large binary streams and durable metadata through real backpressure", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  const stdout = await binaryReplaySink(resolve(directory, "replayed.stdout.bin"), outputFile);
  const stderr = await binaryReplaySink(resolve(directory, "replayed.stderr.bin"), outputFile);
  let result;
  try {
    result = await recordedCommand(
      "vitest",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 786432)],
      outputFile,
      120_000,
      { fileCapture: true, stdout: stdout.destination, stderr: stderr.destination },
    );
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("gate-large-success", directory, {
      stdout: stdout.observations,
      stderr: stderr.observations,
    });
  }
  expect(result.status).toBe(0);
  expect(result.stdout).toBeNull();
  expect(result.stderr).toBeNull();
  const [record] = JSON.parse(await readFile(outputFile, "utf8"));
  const birth = JSON.parse(await readFile(resolve(directory, "birth.json"), "utf8"));
  expect(record.childPid).toBe(birth.pid);
  expect(() => process.kill(birth.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  assertCapturedDescriptorsClosed(record.outputCapture);
  for (const [stream, sink] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    const expected = binaryControlExpected(786432, stream === "stderr");
    expect(await readFile(resolve(directory, `vitest.${stream}.bin`))).toEqual(expected);
    expect(await readFile(resolve(directory, `replayed.${stream}.bin`))).toEqual(expected);
    expect(record.outputCapture[stream]).toMatchObject({
      bytes: 786432,
      complete: true,
      sha256: createHash("sha256").update(expected).digest("hex"),
    });
    expect(sink.observations.maxChunk).toBeLessThanOrEqual(65536);
    expect(sink.observations.backpressure).toBeGreaterThan(0);
    expect(sink.observations.drains).toBeGreaterThan(0);
    expect(sink.observations.metadataBeforeReplay[0].outputCapture[stream].bytes).toBe(786432);
  }
});

test("ordinary Vitest retains nonzero exit API with complete binary output", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  const stdout = await binaryReplaySink(resolve(directory, "replayed.stdout.bin"), outputFile);
  const stderr = await binaryReplaySink(resolve(directory, "replayed.stderr.bin"), outputFile);
  let result;
  try {
    result = await recordedCommand(
      "vitest",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 786432, 7)],
      outputFile,
      120_000,
      { fileCapture: true, stdout: stdout.destination, stderr: stderr.destination },
    );
  } finally {
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("gate-large-exit7", directory, {
      stdout: stdout.observations,
      stderr: stderr.observations,
    });
  }
  expect(result.status).toBe(7);
  expect(result.error).toBeUndefined();
  const [record] = JSON.parse(await readFile(outputFile, "utf8"));
  expect(record).toMatchObject({ exitCode: 7, errorCode: null, timedOut: false });
  for (const stream of ["stdout", "stderr"]) {
    expect(await readFile(resolve(directory, `replayed.${stream}.bin`))).toEqual(
      binaryControlExpected(786432, stream === "stderr"),
    );
    expect(record.outputCapture[stream]).toMatchObject({ complete: true, bytes: 786432 });
  }
});

test("ordinary Vitest preserves timeout and ENOENT with closed binary descriptors before throwing", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  const stdout = await binaryReplaySink(resolve(directory, "replayed.stdout.bin"), outputFile);
  const stderr = await binaryReplaySink(resolve(directory, "replayed.stderr.bin"), outputFile);
  const expected = Buffer.from([0, 255, 1, 2]);
  const prefixPath = resolve(directory, "vitest.stdout.bin");
  const actualOpen = filesystem.open;
  let capturePrefix;
  const captureOpen = vi.spyOn(filesystem, "open").mockImplementation(async function (...args) {
    const handle = await Reflect.apply(actualOpen, this, args);
    if (String(args[0]) !== prefixPath) return handle;
    try {
      await handle.writeFile(expected);
      const bytes = await readFile(prefixPath);
      capturePrefix = {
        origin: "fixture-real-descriptor-before-child-timeout",
        path: prefixPath,
        fd: handle.fd,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        raw: Array.from(bytes),
      };
      return handle;
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        error.secondaryErrors = [...(error.secondaryErrors ?? []), closeError];
      }
      throw error;
    }
  });
  let failure;
  try {
    await recordedCommand(
      "vitest",
      process.execPath,
      [
        "--eval",
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(resolve(directory, "birth.json"))}, JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));setInterval(() => {}, 1000)`,
      ],
      outputFile,
      50,
      { fileCapture: true, stdout: stdout.destination, stderr: stderr.destination },
    );
  } catch (error) {
    failure = error;
  } finally {
    captureOpen.mockRestore();
    await stdout.close();
    await stderr.close();
    await preserveBinaryControl("gate-timeout50", directory, {
      error: { code: failure?.code, message: failure?.message },
      capturePrefix,
      stdout: stdout.observations,
      stderr: stderr.observations,
    });
  }
  expect(failure).toMatchObject({
    code: "ETIMEDOUT",
    ciOutputAttempt: { timeoutMs: 50, timedOut: true },
  });
  assertCapturedDescriptorsClosed(failure.ciOutputAttempt.outputCapture);
  expect(await readFile(resolve(directory, "vitest.stdout.bin"))).toEqual(expected);
  expect(() => process.kill(failure.ciOutputAttempt.childPid, 0)).toThrow(
    expect.objectContaining({ code: "ESRCH" }),
  );
  const absentFile = await isolatedEvidence();
  const absentDirectory = dirname(absentFile);
  let absent;
  try {
    await recordedCommand("vitest", resolve(absentDirectory, "absent"), [], absentFile, 50, {
      fileCapture: true,
    });
  } catch (error) {
    absent = error;
  }
  await preserveBinaryControl("gate-enoent", absentDirectory, {
    error: { code: absent?.code, message: absent?.message },
  });
  expect(absent).toMatchObject({
    code: "ENOENT",
    ciOutputAttempt: { errorCode: "ENOENT", timedOut: false },
  });
  assertCapturedDescriptorsClosed(absent.ciOutputAttempt.outputCapture);
});

test("ordinary Vitest fails closed before launching when binary custody preparation fails", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  await mkdir(resolve(directory, "vitest.stderr.bin"));
  let failure;
  try {
    await recordedCommand(
      "vitest",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 4)],
      outputFile,
      50,
      { fileCapture: true },
    );
  } catch (error) {
    failure = error;
  }
  await preserveBinaryControl("gate-prepare-failure", directory, {
    error: { code: failure?.code, message: failure?.message },
  });
  expect(failure.ciOutputAttempt).toMatchObject({ childPid: null, exitCode: null });
  expect(failure.custodyErrors).toEqual(
    expect.arrayContaining([expect.objectContaining({ phase: "prepare" })]),
  );
  expect(failure.ciOutputAttempt.outputCapture.stdout.closed).toBe(true);
  expect(() => readFileSync(resolve(directory, "birth.json"))).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});

test("ordinary Vitest keeps the original timeout error primary through a real descriptor close failure", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  const actualOpen = filesystem.open.bind(filesystem);
  let closeCalls = 0;
  let descriptor;
  vi.spyOn(filesystem, "open").mockImplementation(async (path, flags) => {
    const handle = await actualOpen(path, flags);
    if (String(path).endsWith("vitest.stdout.bin")) {
      descriptor = handle.fd;
      const actualClose = handle.close.bind(handle);
      handle.close = async () => {
        closeCalls++;
        await actualClose();
        throw Object.assign(
          new Error("Controlled close acknowledgement failure after real close"),
          { code: "EIO" },
        );
      };
    }
    return handle;
  });
  let failure;
  try {
    await recordedCommand(
      "vitest",
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      outputFile,
      50,
      { fileCapture: true },
    );
  } catch (error) {
    failure = error;
  }
  vi.restoreAllMocks();
  await preserveBinaryControl("gate-close-failure", directory, {
    closeCalls,
    descriptor,
    error: { code: failure?.code, message: failure?.message },
    custodyErrors: failure?.custodyErrors,
  });
  expect(failure.code).toBe("ETIMEDOUT");
  expect(closeCalls).toBe(1);
  expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(failure.custodyErrors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: "close", code: "EIO", stream: "stdout" }),
    ]),
  );
  expect(failure.ciOutputAttempt.outputCapture.stdout).toMatchObject({
    complete: true,
    closed: false,
  });
});

test("ordinary Vitest fails closed on missing binary hash input without inventing a child status", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  let failure;
  try {
    await recordedCommand(
      "vitest",
      process.execPath,
      [
        "--eval",
        binaryControlProgram(
          directory,
          4,
          7,
          `fs.unlinkSync(${JSON.stringify(resolve(directory, "vitest.stdout.bin"))});`,
        ),
      ],
      outputFile,
      120_000,
      {
        fileCapture: true,
        stderr: new Writable({
          write(chunk, encoding, callback) {
            callback();
          },
        }),
      },
    );
  } catch (error) {
    failure = error;
  }
  await preserveBinaryControl("gate-hash-failure", directory, {
    error: { code: failure?.code, message: failure?.message },
    custodyErrors: failure?.custodyErrors,
  });
  expect(failure.ciOutputAttempt.exitCode).toBe(7);
  expect(failure.custodyErrors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: "hash", stream: "stdout", code: "ENOENT" }),
    ]),
  );
  expect(failure.ciOutputAttempt.outputCapture.stdout.complete).toBe(false);
});

test("ordinary Vitest records replay failure after durable binary custody", async () => {
  const outputFile = await isolatedEvidence();
  const directory = dirname(outputFile);
  const failureSink = new Writable({
    write(chunk, encoding, callback) {
      callback(
        Object.assign(new Error("Controlled replay destination failure"), { code: "EPIPE" }),
      );
    },
  });
  let failure;
  try {
    await recordedCommand(
      "vitest",
      process.execPath,
      ["--eval", binaryControlProgram(directory, 4)],
      outputFile,
      120_000,
      {
        fileCapture: true,
        stdout: failureSink,
        stderr: new Writable({
          write(chunk, encoding, callback) {
            callback();
          },
        }),
      },
    );
  } catch (error) {
    failure = error;
  }
  await preserveBinaryControl("gate-replay-failure", directory, {
    error: { code: failure?.code, message: failure?.message },
    custodyErrors: failure?.custodyErrors,
  });
  expect(failure.code).toBe("EPIPE");
  expect(failure.ciOutputAttempt).toMatchObject({ exitCode: 0, errorCode: null });
  expect(failure.ciOutputAttempt.outputCapture.stdout).toMatchObject({ complete: true, bytes: 4 });
  expect(JSON.parse(await readFile(outputFile, "utf8"))[0].outputCapture.custodyErrors).toEqual(
    expect.arrayContaining([expect.objectContaining({ phase: "replay", code: "EPIPE" })]),
  );
});
