import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  evaluateTendDoc,
  gitIn,
  isTendFacingPath,
  readChangedPaths,
  readOptOut,
  readPullRequestContext,
  runTendDocCheck,
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
    tendDoc,
  ]) {
    expect({ path, tendFacing: isTendFacingPath(path) }).toEqual({ path, tendFacing: false });
  }
});

test("a test-only change is not tend-facing", () => {
  for (const path of [
    "apps/cli/tests/m1/s6-bindings.test.mjs",
    "apps/cli/tests/m1/s6-bindings.suite.json",
    "apps/cli/src/commands/tests/fixture.ts",
    "apps/server/src/store/config.test.ts",
    "tests/tooling/tend-doc-check.test.mjs",
  ]) {
    expect({ path, tendFacing: isTendFacingPath(path) }).toEqual({ path, tendFacing: false });
  }
  const result = evaluateTendDoc({
    changedPaths: ["apps/cli/tests/m1/cli-usability.test.mjs", "apps/server/src/store/a.test.ts"],
    body: "",
  });
  expect(result).toMatchObject({ outcome: "pass", tendPaths: [] });
});

test("a tend-facing change fails without the doc and passes with it", () => {
  const without = evaluateTendDoc({ changedPaths: [command, "docs/design.md"], body: "" });
  expect(without).toMatchObject({ outcome: "fail", tendPaths: [command] });
  expect(without.message).toContain(tendDoc);
  expect(without.message).toContain("Shepherd-Doc: not-affected <reason>");
  expect(evaluateTendDoc({ changedPaths: [command, tendDoc], body: null })).toMatchObject({
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
    expect(evaluateTendDoc({ changedPaths: [command], body })).toMatchObject({ outcome: "pass" });
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
    expect(evaluateTendDoc({ changedPaths: [], body })).toMatchObject({ outcome: "fail" });
    expect(evaluateTendDoc({ changedPaths: [command, tendDoc], body })).toMatchObject({
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
  await commitFile(git, directory, "apps/cli/src/commands/old.ts", "x\n", "base");
  git(["switch", "-q", "-c", "topic"]);
  git(["mv", "apps/cli/src/commands/old.ts", "apps/cli/src/legacy.ts"]);
  git(["commit", "-q", "-m", "move"]);
  const head = await commitFile(git, directory, "apps/cli/tests/a.test.mjs", "t\n", "test");
  git(["switch", "-q", "main"]);
  // Changed on the base after the fork: not part of the pull request.
  await commitFile(git, directory, tendDoc, "doc\n", "doc on main");
  git(["update-ref", "refs/remotes/origin/main", "main"]);
  git(["switch", "-q", "--detach", head]);
  return { directory, git, head };
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
