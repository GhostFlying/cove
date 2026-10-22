import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  escapeLogText,
  evaluateTendDoc,
  formatResult,
  gitIn,
  isTendFacingPath,
  readChangedPaths,
  readOptOut,
  readDocPresent,
  readPullRequestContext,
  runTendDocCheck,
  summaryCode,
  tendDoc,
} from "../../scripts/tend-doc-check.mjs";

const script = resolve(import.meta.dirname, "../../scripts/tend-doc-check.mjs");
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function isolatedDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cove-tend-doc-"));
  directories.push(path);
  return path;
}

const command = "apps/cli/src/commands/tab.ts";
// The doc exists at the head unless a test says otherwise.
const evaluate = (input) => evaluateTendDoc({ docPresent: true, ...input });

test("selects the CLI, protocol RPC and schema, and server store and operations paths", () => {
  for (const path of [
    command,
    "apps/cli/src/commands/_common.ts",
    "apps/cli/src/main.ts",
    "apps/cli/src/session.ts",
    "packages/protocol/src/rpc-methods.ts",
    "packages/protocol/src/rpc.ts",
    "packages/protocol/src/workspace.ts",
    "packages/protocol/src/errors.ts",
    "packages/protocol/src/auth.ts",
    "packages/protocol/src/bootstrap.ts",
    "apps/server/src/store/database.ts",
    "apps/server/src/operations/operation-receipts.ts",
    // The run and recipe environment (#160).
    "apps/server/src/domain/tabs.ts",
    "packages/terminal-worker/src/worker-execution.ts",
    "packages/protocol/src/pipe-command.ts",
  ]) {
    expect({ path, tendFacing: isTendFacingPath(path) }).toEqual({ path, tendFacing: true });
  }
  for (const path of [
    "apps/cli/src/harness-server.ts",
    "apps/cli/src/mainly.ts",
    "packages/protocol/src/terminal.ts",
    "packages/protocol/src/pipe.ts",
    "apps/server/src/terminal/runtime.ts",
    "apps/server/src/storehouse/x.ts",
    "packages/client/src/rpc.ts",
    // Neighbours of the listed run-environment files are not listed.
    "apps/server/src/domain/tab-bounds.ts",
    "packages/terminal-worker/src/worker-execution-helpers.ts",
    "packages/protocol/src/pipe-command.d.ts",
    tendDoc,
  ]) {
    expect({ path, tendFacing: isTendFacingPath(path) }).toEqual({ path, tendFacing: false });
  }
});

test("a test-only change is not tend-facing", () => {
  for (const path of [
    "apps/cli/tests/m1/s6-bindings.test.mjs",
    "apps/cli/tests/m1/s6-bindings.suite.json",
    "apps/server/src/store/config.test.ts",
    "apps/cli/src/commands/tab.spec.mts",
    "apps/server/src/operations/receipts.test.tsx",
    "tests/tooling/tend-doc-check.test.mjs",
  ]) {
    expect({ path, tendFacing: isTendFacingPath(path) }).toEqual({ path, tendFacing: false });
  }
  // Only real test roots and recognized test suffixes are exempt (#160): a tests/ directory inside
  // a source tree and a helper whose name merely contains `.test.` are source.
  for (const path of [
    "apps/cli/src/commands/tests/x.ts",
    "apps/cli/src/commands/tests/fixture.ts",
    "apps/server/src/store/tests/schema.ts",
    "apps/cli/src/commands/x.test.helpers.ts",
    "apps/server/src/store/config.test.json",
    "apps/server/src/operations/receipts.test.d.ts",
  ]) {
    expect({ path, tendFacing: isTendFacingPath(path) }).toEqual({ path, tendFacing: true });
  }
  const result = evaluate({
    changedPaths: ["apps/cli/tests/m1/cli-usability.test.mjs", "apps/server/src/store/a.test.ts"],
    body: "",
  });
  expect(result).toMatchObject({ outcome: "pass", tendPaths: [] });
});

test("a tend-facing change fails without the doc and passes with it", () => {
  const without = evaluate({ changedPaths: [command, "docs/design.md"], body: "" });
  expect(without).toMatchObject({ outcome: "fail", tendPaths: [command] });
  expect(without.message).toContain(tendDoc);
  expect(without.message).toContain("Shepherd-Doc: not-affected <reason>");
  expect(evaluate({ changedPaths: [command, tendDoc], body: null })).toMatchObject({
    outcome: "pass",
    tendPaths: [command],
  });
});

test("the opt-out marker needs not-affected and a non-empty reason", () => {
  for (const body of [
    "Shepherd-Doc: not-affected internal refactor, no output change",
    "Plan\r\n\r\nShepherd-Doc: not-affected  only comments\r\nCloses #1",
    "Shepherd-Doc:not-affected\tcomments",
  ]) {
    expect({ body, optOut: readOptOut(body) }).toEqual({ body, optOut: "valid" });
    expect(evaluate({ changedPaths: [command], body })).toMatchObject({ outcome: "pass" });
  }
  for (const body of [
    "Shepherd-Doc: not-affected",
    "Shepherd-Doc: not-affected   ",
    "Shepherd-Doc: not-affected \t\r\nmore",
    "Shepherd-Doc: not-affectedcomments",
    "Shepherd-Doc: affected",
    "Shepherd-Doc: not-affected reason\nShepherd-Doc: not-affected",
  ]) {
    expect({ body, optOut: readOptOut(body) }).toEqual({ body, optOut: "invalid" });
    // A malformed marker fails even when nothing tend-facing changed or the doc changed.
    expect(evaluate({ changedPaths: [], body })).toMatchObject({ outcome: "fail" });
    expect(evaluate({ changedPaths: [command, tendDoc], body })).toMatchObject({
      outcome: "fail",
    });
  }
  // Only a line that starts with the key is a marker.
  expect(readOptOut("Use `Shepherd-Doc: not-affected <reason>` to opt out")).toBe("absent");
  expect(readOptOut(undefined)).toBe("absent");
});

test("outside a pull_request event the check is skipped, not passed", () => {
  for (const env of [
    {},
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
  ]) {
    expect(readPullRequestContext(env)).toBeNull();
    const result = runTendDocCheck({
      env,
      git: () => {
        throw new Error("git must not run outside a pull request");
      },
    });
    expect(result.outcome).toBe("skip");
    expect(result.message).toMatch(/^Skipped: .*not a pull_request event.*This is not a pass\.$/);
  }
});

test("reads the base ref, head and description from the pull_request payload", () => {
  const head = "a".repeat(40);
  const payload = (pull) => () => JSON.stringify({ pull_request: pull });
  const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "/event.json" };
  expect(
    readPullRequestContext(env, payload({ base: { ref: "main" }, head: { sha: head }, body: "x" })),
  ).toEqual({ baseRef: "main", headSha: head, body: "x" });
  expect(
    readPullRequestContext(
      env,
      payload({ base: { ref: "main" }, head: { sha: head }, body: null }),
    ),
  ).toEqual({ baseRef: "main", headSha: head, body: "" });
  expect(() => readPullRequestContext(env, payload({ head: { sha: head } }))).toThrow(/base ref/);
  expect(() =>
    readPullRequestContext(env, payload({ base: { ref: "main" }, head: { sha: "HEAD" } })),
  ).toThrow(/head SHA/);
  expect(() => readPullRequestContext({ GITHUB_EVENT_NAME: "pull_request" })).toThrow(
    /GITHUB_EVENT_PATH/,
  );
});

async function commitFile(git, directory, path, content, message) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), content);
  git(["add", "--", path]);
  git(["commit", "-q", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

// A repository whose base branch moved on after the pull request forked from it, with the base
// published as origin/main the way a full-history checkout has it.
async function forkedRepository() {
  const directory = await isolatedDirectory();
  const git = gitIn(directory);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  await commitFile(git, directory, tendDoc, "doc\n", "doc");
  await commitFile(git, directory, "apps/cli/src/commands/old.ts", "x\n", "base");
  git(["switch", "-q", "-c", "topic"]);
  git(["mv", "apps/cli/src/commands/old.ts", "apps/cli/src/legacy.ts"]);
  git(["commit", "-q", "-m", "move"]);
  const head = await commitFile(git, directory, "apps/cli/tests/a.test.mjs", "t\n", "test");
  git(["switch", "-q", "main"]);
  // Changed on the base after the fork: not part of the pull request.
  await commitFile(git, directory, tendDoc, "doc changed\n", "doc on main");
  git(["update-ref", "refs/remotes/origin/main", "main"]);
  git(["switch", "-q", "--detach", head]);
  return { directory, git, head };
}

// Adds commits on top of `head` with `change` and returns the new head, detached.
async function extendHead(git, head, change) {
  git(["switch", "-q", "--detach", head]);
  await change();
  git(["commit", "-q", "-m", "change"]);
  return git(["rev-parse", "HEAD"]).trim();
}

async function runScript(directory, head, body, extraEnv = {}) {
  const event = join(await isolatedDirectory(), "event.json");
  await writeFile(
    event,
    JSON.stringify({ pull_request: { base: { ref: "main" }, head: { sha: head }, body } }),
  );
  return spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: event,
      ...extraEnv,
    },
  });
}

test("diffs the head against its merge base with origin/<base ref>, both sides of a rename", async () => {
  const { git, head } = await forkedRepository();
  const paths = readChangedPaths({ baseRef: "main", headSha: head }, git);
  expect(paths.sort()).toEqual([
    "apps/cli/src/commands/old.ts",
    "apps/cli/src/legacy.ts",
    "apps/cli/tests/a.test.mjs",
  ]);
  expect(() => readChangedPaths({ baseRef: "absent", headSha: head }, git)).toThrow(
    /no origin\/absent; it needs the full history/,
  );
  expect(() => readChangedPaths({ baseRef: "main", headSha: "b".repeat(40) }, git)).toThrow(
    /no head b{40}/,
  );
});

test("the script fails or passes a pull request by its description without printing it", async () => {
  const { directory, head } = await forkedRepository();
  const event = join(await isolatedDirectory(), "event.json");
  const secret = "description-text-that-must-not-be-logged";
  const run = async (body) => {
    await writeFile(
      event,
      JSON.stringify({ pull_request: { base: { ref: "main" }, head: { sha: head }, body } }),
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    return result;
  };
  const failed = await run(`${secret}\n`);
  expect(failed.status).toBe(1);
  expect(failed.stdout).toContain("::error title=Shepherd/tend doc check::");
  expect(failed.stdout).toContain("  tend-facing: apps/cli/src/commands/old.ts");
  const empty = await run(`${secret}\nShepherd-Doc: not-affected\n`);
  expect(empty.status).toBe(1);
  const optedOut = await run(`${secret}\nShepherd-Doc: not-affected ${secret}\n`);
  expect(optedOut.status).toBe(0);
  expect(optedOut.stdout).toContain("::notice title=Shepherd/tend doc check::");

  const skipped = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "push" },
  });
  expect(skipped.status).toBe(0);
  expect(skipped.stdout).toContain("::warning title=Shepherd/tend doc check::Skipped:");
});

test("a missing doc at the head fails whatever changed and whatever the description says", () => {
  for (const input of [
    { changedPaths: [tendDoc], body: "" },
    { changedPaths: [tendDoc, command], body: "" },
    { changedPaths: [tendDoc], body: "Shepherd-Doc: not-affected only the doc moved" },
    { changedPaths: ["docs/design.md"], body: "" },
  ]) {
    for (const docPresent of [false, undefined]) {
      const result = evaluateTendDoc({ ...input, docPresent });
      expect(result.outcome).toBe("fail");
      expect(result.message).toContain(`${tendDoc} does not exist at the pull request head`);
    }
  }
});

test("deleting or renaming away the doc fails the check in a real repository", async () => {
  const { directory, git, head } = await forkedRepository();
  expect(readDocPresent({ headSha: head }, git)).toBe(true);
  const reason = "Shepherd-Doc: not-affected only the doc changed";
  const deleted = await extendHead(git, head, async () => git(["rm", "-q", "--", tendDoc]));
  expect(readDocPresent({ headSha: deleted }, git)).toBe(false);
  expect(readChangedPaths({ baseRef: "main", headSha: deleted }, git)).toContain(tendDoc);
  const renamed = await extendHead(git, head, async () =>
    git(["mv", tendDoc, "docs/integrations/shepherd-tend-old.md"]),
  );
  expect(readDocPresent({ headSha: renamed }, git)).toBe(false);
  // A directory at the doc's path is not the doc either.
  const replaced = await extendHead(git, head, async () => {
    git(["rm", "-q", "--", tendDoc]);
    await mkdir(join(directory, tendDoc), { recursive: true });
    await writeFile(join(directory, tendDoc, "x"), "x\n");
    git(["add", "--", `${tendDoc}/x`]);
  });
  expect(readDocPresent({ headSha: replaced }, git)).toBe(false);
  for (const changed of [deleted, renamed, replaced]) {
    const result = await runScript(directory, changed, reason);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error title=Shepherd/tend doc check::${tendDoc} does not`);
  }
  // Editing the doc in place still passes.
  const edited = await extendHead(git, head, async () => {
    await writeFile(join(directory, tendDoc), "doc edited\n");
    git(["add", "--", tendDoc]);
  });
  expect(readDocPresent({ headSha: edited }, git)).toBe(true);
  expect((await runScript(directory, edited, "")).status).toBe(0);
});

test("untrusted filenames cannot inject workflow commands or summary markup", async () => {
  expect(escapeLogText("a\n::warning::x\r\u0007 \\b")).toBe(
    "a\\u{a}::warning::x\\u{d}\\u{7}\\u{2028}\\u{5c}b",
  );
  expect(summaryCode("a`<b>*_[x](y)\n|&")).toBe(
    "<code>a&#96;&#60;b&#62;&#42;_&#91;x&#93;&#40;y&#41;&#92;u&#123;a&#125;&#124;&#38;</code>",
  );
  const formatted = formatResult(
    { outcome: "fail", tendPaths: ["apps/cli/src/commands/a\n::warning::x.ts"], message: "m" },
    "token",
  );
  expect(formatted.log).toBe(
    "::error title=Shepherd/tend doc check::m\n::stop-commands::token\n" +
      "  tend-facing: apps/cli/src/commands/a\\u{a}::warning::x.ts\n::token::\n",
  );
  expect(formatted.summary).not.toContain("\n::");

  // End to end, with a real file whose name holds a newline and a workflow command.
  const { directory, git, head } = await forkedRepository();
  const name = "apps/cli/src/commands/evil\n::warning title=injected::x.ts";
  const changed = await extendHead(git, head, async () => {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), "x\n");
    git(["add", "--", name]);
  });
  const summary = join(await isolatedDirectory(), "summary.md");
  const result = await runScript(directory, changed, "", { GITHUB_STEP_SUMMARY: summary });
  expect(result.status).toBe(1);
  const lines = result.stdout.split("\n");
  // Our own error, then the stop-commands guard; the only other `::` line ends the guard.
  expect(lines[0]).toMatch(/^::error title=Shepherd\/tend doc check::/);
  const token = /^::stop-commands::([0-9a-f-]{36})$/.exec(lines[1])?.[1];
  expect(token).toBeDefined();
  expect(lines.filter((line) => line.startsWith("::"))).toEqual([
    lines[0],
    `::stop-commands::${token}`,
    `::${token}::`,
  ]);
  expect(result.stdout).toContain(
    "  tend-facing: apps/cli/src/commands/evil\\u{a}::warning title=injected::x.ts",
  );
  const text = await readFile(summary, "utf8");
  expect(text).not.toContain("::warning");
  expect(text).toContain("<code>apps/cli/src/commands/evil&#92;u&#123;a&#125;&#58;&#58;warning");
});
