// Fails a pull request that changes a surface Shepherd/tend consumes without also changing
// docs/integrations/shepherd-tend.md (the AGENTS.md rule; issue #101), unless the pull request
// description opts out with one line:
//
//   Shepherd-Doc: not-affected <reason>
//
//   node scripts/tend-doc-check.mjs
//
// Run from the checkout root by .github/workflows/tend-doc.yml. The pull request comes from the
// event payload at GITHUB_EVENT_PATH; the changed paths are those of `git diff <merge base>
// <head>`, the same three-dot comparison as the pull request's own file list, so commits that
// reached the base branch after the fork point are never attributed to the pull request. Outside
// a pull_request event there is no description and no base to compare against: the check says
// it was skipped and exits 0, which is not a pass. The description is never printed, since it may
// contain anything; only whether a marker was found is reported.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const tendDoc = "docs/integrations/shepherd-tend.md";

// What tend observes, by source location. tend drives Cove only through the `cove` CLI, so the
// surface is the CLI and what decides its requests, JSON output, error kinds and exit codes:
// - apps/cli/src/commands/: every command group, its flags, output and exit codes.
// - apps/cli/src/main.ts: the router, usage/help output and the top-level exit codes.
// - apps/cli/src/session.ts: data directory and server discovery (--home, COVE_HOME,
//   COVE_RENDEZVOUS) and the build identity a command checks.
// - packages/protocol/src/ RPC method table and envelope (rpc-methods.ts, rpc.ts) and the schemas
//   the CLI prints: workspace.ts (M1 task/workspace domain), errors.ts (error kinds and data),
//   auth.ts (M2 devices, entries and the service), bootstrap.ts (build identity in status).
// - apps/server/src/store/ and apps/server/src/operations/: persisted records, settings and
//   operation receipts, which are the run/operation semantics the CLI reports.
// The terminal channel and pipe protocol (terminal*.ts, pipe*.ts) are not listed: tend does not
// parse terminal bytes (shepherd-tend.md section 1). A change elsewhere that still alters a tend
// surface is caught by review, not by this list; an unaffected change here uses the marker.
export const tendFacingDirectories = Object.freeze([
  "apps/cli/src/commands/",
  "apps/server/src/store/",
  "apps/server/src/operations/",
]);
export const tendFacingFiles = Object.freeze([
  "apps/cli/src/main.ts",
  "apps/cli/src/session.ts",
  "packages/protocol/src/rpc-methods.ts",
  "packages/protocol/src/rpc.ts",
  "packages/protocol/src/workspace.ts",
  "packages/protocol/src/errors.ts",
  "packages/protocol/src/auth.ts",
  "packages/protocol/src/bootstrap.ts",
]);

// Tests change no surface: anything under a `tests/` directory, or a `*.test.*` file.
export function isTestPath(path) {
  return /(^|\/)tests\//.test(path) || /\.test\.[^/]+$/.test(path);
}

export function isTendFacingPath(path) {
  if (isTestPath(path)) return false;
  return (
    tendFacingFiles.includes(path) || tendFacingDirectories.some((dir) => path.startsWith(dir))
  );
}

const markerKey = "Shepherd-Doc:";

// "absent", "valid", or "invalid" when any line starting with the key is not exactly
// `Shepherd-Doc: not-affected <non-empty reason>`. A malformed marker fails rather than being
// ignored, so a typo cannot read as an opt-out that is silently not applied, or the reverse.
export function readOptOut(body) {
  let found = false;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (!line.startsWith(markerKey)) continue;
    const match = /^Shepherd-Doc:[ \t]*not-affected(?:[ \t]+(.*))?$/.exec(line.trimEnd());
    if (!match || !match[1]?.trim()) return "invalid";
    found = true;
  }
  return found ? "valid" : "absent";
}

export function evaluateTendDoc({ changedPaths, body }) {
  const tendPaths = changedPaths.filter(isTendFacingPath);
  const docChanged = changedPaths.includes(tendDoc);
  const optOut = readOptOut(body);
  if (optOut === "invalid") {
    return {
      outcome: "fail",
      tendPaths,
      message:
        `The description has a "${markerKey}" line that is not ` +
        `"${markerKey} not-affected <reason>" with a non-empty reason.`,
    };
  }
  if (tendPaths.length === 0) {
    return { outcome: "pass", tendPaths, message: "No tend-facing path changed." };
  }
  if (docChanged) {
    return { outcome: "pass", tendPaths, message: `Tend-facing paths changed with ${tendDoc}.` };
  }
  if (optOut === "valid") {
    return {
      outcome: "pass",
      tendPaths,
      message: `Tend-facing paths changed; the description opts out with a ${markerKey} marker.`,
    };
  }
  return {
    outcome: "fail",
    tendPaths,
    message:
      `Tend-facing paths changed but ${tendDoc} did not. Update it and its change log, or add ` +
      `the line "${markerKey} not-affected <reason>" to the pull request description.`,
  };
}

const objectName = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// null outside a pull_request event; otherwise the base branch, head commit and description.
export function readPullRequestContext(env, readFile = (path) => readFileSync(path, "utf8")) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return null;
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is not set");
  const pull = JSON.parse(readFile(env.GITHUB_EVENT_PATH)).pull_request;
  const baseRef = pull?.base?.ref;
  const headSha = pull?.head?.sha;
  if (typeof baseRef !== "string" || baseRef === "" || baseRef.startsWith("-")) {
    throw new Error("The pull_request payload has no usable base ref");
  }
  if (typeof headSha !== "string" || !objectName.test(headSha)) {
    throw new Error("The pull_request payload has no usable head SHA");
  }
  return { baseRef, headSha, body: typeof pull.body === "string" ? pull.body : "" };
}

export function gitIn(cwd) {
  return (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
}

// The workflow checks out the full history (fetch-depth: 0), which brings the base branch as
// origin/<base ref> and the head as a parent of the pull request's merge ref. A missing object
// is an error, never an empty diff.
export function readChangedPaths({ baseRef, headSha }, git) {
  const base = `refs/remotes/origin/${baseRef}`;
  for (const [name, revision] of [
    [`origin/${baseRef}`, base],
    [`head ${headSha}`, headSha],
  ]) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
    } catch {
      throw new Error(`The checkout has no ${name}; it needs the full history (fetch-depth: 0)`);
    }
  }
  const mergeBase = git(["merge-base", base, headSha]).trim();
  // --no-renames lists both sides of a rename, so moving a file out of a tend-facing directory
  // still counts as changing it.
  return git(["diff", "--name-only", "--no-renames", "-z", mergeBase, headSha])
    .split("\0")
    .filter(Boolean);
}

export function runTendDocCheck({ env, readFile, git }) {
  const context = readPullRequestContext(env, readFile);
  if (context === null) {
    return {
      outcome: "skip",
      tendPaths: [],
      message:
        `Skipped: this is a ${env.GITHUB_EVENT_NAME ? `"${env.GITHUB_EVENT_NAME}"` : "non-GitHub"} ` +
        "run, not a pull_request event, so there is no description or base to check against. " +
        "This is not a pass.",
    };
  }
  return evaluateTendDoc({ changedPaths: readChangedPaths(context, git), body: context.body });
}

function main() {
  const result = runTendDocCheck({ env: process.env, git: gitIn(process.cwd()) });
  const command = { pass: "notice", skip: "warning", fail: "error" }[result.outcome];
  console.log(`::${command} title=Shepherd/tend doc check::${result.message}`);
  for (const path of result.tendPaths) console.log(`  tend-facing: ${path}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Shepherd/tend doc check: ${result.outcome}\n\n${result.message}\n` +
        result.tendPaths.map((path) => `\n- \`${path}\``).join("") +
        "\n",
    );
  }
  if (result.outcome === "fail") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
