import { spawnSync } from "node:child_process";
import {
  captureOrdinaryCIOutput,
  ciTimeBudget,
  ordinaryCIOutputMetadata,
  replayOrdinaryCIOutput,
  throwOrdinaryCIOutputFailure,
} from "./ci-environment-setup.mjs";
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
const qualificationRoot = join(evidenceDir, "worker-qualification");
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
  if (
    (version === null &&
      (record.browserVersionPinMatched !== null || record.browserVersionTruncated !== null)) ||
    (version !== null &&
      (version !== provenance.chromiumVersion ||
        record.browserVersionPinMatched !== true ||
        record.browserVersionTruncated !== false))
  )
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
    (record.browserVersion === null
      ? record.browserVersionPinMatched === null && record.browserVersionTruncated === null
      : record.browserVersionPinMatched === true && record.browserVersionTruncated === false) &&
    (!runId.startsWith("github-") ||
      runId === `github-${provenance.githubRunId}-${provenance.githubRunAttempt}`)
  );
}

// Adding a real suite requires registering its project and file here in the same PR.
export const requiredSuites = [
  { project: "cli", file: "apps/cli/tests/scenarios.test.mjs", minimumTests: 11 },
  { project: "cli", file: "apps/cli/tests/harness-page.test.mjs", minimumTests: 9 },
  { project: "cli", file: "apps/cli/tests/request-identity-cap.test.mjs", minimumTests: 1 },
  { project: "cli", file: "apps/cli/tests/focus-resize.test.mjs", minimumTests: 1 },
  { project: "cli", file: "apps/cli/tests/reattach-lifetime.test.mjs", minimumTests: 2 },
  { project: "cli", file: "apps/cli/tests/worker-pipe-burst.test.mjs", minimumTests: 1 },
  { project: "cli", file: "apps/cli/tests/three-client-acks.test.mjs", minimumTests: 1 },
  { project: "cli", file: "apps/cli/tests/many-subscription-acks.test.mjs", minimumTests: 1 },
  { project: "cli", file: "apps/cli/tests/slow-worker-liveness.test.mjs", minimumTests: 4 },
  { project: "cli", file: "apps/cli/tests/client-lifetime.test.mjs", minimumTests: 3 },
  { project: "client", file: "packages/client/tests/connection-rpc.test.mjs", minimumTests: 66 },
  { project: "client", file: "packages/client/tests/compiled-client.test.mjs", minimumTests: 4 },
  { project: "client", file: "packages/client/tests/credentials.test.mjs", minimumTests: 3 },
  {
    project: "client",
    file: "packages/client/tests/terminal-budgets-preview.test.mjs",
    minimumTests: 33,
  },
  { project: "client", file: "packages/client/tests/terminal-lifecycle.test.mjs", minimumTests: 5 },
  { project: "client", file: "packages/client/tests/terminal-recovery.test.mjs", minimumTests: 46 },
  { project: "client", file: "packages/client/tests/terminal-state.test.mjs", minimumTests: 11 },
  {
    project: "client",
    file: "packages/client/tests/terminal-control-input.test.mjs",
    minimumTests: 62,
  },
  // Three tests run the matrix (53 call points x 15 actions); 43 named regressions; 46 tests.
  { project: "client", file: "packages/client/tests/terminal-reentry.test.mjs", minimumTests: 47 },
  {
    project: "protocol",
    file: "packages/protocol/tests/business-events.test.mjs",
    minimumTests: 3,
  },
  { project: "protocol", file: "packages/protocol/tests/metadata.test.mjs", minimumTests: 7 },
  { project: "protocol", file: "packages/protocol/tests/frame.test.mjs", minimumTests: 8 },
  { project: "protocol", file: "packages/protocol/tests/composition.test.mjs", minimumTests: 5 },
  {
    project: "protocol",
    file: "packages/protocol/tests/supported-terminal.test.mjs",
    minimumTests: 21,
  },
  {
    project: "protocol",
    file: "packages/protocol/tests/supported-pipe.test.mjs",
    minimumTests: 16,
  },
  { project: "protocol", file: "packages/protocol/tests/admission-rpc.test.mjs", minimumTests: 22 },
  {
    project: "protocol",
    file: "packages/protocol/tests/consumer-contracts.test.mjs",
    minimumTests: 12,
  },
  {
    project: "protocol",
    file: "packages/protocol/tests/workspace-contract.test.mjs",
    minimumTests: 11,
  },
  { project: "protocol", file: "packages/protocol/tests/auth-contract.test.mjs", minimumTests: 9 },
  {
    project: "server",
    file: "apps/server/tests/author/runtime-admission.test.mjs",
    minimumTests: 21,
  },
  {
    project: "server",
    file: "apps/server/tests/author/local-entry.test.mjs",
    minimumTests: 50,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/qualified-local-admission.test.mjs",
    minimumTests: 4,
  },
  {
    project: "server",
    file: "apps/server/tests/author/worker-pipe-session.test.mjs",
    minimumTests: 48,
  },
  {
    project: "server",
    file: "apps/server/tests/author/business-events.test.mjs",
    minimumTests: 13,
  },
  { project: "server", file: "apps/server/tests/author/worker-health.test.mjs", minimumTests: 5 },
  { project: "server", file: "apps/server/tests/author/build-id-stamp.test.mjs", minimumTests: 4 },
  { project: "server", file: "apps/server/tests/author/entry-config.test.mjs", minimumTests: 5 },
  { project: "server", file: "apps/server/tests/author/service-state.test.mjs", minimumTests: 7 },
  { project: "server", file: "apps/server/tests/author/tsnet-write.test.mjs", minimumTests: 6 },
  {
    project: "server",
    file: "apps/server/tests/author/operation-receipts.test.mjs",
    minimumTests: 24,
  },
  {
    project: "server",
    file: "apps/server/tests/author/rpc-dispatch.test.mjs",
    minimumTests: 4,
  },
  {
    project: "server",
    file: "apps/server/tests/author/secret-boundary.test.mjs",
    minimumTests: 18,
  },
  { project: "server", file: "apps/server/tests/author/build-id.test.mjs", minimumTests: 4 },
  {
    project: "server",
    file: "apps/server/tests/author/store.test.mjs",
    minimumTests: 24,
  },
  {
    project: "server",
    file: "apps/server/tests/author/repo-registration.test.mjs",
    minimumTests: 23,
  },
  {
    project: "server",
    file: "apps/server/tests/author/workspaces.test.mjs",
    minimumTests: 74,
  },
  { project: "server", file: "apps/server/tests/author/tabs.test.mjs", minimumTests: 20 },
  { project: "server", file: "apps/server/tests/author/worktrees.test.mjs", minimumTests: 44 },
  {
    project: "server",
    file: "apps/server/tests/author/store-worker.test.mjs",
    minimumTests: 11,
  },
  {
    project: "server",
    file: "apps/server/tests/author/terminal-subscriptions.test.mjs",
    minimumTests: 14,
  },
  {
    project: "server",
    file: "apps/server/tests/author/terminal-connection-delivery.test.mjs",
    minimumTests: 7,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    minimumTests: 30,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-client.test.mjs",
    minimumTests: 5,
  },
  {
    project: "server",
    file: "apps/server/tests/author/terminal-control.test.mjs",
    minimumTests: 19,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    minimumTests: 34,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-client.test.mjs",
    minimumTests: 7,
  },
  {
    project: "server",
    file: "apps/server/tests/author/preview-cache.test.mjs",
    minimumTests: 42,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/preview-contract.test.mjs",
    minimumTests: 15,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/preview-client.test.mjs",
    minimumTests: 4,
  },
  { project: "tooling", file: "tests/tooling/project-references.test.ts", minimumTests: 4 },
  { project: "tooling", file: "tests/tooling/ci-test-gate.test.mjs", minimumTests: 45 },
  { project: "tooling", file: "tests/tooling/ci-environment-setup.test.mjs", minimumTests: 4 },
  { project: "tooling", file: "tests/tooling/package-boundaries.test.ts", minimumTests: 8 },
  { project: "tooling", file: "tests/tooling/tend-doc-check.test.mjs", minimumTests: 11 },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/terminal-model.test.mjs",
    minimumTests: 13,
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
    minimumTests: 11,
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
    minimumTests: 22,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-adapter-input.test.mjs",
    minimumTests: 14,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-adapter-real.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/run-session.test.mjs",
    minimumTests: 36,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-execution.test.mjs",
    minimumTests: 36,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/run-session-real.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/spawn-env-real.test.mjs",
    minimumTests: 2,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/pipe-endpoint.test.mjs",
    minimumTests: 34,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/main-shutdown.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/public-delivery.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/qualification-identity.test.mjs",
    minimumTests: 23,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/fifo-reader-ownership.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/qualification-bulk-control.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/pipe-main-real.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/qualification-finite.test.mjs",
    minimumTests: 7,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/physical-stall.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/worker-fairness-real.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/worker-native-spawn-failure.test.mjs",
    minimumTests: 1,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/worker-query-observation.test.mjs",
    minimumTests: 2,
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/worker-timing.test.mjs",
    minimumTests: 7,
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
    project: "terminal-web-unit",
    file: "packages/terminal-web/tests/unit/grid-fit.test.mjs",
    minimumTests: 4,
  },
  {
    project: "terminal-web-unit",
    file: "packages/terminal-web/tests/unit/renderer-fallback.test.mjs",
    minimumTests: 11,
  },
  {
    project: "terminal-web",
    file: "packages/terminal-web/tests/view-input.test.mjs",
    minimumTests: 8,
  },
  {
    project: "terminal-web",
    file: "packages/terminal-web/tests/view-recovery.test.mjs",
    minimumTests: 6,
  },
  {
    project: "terminal-web",
    file: "packages/terminal-web/tests/view-lifecycle.test.mjs",
    minimumTests: 19,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-flow.test.mjs",
    minimumTests: 16,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-preview.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-recovery-clock.test.mjs",
    minimumTests: 3,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-recovery-reservations.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-recovery.test.mjs",
    minimumTests: 9,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/independent/current-recovery.test.mjs",
    minimumTests: 13,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/independent/current-preview.test.mjs",
    minimumTests: 7,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/independent/current-retention-input.test.mjs",
    minimumTests: 10,
  },
  {
    project: "terminal-engine",
    file: "packages/terminal-engine/tests/independent/current-capture.test.mjs",
    minimumTests: 4,
  },
  {
    project: "server",
    file: "apps/server/tests/independent/current-worker-consumer.test.mjs",
    minimumTests: 5,
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/independent/current-shared-native-input.test.mjs",
    minimumTests: 2,
  },
];

export const finiteRuntimeExpansions = [
  {
    project: "tooling",
    file: "tests/tooling/ci-environment-setup.test.mjs",
    template: "setup wait is bounded for %s under an independent watchdog",
    names: [
      "setup wait is bounded for ignore-term under an independent watchdog",
      "setup wait is bounded for descendant-pipe under an independent watchdog",
    ],
  },
  {
    project: "tooling",
    file: "tests/tooling/ci-environment-setup.test.mjs",
    template: "unsupported runner layout refuses without changing the supplied originals (%#)",
    names: [
      "unsupported runner layout refuses without changing the supplied originals (0)",
      "unsupported runner layout refuses without changing the supplied originals (1)",
      "unsupported runner layout refuses without changing the supplied originals (2)",
      "unsupported runner layout refuses without changing the supplied originals (3)",
      "unsupported runner layout refuses without changing the supplied originals (4)",
      "unsupported runner layout refuses without changing the supplied originals (5)",
      "unsupported runner layout refuses without changing the supplied originals (6)",
      "unsupported runner layout refuses without changing the supplied originals (7)",
      "unsupported runner layout refuses without changing the supplied originals (8)",
    ],
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-client.test.mjs",
    template:
      "P2-B2 independent actual compiled public consumer > B2-08 actual server written receipt %s produces exact public partition and notice",
    names: [
      "P2-B2 independent actual compiled public consumer > B2-08 actual server written receipt 9 produces exact public partition and notice",
      "P2-B2 independent actual compiled public consumer > B2-08 actual server written receipt 4 produces exact public partition and notice",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field %s has no business effect",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field serverId has no business effect",
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field relayInstanceId has no business effect",
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field runId has no business effect",
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field connectionId has no business effect",
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field generation has no business effect",
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field viewId has no business effect",
      "P2-B2 independent actual compiled control contracts > B2-01 each stale complete subscription field subscriptionId has no business effect",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-01 foreign worker result %s cannot grant",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-01 foreign worker result workerId cannot grant",
      "P2-B2 independent actual compiled control contracts > B2-01 foreign worker result workerIncarnationId cannot grant",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-02 accepted focus order reversed=%s controls epoch and full holder",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-02 accepted focus order reversed=false controls epoch and full holder",
      "P2-B2 independent actual compiled control contracts > B2-02 accepted focus order reversed=true controls epoch and full holder",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-02 %s control outcome cannot publish grant",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-02 rejected control outcome cannot publish grant",
      "P2-B2 independent actual compiled control contracts > B2-02 unknown control outcome cannot publish grant",
      "P2-B2 independent actual compiled control contracts > B2-02 missing-atSeq control outcome cannot publish grant",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-03 close pending focus with queued newer holder=%s",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-03 close pending focus with queued newer holder=false",
      "P2-B2 independent actual compiled control contracts > B2-03 close pending focus with queued newer holder=true",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-05 own versus watcher %s keeps PTY and no election",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-05 own versus watcher detach keeps PTY and no election",
      "P2-B2 independent actual compiled control contracts > B2-05 own versus watcher close keeps PTY and no election",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-08 binary once preserves writtenBytes=%s bounds",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-08 binary once preserves writtenBytes=9 bounds",
      "P2-B2 independent actual compiled control contracts > B2-08 binary once preserves writtenBytes=4 bounds",
      "P2-B2 independent actual compiled control contracts > B2-08 binary once preserves writtenBytes=10 bounds",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent actual compiled control contracts > B2-08 %s after handoff is unknown and never resent",
    names: [
      "P2-B2 independent actual compiled control contracts > B2-08 timeout after handoff is unknown and never resent",
      "P2-B2 independent actual compiled control contracts > B2-08 contact-loss after handoff is unknown and never resent",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent finite boundary contrasts > B2-07 valid current appearance %s keeps typed failure without success",
    names: [
      "P2-B2 independent finite boundary contrasts > B2-07 valid current appearance rejected keeps typed failure without success",
      "P2-B2 independent finite boundary contrasts > B2-07 valid current appearance unknown keeps typed failure without success",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/terminal-control-contract.test.mjs",
    template:
      "P2-B2 independent F1 held-result close unsubscribe > F1 owned unsubscribe precedes held %s result settlement",
    names: [
      "P2-B2 independent F1 held-result close unsubscribe > F1 owned unsubscribe precedes held focus result settlement",
      "P2-B2 independent F1 held-result close unsubscribe > F1 owned unsubscribe precedes held input result settlement",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/author/terminal-subscriptions.test.mjs",
    template:
      "private terminal subscription delivery > releases unpublished attach ownership when the third identity is %s",
    names: [
      "private terminal subscription delivery > releases unpublished attach ownership when the third identity is invalid",
      "private terminal subscription delivery > releases unpublished attach ownership when the third identity is throw",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/author/terminal-subscriptions.test.mjs",
    template:
      "private terminal subscription delivery > refuses unpublished attach after supplier closes %s at identity %i",
    names: [
      "private terminal subscription delivery > refuses unpublished attach after supplier closes service at identity 1",
      "private terminal subscription delivery > refuses unpublished attach after supplier closes service at identity 2",
      "private terminal subscription delivery > refuses unpublished attach after supplier closes service at identity 3",
      "private terminal subscription delivery > refuses unpublished attach after supplier closes delivery at identity 1",
      "private terminal subscription delivery > refuses unpublished attach after supplier closes delivery at identity 2",
      "private terminal subscription delivery > refuses unpublished attach after supplier closes delivery at identity 3",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    template:
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-F1 third attach identity supplier %s refuses before publishing ownership",
    names: [
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-F1 third attach identity supplier invalid refuses before publishing ownership",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-F1 third attach identity supplier throw refuses before publishing ownership",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    template:
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field %s cannot dispatch",
    names: [
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field serverId cannot dispatch",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field relayInstanceId cannot dispatch",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field runId cannot dispatch",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field connectionId cannot dispatch",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field generation cannot dispatch",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field viewId cannot dispatch",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 stale complete subscription field subscriptionId cannot dispatch",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    template:
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 foreign worker %s cannot publish",
    names: [
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 foreign worker workerId cannot publish",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F06-02 foreign worker workerIncarnationId cannot publish",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    template:
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 invalid resume %s has no dispatch or allocation",
    names: [
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 invalid resume profile has no dispatch or allocation",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 invalid resume encoding has no dispatch or allocation",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 invalid resume geometry has no dispatch or allocation",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    template:
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 impossible %s result cannot activate",
    names: [
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 impossible replay-without-offer result cannot activate",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F07-02 impossible rollback result cannot activate",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "server",
    file: "apps/server/tests/independent/subscription-contract.test.mjs",
    template:
      "P2-B1 actual compiled parser/runtime/subscription contracts > F09-02 %s cannot activate same-chunk delivery",
    names: [
      "P2-B1 actual compiled parser/runtime/subscription contracts > F09-02 reentrant-close cannot activate same-chunk delivery",
      "P2-B1 actual compiled parser/runtime/subscription contracts > F09-02 marker-capacity-refusal cannot activate same-chunk delivery",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "client",
    file: "packages/client/tests/terminal-budgets-preview.test.mjs",
    template:
      "client preview transaction > joins one opaque transfer in %s order without a live controller",
    names: [
      "client preview transaction > joins one opaque transfer in result-first order without a live controller",
      "client preview transaction > joins one opaque transfer in events-first order without a live controller",
    ],
    reporterIdentity: "ancestry",
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/worker-native-spawn-failure.test.mjs",
    template: "public native factory accounts for ${mode} and reuses its slot",
    names: [
      "public native factory accounts for missing-executable and reuses its slot",
      "public native factory accounts for missing-cwd and reuses its slot",
    ],
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/qualification-identity.test.mjs",
    template: "owned Writable hello %s uses shared childPipe send and error wiring",
    names: [
      "owned Writable hello async callback error uses shared childPipe send and error wiring",
      "owned Writable hello false-return completion uses shared childPipe send and error wiring",
      "owned Writable hello missing completion uses shared childPipe send and error wiring",
      "owned Writable hello premature close uses shared childPipe send and error wiring",
    ],
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/qualification-identity.test.mjs",
    template: "cleanup escalation resamples %s before SIGKILL",
    names: [
      "cleanup escalation resamples shim before SIGKILL",
      "cleanup escalation resamples changed birth before SIGKILL",
      "cleanup escalation resamples wrong entry before SIGKILL",
      "cleanup escalation resamples compiled before SIGKILL",
    ],
  },
  {
    project: "terminal-worker",
    file: "tests/integration/terminal-worker/qualification-identity.test.mjs",
    template: "pending real shim cleanup preserves timeout and %s",
    names: [
      "pending real shim cleanup preserves timeout and EOF exit",
      "pending real shim cleanup preserves timeout and unresolved EOF",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/pipe-endpoint.test.mjs",
    template: "public pipe rejects %s before real execution",
    names: [
      "public pipe rejects status with bytes before real execution",
      "public pipe rejects set-control with bytes before real execution",
      "public pipe rejects empty spawn before real execution",
      "public pipe rejects short spawn before real execution",
      "public pipe rejects empty input before real execution",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/native-adapter-input.test.mjs",
    template: "settlement diagnostics retain only bounded %s",
    names: [
      "settlement diagnostics retain only bounded exact ASCII code",
      "settlement diagnostics retain only bounded long ASCII code",
      "settlement diagnostics retain only bounded non-ASCII code",
      "settlement diagnostics retain only bounded exact UTF-8 message",
      "settlement diagnostics retain only bounded long UTF-8 message",
      "settlement diagnostics retain only bounded scalar at byte boundary",
      "settlement diagnostics retain only bounded scalar crossing byte boundary",
      "settlement diagnostics retain only bounded lone surrogate replacement",
      "settlement diagnostics retain only bounded huge diagnostics",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-execution.test.mjs",
    template: "worker ingress returns to its baseline after %s",
    names: [
      "worker ingress returns to its baseline after one chunk",
      "worker ingress returns to its baseline after separate callbacks",
      "worker ingress returns to its baseline after one split callback",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-execution.test.mjs",
    template: "W2 pressure rejects $name without evicting either run or changing replay mode",
    names: [
      "W2 pressure rejects stale epoch without evicting either run or changing replay mode",
      "W2 pressure rejects wrong installed holder without evicting either run or changing replay mode",
      "W2 pressure rejects duplicate sequence without evicting either run or changing replay mode",
      "W2 pressure rejects lower sequence without evicting either run or changing replay mode",
      "W2 pressure rejects exhausted sequence without evicting either run or changing replay mode",
      "W2 pressure rejects identity cap without evicting either run or changing replay mode",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-recovery-clock.test.mjs",
    template:
      "W2 old preparing deadline and late %s preserve replacement and allocated capture debt",
    names: [
      "W2 old preparing deadline and late completion preserve replacement and allocated capture debt",
      "W2 old preparing deadline and late throw preserve replacement and allocated capture debt",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-recovery-reservations.test.mjs",
    template:
      "W2 preparing recover at detached reserve fences old %s without allocating or failing replacement",
    names: [
      "W2 preparing recover at detached reserve fences old completion without allocating or failing replacement",
      "W2 preparing recover at detached reserve fences old throw without allocating or failing replacement",
    ],
  },
  {
    project: "terminal-worker",
    file: "packages/terminal-worker/tests/worker-recovery.test.mjs",
    template:
      "W2 actual engine detached callback %s refuses old allocation and preserves legal fresh admission",
    names: [
      "W2 actual engine detached callback unsubscribe refuses old allocation and preserves legal fresh admission",
      "W2 actual engine detached callback recover refuses old allocation and preserves legal fresh admission",
    ],
  },
];

// Directories whose suites are registered per file instead of in requiredSuites, so that
// concurrent tasks add tests without editing this shared list (docs/milestones/m1.md). Each
// `<name>.test.mjs` directly in the directory has a `<name>.suite.json` beside it containing exactly
// `{ "minimumTests": N }`; a test without a registration, a registration without a test, a nested
// directory or another test file name fails the gate.
//
// The discovered pairs alone fail open: deleting a test together with its registration (or the
// whole directory) would remove it from the expected inventory. `required` is the independent
// floor: suites (by name) that must be present, and the directory itself must exist. A task adding
// a suite only adds its pair; the suite joins `required` when its acceptance must not silently
// disappear.
export const fileRegisteredDirectories = [
  {
    project: "cli",
    directory: "apps/cli/tests/m1",
    required: [
      "d6-probe-entry",
      "pending-operations",
      "s1-repo-registration",
      "s10-storage-identity",
      "s2-task-checkout-mounts",
      "s3-managed-worktrees",
      "s4-worktree-failures",
      "s5-tabs-runs",
      "s6-bindings",
      "s7-tab-restart",
      "s8-worktree-restart",
      "s9-worktree-drift",
      "test-isolation",
    ],
  },
  // M2 acceptance (docs/milestones/m2.md "任务拆分"): each M2 task adds its scenario tests and
  // their .suite.json here without changing this script.
  {
    project: "cli",
    directory: "apps/cli/tests/m2",
    required: ["pending-secrets"],
  },
];

const SUITE_SUFFIX = ".suite.json";
const TEST_SUFFIX = ".test.mjs";

function parseSuiteRegistration(text, file) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Suite registration is not JSON: ${file}`);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "minimumTests" ||
    !Number.isSafeInteger(value.minimumTests) ||
    value.minimumTests < 1
  )
    throw new Error(
      `Suite registration must be exactly { "minimumTests": N } with N >= 1: ${file}`,
    );
  return value.minimumTests;
}

export async function readFileRegisteredSuites(
  checkoutRoot = root,
  directories = fileRegisteredDirectories,
) {
  const suites = [];
  for (const { project, directory, required = [] } of directories) {
    let entries;
    try {
      entries = await readdir(join(checkoutRoot, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(`Per-file registered test directory is missing: ${directory}`);
      throw error;
    }
    const tests = new Set();
    const registrations = new Set();
    for (const entry of entries) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory())
        throw new Error(`Per-file registered test directory has a subdirectory: ${file}`);
      if (entry.name.endsWith(SUITE_SUFFIX))
        registrations.add(entry.name.slice(0, -SUITE_SUFFIX.length));
      else if (entry.name.endsWith(TEST_SUFFIX))
        tests.add(entry.name.slice(0, -TEST_SUFFIX.length));
      else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
        throw new Error(`Per-file registered tests must be named <name>${TEST_SUFFIX}: ${file}`);
    }
    for (const name of [...tests].sort()) {
      if (!registrations.has(name))
        throw new Error(
          `Test file has no ${SUITE_SUFFIX} registration: ${directory}/${name}${TEST_SUFFIX}`,
        );
      const registration = `${directory}/${name}${SUITE_SUFFIX}`;
      suites.push({
        project,
        file: `${directory}/${name}${TEST_SUFFIX}`,
        minimumTests: parseSuiteRegistration(
          await readFile(join(checkoutRoot, registration), "utf8"),
          registration,
        ),
      });
    }
    for (const name of registrations)
      if (!tests.has(name))
        throw new Error(`Suite registration has no test file: ${directory}/${name}${SUITE_SUFFIX}`);
    for (const name of required)
      if (!tests.has(name))
        throw new Error(`Required per-file suite is missing: ${directory}/${name}${TEST_SUFFIX}`);
  }
  return suites;
}

// The complete inventory: the static list plus every per-file registration. A file registered
// both ways is a duplicate and fails discovery.
export async function readRequiredSuites(checkoutRoot = root) {
  return [...requiredSuites, ...(await readFileRegisteredSuites(checkoutRoot))];
}

// CI shards (#163). The Vitest run is serial: every project but the small pure ones sets
// maxWorkers: 1, and Vitest runs the projects one after another, so a run takes the sum of its
// files' durations (about 27.8 minutes on macOS at 161 files in run 39696359165). Lifting
// maxWorkers would change the isolation of timing-sensitive PTY, browser, sshd and user-service
// suites on a 3-vCPU runner. Instead check.yml runs the gate as ciShardCount jobs per OS, each on
// its own runner (so no port, COVE_HOME, browser, sshd fixture or LaunchAgent/systemd label is
// ever shared between shards) and each running a disjoint part of the files with the same
// per-project settings. A last job per OS (`check (<os>)`, the required check) aggregates them.
//
// Correctness never depends on the plan's balance: every shard discovers the whole repository
// and validates it as an unsharded run does, then runs and validates only its own files; the
// aggregation recomputes the plan from the same discovery, requires every shard's files and
// report to match it, merges the reports and validates the merged report against the complete
// inventory with verifyInventory, exactly as one unsharded run. A file in no shard, in two
// shards, or failing in any shard therefore fails the aggregation.
export const ciShardCount = 3;

// Planning weights in seconds, from the green macOS run 39696359165 (files of 15 s or more).
// They only balance the shards: a stale or missing entry makes one shard slower, never drops or
// duplicates a file. A file without an entry, such as a new per-file registered suite, weighs its
// project's default (roughly the observed mean of that project's shorter files, rounded up).
const shardWeightSeconds = new Map([
  ["apps/cli/tests/m2/s1-install-service.test.mjs", 194],
  ["packages/terminal-web/probes/query-input.test.mjs", 99],
  ["packages/terminal-web/tests/view-lifecycle.test.mjs", 93],
  ["apps/cli/tests/m2/s2-restart-impact.test.mjs", 87],
  ["apps/cli/tests/harness-page.test.mjs", 78],
  ["apps/server/tests/author/worktrees.test.mjs", 77],
  ["apps/cli/tests/m2/s3-pairing.test.mjs", 69],
  ["apps/cli/tests/slow-worker-liveness.test.mjs", 53],
  ["apps/server/tests/author/workspaces.test.mjs", 52],
  ["apps/cli/tests/m1/s6-bindings.test.mjs", 51],
  ["apps/cli/tests/m1/cli-usability.test.mjs", 49],
  ["apps/server/tests/author/repo-registration.test.mjs", 34],
  ["packages/terminal-engine/probes/recovery-pragmatic.test.mjs", 33],
  ["apps/cli/tests/m2/install-safety.test.mjs", 32],
  ["apps/cli/tests/m1/s2-task-checkout-mounts.test.mjs", 31],
  ["apps/cli/tests/m1/s10-storage-identity.test.mjs", 29],
  ["tests/integration/terminal-worker/qualification-identity.test.mjs", 27],
  ["apps/cli/tests/scenarios.test.mjs", 25],
  ["packages/terminal-web/tests/view-input.test.mjs", 24],
  ["apps/cli/tests/m1/s1-repo-registration.test.mjs", 20],
  ["apps/cli/tests/m1/s4-worktree-failures.test.mjs", 20],
  ["apps/cli/tests/m1/s5-tabs-runs.test.mjs", 20],
  ["packages/terminal-web/tests/view-recovery.test.mjs", 19],
  ["packages/client/tests/terminal-reentry.test.mjs", 18],
  ["apps/cli/tests/m2/s4-revoke.test.mjs", 16],
  ["packages/terminal-web/probes/environment.test.mjs", 16],
]);
const projectWeightSeconds = new Map([
  ["cli", 8],
  ["tooling", 6],
  ["server", 2],
  ["terminal-worker", 2],
  ["terminal-engine-probes", 3],
]);

// Files that must share a shard. The terminal-web project's three V1 browser suites write one
// browser cleanup evidence directory that is validated as a whole (recordViewEvidence), so the
// project is one unit; every other file is its own unit.
function shardUnit(project, file) {
  return project === "terminal-web" ? `project:${project}` : `file:${file}`;
}

// `entries` are the discovered files as { project, file } with repository paths. Returns
// `count` shards, each { index (1-based), files (sorted) }. Deterministic: units are placed
// heaviest first, ties broken by name, each on the currently lightest shard (lowest index on a
// tie), so every runner of the same discovery computes the same plan.
export function planShards(entries, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid shard count: ${count}`);
  const units = new Map();
  const projects = new Map();
  for (const { project, file } of entries) {
    if (typeof project !== "string" || typeof file !== "string" || !project || !file)
      throw new Error("Shard planning needs a project and file for every entry");
    if (projects.has(file) && projects.get(file) !== project)
      throw new Error(`Test file belongs to two projects: ${file}`);
    if (projects.has(file)) continue;
    projects.set(file, project);
    const key = shardUnit(project, file);
    const unit = units.get(key) ?? { key, files: [], weight: 0 };
    unit.files.push(file);
    unit.weight += shardWeightSeconds.get(file) ?? projectWeightSeconds.get(project) ?? 1;
    units.set(key, unit);
  }
  if (units.size < count)
    throw new Error(`Cannot split ${units.size} test units into ${count} non-empty shards`);
  const shards = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    files: [],
    weight: 0,
  }));
  const ordered = [...units.values()].sort(
    (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  for (const unit of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best));
    lightest.files.push(...unit.files);
    lightest.weight += unit.weight;
  }
  return shards.map(({ index, files, weight }) => ({ index, files: files.sort(), weight }));
}

// COVE_CI_SHARD is `<index>/<count>`; unset means the whole run as one shard (`pnpm test`).
export function parseShard(value) {
  if (value === undefined || value === "") return { index: 1, count: 1 };
  const match = /^([1-9]\d{0,2})\/([1-9]\d{0,2})$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index > count) throw new Error(`COVE_CI_SHARD must be <index>/<count>: ${value}`);
  return { index, count };
}

// The discovered files of a `vitest list --json` result, as planShards entries.
export function discoveredEntries(discovered) {
  return discovered.map((test) => ({ project: test.projectName, file: repositoryPath(test.file) }));
}

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
  const identities = new Set();
  for (const test of discovered) {
    const file = repositoryPath(test.file);
    const key = `${test.projectName}:${file}`;
    if (!expected.has(key)) throw new Error(`Unregistered Vitest suite: ${key}`);
    const identity = `${key}\0${test.name}`;
    if (identities.has(identity)) throw new Error(`Duplicate discovered identity: ${key}`);
    identities.add(identity);
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
  const resultSuites = new Map();
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
    resultSuites.set(file, suite);
  }
  let total = 0;
  for (const [key, count] of found) {
    const file = expected.get(key).file;
    const expansions = finiteRuntimeExpansions.filter(
      (item) => `${item.project}:${item.file}` === key,
    );
    let expectedCount = count;
    if (expansions.length > 0) {
      const names = discovered
        .filter((test) => `${test.projectName}:${repositoryPath(test.file)}` === key)
        .map((test) => test.name);
      const identities = new Set(names);
      if (identities.size !== names.length)
        throw new Error(`Duplicate discovered identity: ${key}`);
      for (const expansion of expansions) {
        if (!identities.delete(expansion.template)) {
          throw new Error(`Missing parameterized declaration: ${key}:${expansion.template}`);
        }
        for (const name of expansion.names) {
          if (identities.has(name)) throw new Error(`Duplicate expanded identity: ${key}:${name}`);
          identities.add(name);
        }
      }
      const structured = expansions.some((expansion) => expansion.reporterIdentity === "ancestry");
      const actual =
        resultSuites.get(file)?.assertionResults.map((test) => {
          if (!structured) return test.fullName;
          const parts = [...(test.ancestorTitles ?? []), test.title];
          if (
            !Array.isArray(test.ancestorTitles) ||
            !parts.every((part) => typeof part === "string" && part.length > 0) ||
            test.fullName !== parts.join(" ")
          )
            return null;
          return parts.join(" > ");
        }) ?? [];
      if (
        new Set(actual).size !== actual.length ||
        actual.some((name) => !identities.has(name)) ||
        identities.size !== actual.length
      ) {
        throw new Error(`Parameterized runtime identities differ from discovery: ${key}`);
      }
      expectedCount = identities.size;
    }
    if (results.get(file) !== expectedCount) {
      throw new Error(
        `Required suite ${key} executed ${results.get(file) ?? 0} of ${expectedCount} expected tests`,
      );
    }
    total += expectedCount;
  }
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
    testFilesIn(join(checkoutRoot, "apps/cli/tests"), "apps/cli/tests"),
    testFilesIn(join(checkoutRoot, "apps/server/tests"), "apps/server/tests"),
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
    testFilesIn(
      join(checkoutRoot, "tests/integration/terminal-worker"),
      "tests/integration/terminal-worker",
    ),
    testFilesIn(join(checkoutRoot, "packages/terminal-web/probes"), "packages/terminal-web/probes"),
    testFilesIn(join(checkoutRoot, "packages/terminal-web/tests"), "packages/terminal-web/tests"),
  ]).then((groups) => groups.flat().sort());
}

async function fileRecordedVitest(stage, binary, args, outputFile, timeoutMs, outputs) {
  const { result, failure, capture } = await captureOrdinaryCIOutput(
    stage,
    binary,
    args,
    dirname(outputFile),
    root,
    timeoutMs,
    512 * 1024,
  );
  const attempt = {
    stage,
    argv: [binary, ...args],
    timeoutMs,
    childPid: result?.pid ?? null,
    exitCode: result?.status ?? null,
    signal: result?.signal ?? null,
    errorCode: failure?.code ?? null,
    timedOut: failure?.code === "ETIMEDOUT",
    outputCapture: ordinaryCIOutputMetadata(capture),
  };
  let prior;
  let recorded = false;
  try {
    await mkdir(dirname(outputFile), { recursive: true });
    try {
      prior = JSON.parse(await readFile(outputFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      prior = [];
    }
    await writeFile(outputFile, `${JSON.stringify([...prior, attempt], null, 2)}\n`);
    recorded = true;
  } catch (error) {
    capture.errors.push({ phase: "metadata", error });
  }
  await replayOrdinaryCIOutput(capture, outputs.stdout, outputs.stderr);
  attempt.outputCapture = ordinaryCIOutputMetadata(capture);
  if (recorded && capture.errors.length) {
    try {
      await writeFile(outputFile, `${JSON.stringify([...prior, attempt], null, 2)}\n`);
    } catch (error) {
      capture.errors.push({ phase: "metadata", error });
      attempt.outputCapture = ordinaryCIOutputMetadata(capture);
    }
  }
  throwOrdinaryCIOutputFailure(failure, capture, attempt);
  return Object.assign(result, { outputCapture: capture });
}

// What a recorded command may print. `vitest list --json` prints every test of the repository
// (about 350 bytes each, some 1,500 tests at the time of writing, past 512 KiB), and spawnSync fails
// the whole gate with ENOBUFS once the output exceeds this; 8 MiB leaves room for many times that.
const COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function recordedCommand(
  stage,
  binary,
  args,
  outputFile,
  timeoutMs = ciTimeBudget.gateCommandMs,
  outputs = {},
) {
  if (outputs.fileCapture)
    return fileRecordedVitest(stage, binary, args, outputFile, timeoutMs, outputs);
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
      maxBuffer: COMMAND_OUTPUT_BYTES,
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

export async function prepareWorkerQualificationEvidence(
  provenance,
  directory = qualificationRoot,
) {
  const { sourceCommit, tree, sourceDirty, runId, githubRunId, githubRunAttempt, githubSha } =
    provenance;
  const github = /^github-(\d+)-(\d+)$/.exec(runId ?? "");
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? "") ||
    !/^[a-f0-9]{40}$/.test(tree ?? "") ||
    sourceDirty !== false ||
    !/^(?:github|local)-[A-Za-z0-9-]{1,72}$/.test(runId ?? "") ||
    (github
      ? githubRunId !== github[1] || githubRunAttempt !== github[2] || githubSha !== sourceCommit
      : githubRunId !== null || githubRunAttempt !== null || githubSha !== null) ||
    !/^\d+\.\d+\.\d+$/.test(provenance.node ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(provenance.pnpm ?? "") ||
    !/^\d+$/.test(provenance.nodeAbi ?? "") ||
    !["darwin", "linux", "win32"].includes(provenance.platform) ||
    !/^[a-z0-9]+$/.test(provenance.arch ?? "")
  )
    throw new Error("Worker qualification evidence identity is invalid");
  await mkdir(directory, { recursive: true });
  const runDirectory = join(directory, runId);
  await mkdir(runDirectory);
  await writeFile(join(runDirectory, "run.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return runDirectory;
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
      (record.browserVersion === null
        ? record.browserVersionPinMatched !== null || record.browserVersionTruncated !== null
        : typeof record.browserVersionPinMatched !== "boolean" ||
          typeof record.browserVersionTruncated !== "boolean") ||
      (record.primaryOutcome === "completed" && record.browserVersion === null) ||
      (record.primaryOutcome === "completed" && record.browserVersionPinMatched !== true) ||
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

// The gate's Vitest run, limited to `files` (repository paths) when there are any. A shard names
// its files as absolute paths, which Vitest matches by prefix; anything the filter matched beyond
// them fails validation as an unexpected result. They come before every option, so no option
// that takes an optional value (`vitest list --json [path]` writes to a following file name) can
// consume a file name as its value.
export function vitestRunArgs(files) {
  return [
    vitest,
    "run",
    ...files.map((file) => join(root, file)),
    "--reporter=default",
    "--reporter=json",
    "--reporter=junit",
    `--outputFile.json=${resultPath}`,
    `--outputFile.junit=${junitPath}`,
  ];
}

const shardPlanName = "shard.json";
const shardResultName = "shard-result.json";
const aggregateDir = join(evidenceDir, "aggregate");
// The check.yml matrix OS label of a shard set, and the platform its shards must report.
const runnerPlatforms = new Map([
  ["ubuntu-latest", "linux"],
  ["macos-latest", "darwin"],
]);

function shardPath(path, shardRoot) {
  if (typeof path !== "string" || !path.startsWith(`${shardRoot}/`))
    throw new Error(`Shard result path is outside its shard checkout: ${path}`);
  return join(root, path.slice(shardRoot.length + 1));
}

function canonicalDiscovery(discovered) {
  if (!Array.isArray(discovered)) throw new Error("Shard discovery is absent");
  return JSON.stringify(
    discovered
      .map(({ projectName, file, name }) => [projectName, file, name])
      .sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : a.join("\0") > b.join("\0") ? 1 : 0)),
  );
}

async function readShardJson(directory, name, label) {
  try {
    return JSON.parse(await readFile(join(directory, name), "utf8"));
  } catch (error) {
    throw new Error(`Shard artifact ${label} has no readable ${name}`, { cause: error });
  }
}

// Validates the shard artifacts of one OS, each extracted into its own subdirectory of
// `directory`, and returns the complete inventory. The aggregation is as strict as one unsharded
// run: every shard must have recorded a passing result for the same commit, run and platform from
// the same discovery; that discovery must pass verifyDiscovery against this checkout's own source
// scan and suite registrations; each shard must have run exactly the plan's files; and the merged
// report must pass verifyInventory and the view evidence check against the complete inventory.
// A shard that failed, never ran, ran the wrong files or left a file out fails it.
//
// Every shard must come from the aggregating run attempt (`runId`, github-<run>-<attempt>), and
// so must its passing result and its browser evidence. A rerun replaces only the jobs it reruns,
// so an older attempt's artifact can outlive a rerun shard that failed before uploading, and a
// rerun of the aggregation alone sees only earlier attempts' artifacts. Accepting either could
// report a pass that no current execution produced, so both fail. GitHub's "re-run failed jobs"
// therefore fails closed (the shards that passed are not rerun); a rerun must rerun all jobs.
export async function aggregateShards(
  directory,
  { platform, sourceCommit, runId, sources, suites, count = ciShardCount },
) {
  const attempt = /^github-(\d+)-(\d+)$/.exec(runId ?? "");
  if (!attempt) throw new Error(`The aggregation needs a GitHub run attempt identity: ${runId}`);
  // No download directory at all (no artifact of this attempt matched) is zero shards.
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length !== count)
    throw new Error(`Expected ${count} shard artifacts, found ${names.length}`);
  const shards = new Map();
  for (const name of names) {
    const shardDirectory = join(directory, name);
    const plan = await readShardJson(shardDirectory, shardPlanName, name);
    const label = `${plan?.index}/${plan?.count}`;
    if (
      plan?.schemaVersion !== 1 ||
      plan.count !== count ||
      !Number.isSafeInteger(plan.index) ||
      plan.index < 1 ||
      plan.index > count
    )
      throw new Error(`Shard artifact ${name} is not one of ${count} shards`);
    if (shards.has(plan.index)) throw new Error(`Shard ${label} appears twice`);
    if (
      plan.sourceCommit !== sourceCommit ||
      plan.platform !== platform ||
      plan.runId !== runId ||
      plan.githubRunId !== attempt[1] ||
      plan.githubRunAttempt !== attempt[2] ||
      typeof plan.root !== "string" ||
      !plan.root.startsWith("/")
    )
      throw new Error(`Shard ${label} is from another commit, run attempt, platform or checkout`);
    const result = await readShardJson(shardDirectory, shardResultName, name);
    if (
      result?.passed !== true ||
      result.index !== plan.index ||
      result.count !== count ||
      result.runId !== runId
    )
      throw new Error(`Shard ${label} did not record a passing result`);
    const report = await readShardJson(shardDirectory, "vitest-results.json", name);
    shards.set(plan.index, { directory: shardDirectory, plan, report, label });
  }
  const ordered = [...shards.values()].sort((a, b) => a.plan.index - b.plan.index);
  const discovery = canonicalDiscovery(ordered[0].plan.discovered);
  for (const shard of ordered) {
    if (canonicalDiscovery(shard.plan.discovered) !== discovery)
      throw new Error(`Shard ${shard.label} discovered different tests`);
    if (JSON.stringify(shard.plan.sources) !== JSON.stringify(sources))
      throw new Error(`Shard ${shard.label} scanned different test files than this checkout`);
  }
  const discovered = ordered[0].plan.discovered.map((test) => ({
    projectName: test.projectName,
    file: join(root, test.file),
    name: test.name,
  }));
  verifyDiscovery(discovered, sources, suites);
  const plan = planShards(discoveredEntries(discovered), count);
  const merged = {
    success: true,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [],
  };
  let viewShard;
  for (const shard of ordered) {
    const files = plan[shard.plan.index - 1].files;
    if (JSON.stringify(shard.plan.files) !== JSON.stringify(files))
      throw new Error(`Shard ${shard.label} ran a different file set than the plan`);
    const { report } = shard;
    if (report?.success !== true || !Array.isArray(report.testResults))
      throw new Error(`Shard ${shard.label} Vitest result is absent or unsuccessful`);
    const owned = new Set(files);
    for (const suite of report.testResults) {
      const name = shardPath(suite?.name, shard.plan.root);
      if (!owned.has(repositoryPath(name)))
        throw new Error(
          `Shard ${shard.label} has a result outside its plan: ${repositoryPath(name)}`,
        );
      merged.testResults.push({ ...suite, name });
    }
    for (const key of [
      "numTotalTests",
      "numPassedTests",
      "numFailedTests",
      "numPendingTests",
      "numTodoTests",
    ]) {
      if (!Number.isSafeInteger(report[key]) || report[key] < 0)
        throw new Error(`Shard ${shard.label} Vitest totals are incomplete`);
      merged[key] += report[key];
    }
    if (
      suites.some((suite) => suite.project === "terminal-web" && owned.has(suite.file)) &&
      viewShard === undefined
    )
      viewShard = shard;
  }
  const inventory = verifyInventory(discovered, merged, sources, suites);
  if (inventory.some((suite) => suite.project === "terminal-web")) {
    if (!viewShard) throw new Error("No shard ran the V1 browser suites");
    const cleanup = await verifyBrowserCleanupEvidence(
      join(viewShard.directory, "browser-cleanup"),
      sourceCommit,
      viewEvidenceCases(merged, inventory),
    );
    if (cleanup.runId !== runId)
      throw new Error(`Shard ${viewShard.label} browser evidence is from another run attempt`);
  }
  return {
    inventory,
    shards: ordered.map((shard) => ({
      index: shard.plan.index,
      files: shard.plan.files.length,
      tests: shard.report.numTotalTests,
    })),
  };
}

function checkoutCommit() {
  const checkout = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (checkout.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(checkout.stdout))
    throw new Error("The checkout's source commit is unavailable");
  return checkout.stdout.trim();
}

async function aggregateMain(args) {
  const [directory, os, ...rest] = args;
  const platform = runnerPlatforms.get(os);
  if (!directory || !platform || rest.length > 0)
    throw new Error("Usage: ci-test-gate.mjs --aggregate <shard artifact directory> <matrix os>");
  await rm(aggregateDir, { recursive: true, force: true });
  await mkdir(aggregateDir, { recursive: true });
  try {
    const result = await aggregateShards(resolve(directory), {
      platform,
      sourceCommit: checkoutCommit(),
      // The aggregating attempt; aggregateShards refuses anything but a GitHub run attempt.
      runId: `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
      sources: await readVitestOwnedTestFiles(),
      suites: await readRequiredSuites(),
    });
    await writeFile(
      join(aggregateDir, "inventory.json"),
      `${JSON.stringify({ os, platform, ...result }, null, 2)}\n`,
    );
    console.log(
      `Required suite inventory passed across ${result.shards.length} ${os} shards ` +
        `(${result.shards.map(({ index, files, tests }) => `${index}: ${files} files, ${tests} tests`).join("; ")}): ` +
        result.inventory
          .map(({ project, file, passed }) => `${project}:${file} (${passed})`)
          .join(", "),
    );
  } catch (error) {
    await writeFile(
      join(aggregateDir, "failure.json"),
      `${JSON.stringify({ stage: "aggregate", message: String(error?.message ?? error) }, null, 2)}\n`,
    );
    throw error;
  }
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
  if (process.argv[2] === "--aggregate") return aggregateMain(process.argv.slice(3));
  await mkdir(evidenceDir, { recursive: true });
  await rm(join(evidenceDir, "smoke"), { recursive: true, force: true });
  await Promise.all(
    [
      "environment.json",
      "vitest-results.json",
      "vitest-results.xml",
      "vitest.stdout.bin",
      "vitest.stderr.bin",
      "execution.json",
      "inventory.json",
      "failure.json",
      "view-evidence.json",
      shardPlanName,
      shardResultName,
    ].map((name) => rm(join(evidenceDir, name), { force: true })),
  );
  let stage = "environment";
  try {
    const toolchain = await environment();
    if (process.argv[2] === "--environment") return;
    if (process.argv.length > 2) throw new Error(`Unknown argument: ${process.argv[2]}`);
    const shard = parseShard(process.env.COVE_CI_SHARD);
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
    const suites = await readRequiredSuites();
    // Validate discovery before running, then validate actual execution from a fresh report.
    // Every shard validates the whole discovery, so a shard never runs from a partial view.
    verifyDiscovery(discovered, sources, suites);
    const plan = planShards(discoveredEntries(discovered), shard.count);
    const selected = new Set(plan[shard.index - 1].files);
    // What the aggregation needs from this shard, written before the run so that a shard whose
    // run fails still says what it was meant to run. Paths are repository-relative, so the
    // aggregation can check them from another checkout.
    await writeFile(
      join(evidenceDir, shardPlanName),
      `${JSON.stringify({
        schemaVersion: 1,
        index: shard.index,
        count: shard.count,
        root,
        sourceCommit,
        runId,
        githubRunId: process.env.GITHUB_RUN_ID ?? null,
        githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        platform: toolchain.platform,
        arch: toolchain.arch,
        files: plan[shard.index - 1].files,
        sources,
        discovered: discovered.map((test) => ({
          projectName: test.projectName,
          file: repositoryPath(test.file),
          name: test.name,
        })),
      })}\n`,
    );
    stage = "qualification-evidence";
    process.env.COVE_QUALIFICATION_EVIDENCE_DIR = await prepareWorkerQualificationEvidence({
      sourceCommit,
      tree: gitText("rev-parse", "HEAD^{tree}"),
      sourceDirty: gitText("status", "--porcelain", "--untracked-files=normal") !== "",
      runId,
      githubRunId: process.env.GITHUB_RUN_ID ?? null,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      githubSha: process.env.GITHUB_SHA ?? null,
      node: toolchain.node,
      pnpm: toolchain.pnpm,
      nodeAbi: toolchain.nodeAbi,
      platform: toolchain.platform,
      arch: toolchain.arch,
      osRelease: toolchain.osRelease,
      runnerOs: toolchain.runnerOs,
      runnerArch: toolchain.runnerArch,
    });
    stage = "vitest";
    process.env.COVE_D_QUALIFIED_OUTPUT ??= join(evidenceDir, "qualified-local-admission", runId);
    const runArgs = vitestRunArgs(shard.count === 1 ? [] : [...selected]);
    const result = await recordedCommand(
      stage,
      process.execPath,
      runArgs,
      join(evidenceDir, "execution.json"),
      // ciTimeBudget sizes the `pnpm check` stage and job timeouts around this bound. While the
      // unbounded work around it stays within its reserves, a hung run fails here with recorded
      // evidence rather than being killed from outside.
      ciTimeBudget.vitestMs,
      { fileCapture: true },
    );
    if (result.status !== 0) throw new Error(`Vitest exited ${result.status}`);
    stage = "report-validation";
    const report = JSON.parse(await readFile(resultPath, "utf8"));
    if ((await stat(junitPath)).size === 0) throw new Error("Vitest JUnit report is empty");
    // This shard's part of the inventory, validated exactly as a whole run is; with one shard it
    // is the whole inventory.
    const inventory = verifyInventory(
      discovered.filter((test) => selected.has(repositoryPath(test.file))),
      report,
      sources.filter((file) => selected.has(file)),
      suites.filter((suite) => selected.has(suite.file)),
    );
    await writeFile(join(evidenceDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    // The terminal-web project is one planning unit, so it is all here or all elsewhere.
    if (inventory.some((suite) => suite.project === "terminal-web"))
      await recordViewEvidence(report, inventory);
    await writeFile(
      join(evidenceDir, shardResultName),
      `${JSON.stringify({ index: shard.index, count: shard.count, runId, passed: true })}\n`,
    );
    console.log(
      `Required suite inventory passed${shard.count === 1 ? "" : ` for shard ${shard.index}/${shard.count}`}: ${inventory.map(({ project, file, passed }) => `${project}:${file} (${passed})`).join(", ")}`,
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
