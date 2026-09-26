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

// Adding a real suite requires registering its project and file here in the same PR.
export const requiredSuites = [
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
  { project: "tooling", file: "tests/tooling/project-references.test.ts", minimumTests: 2 },
  { project: "tooling", file: "tests/tooling/ci-test-gate.test.mjs", minimumTests: 27 },
  { project: "tooling", file: "tests/tooling/ci-environment-setup.test.mjs", minimumTests: 3 },
  { project: "tooling", file: "tests/tooling/package-boundaries.test.ts", minimumTests: 5 },
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
    minimumTests: 6,
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
          perCaseProcessRecord: false,
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

async function main() {
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
