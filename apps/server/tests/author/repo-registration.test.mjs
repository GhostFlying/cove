import { ChildProcess, execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { RepoService } from "../../dist/domain/repos.js";
import {
  discoverRepository,
  inspectRepository,
  isValidBranchName,
  readHead,
} from "../../dist/git/repository.js";
import { runGit } from "../../dist/git/run.js";
import { OperationReceipts } from "../../dist/operations/operation-receipts.js";
import { Store } from "../../dist/store/database.js";
import { prepareHome } from "../../dist/store/home.js";
import { recordInstanceStart } from "../../dist/store/identity.js";
import { SqliteReceiptBackend } from "../../dist/store/operations.js";
import { RuntimeComposition } from "../../dist/terminal/runtime-composition.js";
import { RuntimeRetainedBytes } from "../../dist/terminal/runtime-retained-bytes.js";

// Git queries and repo registration (docs/milestones/m1.md T2) below the CLI: Git answers that
// S1 cannot provoke through the compiled CLI (timeouts, oversized output, a missing git, an
// inherited GIT_DIR, HEAD states) and concurrent registrations.

const encode = (text) => new TextEncoder().encode(text);
const directories = [];
const stores = [];
const savedEnv = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR };

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cove-repo-test-")));
  directories.push(path);
  return path;
}

// git for building fixtures, with its own HOME and no system configuration.
function git(cwd, home, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          PATH: savedEnv.PATH,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Cove Test",
          GIT_AUTHOR_EMAIL: "test@cove.invalid",
          GIT_COMMITTER_NAME: "Cove Test",
          GIT_COMMITTER_EMAIL: "test@cove.invalid",
        },
      },
      (error, stdout, stderr) =>
        error ? fail(new Error(`git ${args.join(" ")}: ${stderr}`)) : done(stdout.trim()),
    ),
  );
}

async function clone(root, name, { commit = true } = {}) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, root, "init", "--quiet", "--initial-branch", "main");
  if (commit) {
    await writeFile(join(path, "README.md"), "test\n");
    await git(path, root, "add", "README.md");
    await git(path, root, "commit", "--quiet", "--no-gpg-sign", "-m", "test");
  }
  return path;
}

// A directory holding a fake `git` executable; putting it first on PATH replaces git for the
// server's runner (runGit looks git up on the PATH it passes to the child).
async function fakeGit(script) {
  const directory = await temporary();
  const path = join(directory, "git");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return directory;
}

describe("Git runner", () => {
  it("passes only the allowlisted environment and disables prompts and pagers", async () => {
    process.env.PATH = `${await fakeGit("env")}:${savedEnv.PATH}`;
    process.env.GIT_DIR = "/elsewhere/.git";
    const result = await runGit(["status"], { cwd: await temporary() });
    expect(result.kind).toBe("exited");
    const env = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env.GIT_DIR).toBeUndefined();
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      LC_ALL: "C",
    });
    const allowed = new Set([
      ...["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR", "GIT_CONFIG_NOSYSTEM"],
      ...["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "LC_ALL", "LANG", "GIT_TERMINAL_PROMPT"],
      ...["GIT_PAGER", "PAGER", "GIT_EDITOR", "GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH"],
      // Set by the shell running the fake git itself.
      ...["PWD", "SHLVL", "_", "OLDPWD"],
    ]);
    expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("reports a timeout, oversized output and a missing git as failures without an answer", async () => {
    const cwd = await temporary();
    process.env.PATH = `${await fakeGit("exec sleep 30")}:${savedEnv.PATH}`;
    const started = Date.now();
    expect(await runGit(["status"], { cwd, timeoutMs: 200 })).toEqual({
      kind: "failed",
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // A query that gets no answer is not "not a repository".
    expect(await inspectRepository(cwd)).toEqual({ kind: "unavailable" });

    process.env.PATH = `${await fakeGit("exec yes")}:${savedEnv.PATH}`;
    expect(await runGit(["status"], { cwd, maxOutputBytes: 4096 })).toEqual({
      kind: "failed",
      reason: "overflow",
    });

    process.env.PATH = await temporary();
    expect(await runGit(["status"], { cwd })).toEqual({ kind: "failed", reason: "spawn" });
    expect(await isValidBranchName("main")).toBeNull();
  });

  // A git that forks without exec: the forked descendant inherits stdout and stderr. Each case
  // must settle promptly (not when the descendant would close the pipes) and end the descendant.
  // (Separate tests rather than it.each: the CI gate counts each `it` once at discovery.)
  // Returns the run's result, whether it settled within 3 s (the descendant lives for 30 s),
  // whether the descendant ended, and how many signals this process sent by number while the
  // run was in progress (none may be: a group or PID may be reused once Node has reaped git).
  // A descendant that outlives the check (an escaped one) is killed here; the test started it.
  async function forkingRun(script, options) {
    const cwd = await temporary();
    const pidFile = join(cwd, "descendant.pid");
    process.env.PATH = `${await fakeGit(script.replaceAll("PIDFILE", pidFile))}:${savedEnv.PATH}`;
    const kills = vi.spyOn(process, "kill");
    const childKills = vi.spyOn(ChildProcess.prototype, "kill");
    const started = Date.now();
    let result;
    let numericSignals;
    try {
      result = await runGit(["status"], { cwd, ...options });
    } finally {
      // Read before restoring: mockRestore also clears the recorded calls.
      numericSignals = kills.mock.calls.length + childKills.mock.calls.length;
      kills.mockRestore();
      childKills.mockRestore();
    }
    const prompt = Date.now() - started < 3_000;
    const pid = Number(await readFile(pidFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("no descendant PID recorded");
    const descendantEnded = await ended(pid);
    if (!descendantEnded) process.kill(pid, "SIGKILL");
    return { result, prompt, descendantEnded, numericSignals };
  }

  // Starts `command` in a new session, so it leaves the run's process group, then waits until it
  // has left: the process records its PID only after setsid (perl's exec keeps that PID).
  const escaped = (command, redirect = "") =>
    `perl -MPOSIX -e 'POSIX::setsid() >= 0 or die; open(my $f, ">", shift) or die; print $f $$; close $f; exec @ARGV' PIDFILE ${command} ${redirect} &\nwhile [ ! -s PIDFILE ]; do sleep 0.05; done\necho done`;

  it("ends the process group and settles promptly after a timeout", async () => {
    expect(await forkingRun("sleep 30 &\necho $! > PIDFILE\nwait", { timeoutMs: 1_000 })).toEqual({
      result: { kind: "failed", reason: "timeout" },
      prompt: true,
      descendantEnded: true,
      numericSignals: 0,
    });
  });

  // #129. A git that ignores SIGTERM and waits for a child in its group: only the deadline's
  // SIGKILL ends it. On macOS a group signal sent by a member of the group (the watcher's
  // `kill 0`) does not reliably reach the group leader: the child dies, the leader's `wait`
  // returns and it runs on (and may exit 0) after its deadline. The miss is a race, seen in about
  // 5-15% of runs on macOS when many runs reach their deadline together, so up to four batches of
  // 64 runs go at once. On Linux the group signal reaches every member before the sender returns,
  // so this passes there with or without the fix. A leader that runs past the kill records it.
  it(
    "kills a git that ignores SIGTERM at its deadline, leader included",
    { timeout: 90_000 },
    async () => {
      // Its output goes to /dev/null: the shell reports the killed child on stderr, and the run's
      // stderr is closed at the deadline, so a leader that ran on would die of SIGPIPE there and
      // hide the miss.
      const script = [
        "exec >/dev/null 2>&1",
        'trap "" TERM',
        'echo $$ > "$PWD/git.pid"',
        "/bin/sleep 30 &",
        "wait",
        "wait",
        'echo ran-on > "$PWD/ran-on"',
      ].join("\n");
      process.env.PATH = `${await fakeGit(script)}:${savedEnv.PATH}`;
      const outcome = async (cwd) => {
        let pid;
        try {
          pid = Number(await readFile(join(cwd, "git.pid"), "utf8"));
        } catch (error) {
          // Killed before it recorded its PID: nothing of it ran on.
          if (error.code === "ENOENT") return "killed";
          throw error;
        }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("no git PID recorded");
        // The watcher's own start may be delayed under load; give the kill time to land.
        const gone = (await ended(pid, 10_000)) ? "killed" : "alive";
        if (gone === "alive") process.kill(pid, "SIGKILL");
        return (await exists(join(cwd, "ran-on"))) ? "ran on" : gone;
      };
      for (let batch = 0; batch < 4; batch++) {
        const cwds = await Promise.all(Array.from({ length: 64 }, () => temporary()));
        const results = await Promise.all(
          cwds.map((cwd) => runGit(["status"], { cwd, timeoutMs: 1_000 })),
        );
        expect(results.filter((result) => result.reason !== "timeout")).toEqual([]);
        const outcomes = await Promise.all(cwds.map(outcome));
        expect(outcomes.filter((result) => result !== "killed")).toEqual([]);
      }
    },
  );

  it("ends the process group and settles promptly after an output overflow", async () => {
    expect(await forkingRun("yes &\necho $! > PIDFILE\nwait", { maxOutputBytes: 4096 })).toEqual({
      result: { kind: "failed", reason: "overflow" },
      prompt: true,
      descendantEnded: true,
      numericSignals: 0,
    });
  });

  it("ends a descendant left holding the pipes when git exits", async () => {
    expect(await forkingRun("sleep 30 &\necho $! > PIDFILE\necho done", {})).toEqual({
      result: { kind: "exited", code: 0, stdout: "done\n", stderr: "" },
      prompt: true,
      descendantEnded: true,
      numericSignals: 0,
    });
  });

  it("ends a descendant left in the group with its output closed when git exits", async () => {
    const script = "sleep 30 </dev/null >/dev/null 2>&1 &\necho $! > PIDFILE\necho done";
    expect(await forkingRun(script, {})).toEqual({
      result: { kind: "exited", code: 0, stdout: "done\n", stderr: "" },
      prompt: true,
      descendantEnded: true,
      numericSignals: 0,
    });
  });

  // Documented limit: a descendant that leaves the group is not contained. Completion stays
  // bounded; one holding the pipes turns the run into a timeout at the deadline.
  it("bounds a run whose escaped descendant holds the pipes, without containing it", async () => {
    const script = escaped("sleep 30");
    expect(await forkingRun(script, { timeoutMs: 1_000 })).toEqual({
      result: { kind: "failed", reason: "timeout" },
      prompt: true,
      descendantEnded: false,
      numericSignals: 0,
    });
  });

  it("completes a run whose escaped descendant closed its output, without containing it", async () => {
    const script = escaped("sleep 30", "</dev/null >/dev/null 2>&1");
    expect(await forkingRun(script, { timeoutMs: 1_000 })).toEqual({
      result: { kind: "exited", code: 0, stdout: "done\n", stderr: "" },
      prompt: true,
      descendantEnded: false,
      numericSignals: 0,
    });
  });
});

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Every entry under `root` (including .git) with its type, size and modification time.
async function snapshot(root) {
  const entries = {};
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await lstat(path);
      entries[path.slice(root.length)] = [info.mode, info.size, info.mtimeMs];
      if (info.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return entries;
}

// Whether `pid` stops existing within `withinMs` (an orphaned descendant is reaped by init).
async function ended(pid, withinMs = 3_000) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
}

describe("repository queries", () => {
  it("reads HEAD on a branch, detached and unborn", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const commit = await git(path, root, "rev-parse", "HEAD");
    expect(await readHead(path)).toEqual({ kind: "head", branch: "main", commit });
    await git(path, root, "checkout", "--quiet", "--detach");
    expect(await readHead(path)).toEqual({ kind: "head", branch: null, commit });
    const empty = await clone(root, "empty", { commit: false });
    expect(await readHead(empty)).toEqual({ kind: "head", branch: "main", commit: null });
    expect(await readHead(await temporary())).toEqual({ kind: "not-repository" });
  });

  it("peels HEAD to a commit and tells a non-commit from an unborn branch", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const commit = await git(path, root, "rev-parse", "HEAD");
    // A detached HEAD holding an annotated tag's own object ID resolves to the tagged commit.
    await git(path, root, "tag", "--annotate", "--message", "release", "v1");
    const tag = await git(path, root, "rev-parse", "v1");
    expect(tag).not.toBe(commit);
    // Git refuses to write a non-commit to HEAD or a branch itself, so these refs are written as
    // loose ref files (the fixture uses the default files ref backend).
    await writeFile(join(path, ".git", "HEAD"), `${tag}\n`);
    const annotated = await readHead(path);
    // HEAD a symbolic ref to a tag of a blob: it names an object, but no commit.
    const blob = await git(path, root, "rev-parse", "HEAD:README.md");
    await git(path, root, "tag", "--annotate", "--message", "blob", "blob-tag", blob);
    await git(path, root, "symbolic-ref", "HEAD", "refs/tags/blob-tag");
    const blobTag = await readHead(path);
    // A branch pointing straight at a blob.
    await writeFile(join(path, ".git", "refs", "heads", "blob"), `${blob}\n`);
    await git(path, root, "symbolic-ref", "HEAD", "refs/heads/blob");
    const blobBranch = await readHead(path);
    // An unborn branch: nothing named at all.
    await git(path, root, "symbolic-ref", "HEAD", "refs/heads/unborn");
    const unborn = await readHead(path);
    expect([annotated, blobTag, blobBranch, unborn]).toEqual([
      { kind: "head", branch: null, commit },
      { kind: "unresolved", branch: "refs/tags/blob-tag" },
      { kind: "unresolved", branch: "blob" },
      { kind: "head", branch: "unborn", commit: null },
    ]);
  });

  it("does not peel HEAD with a Git that cannot disable lazy fetching", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const empty = await clone(root, "empty", { commit: false });
    const real = await new Promise((done, fail) =>
      execFile("sh", ["-c", "command -v git"], { env: { PATH: savedEnv.PATH } }, (error, out) =>
        error ? fail(error) : done(out.trim()),
      ),
    );
    // Git 2.44 predates GIT_NO_LAZY_FETCH; every other command runs the real git.
    const script = `for last; do :; done\nif [ "$last" = version ]; then echo 'git version 2.44.2'; exit 0; fi\nexec '${real}' "$@"`;
    process.env.PATH = `${await fakeGit(script)}:${savedEnv.PATH}`;
    expect([await readHead(path), await readHead(empty)]).toEqual([
      { kind: "unavailable" },
      { kind: "head", branch: "main", commit: null },
    ]);
  });

  it("checks the Git version where the peel would run", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const real = await new Promise((done, fail) =>
      execFile("sh", ["-c", "command -v git"], { env: { PATH: savedEnv.PATH } }, (error, out) =>
        error ? fail(error) : done(out.trim()),
      ),
    );
    // A relative PATH entry: from `/` it names nothing, so the real (supported) git answers there;
    // inside the clone it names a Git 2.44 that would ignore GIT_NO_LAZY_FETCH. The fake logs
    // every call and otherwise runs the real git.
    const bin = "cove-test-old-git-bin";
    const calls = join(root, "calls.log");
    await mkdir(join(path, bin));
    await writeFile(
      join(path, bin, "git"),
      `#!/bin/sh\necho "$*" >> '${calls}'\nfor last; do :; done\nif [ "$last" = version ]; then echo 'git version 2.44.2'; exit 0; fi\nexec '${real}' "$@"\n`,
    );
    await chmod(join(path, bin, "git"), 0o755);
    process.env.PATH = `${bin}:${savedEnv.PATH}`;
    const result = await readHead(path);
    const log = await readFile(calls, "utf8");
    expect({
      result,
      versionAskedInClone: log.split("\n").some((line) => line.endsWith(" version")),
      peeled: log.includes("^{commit}"),
    }).toEqual({ result: { kind: "unavailable" }, versionAskedInClone: true, peeled: false });
  });

  it("ignores an inherited GIT_DIR and resolves a linked worktree to its clone", async () => {
    const root = await temporary();
    const main = await clone(root, "main");
    const other = await clone(root, "other");
    process.env.GIT_DIR = join(other, ".git");
    const linked = join(root, "linked");
    await git(main, root, "worktree", "add", "--quiet", "-b", "topic", linked);
    const expected = { kind: "clone", topLevel: main, commonDir: join(main, ".git") };
    expect(await inspectRepository(main)).toEqual(expected);
    expect(await inspectRepository(`${linked}/`)).toEqual(expected);
    expect(await inspectRepository("relative/path")).toEqual({ kind: "not-repository" });
  });

  it("refuses a linked worktree whose clone's main working tree no longer exists", async () => {
    const root = await temporary();
    const main = join(root, "main");
    const gitDir = join(root, "git-dirs", "main");
    await mkdir(join(root, "git-dirs"));
    await git(root, root, "init", "--quiet", "-b", "main", "--separate-git-dir", gitDir, main);
    await writeFile(join(main, "README.md"), "test\n");
    await git(main, root, "add", "README.md");
    await git(main, root, "commit", "--quiet", "--no-gpg-sign", "-m", "test");
    expect(await inspectRepository(main)).toEqual({
      kind: "clone",
      topLevel: main,
      commonDir: gitDir,
    });
    const linked = join(root, "linked");
    await git(main, root, "worktree", "add", "--quiet", "-b", "topic", linked);
    // The Git directory and the linked worktree remain, but no directory is the clone any more,
    // so there is nothing a registration could name.
    await rm(main, { recursive: true });
    expect(await inspectRepository(linked)).toEqual({ kind: "not-repository" });
  });

  it("runs no repository-configured program and fetches nothing from a promisor remote", async () => {
    const root = await temporary();
    const path = await clone(root, "partial");
    // A partial clone whose HEAD names a commit that is not present: reading the object would
    // lazily fetch it through the promisor remote, here an `ext::` transport that leaves a marker.
    // core.fsmonitor is a program Git runs when it reads the index; it leaves another marker.
    const missing = "1".repeat(40);
    await writeFile(join(path, ".git", "refs", "heads", "main"), `${missing}\n`);
    const fetched = join(root, "fetched");
    const monitored = join(root, "monitored");
    const monitor = join(root, "monitor.sh");
    await writeFile(monitor, `#!/bin/sh\ntouch '${monitored}'\n`);
    await chmod(monitor, 0o755);
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.promisor", "true"],
      ["protocol.ext.allow", "always"],
      ["remote.origin.url", `ext::sh -c touch% ${fetched}`],
      ["core.fsmonitor", monitor],
    ])
      await git(path, root, "config", key, value);
    const before = await snapshot(path);

    // The missing commit is reported as unresolved (not unborn), and was not fetched.
    expect(await readHead(path)).toEqual({ kind: "unresolved", branch: "main" });
    expect(await inspectRepository(path)).toEqual({
      kind: "clone",
      topLevel: path,
      commonDir: join(path, ".git"),
    });
    expect(await isValidBranchName("main")).toBe(true);

    expect(await exists(fetched)).toBe(false);
    expect(await exists(monitored)).toBe(false);
    expect(await snapshot(path)).toEqual(before);
  });

  it("checks branch names with Git's own rules", async () => {
    for (const name of ["main", "release/1.0", "feature-x"])
      expect(await isValidBranchName(name)).toBe(true);
    for (const name of ["a..b", "topic.lock", "feature/", "x@{1}", "HEAD/x."])
      expect(await isValidBranchName(name)).toBe(false);
  });
});

async function service(git) {
  const layout = await prepareHome(join(await temporary(), "home"));
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
  });
  stores.push(store);
  const bytes = new RuntimeRetainedBytes(M0_LIMITS.runtimeBytes, 1024 * 1024);
  const composition = new RuntimeComposition("server", "instance", { ...M0_LIMITS }, bytes);
  await recordInstanceStart(store, "instance", 1);
  const receipts = new OperationReceipts(
    composition,
    encode,
    new SqliteReceiptBackend(store, "instance", () => 1),
  );
  return {
    store,
    repos: new RepoService({ store, serverId: "server", receipts, encodeUtf8: encode, git }),
  };
}

describe("repo registration", () => {
  it("lets exactly one of two concurrent registrations of one clone succeed", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const { repos } = await service();
    const outcomes = await Promise.all([
      repos.register("principal", { operationId: "a", path }),
      repos.register("principal", { operationId: "b", path: `${path}/` }),
      repos.register("principal", { operationId: "a", path }),
    ]);
    // The Git checks run concurrently; the transactions then serialize. Whichever request commits
    // first wins: if `a` wins, its second request returns the same receipt and `b` is refused; if
    // `b` wins, both `a` requests are refused. Never two registrations.
    //
    // The store answers asynchronously (D6), so the two `a` requests can overlap: while one holds
    // the operation ID's reservation (its receipts.write call is in flight), the other is refused
    // as BUSY, not accepted (relay-protocol §11.3; the client retries with the same operation ID).
    // At most one of them can be BUSY, and its retry gets the other's answer.
    const busy = [0, 2].filter((index) => outcomes[index].error?.kind === "BUSY");
    expect(busy.length).toBeLessThan(2);
    for (const index of busy) {
      expect(outcomes[index].error.acceptance).toBe("not-accepted");
      outcomes[index] = await repos.register("principal", { operationId: "a", path });
    }
    const summary = outcomes.map((outcome) =>
      "error" in outcome
        ? outcome.error.kind
        : `${outcome.operation.operationId}:${outcome.operation.state}`,
    );
    expect([
      ["a:succeeded", "REPO_ALREADY_REGISTERED", "a:succeeded"],
      ["REPO_ALREADY_REGISTERED", "b:succeeded", "REPO_ALREADY_REGISTERED"],
    ]).toContainEqual(summary);
    // Both requests with operation ID `a` got the same answer: one receipt or the same refusal.
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect((await repos.list({ limit: 10 })).repos).toHaveLength(1);
  });

  it("reports repo reads on a closed store as unavailable rather than throwing", async () => {
    const { store, repos } = await service();
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const unavailable = { error: expect.objectContaining({ kind: "CAPABILITY_UNAVAILABLE" }) };
    expect(await repos.list({ limit: 10 })).toEqual(unavailable);
    expect(await repos.get("repo")).toEqual(unavailable);
  });

  it("answers a resend from its receipt without consulting Git", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    const { repos } = await service();
    const first = await repos.register("principal", { operationId: "op", path });
    expect(first.operation.state).toBe("succeeded");
    // The clone is gone and git cannot even be started: the receipt alone answers.
    await rm(path, { recursive: true });
    process.env.PATH = await temporary();
    expect(await repos.register("principal", { operationId: "op", path })).toEqual(first);
    expect(
      (await repos.register("principal", { operationId: "op", path: `${path}/` })).error.kind,
    ).toBe("OPERATION_ID_CONFLICT");
    // A new request is checked: the missing path is refused before Git runs, and an existing
    // directory Git cannot answer for is refused as GIT_UNAVAILABLE, not as "not a repository".
    expect((await repos.register("principal", { operationId: "new", path })).error.kind).toBe(
      "NOT_A_GIT_REPOSITORY",
    );
    expect((await repos.register("principal", { operationId: "new", path: root })).error).toEqual(
      expect.objectContaining({ kind: "GIT_UNAVAILABLE", acceptance: "not-accepted" }),
    );
    expect((await repos.list({ limit: 10 })).repos).toHaveLength(1);
  });

  it("answers a late Git refusal with the receipt a request of the same ID committed meanwhile", async () => {
    const root = await temporary();
    const path = await clone(root, "repo");
    // Each call of a Git query takes the next behaviour. The first two requests are held at their
    // Git check until the third, identical to the first, has committed; they are then refused.
    const held = deferred();
    const queue = (behaviours) => {
      let next = 0;
      return (...args) => behaviours[next++](...args);
    };
    const { repos } = await service({
      discoverRepository: queue([
        () => held.promise.then(() => ({ kind: "not-repository" })),
        () => held.promise.then(() => ({ kind: "unavailable" })),
        discoverRepository,
        discoverRepository,
      ]),
      isValidBranchName: queue([
        () => held.promise.then(() => null),
        () => held.promise.then(() => false),
        isValidBranchName,
      ]),
    });
    const params = { operationId: "register", path };
    const lateRegister = repos.register("principal", params);
    const changedRegister = repos.register("principal", { ...params, displayName: "Other" });
    const update = { operationId: "update", repoId: "", mainBranch: "develop" };
    const committedRegister = await repos.register("principal", params);
    expect(committedRegister.operation.state).toBe("succeeded");
    update.repoId = committedRegister.operation.result.resource.id;
    const lateUpdate = repos.update("principal", update);
    const changedUpdate = repos.update("principal", { ...update, mainBranch: "other" });
    const committedUpdate = await repos.update("principal", update);
    expect(committedUpdate.operation.state).toBe("succeeded");
    held.resolve();

    // The identical requests return the committed record instead of their own late refusal;
    // the changed ones learn that the operation ID is taken.
    expect(await lateRegister).toEqual(committedRegister);
    expect((await changedRegister).error.kind).toBe("OPERATION_ID_CONFLICT");
    expect(await lateUpdate).toEqual(committedUpdate);
    expect((await changedUpdate).error.kind).toBe("OPERATION_ID_CONFLICT");
    // Without a receipt the refusal stands, and nothing more was written.
    expect(
      (await repos.register("principal", { operationId: "other", path: `${path}/` })).error.kind,
    ).toBe("REPO_ALREADY_REGISTERED");
    expect((await repos.get(update.repoId)).repo).toMatchObject({
      revision: 1,
      mainBranch: "develop",
    });
  });

  // Clones whose main working tree Git cannot name from a linked worktree: once the clone is
  // registered, its common directory still identifies it, so the linked worktree (also through a
  // symlink) is the duplicate it is rather than "not a repository".
  async function recognizedThroughLinkedWorktree(make) {
    const root = await temporary();
    const main = await make(root);
    const linked = join(root, "linked");
    await git(main, root, "worktree", "add", "--quiet", "-b", "topic", linked);
    const linkedLink = join(root, "linked-link");
    await symlink(linked, linkedLink);
    const { repos } = await service();
    // Unregistered, the linked worktree cannot name the clone.
    const unregistered = (await repos.register("principal", { operationId: "a", path: linked }))
      .error?.kind;
    const registered = (await repos.register("principal", { operationId: "b", path: main }))
      .operation?.state;
    const paths = (await repos.list({ limit: 10 })).repos.map((repo) => repo.path);
    const duplicates = [];
    for (const [operationId, path] of [
      ["c", linked],
      ["d", `${linkedLink}/`],
    ])
      duplicates.push((await repos.register("principal", { operationId, path })).error?.kind);
    return {
      unregistered,
      registered,
      pathIsMain: paths.length === 1 && paths[0] === (await realpath(main)),
      duplicates,
      count: (await repos.list({ limit: 10 })).repos.length,
    };
  }

  const recognized = {
    unregistered: "NOT_A_GIT_REPOSITORY",
    registered: "succeeded",
    pathIsMain: true,
    duplicates: ["REPO_ALREADY_REGISTERED", "REPO_ALREADY_REGISTERED"],
    count: 1,
  };

  it("recognizes a registered clone with a separate Git directory through its linked worktree", async () => {
    expect(
      await recognizedThroughLinkedWorktree(async (root) => {
        const main = join(root, "main");
        await mkdir(join(root, "git-dirs"));
        const gitDir = join(root, "git-dirs", "main");
        await git(root, root, "init", "--quiet", "-b", "main", "--separate-git-dir", gitDir, main);
        await commitFile(main, root);
        return main;
      }),
    ).toEqual(recognized);
  });

  it("recognizes a registered clone with a relocated, symlinked Git directory through its linked worktree", async () => {
    expect(
      await recognizedThroughLinkedWorktree(async (root) => {
        const main = await clone(root, "main");
        await mkdir(join(root, "store"));
        await rename(join(main, ".git"), join(root, "store", "main.git"));
        await symlink(join(root, "store", "main.git"), join(main, ".git"));
        return main;
      }),
    ).toEqual(recognized);
  });

  it("recognizes a registered submodule through its linked worktree", async () => {
    expect(
      await recognizedThroughLinkedWorktree(async (root) => {
        const source = await clone(root, "source");
        const superproject = await clone(root, "super");
        const add = ["submodule", "add", "--quiet", source, "sub"];
        await git(superproject, root, "-c", "protocol.file.allow=always", ...add);
        return join(superproject, "sub");
      }),
    ).toEqual(recognized);
  });
});

async function commitFile(path, home) {
  await writeFile(join(path, "README.md"), "test\n");
  await git(path, home, "add", "README.md");
  await git(path, home, "commit", "--quiet", "--no-gpg-sign", "-m", "test");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
