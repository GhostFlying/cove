import { spawn, type ChildProcess } from "node:child_process";

// One bounded Git subprocess. Every Git command of the server goes through here so that none of
// them can hang a request or grow without limit:
// - git is spawned with an argument array, never a shell string, so a path or ref is never parsed
//   by a shell;
// - stdin is closed and prompting, pagers and the user's editor are disabled, so a credential
//   helper, pager or editor configured by the user cannot wait for a terminal that does not exist;
// - the environment is rebuilt from a short allowlist: a GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
//   GIT_CEILING_DIRECTORIES or GIT_CONFIG_* inherited from whoever started the server would
//   otherwise silently redirect the query to another repository or configuration;
// - repository configuration cannot make a read-only query run programs or contact a remote:
//   lazy fetching of missing objects from a promisor remote is disabled (GIT_NO_LAZY_FETCH, Git
//   2.45+; readHead, the only query that reads objects, refuses an older Git) and the file-system
//   monitor hook is off (core.fsmonitor);
// - messages are forced to the C locale, so the few stderr texts the caller classifies are stable;
// - stdout and stderr are capped, and the whole run has a deadline (see runGit for how the
//   process tree is ended and why completion is bounded).
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
};

// `exited`: git ran to completion with this status (0 or not). `failed`: there is no answer;
// `spawn` (git could not be started), `timeout`, `overflow` (an output cap was exceeded) or
// `signal` (git was ended by a signal Cove did not send). A failed run proves nothing about the
// repository, so callers must not read it as "not a repository".
export type GitRunResult =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "failed"; reason: "spawn" | "timeout" | "overflow" | "signal" };

// Sends SIGKILL to the process group the run created. ESRCH (the group is already empty) is the
// expected outcome after an orderly exit.
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH: nothing left to end. EPERM cannot happen for a group this process created.
  }
}

// Runs git once. Process tree and completion bounds:
//
// git starts as the leader of a new process group and session (`detached`), so every process it
// starts (helpers, wrappers, a shell script standing in for git) is in that group unless it
// deliberately leaves it, and none of them can open the server's controlling terminal.
//
// The group is signalled only while its ID is certainly still ours. A process group ID is the
// leader's PID, and the kernel does not hand out a PID that is still in use as a process or
// group ID. While the leader has not exited, its PID (alive or as an unreaped zombie) pins the
// ID. Once Node has reaped the leader, the ID stays pinned only while another member remains, so
// the group is signalled exactly once more, synchronously in the leader's `exit` handler, and
// never later. Reusing the ID in between would need every member to be gone and the PID space to
// wrap within that one tick.
//
// - Timeout or overflow before the leader exits: kill the group, destroy the pipes and settle at
//   once. Nothing waits for a descendant to close its copy of stdout or stderr.
// - Leader exits: kill the group (a read-only query has no legitimate background process; this
//   ends any descendant still holding the pipes) and settle on `close`, which then follows
//   promptly. The deadline still applies: if the pipes are not closed by then (a descendant that
//   left the group), the pipes are destroyed and the run is a timeout.
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? GIT_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("git", [...GLOBAL_OPTIONS, ...args], {
        cwd: options.cwd,
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
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
    let leaderExited = false;
    let spawnFailed = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

    const settle = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };
    // Cove ends the run: the group is killed only while the leader has not exited (see above).
    const abandon = (reason: "timeout" | "overflow") => {
      if (settled) return;
      if (!leaderExited && child.pid !== undefined) killGroup(child.pid);
      settle({ kind: "failed", reason });
    };
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
    child.stdout!.on("error", () => {});
    child.stderr!.on("error", () => {});
    child.once("error", () => {
      // ENOENT (no git on PATH), EACCES or a bad cwd. No process was started; `close` follows.
      spawnFailed = true;
      if (child.pid === undefined) settle({ kind: "failed", reason: "spawn" });
    });
    child.once("exit", (code, signal) => {
      leaderExited = true;
      exit = { code, signal };
      // The only signal after the leader was reaped: same tick, before its ID can be reused.
      if (child.pid !== undefined) killGroup(child.pid);
    });
    child.once("close", () => {
      if (spawnFailed) return settle({ kind: "failed", reason: "spawn" });
      if (!exit || exit.code === null)
        return settle({ kind: "failed", reason: exit?.signal ? "signal" : "spawn" });
      settle({
        kind: "exited",
        code: exit.code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
