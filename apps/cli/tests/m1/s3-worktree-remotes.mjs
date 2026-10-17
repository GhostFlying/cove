import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Shared by the T3b scenarios (S3, S4, S8, S9): registered clones of local bare remotes under the
// fixture's root, so a worktree creation fetches from a real remote without any network. Each
// remote is fed from an upstream working repository that a scenario commits and pushes to.

const AUTHOR = {
  GIT_AUTHOR_NAME: "Cove Fixture",
  GIT_AUTHOR_EMAIL: "fixture@cove.invalid",
  GIT_COMMITTER_NAME: "Cove Fixture",
  GIT_COMMITTER_EMAIL: "fixture@cove.invalid",
};

// git in `cwd` with the fixture's environment (never the operator's Git configuration); the PATH
// is the test process's, so a scenario's git wrapper on the server's PATH is not used here.
export function gitIn(fixture, cwd, ...args) {
  return new Promise((done, fail) =>
    execFile(
      "git",
      args,
      { cwd, env: { ...fixture.env, ...AUTHOR, PATH: process.env.PATH } },
      (error, stdout, stderr) =>
        error ? fail(new Error(`git ${args.join(" ")} failed: ${stderr}`)) : done(stdout.trim()),
    ),
  );
}

// An upstream repository with one commit on `branch`, its bare remote, and a clone of the remote
// registered with the server of `home`.
export async function registeredRemote(fixture, home, name, { branch = "main" } = {}) {
  const git = (cwd, ...args) => gitIn(fixture, cwd, ...args);
  const base = join(fixture.root, "remotes", name);
  const upstream = join(base, "upstream");
  await mkdir(upstream, { recursive: true });
  await git(upstream, "init", "--quiet", "--initial-branch", branch);
  await writeFile(join(upstream, "README.md"), `${name}\n`);
  await git(upstream, "add", "README.md");
  await git(upstream, "commit", "--quiet", "--no-gpg-sign", "-m", "initial");
  const remote = join(base, "remote.git");
  await git(base, "clone", "--quiet", "--bare", upstream, remote);
  await git(upstream, "remote", "add", "origin", remote);
  const clone = join(fixture.root, "clones", name);
  await mkdir(join(fixture.root, "clones"), { recursive: true });
  await git(fixture.root, "clone", "--quiet", remote, clone);
  const operation = await fixture.coveJson(["repo", "register", clone], { home });
  // A new commit on `onto` in the remote (not fetched by the clone); returns its ID.
  const push = async (file, text, onto = branch) => {
    await git(upstream, "checkout", "--quiet", "-B", onto);
    await writeFile(join(upstream, file), text);
    await git(upstream, "add", file);
    await git(upstream, "commit", "--quiet", "--no-gpg-sign", "-m", file);
    await git(upstream, "push", "--quiet", "origin", onto);
    return git(upstream, "rev-parse", "HEAD");
  };
  return {
    repoId: operation.result.resource.id,
    clone,
    remote,
    upstream,
    push,
    git: (...args) => git(clone, ...args),
  };
}

// The managed worktree mounts of a task as the CLI prints them.
export function worktreeMounts(task) {
  return task.workspace.mounts.filter((mount) => mount.source === "worktree");
}
