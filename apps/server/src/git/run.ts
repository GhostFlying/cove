import { spawn } from "node:child_process";

// One bounded Git subprocess. Every Git command of the server goes through here so that none of
// them can hang a request or grow without limit:
// - git is spawned with an argument array, never a shell string, so a path or ref is never parsed
//   by a shell;
// - stdin is closed and prompting, pagers and the user's editor are disabled, so a credential
//   helper, pager or editor configured by the user cannot wait for a terminal that does not exist;
// - the environment is rebuilt from a short allowlist: a GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
//   GIT_CEILING_DIRECTORIES or GIT_CONFIG_* inherited from whoever started the server would
//   otherwise silently redirect the query to another repository or configuration;
// - messages are forced to the C locale, so the few stderr texts the caller classifies are stable;
// - stdout and stderr are capped; exceeding a cap or the time limit kills git with SIGKILL and
//   reports `overflow` or `timeout` instead of a partial answer.
//
// The user's global and system Git configuration (located through HOME, XDG_CONFIG_HOME and the
// GIT_CONFIG_{GLOBAL,SYSTEM,NOSYSTEM} switches) is still read: safe.directory and similar trust
// settings must apply to the server's queries exactly as they do to the user's own git.

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
  };
}

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

export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? GIT_OUTPUT_BYTES;
  return new Promise((settle) => {
    let child;
    try {
      child = spawn("git", ["--no-pager", ...args], {
        cwd: options.cwd,
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch {
      settle({ kind: "failed", reason: "spawn" });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = { stdout: 0, stderr: 0 };
    // The first reason Cove ended the run; it wins over the exit status the kill produces.
    let ended: "timeout" | "overflow" | null = null;
    const end = (reason: "timeout" | "overflow") => {
      if (ended) return;
      ended = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => end("timeout"), timeoutMs);
    const collect = (stream: "stdout" | "stderr", into: Buffer[]) => (chunk: Buffer) => {
      if (ended) return;
      bytes = { ...bytes, [stream]: bytes[stream] + chunk.byteLength };
      if (bytes[stream] > maxBytes) end("overflow");
      else into.push(chunk);
    };
    child.stdout.on("data", collect("stdout", stdout));
    child.stderr.on("data", collect("stderr", stderr));
    let spawnFailed = false;
    child.once("error", () => {
      // ENOENT (no git on PATH), EACCES or a bad cwd; `close` still follows.
      spawnFailed = true;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (ended) settle({ kind: "failed", reason: ended });
      else if (spawnFailed) settle({ kind: "failed", reason: "spawn" });
      else if (code === null) settle({ kind: "failed", reason: signal ? "signal" : "spawn" });
      else
        settle({
          kind: "exited",
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}
