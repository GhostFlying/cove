import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { processStartIdentity } from "../store/processes.js";
import { gitEnvironment, runGit, type GitRunResult } from "./run.js";

// The Git side of managed worktree creation (docs/milestones/m1.md T3b, D1): fetching the source
// remote, resolving the base, the three creation steps and the observation a restart, a continue
// or an abandon decides from. domain/worktrees.ts orders them; nothing here touches the database.
//
// Two kinds of command:
// - Queries (rev-parse, symbolic-ref, ls-remote, worktree list, status) change nothing in the
//   repository. They run through runGit (git/run.ts): bounded, and their process group is killed
//   when they end or when this server dies, because nothing depends on them finishing.
// - Steps (fetch, update-ref, worktree add, read-tree, worktree remove) change the repository.
//   They run through runGitStep below, in a process group of their own that is recorded before Git
//   starts and that is NOT killed when the server dies: losing the server is not proof that a step
//   stopped, and killing a Git write half way is worse than letting it finish. A restarted server
//   finds the recorded process, refuses to continue or abandon while it may still run, and decides
//   from what it observes once it ended (S8).
//
// The creation steps are chosen so that each one is a single Git command whose effect can be
// observed afterwards, and so that a step never takes over something it did not create:
// - branch: `update-ref refs/heads/<b> <base> ""` creates the branch only if it does not exist
//   (the empty old value), atomically, so there is no gap between "the branch is free" and creating
//   it, and an existing branch is never moved;
// - worktree: `worktree add --no-checkout <path> <b>` registers the worktree without writing files;
// - checkout: `read-tree --reset -u HEAD` in the new worktree fills the index and the files.
// Removal for abandon is the reverse, again guarded: `worktree remove --force` only for a worktree
// observed exactly as created, and `update-ref -d refs/heads/<b> <base>`, which deletes the branch
// only while it still points at the recorded base commit.

// The remote Cove fetches and resolves the main branch from (D1). A clone without it gets
// FETCH_FAILED (or MAIN_BRANCH_UNRESOLVED with --no-fetch) and the operator passes --base.
export const SOURCE_REMOTE = "origin";

// The order D1 falls back to when neither the setting, origin/HEAD nor the remote's HEAD names
// the main branch.
export const MAIN_BRANCH_CANDIDATES = ["main", "master", "trunk", "develop"] as const;

// Deadlines of the steps. A fetch can wait for a slow remote or a credential helper; the other
// steps are local, but a checkout of a large tree takes a while. At the deadline the group gets
// SIGTERM and, STEP_KILL_GRACE_MS later, SIGKILL; a step still not seen to exit after that is
// reported uncertain.
export const FETCH_TIMEOUT_MS = 120_000;
export const STEP_TIMEOUT_MS = 300_000;
export const STEP_KILL_GRACE_MS = 10_000;
const QUERY_NETWORK_TIMEOUT_MS = 30_000;
const STEP_OUTPUT_BYTES = 1024 * 1024;

// Status 125 from the supervisor means it never started git (see SUPERVISOR); Git itself exits 0,
// 1, 128 or 129, and 126/127 mean the exec of git failed.
const NOT_STARTED_STATUS = 125;

export type StartedProcess = { pid: number; pgid: number; startIdentity: string };

// - exited: the command ran to completion with this status;
// - not-started: git certainly never ran (it could not be started, its process could not be
//   identified, or recording it failed), so nothing changed;
// - uncertain: it may have run, wholly or in part (it timed out or was killed and its exit was not
//   seen, or its output overflowed); only an observation tells what it did.
export type StepResult =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "not-started" }
  | { kind: "uncertain" };

// The supervisor script, run by /bin/sh as the leader of a new process group (its PID is the
// group ID), with this process's pipe as stdin:
// 1. It waits for one byte, "g", before it starts git. The server reads the start identity of the
//    waiting shell and records it durably first (ProcessLedger), so the record names a process that
//    is known to be alive and cannot have been reused, and no git ever runs unrecorded. Any other
//    outcome (end of file because the server died or gave up) exits with 125 without running git.
// 2. A watcher stays in the group and reads further bytes: "t" sends SIGTERM to the group, "k"
//    SIGKILL; both are sent by a live member of the group to its own group, so the group ID cannot
//    have been reused (see git/run.ts for why this process never signals a group by number). End of
//    file ends the watcher and leaves the group running: that is what happens when the server dies.
// 3. `exec git` keeps the PID, so the recorded identity stays the process's, and Node receives
//    git's own exit status.
// Bytes are read with dd, one byte per read(2), so a byte meant for the watcher is never consumed
// by the first read. On macOS a read of a freshly inherited pipe occasionally fails once with
// EBADF (git/run.ts); dd then exits non-zero and the read is retried for about 5 s.
const SUPERVISOR = [
  "exec 3<&0 0</dev/null",
  "n=0",
  "until g=$(/bin/dd bs=1 count=1 <&3 2>/dev/null); do n=$((n + 1)); " +
    '[ "$n" -ge 50 ] && exit 125; /bin/sleep 0.1; done',
  `[ "$g" = g ] || exit ${NOT_STARTED_STATUS}`,
  "(while :; do n=0; until c=$(/bin/dd bs=1 count=1 <&3 2>/dev/null); do n=$((n + 1)); " +
    '[ "$n" -ge 50 ] && exit 0; /bin/sleep 0.1; done; ' +
    'case "$c" in t) kill -s TERM 0 ;; k) kill -s KILL 0 ;; "") exit 0 ;; esac; done) ' +
    "</dev/null >/dev/null 2>&1 &",
  'exec git "$@" 3<&-',
].join("\n");

const GLOBAL_OPTIONS = ["--no-pager", "-c", "core.fsmonitor=false"] as const;

export type StepOptions = {
  cwd: string;
  timeoutMs: number;
  // Records the started process durably; git starts only once it resolved. A rejection means it
  // was not recorded, and git is not started.
  record: (process: StartedProcess) => Promise<unknown>;
  // Called once a recorded process was observed to end, before the result is returned.
  ended?: () => Promise<unknown>;
  killGraceMs?: number;
};

// How long the pipes may stay open after git exited (a descendant that left the group holds them)
// before the result is taken from what was read.
const CLOSE_AFTER_EXIT_MS = 5_000;

// Runs one Git step in a recorded process group of its own (see the header and SUPERVISOR).
export async function runGitStep(
  args: readonly string[],
  options: StepOptions,
): Promise<StepResult> {
  let child: ChildProcess;
  try {
    child = spawn("/bin/sh", ["-c", SUPERVISOR, "cove-git", ...GLOBAL_OPTIONS, ...args], {
      cwd: options.cwd,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
  } catch {
    return { kind: "not-started" };
  }
  // The step must not keep this process alive: an orderly stop of the server ends without waiting
  // for it, and the step goes on, recorded, like after a crash.
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr])
    (stream as unknown as { unref?: () => void } | null)?.unref?.();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const collect = (into: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > STEP_OUTPUT_BYTES) overflow = true;
    else into.push(chunk);
  };
  child.stdout!.on("data", collect(stdout));
  child.stderr!.on("data", collect(stderr));
  // A pipe closed by either side may report an error; the outcome is decided by the exit.
  child.stdin!.on("error", () => {});
  child.stdout!.on("error", () => {});
  child.stderr!.on("error", () => {});
  const send = (byte: string) => {
    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(byte);
  };
  let exit: { code: number | null } | null = null;
  // Resolves with the exit status once the process ended and its pipes closed (or shortly after
  // the exit, see CLOSE_AFTER_EXIT_MS); null when it could not be started at all.
  const ended = new Promise<{ code: number | null } | null>((done) => {
    child.once("error", () => {
      if (child.pid === undefined) done(null);
    });
    child.once("exit", (code) => {
      exit = { code };
      // Ends whatever git left in its group (a helper it started in the background); the step
      // itself is over. The watcher then ends with the group.
      send("k");
      setTimeout(() => done(exit), CLOSE_AFTER_EXIT_MS).unref();
    });
    child.once("close", () => done(exit ?? { code: null }));
  });
  const release = () => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const pid = child.pid;
  if (pid === undefined) {
    await ended;
    release();
    return { kind: "not-started" };
  }
  // The shell waits for "g" (SUPERVISOR), so it is alive here and its PID cannot be reused yet.
  const startIdentity = await processStartIdentity(pid);
  let recorded = false;
  if (startIdentity !== null && exit === null) {
    try {
      await options.record({ pid, pgid: pid, startIdentity });
      recorded = true;
    } catch {
      // Not recorded: git must not start.
    }
  }
  const markEnded = async () => {
    if (recorded) await options.ended?.().catch(() => undefined);
  };
  if (!recorded || exit !== null) {
    // End of file makes the shell exit 125 without running git.
    child.stdin?.end();
    await ended;
    release();
    await markEnded();
    return { kind: "not-started" };
  }
  send("g");
  const grace = options.killGraceMs ?? STEP_KILL_GRACE_MS;
  const timers: NodeJS.Timeout[] = [];
  const unseen = new Promise<"unseen">((done) => {
    timers.push(
      setTimeout(() => {
        send("t");
        timers.push(
          setTimeout(() => {
            send("k");
            // Not seen to exit even after SIGKILL: what it did is unknown.
            timers.push(setTimeout(() => done("unseen"), grace).unref());
          }, grace).unref(),
        );
      }, options.timeoutMs).unref(),
    );
  });
  const outcome = await Promise.race([ended, unseen]);
  for (const timer of timers) clearTimeout(timer);
  release();
  if (outcome === "unseen") return { kind: "uncertain" };
  await markEnded();
  const code = outcome?.code ?? null;
  if (code === null) return { kind: "uncertain" };
  if (code === NOT_STARTED_STATUS || code === 126 || code === 127) return { kind: "not-started" };
  if (overflow) return { kind: "uncertain" };
  return {
    kind: "exited",
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

// ---------------------------------------------------------------------------------------------
// Queries.

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function firstLine(result: GitRunResult): string | null {
  if (result.kind !== "exited" || result.code !== 0) return null;
  const line = result.stdout.split("\n")[0] ?? "";
  return line || null;
}

// The commit `ref` names (peeled), null when it names none, "unavailable" when Git gave no answer.
export async function commitOf(clone: string, ref: string): Promise<string | null | "unavailable"> {
  const result = await runGit(["rev-parse", "--quiet", "--verify", `${ref}^{commit}`], {
    cwd: clone,
  });
  if (result.kind === "failed") return "unavailable";
  if (result.code !== 0) return null;
  const id = firstLine(result);
  return id && OBJECT_ID.test(id) ? id : "unavailable";
}

// The commit a branch points at (no peeling: a branch names a commit), null when it does not exist.
export async function branchCommit(
  clone: string,
  branch: string,
): Promise<string | null | "unavailable"> {
  const result = await runGit(["rev-parse", "--quiet", "--verify", `refs/heads/${branch}`], {
    cwd: clone,
  });
  if (result.kind === "failed") return "unavailable";
  if (result.code === 1) return null;
  if (result.code !== 0) return "unavailable";
  const id = firstLine(result);
  return id && OBJECT_ID.test(id) ? id : "unavailable";
}

// Whether the remote-tracking branch of `branch` exists.
async function trackingCommit(clone: string, branch: string) {
  return commitOf(clone, `refs/remotes/${SOURCE_REMOTE}/${branch}`);
}

// The branch the local origin/HEAD points at, null when there is none.
async function localRemoteHead(clone: string): Promise<string | null | "unavailable"> {
  const result = await runGit(["symbolic-ref", "--quiet", `refs/remotes/${SOURCE_REMOTE}/HEAD`], {
    cwd: clone,
  });
  if (result.kind === "failed") return "unavailable";
  if (result.code !== 0) return null;
  const ref = firstLine(result);
  const prefix = `refs/remotes/${SOURCE_REMOTE}/`;
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

// The branch the remote's HEAD names (`git ls-remote --symref`), null when it names none or the
// remote does not answer. It is a fallback of the resolution, never a reason to fail it: an
// unreachable remote was already reported by the fetch.
async function remoteHead(clone: string): Promise<string | null> {
  const result = await runGit(["ls-remote", "--symref", SOURCE_REMOTE, "HEAD"], {
    cwd: clone,
    timeoutMs: QUERY_NETWORK_TIMEOUT_MS,
  });
  if (result.kind !== "exited" || result.code !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

export type BaseResolution =
  | { kind: "resolved"; ref: string; commit: string }
  | { kind: "unresolved" }
  | { kind: "invalid-base" }
  | { kind: "unavailable" };

// The base commit of a new worktree (D1): an explicit base; otherwise the remote-tracking branch of
// the main branch, resolved in this order: Cove's main-branch setting, origin/HEAD, the remote's
// HEAD (`ls-remote --symref`, skipped with --no-fetch, which promises not to contact the remote),
// then the first of MAIN_BRANCH_CANDIDATES that exists as a remote-tracking branch. Never the local
// HEAD or a local branch: a base nobody asked for is a silent guess (Orca falls back to them).
export async function resolveBase(
  clone: string,
  options: { base: string | null; mainBranch: string | null; offline: boolean },
): Promise<BaseResolution> {
  const resolved = async (ref: string): Promise<BaseResolution | null> => {
    const commit = await commitOf(clone, ref);
    if (commit === "unavailable") return { kind: "unavailable" };
    return commit === null ? null : { kind: "resolved", ref, commit };
  };
  if (options.base !== null) return (await resolved(options.base)) ?? { kind: "invalid-base" };
  const tracking = (branch: string) => resolved(`refs/remotes/${SOURCE_REMOTE}/${branch}`);
  // A setting that the remote does not have is not silently replaced by another branch.
  if (options.mainBranch !== null)
    return (await tracking(options.mainBranch)) ?? { kind: "unresolved" };
  const local = await localRemoteHead(clone);
  if (local === "unavailable") return { kind: "unavailable" };
  if (local !== null) {
    const found = await tracking(local);
    if (found) return found;
  }
  if (!options.offline) {
    const named = await remoteHead(clone);
    if (named !== null) {
      const found = await tracking(named);
      if (found) return found;
    }
  }
  for (const candidate of MAIN_BRANCH_CANDIDATES) {
    const commit = await trackingCommit(clone, candidate);
    if (commit === "unavailable") return { kind: "unavailable" };
    if (commit !== null)
      return { kind: "resolved", ref: `refs/remotes/${SOURCE_REMOTE}/${candidate}`, commit };
  }
  return { kind: "unresolved" };
}

type WorktreeEntry = { path: string; branch: string | null; bare: boolean };

// Every worktree of the clone (`worktree list --porcelain -z`, Git 2.36+), null when Git gave no
// usable answer.
export async function listWorktrees(clone: string): Promise<WorktreeEntry[] | null> {
  const result = await runGit(["worktree", "list", "--porcelain", "-z"], { cwd: clone });
  if (result.kind !== "exited" || result.code !== 0) return null;
  const entries: WorktreeEntry[] = [];
  for (const record of result.stdout.split("\0\0")) {
    if (!record) continue;
    const fields = record.split("\0").filter(Boolean);
    const head = fields[0];
    if (!head?.startsWith("worktree ")) return null;
    const branchField = fields.find((field) => field.startsWith("branch "));
    entries.push({
      path: head.slice("worktree ".length),
      branch: branchField ? branchField.slice("branch ".length) : null,
      bare: fields.includes("bare"),
    });
  }
  return entries;
}

// What is at the intended worktree path, relative to the recorded intent:
// - absent: no worktree is registered there and nothing is at the path;
// - unchecked: our worktree is registered there on the branch, with no index and nothing but its
//   `.git` file (created by `worktree add --no-checkout`, not checked out yet);
// - partial: as unchecked, but files are already there (a checkout cut short);
// - clean: checked out on the branch, with nothing changed, staged or untracked;
// - changed: checked out on the branch, with changes;
// - foreign: something else is at the path, or registered there on another branch;
// - unknown: it could not be established.
export type WorktreeObservation =
  "absent" | "unchecked" | "partial" | "clean" | "changed" | "foreign" | "unknown";
// - absent: no such branch; at-base: it points at the recorded base; moved: it points elsewhere.
export type BranchObservation = "absent" | "at-base" | "moved" | "unknown";
export type Observation = {
  branch: BranchObservation;
  worktree: WorktreeObservation;
  // Other worktrees that have the branch checked out (abandon never deletes such a branch).
  branchUsedElsewhere: boolean;
};

async function pathState(path: string): Promise<"absent" | "present" | "unknown"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "absent" : "unknown";
  }
}

async function worktreeContent(path: string): Promise<WorktreeObservation> {
  const indexRun = await runGit(["rev-parse", "--git-path", "index"], { cwd: path });
  const indexText = firstLine(indexRun);
  if (indexText === null) return "unknown";
  const index = await pathState(isAbsolute(indexText) ? indexText : resolve(path, indexText));
  if (index === "unknown") return "unknown";
  if (index === "absent") {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return "unknown";
    }
    return names.length === 1 && names[0] === ".git" ? "unchecked" : "partial";
  }
  const status = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    { cwd: path },
  );
  if (status.kind !== "exited" || status.code !== 0) return "unknown";
  return status.stdout === "" ? "clean" : "changed";
}

export async function observe(
  clone: string,
  intent: { path: string; branch: string; baseCommit: string },
): Promise<Observation> {
  const [commit, worktrees, atPath] = await Promise.all([
    branchCommit(clone, intent.branch),
    listWorktrees(clone),
    pathState(intent.path),
  ]);
  const branch: BranchObservation =
    commit === "unavailable"
      ? "unknown"
      : commit === null
        ? "absent"
        : commit === intent.baseCommit
          ? "at-base"
          : "moved";
  if (worktrees === null || atPath === "unknown")
    return { branch, worktree: "unknown", branchUsedElsewhere: false };
  const ref = `refs/heads/${intent.branch}`;
  const registered = worktrees.find((entry) => entry.path === intent.path);
  const branchUsedElsewhere = worktrees.some(
    (entry) => entry.path !== intent.path && entry.branch === ref,
  );
  let worktree: WorktreeObservation;
  if (!registered) worktree = atPath === "absent" ? "absent" : "foreign";
  else if (registered.branch !== ref || atPath === "absent") worktree = "foreign";
  else worktree = await worktreeContent(intent.path);
  return { branch, worktree, branchUsedElsewhere };
}

// ---------------------------------------------------------------------------------------------
// Steps. Each takes the recording hooks of runGitStep.

export type Recording = Pick<StepOptions, "record" | "ended">;

// Fetches the source remote. The remote's HEAD is not followed into origin/HEAD
// (remote.<name>.followRemoteHEAD=never, Git 2.48+; older Git ignores the setting and never
// changes it): the local origin/HEAD is the clone owner's, and D1 reads it as such.
export function fetchRemote(clone: string, recording: Recording): Promise<StepResult> {
  return runGitStep(
    ["-c", `remote.${SOURCE_REMOTE}.followRemoteHEAD=never`, "fetch", "--quiet", SOURCE_REMOTE],
    { cwd: clone, timeoutMs: FETCH_TIMEOUT_MS, ...recording },
  );
}

export function createBranch(
  clone: string,
  branch: string,
  baseCommit: string,
  recording: Recording,
): Promise<StepResult> {
  return runGitStep(
    ["update-ref", "-m", "cove: create worktree branch", `refs/heads/${branch}`, baseCommit, ""],
    { cwd: clone, timeoutMs: STEP_TIMEOUT_MS, ...recording },
  );
}

export function addWorktree(
  clone: string,
  path: string,
  branch: string,
  recording: Recording,
): Promise<StepResult> {
  return runGitStep(["worktree", "add", "--no-checkout", "--quiet", path, branch], {
    cwd: clone,
    timeoutMs: STEP_TIMEOUT_MS,
    ...recording,
  });
}

export function checkOut(path: string, recording: Recording): Promise<StepResult> {
  return runGitStep(["read-tree", "--reset", "-u", "HEAD"], {
    cwd: path,
    timeoutMs: STEP_TIMEOUT_MS,
    ...recording,
  });
}

export function removeWorktree(
  clone: string,
  path: string,
  recording: Recording,
): Promise<StepResult> {
  return runGitStep(["worktree", "remove", "--force", path], {
    cwd: clone,
    timeoutMs: STEP_TIMEOUT_MS,
    ...recording,
  });
}

export function deleteBranch(
  clone: string,
  branch: string,
  baseCommit: string,
  recording: Recording,
): Promise<StepResult> {
  return runGitStep(["update-ref", "-d", `refs/heads/${branch}`, baseCommit], {
    cwd: clone,
    timeoutMs: STEP_TIMEOUT_MS,
    ...recording,
  });
}
