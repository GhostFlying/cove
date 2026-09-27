import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(root, ".cache/ci");
const resultPath = join(evidenceDir, "vitest-results.json");
const junitPath = join(evidenceDir, "vitest-results.xml");
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const diagnosticDir = join(evidenceDir, "browser-close-diagnostic");
const diagnosticName =
  "V1-L4 publishes focus before input but not for selection scrolling appearance or show";
const diagnosticFile = "packages/terminal-web/tests/view-lifecycle.test.mjs";
const diagnosticBase = "c47b11dffe5690e359e04d873428e5d107182bf0";
const diagnosticFiles = new Set([
  ".github/workflows/check.yml",
  "docs/handoff.md",
  "docs/tasks/m0-p3a-browser-close-diagnostic-plan.md",
  "docs/tasks/m0-p3a-browser-close-diagnostic-repair-plan.md",
  "docs/tasks/m0-p3a-browser-close-diagnostic-results.md",
  "packages/terminal-web/probes/node/managed-browser.ts",
  "packages/terminal-web/probes/managed-browser-timeline.test.mjs",
  "packages/terminal-web/tests/view-browser-runner.mjs",
  "scripts/ci-test-gate.mjs",
  "tests/tooling/ci-test-gate.test.mjs",
]);

export function validateBrowserCloseDiagnosticInvocation(input) {
  if (
    input.eventName !== "workflow_dispatch" ||
    input.mode !== "browser-close-v1-l4" ||
    input.ref !== "refs/heads/p/luchengxuan/m0-browser-close-diagnostic" ||
    !/^[a-f0-9]{40}$/.test(input.expectedSha ?? "") ||
    input.head !== input.expectedSha ||
    input.githubSha !== input.expectedSha ||
    input.dirty !== false ||
    input.baseIsAncestor !== true ||
    !Array.isArray(input.changedFiles) ||
    input.changedFiles.length === 0 ||
    input.changedFiles.some((file) => !diagnosticFiles.has(file))
  )
    throw new Error("Browser-close diagnostic dispatch identity or source scope is invalid");
  return { mode: input.mode, ref: input.ref, sourceCommit: input.head, base: diagnosticBase };
}

export function verifyBrowserCloseDiagnosticSelection(report) {
  const suites = report?.testResults;
  const assertions = suites?.[0]?.assertionResults;
  if (!Array.isArray(suites) || suites.length !== 1 || !Array.isArray(assertions))
    throw new Error("Browser-close diagnostic did not execute exactly V1-L4");
  const executed = assertions.filter((assertion) => assertion.status !== "skipped");
  const status = executed[0]?.status;
  if (
    !["passed", "failed"].includes(status) ||
    report.success !== (status === "passed") ||
    report.numTotalTests !== assertions.length ||
    report.numPassedTests !== (status === "passed" ? 1 : 0) ||
    report.numFailedTests !== (status === "failed" ? 1 : 0) ||
    report.numPendingTests !== assertions.length - 1 ||
    report.numTodoTests !== 0 ||
    repositoryPath(suites[0].name) !== diagnosticFile ||
    suites[0].status !== status ||
    executed.length !== 1 ||
    executed[0].fullName !== diagnosticName
  )
    throw new Error("Browser-close diagnostic did not execute exactly V1-L4");
  return { outcome: status, cases: [{ file: diagnosticFile, name: diagnosticName }] };
}

export function verifyBrowserCloseDiagnosticReport(report) {
  const selected = verifyBrowserCloseDiagnosticSelection(report);
  if (selected.outcome !== "passed")
    throw new Error("Browser-close diagnostic did not pass exactly V1-L4");
  return selected.cases;
}

function gitText(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error)
    throw new Error(`Diagnostic git identity failed: ${args[0]}`);
  return result.stdout.trim();
}

async function diagnosticIdentity() {
  const head = gitText("rev-parse", "HEAD");
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", diagnosticBase, "HEAD"], {
    cwd: root,
  });
  const identity = validateBrowserCloseDiagnosticInvocation({
    eventName: process.env.GITHUB_EVENT_NAME,
    mode: process.env.COVE_DIAGNOSTIC_MODE,
    ref: process.env.GITHUB_REF,
    expectedSha: process.env.COVE_DIAGNOSTIC_EXPECTED_SHA,
    githubSha: process.env.GITHUB_SHA,
    head,
    dirty: gitText("status", "--porcelain", "--untracked-files=normal") !== "",
    baseIsAncestor: ancestry.status === 0,
    changedFiles: gitText("diff", "--name-only", diagnosticBase, "HEAD").split("\n"),
  });
  await mkdir(diagnosticDir, { recursive: true });
  const fullIdentity = { ...identity, tree: gitText("rev-parse", "HEAD^{tree}") };
  await writeFile(
    join(diagnosticDir, "identity.json"),
    `${JSON.stringify(fullIdentity, null, 2)}\n`,
  );
  return fullIdentity;
}

async function installedBrowserProvenance(identity, runId) {
  const requireWeb = createRequire(join(root, "packages/terminal-web/package.json"));
  const playwrightPath = requireWeb.resolve("playwright/package.json");
  const requirePlaywright = createRequire(playwrightPath);
  const corePath = requirePlaywright.resolve("playwright-core/package.json");
  const [playwright, core, browsers] = await Promise.all([
    readFile(playwrightPath, "utf8").then(JSON.parse),
    readFile(corePath, "utf8").then(JSON.parse),
    readFile(join(dirname(corePath), "browsers.json"), "utf8").then(JSON.parse),
  ]);
  const chromium = browsers.browsers?.filter((entry) => entry.name === "chromium");
  const provenance = {
    sourceCommit: identity.sourceCommit,
    tree: identity.tree,
    runId,
    githubRunId: process.env.GITHUB_RUN_ID,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    playwright: playwright.version ?? null,
    playwrightCore: core.version ?? null,
    chromiumRevision: chromium?.[0]?.revision ?? null,
    chromiumVersion: chromium?.[0]?.browserVersion ?? null,
    browserReportedVersion: null,
  };
  await writeFile(
    join(diagnosticDir, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  if (
    provenance.playwright !== "1.63.0" ||
    provenance.playwrightCore !== "1.63.0" ||
    chromium?.length !== 1 ||
    provenance.chromiumRevision !== "1243" ||
    !/^\d+(?:\.\d+){1,3}$/.test(provenance.chromiumVersion ?? "")
  )
    throw new Error("Browser-close diagnostic installed browser dependency differs from pins");
  return provenance;
}

export function bindDiagnosticBrowserVersion(provenance, record) {
  const version = record.browserVersion;
  if (version !== null && version !== provenance.chromiumVersion)
    throw new Error("Browser-close diagnostic reported browser version differs from installed pin");
  return { ...provenance, browserReportedVersion: version };
}

export function validDiagnosticBrowserProvenance(provenance, identity, runId, record) {
  return (
    provenance.sourceCommit === identity.sourceCommit &&
    provenance.tree === identity.tree &&
    provenance.runId === runId &&
    provenance.playwright === "1.63.0" &&
    provenance.playwrightCore === "1.63.0" &&
    provenance.chromiumRevision === "1243" &&
    /^\d+(?:\.\d+){1,3}$/.test(provenance.chromiumVersion ?? "") &&
    provenance.browserReportedVersion === record.browserVersion &&
    (record.browserVersion === null || record.browserVersion === provenance.chromiumVersion) &&
    (!runId.startsWith("github-") ||
      runId === `github-${provenance.githubRunId}-${provenance.githubRunAttempt}`)
  );
}

// Adding a real suite requires registering its project and file here in the same PR.
export const requiredSuites = [
  { project: "client", file: "packages/client/tests/connection-rpc.test.mjs", minimumTests: 59 },
  { project: "client", file: "packages/client/tests/compiled-client.test.mjs", minimumTests: 4 },
  { project: "protocol", file: "packages/protocol/tests/metadata.test.mjs", minimumTests: 7 },
  { project: "protocol", file: "packages/protocol/tests/frame.test.mjs", minimumTests: 8 },
  { project: "protocol", file: "packages/protocol/tests/composition.test.mjs", minimumTests: 5 },
  {
    project: "protocol",
    file: "packages/protocol/tests/supported-terminal.test.mjs",
    minimumTests: 14,
  },
  { project: "protocol", file: "packages/protocol/tests/supported-pipe.test.mjs", minimumTests: 8 },
  { project: "protocol", file: "packages/protocol/tests/admission-rpc.test.mjs", minimumTests: 17 },
  {
    project: "protocol",
    file: "packages/protocol/tests/consumer-contracts.test.mjs",
    minimumTests: 12,
  },
  { project: "tooling", file: "tests/tooling/project-references.test.ts", minimumTests: 3 },
  { project: "tooling", file: "tests/tooling/ci-test-gate.test.mjs", minimumTests: 37 },
  { project: "tooling", file: "tests/tooling/ci-environment-setup.test.mjs", minimumTests: 3 },
  { project: "tooling", file: "tests/tooling/package-boundaries.test.ts", minimumTests: 7 },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/terminal-model.test.mjs",
    minimumTests: 11,
  },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/engine-recovery.test.mjs",
    minimumTests: 9,
  },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/engine-parser.test.mjs",
    minimumTests: 9,
  },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/engine-query.test.mjs",
    minimumTests: 11,
  },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/engine-preview.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/environment.test.mjs",
    minimumTests: 4,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-state.test.mjs",
    minimumTests: 7,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-parser.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-query.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-boundaries.test.mjs",
    minimumTests: 10,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-join.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-geometry.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-source-derived.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-engine-probes",
    file: "packages/terminal-engine/probes/recovery-pragmatic.test.mjs",
    minimumTests: 37,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-qualification.test.mjs",
    minimumTests: 4,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-owner.test.mjs",
    minimumTests: 12,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-reuse.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-lifecycle.test.mjs",
    minimumTests: 2,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-rollback.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-fault.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-churn.test.mjs",
    minimumTests: 2,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-spawn-contract.test.mjs",
    minimumTests: 11,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-write-owned-stop.test.mjs",
    minimumTests: 10,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-adapter-factory.test.mjs",
    minimumTests: 18,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-adapter-input.test.mjs",
    minimumTests: 7,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-adapter-real.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/run-session.test.mjs",
    minimumTests: 26,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/run-session-real.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-web-probes",
    file: "packages/terminal-web/probes/environment.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-web-probes",
    file: "packages/terminal-web/probes/query-input.test.mjs",
    minimumTests: 11,
  },
  {
    project: "terminal-web-probes",
    file: "packages/terminal-web/probes/managed-browser-timeline.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-web",
    file: "packages/terminal-web/tests/view-input.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-web",
    file: "packages/terminal-web/tests/view-recovery.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-web",
    file: "packages/terminal-web/tests/view-lifecycle.test.mjs",
    minimumTests: 10,
  },
];

function repositoryPath(path) {
  const local = relative(root, path).split(sep).join("/");
  if (!local || local.startsWith("../") || local === "..") {
    throw new Error(`Test path is outside the checkout: ${path}`);
  }
  return local;
}

export function verifyDiscovery(discovered, sourceFiles, suites = requiredSuites) {
  const expected = new Map(suites.map((suite) => [`${suite.project}:${suite.file}`, suite]));
  if (expected.size !== suites.length || expected.size === 0) {
    throw new Error("Required suite inventory is empty or contains duplicates");
  }
  const found = new Map();
  for (const test of discovered) {
    const file = repositoryPath(test.file);
    const key = `${test.projectName}:${file}`;
    if (!expected.has(key)) throw new Error(`Unregistered Vitest suite: ${key}`);
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  for (const [key, suite] of expected) {
    if ((found.get(key) ?? 0) < suite.minimumTests) {
      throw new Error(
        `Required suite ${key} discovered ${found.get(key) ?? 0} tests; needs ${suite.minimumTests}`,
      );
    }
  }
  const discoveredFiles = new Set(discovered.map((test) => repositoryPath(test.file)));
  for (const file of sourceFiles) {
    if (!discoveredFiles.has(file))
      throw new Error(`Test file is absent from Vitest discovery: ${file}`);
  }
  return { expected, found, discoveredFiles };
}

export function verifyInventory(discovered, report, sourceFiles, suites = requiredSuites) {
  const { expected, found, discoveredFiles } = verifyDiscovery(discovered, sourceFiles, suites);
  if (!report || report.success !== true || !Array.isArray(report.testResults)) {
    throw new Error("Vitest JSON result is absent or unsuccessful");
  }
  const results = new Map();
  for (const suite of report.testResults) {
    const file = repositoryPath(suite.name);
    if (!discoveredFiles.has(file) || results.has(file)) {
      throw new Error(`Unexpected or duplicate Vitest result: ${file}`);
    }
    if (suite.status !== "passed" || !Array.isArray(suite.assertionResults)) {
      throw new Error(`Required suite did not pass: ${file}`);
    }
    if (suite.assertionResults.some((test) => test.status !== "passed")) {
      throw new Error(`Required suite has skipped, pending, or failed tests: ${file}`);
    }
    results.set(file, suite.assertionResults.length);
  }
  for (const [key, count] of found) {
    const file = expected.get(key).file;
    if (results.get(file) !== count) {
      throw new Error(
        `Required suite ${key} executed ${results.get(file) ?? 0} of ${count} discovered tests`,
      );
    }
  }
  const total = [...found.values()].reduce((sum, count) => sum + count, 0);
  if (
    total === 0 ||
    report.numTotalTests !== total ||
    report.numPassedTests !== total ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    throw new Error(`Vitest totals do not show ${total} executed passing tests`);
  }
  return suites.map((suite) => ({
    project: suite.project,
    file: suite.file,
    discovered: found.get(`${suite.project}:${suite.file}`),
    passed: results.get(suite.file),
  }));
}

export function viewEvidenceCases(report, inventory) {
  const registered = new Map(
    requiredSuites
      .filter((suite) => suite.project === "terminal-web")
      .map((suite) => [suite.file, suite.minimumTests]),
  );
  const viewSuites = inventory.filter((suite) => suite.project === "terminal-web");
  if (
    registered.size !== 3 ||
    viewSuites.length !== 3 ||
    viewSuites.some(
      (suite) =>
        !registered.has(suite.file) ||
        !Number.isSafeInteger(suite.passed) ||
        suite.passed < registered.get(suite.file) ||
        suite.passed !== suite.discovered,
    )
  )
    throw new Error("V1 browser suite evidence is incomplete");
  const counts = new Map(viewSuites.map((suite) => [suite.file, suite.passed]));
  if (counts.size !== registered.size) throw new Error("V1 browser suite evidence is incomplete");
  const observed = new Set();
  const cases = [];
  for (const suite of report.testResults) {
    const file = repositoryPath(suite.name);
    if (!counts.has(file)) continue;
    if (
      observed.has(file) ||
      suite.status !== "passed" ||
      !Array.isArray(suite.assertionResults) ||
      suite.assertionResults.length !== counts.get(file) ||
      suite.assertionResults.some((result) => result.status !== "passed")
    )
      throw new Error("V1 browser case evidence is incomplete");
    observed.add(file);
    cases.push(
      ...suite.assertionResults.map((result) => ({
        file,
        name: result.fullName,
        status: result.status,
      })),
    );
  }
  if (observed.size !== counts.size) throw new Error("V1 browser case evidence is incomplete");
  return cases;
}

async function recordViewEvidence(report, inventory) {
  const source = await recordedCommand(
    "source-revision",
    "git",
    ["rev-parse", "HEAD", "HEAD^{tree}"],
    join(evidenceDir, "execution.json"),
  );
  if (source.status !== 0) throw new Error(`git rev-parse exited ${source.status}`);
  const [commit, tree] = source.stdout.trim().split("\n");
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree))
    throw new Error("Source revision evidence is incomplete");
  const web = join(root, "packages/terminal-web");
  const requireWeb = createRequire(join(web, "package.json"));
  const playwrightPath = requireWeb.resolve("playwright/package.json");
  const requirePlaywright = createRequire(playwrightPath);
  const browserPath = join(
    dirname(requirePlaywright.resolve("playwright-core/package.json")),
    "browsers.json",
  );
  const [xterm, playwright, browsers, lock, profile] = await Promise.all([
    readFile(join(web, "node_modules/@xterm/xterm/package.json"), "utf8").then(JSON.parse),
    readFile(playwrightPath, "utf8").then(JSON.parse),
    readFile(browserPath, "utf8").then(JSON.parse),
    readFile(join(root, "pnpm-lock.yaml")),
    readFile(join(root, "tests/fixtures/protocol/m0/profile.json")),
  ]);
  const chromium = browsers.browsers?.filter((entry) => entry.name === "chromium");
  if (
    xterm.version !== "6.0.0" ||
    playwright.version !== "1.63.0" ||
    chromium?.length !== 1 ||
    chromium[0].revision !== "1243" ||
    !chromium[0].browserVersion
  )
    throw new Error("V1 browser dependency evidence differs from the pinned profile");
  const cases = viewEvidenceCases(report, inventory);
  const cleanup = await verifyBrowserCleanupEvidence(
    join(evidenceDir, "browser-cleanup"),
    commit,
    cases,
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const toolchain = JSON.parse(await readFile(join(evidenceDir, "environment.json"), "utf8"));
  await writeFile(
    join(evidenceDir, "view-evidence.json"),
    `${JSON.stringify(
      {
        commit,
        tree,
        platform: toolchain.platform,
        arch: toolchain.arch,
        node: toolchain.node,
        pnpm: toolchain.pnpm,
        xterm: xterm.version,
        playwright: playwright.version,
        chromiumRevision: chromium[0].revision,
        chromiumVersion: chromium[0].browserVersion,
        lockSha256: digest(lock),
        profileSha256: digest(profile),
        cases,
        cleanup: {
          basis: "withViewPage awaits withManagedBrowser cleanup before each case can pass",
          perCaseProcessRecord: true,
          directory: "browser-cleanup",
          runId: cleanup.runId,
          recordCount: cleanup.recordCount,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function testFilesIn(directory, prefix) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (["node_modules", "dist", ".cache"].includes(entry.name)) continue;
    if (entry.isDirectory()) found.push(...(await testFilesIn(join(directory, entry.name), name)));
    else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) found.push(name);
  }
  return found.sort();
}

export function readVitestOwnedTestFiles(checkoutRoot = root) {
  return Promise.all([
    testFilesIn(join(checkoutRoot, "packages/client/tests"), "packages/client/tests"),
    testFilesIn(join(checkoutRoot, "packages/protocol/tests"), "packages/protocol/tests"),
    testFilesIn(join(checkoutRoot, "tests/tooling"), "tests/tooling"),
    testFilesIn(
      join(checkoutRoot, "packages/terminal-engine/tests"),
      "packages/terminal-engine/tests",
    ),
    testFilesIn(
      join(checkoutRoot, "packages/terminal-engine/probes"),
      "packages/terminal-engine/probes",
    ),
    testFilesIn(
      join(checkoutRoot, "packages/terminal-worker/tests"),
      "packages/terminal-worker/tests",
    ),
    testFilesIn(join(checkoutRoot, "packages/terminal-web/probes"), "packages/terminal-web/probes"),
    testFilesIn(join(checkoutRoot, "packages/terminal-web/tests"), "packages/terminal-web/tests"),
  ]).then((groups) => groups.flat().sort());
}

export async function recordedCommand(stage, binary, args, outputFile, timeoutMs = 120_000) {
  const attempt = {
    stage,
    argv: [binary, ...args],
    timeoutMs,
    exitCode: null,
    signal: null,
    errorCode: null,
    timedOut: false,
  };
  let result;
  let failure;
  try {
    result = spawnSync(binary, args, {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    });
    attempt.exitCode = result.status;
    attempt.signal = result.signal;
    failure = result.error;
  } catch (error) {
    failure = error;
  }
  attempt.errorCode = failure?.code ?? null;
  attempt.timedOut = failure?.code === "ETIMEDOUT";
  await mkdir(dirname(outputFile), { recursive: true });
  let prior = [];
  try {
    prior = JSON.parse(await readFile(outputFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(outputFile, `${JSON.stringify([...prior, attempt], null, 2)}\n`);
  if (failure) throw failure;
  return result;
}

async function environment() {
  const pnpm = await recordedCommand(
    "toolchain",
    "pnpm",
    ["--version"],
    join(evidenceDir, "execution.json"),
  );
  if (pnpm.status !== 0) throw new Error(`pnpm --version exited ${pnpm.status}`);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expectedNode = pkg.engines.node;
  const expectedPnpm = pkg.engines.pnpm;
  const actualNode = process.versions.node;
  const actualPnpm = pnpm.stdout.trim();
  if (actualNode !== expectedNode || actualPnpm !== expectedPnpm) {
    throw new Error(
      `Toolchain mismatch: Node ${actualNode}/${expectedNode}, pnpm ${actualPnpm}/${expectedPnpm}`,
    );
  }
  const evidence = {
    node: actualNode,
    pnpm: actualPnpm,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    commit: process.env.GITHUB_SHA ?? null,
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "environment.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`CI environment: ${JSON.stringify(evidence)}`);
  return evidence;
}

export async function prepareBrowserCleanupEvidence(
  sourceCommit,
  runId,
  directory = join(evidenceDir, "browser-cleanup"),
) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[A-Za-z0-9-]{1,80}$/.test(runId))
    throw new Error("Invalid browser cleanup evidence identity");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "run.json"),
    `${JSON.stringify({ sourceCommit, runId, githubCommit: process.env.GITHUB_SHA ?? null })}\n`,
  );
}

function browserEvidenceInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function evidenceKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function validBrowserCleanupPhase(phase, deadline, maximumBudget) {
  if (!phase || !browserEvidenceInteger(phase.attempts, 0, 1) || phase.phaseDeadlineMs !== deadline)
    return false;
  if (phase.attempts === 0)
    return (
      phase.startedMs === null &&
      phase.phaseRemainingMs === null &&
      phase.budgetMs === 0 &&
      phase.elapsedMs === 0 &&
      phase.outcome === "not-started" &&
      phase.lateOutcome === undefined
    );
  return (
    browserEvidenceInteger(phase.startedMs, 0, 30_000) &&
    browserEvidenceInteger(phase.phaseRemainingMs, -30_000, deadline) &&
    Math.abs(phase.startedMs + phase.phaseRemainingMs - deadline) <= 2 &&
    browserEvidenceInteger(phase.budgetMs, 1, maximumBudget) &&
    phase.budgetMs <= Math.max(1, Math.min(maximumBudget, phase.phaseRemainingMs)) &&
    browserEvidenceInteger(phase.elapsedMs, 0, 30_000) &&
    ["completed", "timed-out", "rejected"].includes(phase.outcome) &&
    (phase.lateOutcome === undefined ||
      (phase.outcome === "timed-out" && ["completed", "rejected"].includes(phase.lateOutcome)))
  );
}

function validBrowserPageRecord(page, index) {
  const dispose = page?.dispose;
  const close = page?.close;
  return (
    page?.page === index + 1 &&
    browserEvidenceInteger(page.shareMs, -30_000, 3_500) &&
    dispose &&
    browserEvidenceInteger(dispose.budgetMs, 0, 1_500) &&
    browserEvidenceInteger(dispose.elapsedMs, 0, 30_000) &&
    ["completed", "timed-out", "phase-expired", "error"].includes(dispose.outcome) &&
    (dispose.outcome !== "completed" || dispose.budgetMs > 0) &&
    close &&
    browserEvidenceInteger(close.attempts, 0, 1) &&
    browserEvidenceInteger(close.budgetMs, 0, 3_500) &&
    browserEvidenceInteger(close.elapsedMs, 0, 30_000) &&
    ["completed", "timed-out", "phase-expired", "error"].includes(close.outcome) &&
    (close.attempts !== 0 || ["phase-expired", "error"].includes(close.outcome)) &&
    (close.outcome !== "completed" || (close.attempts === 1 && close.budgetMs > 0)) &&
    (close.lateOutcome === undefined ||
      (close.outcome === "timed-out" && ["completed", "rejected"].includes(close.lateOutcome)))
  );
}

function validTimelineEvent(event, finalMs) {
  return (
    evidenceKeys(event, ["firstMs", "count"]) &&
    browserEvidenceInteger(event.count, 0, 2) &&
    (event.count === 0 ? event.firstMs === null : browserEvidenceInteger(event.firstMs, 0, finalMs))
  );
}

function validTimelineCall(call, finalMs) {
  if (
    !evidenceKeys(call, ["calledMs", "settledMs", "outcome"]) ||
    !["not-called", "pending", "fulfilled", "rejected", "threw"].includes(call.outcome)
  )
    return false;
  if (call.outcome === "not-called") return call.calledMs === null && call.settledMs === null;
  if (!browserEvidenceInteger(call.calledMs, 0, finalMs)) return false;
  if (call.outcome === "pending") return call.settledMs === null;
  return browserEvidenceInteger(call.settledMs, call.calledMs, finalMs);
}

export function validBrowserCloseTimeline(timeline, record) {
  const finalMs = timeline?.finalMs;
  const cleanupMs = timeline?.cleanupStartedMs;
  if (
    !evidenceKeys(timeline, [
      "cleanupStartedMs",
      "finalMs",
      "connectedBeforeClose",
      "connectedAtFinal",
      "disconnected",
      "serverClose",
      "processExit",
      "rawClose",
      "closeWrapper",
      "rawKill",
      "finalized",
      "invocationId",
      "runId",
      "sourceCommit",
    ]) ||
    timeline?.finalized !== true ||
    timeline.invocationId !== record.invocationId ||
    timeline.runId !== record.runId ||
    timeline.sourceCommit !== record.sourceCommit ||
    !browserEvidenceInteger(cleanupMs, 0, 60_000) ||
    !browserEvidenceInteger(finalMs, cleanupMs, 60_000) ||
    ![true, false, null].includes(timeline.connectedBeforeClose) ||
    ![true, false, null].includes(timeline.connectedAtFinal) ||
    !validTimelineEvent(timeline.disconnected, finalMs) ||
    !validTimelineEvent(timeline.serverClose, finalMs) ||
    !validTimelineEvent(timeline.processExit, finalMs) ||
    !validTimelineCall(timeline.rawClose, finalMs) ||
    !evidenceKeys(timeline.closeWrapper, [
      "calledMs",
      "settledMs",
      "outcome",
      "timeoutObservedMs",
    ]) ||
    !validTimelineCall(
      {
        calledMs: timeline.closeWrapper.calledMs,
        settledMs: timeline.closeWrapper.settledMs,
        outcome: timeline.closeWrapper.outcome,
      },
      finalMs,
    ) ||
    !validTimelineCall(timeline.rawKill, finalMs)
  )
    return false;
  const timeout = timeline.closeWrapper.timeoutObservedMs;
  return (
    timeline.closeWrapper.outcome !== "threw" &&
    (timeout === null ||
      (browserEvidenceInteger(timeout, timeline.closeWrapper.calledMs ?? 0, finalMs) &&
        record.graceful.outcome === "timed-out")) &&
    (timeline.closeWrapper.outcome === "not-called"
      ? record.graceful.attempts === 0 || timeline.rawClose.outcome === "threw"
      : record.graceful.attempts === 1) &&
    (record.kill.attempts === 0) === (timeline.rawKill.outcome === "not-called") &&
    (timeline.rawClose.outcome === "not-called" || timeline.rawClose.calledMs >= cleanupMs) &&
    (timeline.rawKill.outcome === "not-called" || timeline.rawKill.calledMs >= cleanupMs) &&
    (!record.browserExit ||
      (timeline.processExit.count > 0 &&
        Math.abs(timeline.processExit.firstMs - cleanupMs - record.browserExit.observedMs) <= 3)) &&
    finalMs - cleanupMs <= record.cleanupElapsedMs + 3 &&
    record.cleanupElapsedMs - (finalMs - cleanupMs) <= 1_000
  );
}

function validBrowserCleanupRecord(record) {
  const exit = record.browserExit;
  return (
    record.profile === "query" &&
    ["completed", "rejected"].includes(record.primaryOutcome) &&
    (record.primaryOutcome === "completed"
      ? record.primaryErrorName === null
      : typeof record.primaryErrorName === "string" &&
        /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(record.primaryErrorName)) &&
    browserEvidenceInteger(record.listenerPort, 1, 65_535) &&
    exit &&
    ((browserEvidenceInteger(exit.code, 0, 255) && exit.signal === null) ||
      (exit.code === null && /^SIG[A-Z0-9]+$/.test(exit.signal))) &&
    browserEvidenceInteger(exit.observedMs, 0, 30_000) &&
    validBrowserCleanupPhase(record.graceful, 4_500, 2_000) &&
    record.graceful.attempts === 1 &&
    validBrowserCleanupPhase(record.kill, 6_000, 1_500) &&
    record.kill.attempts === (record.graceful.outcome === "completed" ? 0 : 1) &&
    validBrowserCleanupPhase(record.listener, 7_000, 750) &&
    record.listener.attempts === 1 &&
    browserEvidenceInteger(record.cleanupElapsedMs, 0, 30_000) &&
    browserEvidenceInteger(exit.observedMs, 0, record.cleanupElapsedMs + 2) &&
    [record.graceful, record.kill, record.listener].every(
      (phase) =>
        phase.attempts === 0 || phase.startedMs + phase.elapsedMs <= record.cleanupElapsedMs + 2,
    ) &&
    browserEvidenceInteger(record.workBudgetMs, 500, 32_000) &&
    Array.isArray(record.pages) &&
    (record.primaryOutcome !== "completed" || record.pages.length > 0) &&
    record.pages.every(validBrowserPageRecord) &&
    record.disposedPages ===
      record.pages.filter((page) => page.close.outcome === "completed").length
  );
}

export async function verifyBrowserCleanupEvidence(directory, sourceCommit, expectedCases) {
  const minimumRecords = Array.isArray(expectedCases) ? expectedCases.length : expectedCases;
  const names = await readdir(directory);
  const marker = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
  const cases = names.filter((name) => name !== "run.json");
  const observedCases = new Set();
  if (
    marker.sourceCommit !== sourceCommit ||
    !/^[A-Za-z0-9-]{1,80}$/.test(marker.runId) ||
    cases.length < minimumRecords ||
    cases.length > 64
  )
    throw new Error("Browser cleanup evidence identity or count is incomplete");
  for (const name of cases) {
    if (!/^\d+-\d+\.json$/.test(name))
      throw new Error("Browser cleanup evidence filename is invalid");
    const record = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (
      record.schemaVersion !== 1 ||
      record.final !== true ||
      record.sourceCommit !== sourceCommit ||
      record.sourceDirty !== false ||
      record.runId !== marker.runId ||
      record.invocationId !== name.slice(0, -5) ||
      !/^(standalone|view-(?:input|recovery|lifecycle)\.test\.mjs:\d+)$/.test(record.caseId) ||
      (record.caseId === "standalone"
        ? record.testName !== null
        : typeof record.testName !== "string" || !record.testName) ||
      !Number.isSafeInteger(record.browserPid) ||
      record.browserPid <= 0 ||
      (record.browserVersion !== null &&
        (typeof record.browserVersion !== "string" ||
          !/^\d+(?:\.\d+){1,3}$/.test(record.browserVersion) ||
          record.browserVersion.length > 80)) ||
      (record.primaryOutcome === "completed" && record.browserVersion === null) ||
      record.browserExited !== true ||
      record.listenerClosed !== true ||
      !validBrowserCleanupRecord(record) ||
      !validBrowserCloseTimeline(record.closeTimeline, record)
    )
      throw new Error(`Browser cleanup evidence incomplete: ${name}`);
    if (record.testName !== null) {
      const key = `${record.caseId.split(":")[0]}\0${record.testName}`;
      observedCases.add(key);
    }
  }
  if (Array.isArray(expectedCases)) {
    const expected = new Set(
      expectedCases.map((item) => `${item.file.split("/").at(-1)}\0${item.name}`),
    );
    if (
      expected.size !== expectedCases.length ||
      observedCases.size !== expected.size ||
      [...expected].some((key) => !observedCases.has(key))
    )
      throw new Error("Browser cleanup evidence does not match executed cases");
  }
  return { runId: marker.runId, recordCount: cases.length };
}

export async function verifyBrowserCloseDiagnosticEvidence(
  diagnosticDirectory,
  cleanupDirectory,
  sourceCommit,
  runId,
  exitStatus,
) {
  const report = JSON.parse(
    await readFile(join(diagnosticDirectory, "vitest-results.json"), "utf8"),
  );
  const selection = verifyBrowserCloseDiagnosticSelection(report);
  if (
    !Number.isSafeInteger(exitStatus) ||
    exitStatus < 0 ||
    exitStatus > 255 ||
    (selection.outcome === "passed" ? exitStatus !== 0 : exitStatus === 0)
  )
    throw new Error("Browser-close diagnostic exit and selected case disagree");
  const cleanup = await verifyBrowserCleanupEvidence(
    cleanupDirectory,
    sourceCommit,
    selection.cases,
  );
  if (cleanup.recordCount !== 1 || cleanup.runId !== runId)
    throw new Error("Browser-close diagnostic cleanup invocation identity is incomplete");
  const caseFiles = (await readdir(cleanupDirectory)).filter((name) => name !== "run.json");
  const record = JSON.parse(await readFile(join(cleanupDirectory, caseFiles[0]), "utf8"));
  if (
    selection.outcome === "passed" &&
    (record.primaryOutcome !== "completed" ||
      record.graceful.outcome !== "completed" ||
      record.closeTimeline.rawClose.outcome !== "fulfilled")
  )
    throw new Error("Browser-close diagnostic did not finish graceful cleanup");
  return { ...selection, record, caseFile: caseFiles[0] };
}

export async function writeBrowserCloseDiagnosticManifest({
  diagnosticDirectory,
  cleanupDirectory,
  environmentPath,
  identity,
  runId,
  verified,
  exitStatus,
  provenance,
}) {
  if (!validDiagnosticBrowserProvenance(provenance, identity, runId, verified.record))
    throw new Error("Browser-close diagnostic provenance is incomplete");
  await writeFile(
    join(diagnosticDirectory, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  const files = {
    "identity.json": join(diagnosticDirectory, "identity.json"),
    "provenance.json": join(diagnosticDirectory, "provenance.json"),
    "vitest-results.json": join(diagnosticDirectory, "vitest-results.json"),
    "execution.json": join(diagnosticDirectory, "execution.json"),
    "browser-cleanup/run.json": join(cleanupDirectory, "run.json"),
    [`browser-cleanup/${verified.caseFile}`]: join(cleanupDirectory, verified.caseFile),
    "environment.json": environmentPath,
  };
  const hashes = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, file]) => [
        name,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
  const result = {
    ...identity,
    runId,
    case: verified.cases[0],
    outcome: verified.outcome,
    vitestExitCode: exitStatus,
    gracefulOutcome: verified.record.graceful.outcome,
    evidenceValidated: true,
    hashes,
  };
  if (verified.outcome === "failed")
    await writeFile(
      join(diagnosticDirectory, "failure.json"),
      `${JSON.stringify({ classification: "validated-test-failure", vitestExitCode: exitStatus })}\n`,
    );
  await writeFile(join(diagnosticDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function writeNoConclusionDiagnosticFailure(directory, error) {
  await mkdir(directory, { recursive: true });
  const failure = {
    classification: "no-conclusion",
    errorName: error instanceof Error ? error.name : "unknown",
  };
  await writeFile(join(directory, "failure.json"), `${JSON.stringify(failure)}\n`);
  return failure;
}

async function browserCloseDiagnostic() {
  const identity = await diagnosticIdentity();
  await environment();
  const runId = `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  if (!/^github-\d+-\d+$/.test(runId)) throw new Error("Diagnostic run identity is unavailable");
  await prepareBrowserCleanupEvidence(identity.sourceCommit, runId);
  process.env.COVE_BROWSER_CLEANUP_RUN_ID = runId;
  const installed = await installedBrowserProvenance(identity, runId);
  const output = join(diagnosticDir, "vitest-results.json");
  const result = await recordedCommand(
    "browser-close-v1-l4",
    process.execPath,
    [
      vitest,
      "run",
      "--project",
      "terminal-web",
      diagnosticFile,
      "--testNamePattern",
      `^${diagnosticName}$`,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${output}`,
    ],
    join(diagnosticDir, "execution.json"),
    90_000,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const verified = await verifyBrowserCloseDiagnosticEvidence(
    diagnosticDir,
    join(evidenceDir, "browser-cleanup"),
    identity.sourceCommit,
    runId,
    result.status,
  );
  const provenance = bindDiagnosticBrowserVersion(installed, verified.record);
  await writeBrowserCloseDiagnosticManifest({
    diagnosticDirectory: diagnosticDir,
    cleanupDirectory: join(evidenceDir, "browser-cleanup"),
    environmentPath: join(evidenceDir, "environment.json"),
    identity,
    runId,
    verified,
    exitStatus: result.status,
    provenance,
  });
  return verified.outcome === "passed";
}

async function main() {
  if (process.argv[2] === "--diagnostic-identity") return diagnosticIdentity();
  if (process.argv[2] === "--browser-close-diagnostic") {
    try {
      if (!(await browserCloseDiagnostic())) process.exitCode = 1;
      return;
    } catch (error) {
      await writeNoConclusionDiagnosticFailure(diagnosticDir, error);
      throw error;
    }
  }
  await mkdir(evidenceDir, { recursive: true });
  await rm(join(evidenceDir, "smoke"), { recursive: true, force: true });
  await Promise.all(
    [
      "environment.json",
      "vitest-results.json",
      "vitest-results.xml",
      "execution.json",
      "inventory.json",
      "failure.json",
      "view-evidence.json",
    ].map((name) => rm(join(evidenceDir, name), { force: true })),
  );
  let stage = "environment";
  try {
    await environment();
    if (process.argv[2] === "--environment") return;
    if (process.argv.length > 2) throw new Error(`Unknown argument: ${process.argv[2]}`);
    const checkout = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (checkout.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(checkout.stdout))
      throw new Error("Browser cleanup evidence source commit is unavailable");
    const sourceCommit = checkout.stdout.trim();
    const runId = /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
      ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
      : `local-${process.pid}-${Date.now()}`;
    await prepareBrowserCleanupEvidence(sourceCommit, runId);
    process.env.COVE_BROWSER_CLEANUP_RUN_ID = runId;
    stage = "discovery";
    const discovery = await recordedCommand(
      stage,
      process.execPath,
      [vitest, "list", "--json"],
      join(evidenceDir, "execution.json"),
    );
    if (discovery.status !== 0) {
      throw new Error(`vitest list --json exited ${discovery.status}: ${discovery.stderr}`);
    }
    const discovered = JSON.parse(discovery.stdout);
    const sources = await readVitestOwnedTestFiles();
    // Validate discovery before running, then validate actual execution from a fresh report.
    verifyDiscovery(discovered, sources);
    stage = "vitest";
    const runArgs = [
      vitest,
      "run",
      "--reporter=default",
      "--reporter=json",
      "--reporter=junit",
      `--outputFile.json=${resultPath}`,
      `--outputFile.junit=${junitPath}`,
    ];
    const result = await recordedCommand(
      stage,
      process.execPath,
      runArgs,
      join(evidenceDir, "execution.json"),
      8 * 60_000,
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`Vitest exited ${result.status}`);
    stage = "report-validation";
    const report = JSON.parse(await readFile(resultPath, "utf8"));
    if ((await stat(junitPath)).size === 0) throw new Error("Vitest JUnit report is empty");
    const inventory = verifyInventory(discovered, report, sources);
    await writeFile(join(evidenceDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    await recordViewEvidence(report, inventory);
    console.log(
      `Required suite inventory passed: ${inventory.map(({ project, file, passed }) => `${project}:${file} (${passed})`).join(", ")}`,
    );
  } catch (error) {
    await writeFile(
      join(evidenceDir, "failure.json"),
      `${JSON.stringify({ stage, errorCode: error.code ?? null }, null, 2)}\n`,
    );
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
