import { spawn, type ChildProcess } from "node:child_process";
import { processStartIdentity } from "../store/processes.js";
import { gitEnvironment, runGit, type GitRunResult } from "./run.js";

// The Git side of managed worktree creation (docs/milestones/m1.md T3b, D1): fetching the source
// remote, resolving the base, the creation and removal steps and the queries a continue or an
// abandon decides from. domain/worktrees.ts orders them, records each step and does every
// filesystem check itself (under the shared filesystem permits); nothing here touches the
// database or the filesystem directly.
//
// Two kinds of command:
// - Queries (rev-parse, symbolic-ref, reflog, ls-remote, worktree list, status) change nothing in
//   the repository. They run through runGit (git/run.ts): bounded, and their process group is
//   killed when they end or when this server dies, because nothing depends on them finishing.
// - Steps (fetch, update-ref, worktree add, read-tree, worktree remove) change the repository.
//   They run through runGitStep below, in a process group of their own that is recorded before Git
//   starts and that is NOT killed when the server dies: losing the server is not proof that a step
//   stopped, and killing a Git write half way is worse than letting it finish. A restarted server
//   finds the recorded process, refuses to continue or abandon while it may still run, and decides
//   from what it observes once it ended (S8).
//
// The creation steps are chosen so that each one is a single Git command whose effect can be
// observed afterwards, and so that a step never takes over or destroys what was already there:
// - branch: `update-ref --no-deref --create-reflog -m "cove: create worktree branch <attempt>"
//   refs/heads/<b> <base> ""` creates the branch only if it does not exist (the empty old value),
//   atomically, so there is no gap between "the branch is free" and creating it, and an existing
//   branch is never moved. The reflog entry it writes names the attempt, for a person reading
//   the reflog; Cove decides from the branch's shape (domain/worktrees.ts, the threat model);
// - worktree: `worktree add --no-checkout <path> <b>` registers the worktree without writing files;
// - checkout: `read-tree -m -u HEAD` in the new worktree fills the index and the files. Unlike
//   `--reset`, it refuses to overwrite an untracked file that is in the way and keeps every other
//   file, so a checkout never destroys what someone put there.
// Removal (a failed attempt, or an abandon) is the reverse, and never forced:
// - `worktree remove <path>` without --force, so that Git itself refuses a worktree with changes
//   or untracked files at the moment it removes it; Git does remove ignored files, so the domain
//   first requires a status that lists ignored files to be empty. A worktree never checked out is
//   removed by the domain itself (its `.git` file, then an empty directory);
// - `update-ref --no-deref -d refs/heads/<b> <base>`, which deletes exactly that ref (never what a
//   symbolic ref points at) and only while it still points at the recorded base commit.
// The only forced command is the deletion of a managed worktree that the user explicitly confirmed
// (binding.delete, m1 T5, D10; domain/bindings.ts): forceRemoveWorktree, which keeps the branch.

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
// Overrides of the deadlines above (tests use short ones).
export type StepTimeouts = { fetchMs?: number; stepMs?: number; killGraceMs?: number };
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
//    The watcher ignores SIGTERM itself: the SIGTERM it sends reaches its own group, and a watcher
//    ended by it could no longer send the SIGKILL that a git ignoring SIGTERM needs.
//    Each signal also names the leader (the shell that becomes git; `$$` in the subshell) by PID:
//    on macOS a group signal (`kill 0`) sent by a member does not reliably reach the session
//    leader, so a git ignoring SIGTERM survived its deadline. Naming the PID is safe because a PID
//    is never reused while a process group with that ID exists, and the sender is a member of it.
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
  "(trap '' TERM; while :; do n=0; until c=$(/bin/dd bs=1 count=1 <&3 2>/dev/null); do n=$((n + 1)); " +
    '[ "$n" -ge 50 ] && exit 0; /bin/sleep 0.1; done; ' +
    'case "$c" in t) kill -s TERM $$ 0 ;; k) kill -s KILL $$ 0 ;; "") exit 0 ;; esac; done) ' +
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
  // gitEnvironment() unless given (a fetch gets networkEnvironment()).
  env?: NodeJS.ProcessEnv;
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
      env: options.env ?? gitEnvironment(),
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
  // The leader (git itself) is also signalled by this process directly, as a second path next to
  // the watcher's. A group signal sent by the watcher does not reliably reach the group leader on
  // macOS (see SUPERVISOR), and in one full test run a leader outlived the watcher's signal by PID
  // as well (cause not established). This process may signal it by PID: it is this process's own
  // child, and its PID cannot be reused before its exit has been seen here (Node reaps it and
  // reports the exit in one callback, after which `exit` is set). A leader that still does not end
  // leaves the step uncertain, with its process recorded, which is never treated as ended.
  const signalLeader = (signal: NodeJS.Signals) => {
    if (exit === null) child.kill(signal);
  };
  const grace = options.killGraceMs ?? STEP_KILL_GRACE_MS;
  const timers: NodeJS.Timeout[] = [];
  const unseen = new Promise<"unseen">((done) => {
    timers.push(
      setTimeout(() => {
        send("t");
        signalLeader("SIGTERM");
        timers.push(
          setTimeout(() => {
            send("k");
            signalLeader("SIGKILL");
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
// Environment.

// The environment of a command that contacts the remote (fetch, ls-remote): gitEnvironment(),
// which still excludes every variable that could redirect Git to another repository or
// configuration, plus SSH_AUTH_SOCK, so an SSH remote authenticates with the operator's agent as
// a plain `git fetch` would. Nothing may prompt: Git's terminal prompt is off
// (GIT_TERMINAL_PROMPT=0), an empty GIT_ASKPASS makes Git skip every askpass program (core.askPass
// and SSH_ASKPASS included), and SSH_ASKPASS_REQUIRE=never keeps ssh from starting one itself.
// The step runs in a session of its own without a terminal, so ssh cannot ask on a tty either.
export function networkEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...gitEnvironment(source),
    ...(source.SSH_AUTH_SOCK === undefined ? {} : { SSH_AUTH_SOCK: source.SSH_AUTH_SOCK }),
    GIT_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
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

// The branches named `branch` or `branch-<anything>`, local (refs/heads) or remote-tracking under
// any remote (refs/remotes/<remote>), together with any branch below them (`branch/...`, which
// would keep `branch` from being created), returned without their refs/heads/ or
// refs/remotes/<remote>/ prefix; "unavailable" when Git gave no answer. Matching ignores case
// (`--ignore-case`): on a case-insensitive file system, as macOS uses by default, `cove/Fix` and
// `cove/fix` are the same loose ref file. Used to choose a default branch that is free (D1); the
// caller passes a `branch` without glob characters.
export async function branchesLike(
  clone: string,
  branch: string,
): Promise<string[] | "unavailable"> {
  // A pattern without a wildcard also matches the refs below it; one with a wildcard does not,
  // hence the `/**` forms. `*` does not match `/`, so a remote name is one component.
  const patterns = [`refs/heads/${branch}`, `refs/heads/${branch}-*`];
  for (const name of [branch, `${branch}-*`])
    patterns.push(`refs/remotes/*/${name}`, `refs/remotes/*/${name}/**`);
  patterns.push(`refs/heads/${branch}-*/**`);
  const result = await runGit(
    ["for-each-ref", "--ignore-case", "--format=%(refname)", ...patterns],
    { cwd: clone },
  );
  if (result.kind !== "exited" || result.code !== 0) return "unavailable";
  const found: string[] = [];
  for (const ref of result.stdout.split("\n")) {
    if (ref.startsWith("refs/heads/")) found.push(ref.slice("refs/heads/".length));
    else if (ref.startsWith("refs/remotes/")) {
      const rest = ref.slice("refs/remotes/".length);
      const slash = rest.indexOf("/");
      if (slash > 0) found.push(rest.slice(slash + 1));
    }
  }
  return found;
}

// Whether refs/heads/<branch> is a symbolic ref (`symbolic-ref -q` exits 0 for one, 1 for a plain
// ref or none); null when Git gave no answer. A symbolic ref is never Cove's branch: Cove creates
// plain refs, and deleting through one would delete what it points at.
export async function isSymbolicRef(clone: string, branch: string): Promise<boolean | null> {
  const result = await runGit(["symbolic-ref", "--quiet", `refs/heads/${branch}`], { cwd: clone });
  if (result.kind !== "exited") return null;
  if (result.code === 0) return true;
  return result.code === 1 ? false : null;
}

// The message every branch creation of an attempt writes into the branch's reflog.
export function branchMarker(attemptId: string): string {
  return `cove: create worktree branch ${attemptId}`;
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
    env: networkEnvironment(),
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

// `head` is the commit the worktree's HEAD is at (null for a bare entry or without one).
export type WorktreeEntry = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
};

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
    const headField = fields.find((field) => field.startsWith("HEAD "));
    entries.push({
      path: head.slice("worktree ".length),
      head: headField ? headField.slice("HEAD ".length) : null,
      branch: branchField ? branchField.slice("branch ".length) : null,
      bare: fields.includes("bare"),
    });
  }
  return entries;
}

// `git rev-parse --git-path <name>` in a worktree, as an absolute path; null without an answer.
export async function gitPath(worktree: string, name: string): Promise<string | null> {
  const line = firstLine(await runGit(["rev-parse", "--git-path", name], { cwd: worktree }));
  if (line === null) return null;
  return line.startsWith("/") ? line : `${worktree}/${line}`;
}

// Whether a checked-out worktree's status lists nothing, ignored files included: the evidence that
// a checkout whose end was not seen completed (domain/worktrees.ts evidence). Removal does not use
// it; there Git's own refusal in `worktree remove` decides. Null when Git gave no usable answer.
export async function statusEmpty(worktree: string): Promise<boolean | null> {
  const status = await runGit(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ],
    { cwd: worktree },
  );
  if (status.kind !== "exited" || status.code !== 0) return null;
  return status.stdout === "";
}

// What a conversion leaves in the source checkout (m1 T5, D3: shown, never carried over), counted
// from `status --porcelain=v1 -z` without ignored files: entries with a staged change, entries
// with an unstaged one (an entry may have both; a submodule's own changes count as unstaged) and
// untracked entries (an untracked directory counts once). Null when Git gave no usable answer.
// Only counts are kept, never paths.
export async function sourceChanges(
  checkout: string,
): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const status = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"],
    { cwd: checkout },
  );
  if (status.kind !== "exited" || status.code !== 0) return null;
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  const fields = status.stdout.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") return null;
    const x = entry[0]!;
    const y = entry[1]!;
    if (x === "?" && y === "?") counts.untracked++;
    else {
      if (x !== " ") counts.staged++;
      if (y !== " ") counts.unstaged++;
    }
    // A rename or copy is followed by the field of its original path.
    if (x === "R" || x === "C" || y === "R" || y === "C") index++;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Steps. Each takes the recording hooks of runGitStep.

export type Recording = Pick<StepOptions, "record" | "ended">;

// Fetches the source remote. The remote's HEAD is not followed into origin/HEAD
// (remote.<name>.followRemoteHEAD=never, Git 2.48+; older Git ignores the setting and never
// changes it): the local origin/HEAD is the clone owner's, and D1 reads it as such.
export function fetchRemote(
  clone: string,
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return runGitStep(
    ["-c", `remote.${SOURCE_REMOTE}.followRemoteHEAD=never`, "fetch", "--quiet", SOURCE_REMOTE],
    {
      cwd: clone,
      timeoutMs: timeouts.fetchMs ?? FETCH_TIMEOUT_MS,
      env: networkEnvironment(),
      ...killGrace(timeouts),
      ...recording,
    },
  );
}

function killGrace(timeouts: StepTimeouts): { killGraceMs?: number } {
  return timeouts.killGraceMs === undefined ? {} : { killGraceMs: timeouts.killGraceMs };
}

function step(
  args: readonly string[],
  cwd: string,
  recording: Recording,
  timeouts: StepTimeouts,
): Promise<StepResult> {
  return runGitStep(args, {
    cwd,
    timeoutMs: timeouts.stepMs ?? STEP_TIMEOUT_MS,
    ...killGrace(timeouts),
    ...recording,
  });
}

export function createBranch(
  clone: string,
  input: { branch: string; baseCommit: string; attemptId: string },
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return step(
    [
      "update-ref",
      "--no-deref",
      "--create-reflog",
      "-m",
      branchMarker(input.attemptId),
      `refs/heads/${input.branch}`,
      input.baseCommit,
      "",
    ],
    clone,
    recording,
    timeouts,
  );
}

export function addWorktree(
  clone: string,
  path: string,
  branch: string,
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return step(
    ["worktree", "add", "--no-checkout", "--quiet", path, branch],
    clone,
    recording,
    timeouts,
  );
}

export function checkOut(
  path: string,
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return step(["read-tree", "-m", "-u", "HEAD"], path, recording, timeouts);
}

// Plain `worktree remove`, run in the source clone: never `--force`, so Git itself refuses a
// worktree with changes or untracked files (or a locked one), and that refusal keeps it.
export function removeWorktree(
  clone: string,
  path: string,
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return step(["worktree", "remove", path], clone, recording, timeouts);
}

// The deletion a user confirmed (m1 T5, D10): `worktree remove --force <path>` in the source
// clone removes the registered worktree with its uncommitted, untracked and ignored files and keeps
// its branch. One --force only: Git still refuses a locked worktree (that takes `-f -f`), and a
// lock is the owner's own explicit protection, so it stays. A worktree whose directory is already
// gone is deregistered.
export function forceRemoveWorktree(
  clone: string,
  path: string,
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return step(["worktree", "remove", "--force", path], clone, recording, timeouts);
}

export function deleteBranch(
  clone: string,
  branch: string,
  baseCommit: string,
  recording: Recording,
  timeouts: StepTimeouts = {},
): Promise<StepResult> {
  return step(
    ["update-ref", "--no-deref", "-d", `refs/heads/${branch}`, baseCommit],
    clone,
    recording,
    timeouts,
  );
}
