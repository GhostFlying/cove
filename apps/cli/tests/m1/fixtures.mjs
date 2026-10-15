import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRendezvous } from "../../dist/session.js";
import { waitFor } from "../recording-view.mjs";
import { stopServer, within } from "../server-process.mjs";
import { isolatedEnv } from "../test-env.mjs";

// Shared fixtures of the M1 CLI scenarios. Every scenario drives the compiled `cove` executable
// against temporary data directories and temporary Git repositories under one temporary root;
// HOME and COVE_HOME point into that root (isolatedEnv), so no scenario can read or write the
// operator's real data directory, Git configuration or repositories.
//
// A fixture tracks every process a scenario creates or learns about (servers, background CLI
// commands, workers, PTY processes reported by marker files). `cleanup()` ends all of them,
// confirms that each one exited and removes the root; call it from `finally`/afterEach whether
// or not the scenario passed.

export const cli = resolve(import.meta.dirname, "../../dist/main.js");

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function kill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function run(file, args, options) {
  return new Promise((done) => {
    execFile(file, args, { timeout: 30_000, ...options }, (error, stdout, stderr) =>
      done({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        signal: error?.signal ?? null,
        stdout,
        stderr,
      }),
    );
  });
}

export async function createM1Fixture() {
  // Realpath the root: on macOS /var is a symlink, and the server refuses a data directory or
  // rendezvous reached through a symlinked ancestor.
  const root = await realpath(await mkdtemp(join(tmpdir(), "cove-m1-")));
  const userHome = join(root, "user-home");
  await mkdir(userHome, { mode: 0o700 });
  const env = isolatedEnv(userHome, { GIT_CONFIG_NOSYSTEM: "1" });
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) delete env[name];
  const servers = [];
  const background = [];
  const pids = new Set();

  const fixture = {
    root,
    env,

    // A data directory path under the root. The CLI creates it (owner-only) on first use.
    home(name) {
      return join(root, name);
    },

    // A temporary Git repository with one commit on `branch`.
    async gitRepo(name, { branch = "main", files = { "README.md": "fixture\n" } } = {}) {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      const git = async (...args) => {
        const result = await run("git", args, {
          cwd: path,
          env: {
            ...env,
            GIT_AUTHOR_NAME: "Cove Fixture",
            GIT_AUTHOR_EMAIL: "fixture@cove.invalid",
            GIT_COMMITTER_NAME: "Cove Fixture",
            GIT_COMMITTER_EMAIL: "fixture@cove.invalid",
          },
        });
        if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
        return result.stdout;
      };
      await git("init", "--quiet", "--initial-branch", branch);
      for (const [file, content] of Object.entries(files))
        await writeFile(join(path, file), content);
      await git("add", "--all");
      await git("commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
      return { path, git };
    },

    // Runs `cove [--home H] ...args` to completion.
    cove(args, { home } = {}) {
      return run(process.execPath, [cli, ...(home ? ["--home", home] : []), ...args], { env });
    },

    async coveJson(args, options) {
      const result = await fixture.cove(args, options);
      if (result.code !== 0)
        throw new Error(`cove ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
      return JSON.parse(result.stdout);
    },

    // Starts `cove [--home H] ...args` without waiting for it; the fixture ends it on cleanup.
    spawnCove(args, { home } = {}) {
      const child = spawn(process.execPath, [cli, ...(home ? ["--home", home] : []), ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const done = new Promise((settle) =>
        child.once("exit", (code, signal) => settle({ code, signal, stdout, stderr })),
      );
      background.push({ child, done });
      return { child, done };
    },

    // `cove server start` for a data directory. Resolves once the start report is printed; the
    // result keeps the wrapper process, the real server PID and the published rendezvous.
    async startServer(home, args = []) {
      const wrapper = spawn(process.execPath, [cli, "--home", home, "server", "start", ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      wrapper.stdout.on("data", (chunk) => (stdout += chunk));
      wrapper.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((done) => wrapper.once("exit", (code) => done(code)));
      const server = { home, wrapper, exited, stderr: () => stderr, report: null, record: null };
      servers.push(server);
      await waitFor(
        "the server start report",
        () => wrapper.exitCode !== null || stdout.trim().endsWith("}"),
        20_000,
      );
      if (wrapper.exitCode !== null)
        throw new Error(`cove server start exited ${wrapper.exitCode}: ${stderr}`);
      server.report = JSON.parse(stdout);
      server.pid = server.report.pid;
      server.record = await readRendezvous(server.report.rendezvous);
      return server;
    },

    // Orderly stop through the wrapper (SIGTERM), with SIGKILL as the bounded fallback.
    async stopServer(server) {
      servers.splice(servers.indexOf(server), 1);
      return stopServer(server.wrapper, server.exited, server.pid);
    },

    // `kill -9` of the server process itself. Its children (worker, PTY processes) are not
    // signalled; the caller tracks them with trackPid so cleanup ends them.
    async killServer(server) {
      kill(server.pid, "SIGKILL");
      await waitFor("the killed server to exit", () => !alive(server.pid), 5_000);
      if ((await within(server.exited, 5_000)) === "timeout")
        throw new Error("the cove server start wrapper outlived its server");
      servers.splice(servers.indexOf(server), 1);
    },

    // Direct children of a process, e.g. the worker of a server.
    async childrenOf(pid) {
      const result = await run("pgrep", ["-P", String(pid)], { env });
      // pgrep exits 1 when nothing matches.
      if (result.code !== 0 && result.code !== 1) throw new Error(`pgrep failed: ${result.stderr}`);
      return result.stdout
        .split("\n")
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
    },

    // A process that cleanup must end with SIGKILL (never SIGCONT first) and confirm exited.
    trackPid(pid) {
      pids.add(pid);
    },

    // Ends every tracked process, confirms each exited and removes the root. Throws when any
    // process survived, after attempting every step.
    async cleanup() {
      const failures = [];
      for (const pid of pids) kill(pid, "SIGKILL");
      for (const { child } of background) if (child.exitCode === null) child.kill("SIGKILL");
      for (const server of servers.splice(0)) {
        try {
          await stopServer(server.wrapper, server.exited, server.pid);
        } catch (error) {
          failures.push(error);
        }
      }
      await Promise.all(background.map(({ done }) => within(done, 5_000)));
      try {
        await waitFor(
          "every tracked process to exit",
          () => [...pids].every((pid) => !alive(pid)),
          5_000,
        );
      } catch (error) {
        failures.push(new Error(`${error.message}: ${[...pids].filter(alive).join(", ")}`));
      }
      await rm(root, { recursive: true, force: true });
      if (failures.length > 0) throw new AggregateError(failures, "M1 fixture cleanup failed");
    },
  };
  return fixture;
}
