import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

// One bounded Git subprocess. Every Git command of the server goes through here so that none of
// them can hang a request or grow without limit:
// - git is run with an argument array, never a command string: the arguments reach git as "$@"
//   of a fixed supervisor script (see runGit), so a path or ref is never parsed by a shell;
// - git's stdin is /dev/null and prompting, pagers and the user's editor are disabled, so a
//   credential helper, pager or editor configured by the user cannot wait for a terminal that
//   does not exist;
// - the environment is rebuilt from a short allowlist: a GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
//   GIT_CEILING_DIRECTORIES or GIT_CONFIG_* inherited from whoever started the server would
//   otherwise silently redirect the query to another repository or configuration;
// - repository configuration cannot make a read-only query run programs or contact a remote:
//   lazy fetching of missing objects from a promisor remote is disabled (GIT_NO_LAZY_FETCH) and
//   the file-system monitor hook is off (core.fsmonitor);
// - only a Git that honours GIT_NO_LAZY_FETCH is ever run (see findGit): an older Git ignores the
//   variable silently, and in a partial clone reading a missing object would then fetch it from
//   the remote, even for a query that asked for no fetch;
// - messages are forced to the C locale, so the few stderr texts the caller classifies are stable;
// - stdout and stderr are capped, and the whole run has a deadline (see runGit for which
//   processes are ended and why completion is bounded).
//
// The user's global and system Git configuration (located through HOME, XDG_CONFIG_HOME and the
// GIT_CONFIG_{GLOBAL,SYSTEM,NOSYSTEM} switches) is still read: safe.directory and similar trust
// settings must apply to the server's queries exactly as they do to the user's own git.
//
// Supported Git: 2.45 or later, the first with GIT_NO_LAZY_FETCH (MINIMUM_GIT). Every command
// here and in git/worktree.ts runs the executable findGit resolved and verified, never `git` looked
// up again by the shell, so no later query can reach an older Git. The server checks it at startup
// too (entry/main.ts), so an unsupported Git is reported at once rather than as GIT_UNAVAILABLE.

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_OUTPUT_BYTES = 1024 * 1024;

const INHERITED = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
] as const;

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) if (source[name] !== undefined) env[name] = source[name];
  return {
    ...env,
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    // Read-only queries must not refresh the index or take optional locks in the user's clone.
    GIT_OPTIONAL_LOCKS: "0",
    // A missing object must not be fetched from a promisor remote: that would write objects and
    // run repository-configured transport commands (core.sshCommand, remote helpers).
    GIT_NO_LAZY_FETCH: "1",
  };
}

export const MINIMUM_GIT = [2, 45] as const;

// The `git` the server runs. `supported`: an executable that reported a version of at least
// MINIMUM_GIT. `missing`: no PATH entry has one. `too-old`: it reported an older version.
// `unknown`: it gave no usable version (it failed, timed out, or printed something else).
export type GitExecutable =
  | { kind: "supported"; path: string; version: string }
  | { kind: "missing" }
  | { kind: "too-old"; path: string; version: string }
  | { kind: "unknown"; path: string };

// Answers of the version check, by the identity of the file that gave them. A verdict holds only
// for the exact file that gave it: replacing it (a package upgrade or removal, another PATH) gives
// a new identity, which is checked again. Bounded: the server sees a handful of identities in its
// life, and dropping the map only costs a repeated `git version`.
const VERIFIED = new Map<string, Promise<GitExecutable>>();
const VERIFIED_LIMIT = 16;

// The first `git` on `env.PATH` and whether Cove may run it. Resolved for every command, so the
// answer follows PATH and the file it names; the version is asked once per file identity
// (VERIFIED). Only absolute PATH entries are searched: the shell would resolve a relative or empty
// entry against each command's working directory, so one query could reach a different Git than
// the one checked here. `timeoutMs` bounds the version check. A file replaced between this check
// and the command's exec is a residual window: it takes the owner's own concurrent change, and
// the next command checks the new file.
export async function findGit(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitExecutable> {
  for (const entry of (env.PATH ?? "").split(":")) {
    if (!isAbsolute(entry)) continue;
    // Appended as the shell's lookup does, not join()ed: join resolves `..` lexically, while the
    // kernel resolves it after following symlinks, so for `/var/../usr/bin` with /var a symlink
    // join would name another file than the one the shell runs.
    const path = `${entry}/git`;
    let identity: string;
    try {
      const found = await stat(path);
      if (!found.isFile()) continue;
      await access(path, constants.X_OK);
      identity = `${path}\0${found.dev}:${found.ino}:${found.size}:${found.mtimeMs}:${found.ctimeMs}`;
    } catch {
      continue;
    }
    const known = VERIFIED.get(identity);
    if (known) return known;
    const checked = gitVersion(path, env, timeoutMs);
    if (VERIFIED.size >= VERIFIED_LIMIT) VERIFIED.clear();
    VERIFIED.set(identity, checked);
    // No usable answer proves nothing about the file: it is asked again next time.
    void checked.then((result) => {
      if (result.kind === "unknown" && VERIFIED.get(identity) === checked)
        VERIFIED.delete(identity);
    });
    return checked;
  }
  return { kind: "missing" };
}

// `<path> version`, which reads no repository and runs nothing configured. It runs under the
// same supervision as every other command (see runGit), so a Git that hangs, floods its output or
// leaves helpers behind cannot hold the check past its deadline either.
async function gitVersion(
  path: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<GitExecutable> {
  const result = await supervised(path, ["version"], {
    cwd: "/",
    timeoutMs,
    maxOutputBytes: 4096,
    env: gitEnvironment(env),
  });
  const match =
    result.kind === "exited" && result.code === 0
      ? /^git version ((\d+)\.(\d+)\S*)/.exec(result.stdout)
      : null;
  if (!match) return { kind: "unknown", path };
  const [major, minor] = [Number(match[2]), Number(match[3])];
  const supported = major > MINIMUM_GIT[0] || (major === MINIMUM_GIT[0] && minor >= MINIMUM_GIT[1]);
  return { kind: supported ? "supported" : "too-old", path, version: match[1]! };
}

// What an unsupported Git means to the operator, without its path. Server startup reports it.
export function describeUnsupportedGit(git: Exclude<GitExecutable, { kind: "supported" }>): string {
  const required = `Cove requires Git ${MINIMUM_GIT.join(".")} or later`;
  // Apple's Command Line Tools Git (/usr/bin/git) can be older than that.
  const fix = "put a newer git (such as Homebrew's) first on PATH";
  if (git.kind === "missing") return `git was not found on PATH; ${required}`;
  if (git.kind === "too-old") return `git ${git.version} is too old: ${required}; ${fix}`;
  return `git did not report its version; ${required}`;
}

// Options placed before every command. core.fsmonitor names a program in the repository's own
// configuration that Git runs when it reads the index; no query here needs it.
const GLOBAL_OPTIONS = ["--no-pager", "-c", "core.fsmonitor=false"] as const;

export type GitRunOptions = {
  // Working directory of the command; the caller passes a real, absolute directory.
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  // The environment git runs with; gitEnvironment() unless the caller built one from it (a
  // command that contacts a remote, git/worktree.ts networkEnvironment).
  env?: NodeJS.ProcessEnv;
};

// `exited`: git ran to completion with this status (0 or not). `failed`: there is no answer;
// `spawn` (git could not be started), `timeout`, `overflow` (an output cap was exceeded) or
// `signal` (git was ended by a signal Cove did not send). A failed run proves nothing about the
// repository, so callers must not read it as "not a repository".
export type GitRunResult =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "failed"; reason: "spawn" | "timeout" | "overflow" | "signal" };

// Shell text for a supervisor's watcher subshell: send `signal` to the supervisor's process group
// and to its leader by PID (`$$` in a subshell is the supervisor shell, which `exec`s git and
// keeps that PID). The leader comes first. On macOS a group signal (`kill 0`) sent by a member of
// the group does not reliably reach the group leader, which is also the session leader here: a
// git stand-in waiting for its child saw the child die of the group's SIGKILL, then ran on past
// its deadline and exited 0 (#129: several of every hundred runs that reach their deadlines
// together; the same was seen in git/worktree.ts). A SIGKILL sent to the leader's PID has not been
// seen to miss. Naming the PID is safe: a PID is not reused while a process group with that ID
// exists, and the sender is a live member of that group. Both supervisors use this so that their
// kill paths cannot drift apart.
export function signalGroupAndLeader(signal: "TERM" | "KILL"): string {
  return `kill -s ${signal} $$ 0`;
}

// The supervisor script run by /bin/sh as the leader of the run's process group (see runGit).
// fd 3 becomes the watcher's pipe; git gets /dev/null as stdin and does not inherit fd 3. The
// watcher's output goes to /dev/null so that it never holds git's stdout or stderr open.
//
// The watcher waits with cat, which exits 0 only at end of file, rather than the shell's `read`,
// which returns the same status for end of file and for a read error. On macOS a read of the
// freshly inherited pipe occasionally fails once with EBADF (observed about once per thousand runs
// with Node's own stdin closed; bash 3.2's `read` and cat both see it, and a retry succeeds), and
// treating that as end of file would kill git mid-query. A read error is therefore retried for
// about 5 s; if it persists, the group is killed anyway, so the run fails (as `signal`) rather
// than leaving the group running. cat and sleep are named by path so that PATH cannot change them.
// Its first argument is the Git executable findGit verified.
const SUPERVISOR = [
  "cove_git=$1; shift",
  "exec 3<&0 0</dev/null",
  "(n=0; until /bin/cat <&3 >/dev/null; do n=$((n + 1)); " +
    `[ "$n" -ge 50 ] && break; /bin/sleep 0.1; done; ${signalGroupAndLeader("KILL")}) ` +
    "</dev/null >/dev/null 2>&1 &",
  'exec "$cove_git" "$@" 3<&-',
].join("\n");

// Runs git once. Process group and completion bounds:
//
// git runs in a new process group and session (`detached`), so every process it starts (helpers,
// wrappers, a shell script standing in for git) is in that group unless it deliberately leaves
// it, and none of them can open the server's controlling terminal.
//
// Who signals the group. A process group ID is a PID, and the kernel does not hand it out again
// while any process is still a member of that group. Node learns that a child ended only after
// libuv has reaped it (libuv reaps before it runs exit callbacks), so when Node could act on an
// exit the group may already be empty and its ID free for an unrelated group; checking that the
// ID exists and then signalling it keeps the same race. This process therefore never signals
// the group, or git, by number. Instead /bin/sh, the group leader (its PID is the group ID),
// starts a watcher in the background and then `exec`s git, which keeps the PID, so Node still
// receives git's own exit status. The watcher stays in the group and blocks reading a pipe
// whose only writer is this process. When this process closes it (git exited, timeout,
// overflow) or dies, the watcher sends SIGKILL to its own group (and to the leader by PID, see
// signalGroupAndLeader): signals sent by a live member of the group, so the group ID is pinned by
// the sender itself and cannot have been reused.
//
// Guarantee, and its limit. Completion is always bounded by the deadline. Descendants that remain
// in the created group are killed once git exits or the run is abandoned. A descendant that
// leaves the group (setsid, setpgid) is not contained: it keeps running, and if it holds stdout
// or stderr open the run ends at the deadline as a timeout. Containing such processes needs OS
// facilities beyond M1; git and its configuration are trusted local inputs, and the concern is
// helpers left running, not an adversary. If the watcher is killed from outside, descendants are
// likewise left running; completion stays bounded.
//
// - Timeout or overflow: close the watcher's pipe, destroy stdout and stderr, and settle at once.
//   Nothing waits for a descendant to close its copy of the pipes.
// - git exits: close the watcher's pipe (a read-only query has no legitimate background process)
//   and settle on `close`, which then follows promptly unless an escaped descendant holds the
//   pipes; the deadline then settles the run as a timeout.
//
// No supported Git (findGit: missing, older than MINIMUM_GIT, or no version) is reported as
// `spawn`, and nothing is run. If `exec` fails (the file went away), the shell exits 127 or 126.
// The Git commands Cove runs never exit with those statuses themselves (Git uses 0, 1, 128 and
// 129), so both are reported as `spawn` too. The version check, when one is needed, is part of
// the run's deadline.
export async function runGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  const started = performance.now();
  const deadlineMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = await findGit(options.env ?? process.env, deadlineMs);
  const timeoutMs = Math.floor(deadlineMs - (performance.now() - started));
  // A version check that used up the deadline is a timeout, like any other unanswered command.
  if (timeoutMs <= 0) return { kind: "failed", reason: "timeout" };
  if (git.kind !== "supported") return { kind: "failed", reason: "spawn" };
  return supervised(git.path, args, { ...options, timeoutMs });
}

// One supervised run of the executable `git` (see runGit).
function supervised(
  git: string,
  args: readonly string[],
  options: GitRunOptions & { timeoutMs: number },
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs;
  const maxBytes = options.maxOutputBytes ?? GIT_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", SUPERVISOR, "cove-git", git, ...GLOBAL_OPTIONS, ...args], {
        cwd: options.cwd,
        env: options.env ?? gitEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: true,
      });
    } catch {
      resolve({ kind: "failed", reason: "spawn" });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const bytes = { stdout: 0, stderr: 0 };
    let settled = false;
    let spawnFailed = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

    // Closing the only writer of the watcher's pipe makes the watcher kill the group.
    const releaseGroup = () => child.stdin?.destroy();
    const settle = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    const abandon = (reason: "timeout" | "overflow") => settle({ kind: "failed", reason });
    const timer = setTimeout(() => abandon("timeout"), timeoutMs);

    const collect = (stream: "stdout" | "stderr", into: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      bytes[stream] += chunk.byteLength;
      if (bytes[stream] > maxBytes) abandon("overflow");
      else into.push(chunk);
    };
    child.stdout!.on("data", collect("stdout", stdout));
    child.stderr!.on("data", collect("stderr", stderr));
    // A destroyed pipe may report an error; the run's outcome is already decided by then.
    child.stdin!.on("error", () => {});
    child.stdout!.on("error", () => {});
    child.stderr!.on("error", () => {});
    child.once("error", () => {
      // /bin/sh could not be started or the cwd is bad. No process was started; `close` follows.
      spawnFailed = true;
      if (child.pid === undefined) settle({ kind: "failed", reason: "spawn" });
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      releaseGroup();
    });
    child.once("close", () => {
      if (spawnFailed) return settle({ kind: "failed", reason: "spawn" });
      if (!exit || exit.code === null)
        return settle({ kind: "failed", reason: exit?.signal ? "signal" : "spawn" });
      if (exit.code === 126 || exit.code === 127)
        return settle({ kind: "failed", reason: "spawn" });
      settle({
        kind: "exited",
        code: exit.code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
