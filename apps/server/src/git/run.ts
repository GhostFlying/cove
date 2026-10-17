import { spawn, type ChildProcess } from "node:child_process";

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
//   lazy fetching of missing objects from a promisor remote is disabled (GIT_NO_LAZY_FETCH, Git
//   2.45+; readHead, the only query that reads objects, refuses an older Git) and the file-system
//   monitor hook is off (core.fsmonitor);
// - messages are forced to the C locale, so the few stderr texts the caller classifies are stable;
// - stdout and stderr are capped, and the whole run has a deadline (see runGit for which
//   processes are ended and why completion is bounded).
//
// The user's global and system Git configuration (located through HOME, XDG_CONFIG_HOME and the
// GIT_CONFIG_{GLOBAL,SYSTEM,NOSYSTEM} switches) is still read: safe.directory and similar trust
// settings must apply to the server's queries exactly as they do to the user's own git.
//
// Supported Git: 2.36 or later (`git worktree list -z`, repository.ts); readHead needs 2.45.

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
const SUPERVISOR = [
  "exec 3<&0 0</dev/null",
  "(n=0; until /bin/cat <&3 >/dev/null; do n=$((n + 1)); " +
    '[ "$n" -ge 50 ] && break; /bin/sleep 0.1; done; kill -s KILL 0) </dev/null >/dev/null 2>&1 &',
  'exec git "$@" 3<&-',
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
// overflow) or dies, the watcher runs `kill -s KILL 0`: a signal to its own group sent by a
// live member of it, so the group ID is pinned by the sender itself and cannot have been reused.
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
// If `exec` fails (no git on PATH, not executable), the shell exits 127 or 126. The Git commands
// Cove runs never exit with those statuses themselves (Git uses 0, 1, 128 and 129), so both are
// reported as `spawn`.
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? GIT_OUTPUT_BYTES;
  return new Promise((resolve) => {
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
