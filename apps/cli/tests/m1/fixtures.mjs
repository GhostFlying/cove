import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRendezvous } from "../../dist/session.js";
import { waitFor } from "../recording-view.mjs";
import { within } from "../server-process.mjs";
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

// macOS process start time with microseconds (kinfo_proc p_starttime via __sysctl), the same
// reader as the server's store/processes.ts: `ps` lstart has one-second resolution and a PID can
// be reused within a second. Exit status 1: no such process.
const DARWIN_START_TIME = String.raw`
my $pid = shift;
my $mib = pack("i4", 1, 14, 1, $pid);
my $buf = "\0" x 4096;
my $len = pack("Q", length $buf);
syscall(202, $mib, 4, $buf, $len, 0, 0) == 0 or exit 2;
my $size = unpack("Q", $len);
exit 1 if $size == 0;
exit 3 if $size < 648 || unpack("l", substr($buf, 40, 4)) != $pid;
my ($sec, $usec) = unpack("q l", $buf);
printf("%d.%06d\n", $sec, $usec);
`;

// The operating-system start identity of a live process, or null when it does not exist: the
// PID plus this identity names one process, which a later process reusing the PID does not share.
// Linux: boot ID and start ticks (/proc/<pid>/stat field 22); macOS: start time in microseconds.
async function startIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const [boot, stat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      return `${boot.trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  const result = await run("/usr/bin/perl", ["-e", DARWIN_START_TIME, String(pid)], {
    env: { PATH: process.env.PATH },
  });
  if (result.code === 1) return null;
  if (result.code !== 0 || !/^\d+\.\d{6}\n$/.test(result.stdout))
    throw new Error(`reading the start time of ${pid} failed (${result.code}): ${result.stderr}`);
  return result.stdout.trim();
}

// Whether `pid` is still the process recorded with `identity`.
async function runsAs(pid, identity) {
  return identity !== undefined && (await startIdentity(pid)) === identity;
}

// The only place the fixture signals a process by number. It signals `pid` only while it is the
// process recorded with `identity` (start identity read while it was known to run); a PID that
// ended or now belongs to another process is not signalled (false). An unreadable identity throws,
// also without signalling. A process the fixture spawned itself is signalled through its
// ChildProcess handle instead, which Node never signals after the child was reaped.
async function signalIdentified(pid, identity, signal) {
  if (!(await runsAs(pid, identity))) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function identify(pid) {
  const identity = await startIdentity(pid);
  if (identity === null) throw new Error(`process ${pid} is not running`);
  return identity;
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
  // Tracked processes by PID, with the start identity read while they were known to run.
  const pids = new Map();
  const stillRuns = (pid) => runsAs(pid, pids.get(pid));
  const serverGone = (server) =>
    waitFor(
      "the server process to exit",
      async () => !(await runsAs(server.pid, server.identity)),
      5_000,
    );

  // Orderly stop through the owned wrapper handle (SIGTERM). The fallback SIGKILLs the wrapper
  // through its handle and the server only while it is the identified server process.
  async function stopOwnedServer(server) {
    server.wrapper.kill("SIGTERM");
    const code = await within(server.exited, 15_000);
    if (code === "timeout") {
      server.wrapper.kill("SIGKILL");
      await signalIdentified(server.pid, server.identity, "SIGKILL");
      if ((await within(server.exited, 5_000)) === "timeout")
        throw new Error("the server wrapper survived SIGKILL");
    }
    if (server.identity !== undefined) await serverGone(server);
    return code;
  }

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
    // `timeoutMs` bounds the command (it is killed when the time is up).
    cove(args, { home, timeoutMs } = {}) {
      return run(process.execPath, [cli, ...(home ? ["--home", home] : []), ...args], {
        env,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
      });
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
      // Read while the server is known to run (it just reported readiness).
      server.identity = await identify(server.pid);
      server.record = await readRendezvous(server.report.rendezvous);
      return server;
    },

    // Starts a server entry file directly, with the arguments `cove server start` passes and the
    // data directory's default rendezvous; the D6 probe starts its instrumented entry this way.
    // The result has the same shape as startServer's; the entry process is its own wrapper.
    async startServerEntry(entry, home) {
      await mkdir(join(home, "server"), { recursive: true, mode: 0o700 });
      const rendezvous = join(home, "server", "run", "rendezvous.json");
      const child = spawn(
        process.execPath,
        [
          entry,
          ...["--mode", "m0-local", "--host", "127.0.0.1", "--port", "0"],
          ...["--rendezvous", rendezvous, "--home", home],
        ],
        { env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((done) => child.once("exit", (code) => done(code)));
      const server = { home, wrapper: child, exited, stderr: () => stderr, pid: child.pid };
      servers.push(server);
      const published = () =>
        readRendezvous(rendezvous).then(
          () => true,
          () => false,
        );
      await waitFor(
        "the server rendezvous",
        async () => child.exitCode !== null || (await published()),
        20_000,
      );
      if (child.exitCode !== null) throw new Error(`${entry} exited ${child.exitCode}: ${stderr}`);
      server.report = { rendezvous, pid: child.pid };
      server.identity = await identify(child.pid);
      server.record = await readRendezvous(rendezvous);
      return server;
    },

    // Orderly stop through the wrapper (SIGTERM), with SIGKILL as the bounded fallback.
    async stopServer(server) {
      servers.splice(servers.indexOf(server), 1);
      return stopOwnedServer(server);
    },

    // Whether the server is still the process identified when it became ready.
    serverRuns(server) {
      return runsAs(server.pid, server.identity);
    },

    // Sends `signal` to the server process (e.g. the D6 mode switch): through the owned handle
    // when the fixture spawned the server itself, otherwise only while the PID is the identified
    // server. Throws instead of signalling anything else.
    async signalServer(server, signal) {
      const sent =
        server.wrapper.pid === server.pid
          ? server.wrapper.exitCode === null &&
            server.wrapper.signalCode === null &&
            server.wrapper.kill(signal)
          : await signalIdentified(server.pid, server.identity, signal);
      if (!sent) throw new Error(`the server ${server.pid} is no longer running`);
    },

    // `kill -9` of the server process itself. Its children (worker, PTY processes) are not
    // signalled; the caller tracks them with trackPid so cleanup ends them.
    async killServer(server) {
      await fixture.signalServer(server, "SIGKILL");
      await serverGone(server);
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

    // A process that cleanup must end with SIGKILL (never SIGCONT first) and confirm exited. Call
    // it while the process is known to run: its start identity is recorded now, and cleanup
    // signals the PID only while it still carries that identity, so a process that reused the PID
    // in between is never killed.
    async trackPid(pid) {
      pids.set(pid, await identify(pid));
    },

    // Signals a tracked process only while it is the identified process; throws otherwise.
    async signalTracked(pid, signal) {
      if (!pids.has(pid)) throw new Error(`process ${pid} is not tracked`);
      if (!(await signalIdentified(pid, pids.get(pid), signal)))
        throw new Error(`process ${pid} is no longer the tracked process`);
    },

    // Ends every tracked process, confirms each exited and removes the root. Throws when any
    // process survived, after attempting every step.
    async cleanup() {
      const failures = [];
      for (const pid of pids.keys()) {
        try {
          await signalIdentified(pid, pids.get(pid), "SIGKILL");
        } catch (error) {
          failures.push(error);
        }
      }
      for (const { child } of background) if (child.exitCode === null) child.kill("SIGKILL");
      for (const server of servers.splice(0)) {
        try {
          await stopOwnedServer(server);
        } catch (error) {
          failures.push(error);
        }
      }
      const waited = await Promise.all(background.map(({ done }) => within(done, 5_000)));
      const survivors = background.filter((_, index) => waited[index] === "timeout");
      if (survivors.length > 0)
        failures.push(
          new Error(
            `background cove commands survived SIGKILL: ${survivors.map(({ child }) => child.pid).join(", ")}`,
          ),
        );
      const running = async () => {
        const left = [];
        for (const pid of pids.keys()) if (await stillRuns(pid)) left.push(pid);
        return left;
      };
      try {
        await waitFor(
          "every tracked process to exit",
          async () => (await running()).length === 0,
          5_000,
        );
      } catch (error) {
        failures.push(new Error(`${error.message}: ${(await running()).join(", ")}`));
      }
      await rm(root, { recursive: true, force: true });
      if (failures.length > 0) throw new AggregateError(failures, "M1 fixture cleanup failed");
    },
  };
  return fixture;
}
