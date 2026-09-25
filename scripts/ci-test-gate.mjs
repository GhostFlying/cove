import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  { project: "tooling", file: "tests/tooling/project-references.test.ts", minimumTests: 2 },
  { project: "tooling", file: "tests/tooling/ci-test-gate.test.mjs", minimumTests: 4 },
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

async function testFiles(directory = root, prefix = "") {
  const ignored = new Set([
    ".git",
    ".cache",
    "node_modules",
    "dist",
    "coverage",
    "docs/benchmarks",
  ]);
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (ignored.has(name) || ignored.has(entry.name)) continue;
    if (entry.isDirectory()) found.push(...(await testFiles(join(directory, entry.name), name)));
    else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) found.push(name);
  }
  return found.sort();
}

function command(binary, args, timeout = 120_000) {
  const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", timeout });
  if (result.error) throw result.error;
  return result;
}

async function environment() {
  const pnpm = command("pnpm", ["--version"]);
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
  await environment();
  if (process.argv[2] === "--environment") return;
  if (process.argv.length > 2) throw new Error(`Unknown argument: ${process.argv[2]}`);
  await Promise.all(
    ["vitest-results.json", "vitest-results.xml", "execution.json", "inventory.json"].map((name) =>
      rm(join(evidenceDir, name), { force: true }),
    ),
  );
  const discovery = command(process.execPath, [vitest, "list", "--json"]);
  if (discovery.status !== 0) {
    throw new Error(`vitest list --json exited ${discovery.status}: ${discovery.stderr}`);
  }
  const discovered = JSON.parse(discovery.stdout);
  const sources = await testFiles();
  // Validate discovery before running, then validate actual execution from a fresh report.
  verifyDiscovery(discovered, sources);
  const runArgs = [
    vitest,
    "run",
    "--reporter=default",
    "--reporter=json",
    "--reporter=junit",
    `--outputFile.json=${resultPath}`,
    `--outputFile.junit=${junitPath}`,
  ];
  const result = command(process.execPath, runArgs, 14 * 60_000);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const execution = {
    command:
      "node node_modules/vitest/vitest.mjs run --reporter=default --reporter=json --reporter=junit",
    exitCode: result.status,
  };
  await writeFile(join(evidenceDir, "execution.json"), `${JSON.stringify(execution, null, 2)}\n`);
  if (result.status !== 0) throw new Error(`Vitest exited ${result.status}`);
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  if ((await stat(junitPath)).size === 0) throw new Error("Vitest JUnit report is empty");
  const inventory = verifyInventory(discovered, report, sources);
  await writeFile(join(evidenceDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(
    `Required suite inventory passed: ${inventory.map(({ project, file, passed }) => `${project}:${file} (${passed})`).join(", ")}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
