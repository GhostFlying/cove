import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runGit, type GitRunResult } from "./run.js";

// Read-only Git queries about a clone (M1 T2): its top level, common directory, bareness and
// HEAD. Nothing here writes to a repository: the commands are rev-parse, worktree list,
// symbolic-ref and check-ref-format, run through runGit with optional locks disabled.
//
// Real-path rule (docs/milestones/m1.md S1): every path this module returns is a real path
// (symlinks resolved, no trailing slash), so one clone has one spelling however the operator
// reached it. Git runs with the real directory as its working directory, so the answer never
// depends on which symlink the operator used.

// Why a path cannot be used as a clone. `unavailable` means Git gave no answer (it could not be
// started, timed out, overflowed or was killed); it proves nothing about the path and must be
// reported as such, never as "not a repository".
export type RepositoryRefusal =
  | { kind: "missing" }
  | { kind: "inaccessible" }
  | { kind: "not-repository" }
  | { kind: "bare" }
  | { kind: "unavailable" };

// A non-bare clone identified by its real Git common directory. `topLevel` is the real top level
// of the clone's main working tree, also when the given path was inside one of its linked
// worktrees: the registration names the clone, and its worktrees share its identity (D2).
export type RepositoryInspection = { kind: "clone"; topLevel: string; commonDir: string };

type FsOutcome = { ok: true; path: string } | { ok: false; refusal: RepositoryRefusal };

async function realDirectory(path: string): Promise<FsOutcome> {
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory())
      return { ok: false, refusal: { kind: "not-repository" } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP")
      return { ok: false, refusal: { kind: "missing" } };
    if (code === "EACCES" || code === "EPERM")
      return { ok: false, refusal: { kind: "inaccessible" } };
    return { ok: false, refusal: { kind: "unavailable" } };
  }
  return { ok: true, path: real };
}

// Output lines of a command whose fields are one per line. A path is the last field so that it
// keeps any newline it contains; git ends the output with exactly one newline.
function lines(stdout: string, count: number): string[] | null {
  if (!stdout.endsWith("\n")) return null;
  const parts = stdout.slice(0, -1).split("\n");
  if (parts.length < count) return null;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join("\n")];
}

type Discovery =
  { kind: "work-tree"; gitDir: string; commonDir: string; topLevel: string } | RepositoryRefusal;

// What Git sees at a real directory. A non-zero exit means Git refused to treat it as a
// repository work tree: not a repository, a dubious-ownership refusal (safe.directory) or a
// broken `.git` link; the registration is refused either way and the operator fixes the path.
async function discover(directory: string): Promise<Discovery> {
  const flags = await runGit(
    ["rev-parse", "--is-bare-repository", "--is-inside-work-tree", "--git-dir", "--git-common-dir"],
    { cwd: directory },
  );
  if (flags.kind === "failed") return { kind: "unavailable" };
  if (flags.code !== 0) return { kind: "not-repository" };
  const fields = lines(flags.stdout, 4);
  // --git-dir and --git-common-dir print one path per line; a newline inside the git directory
  // path would make the split ambiguous, so such output is not trusted.
  if (!fields || fields[3]!.includes("\n")) return { kind: "unavailable" };
  const [bare, inside, gitDir, commonDir] = fields as [string, string, string, string];
  if (bare === "true") return { kind: "bare" };
  // Inside the `.git` directory of a non-bare clone: a Git directory, not a working tree.
  if (inside !== "true") return { kind: "not-repository" };
  const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: directory });
  if (top.kind === "failed") return { kind: "unavailable" };
  if (top.code !== 0) return { kind: "not-repository" };
  const topFields = lines(top.stdout, 1);
  if (!topFields) return { kind: "unavailable" };
  const real = await Promise.all(
    [gitDir, commonDir, topFields[0]!].map((path) => realDirectory(resolve(directory, path))),
  );
  for (const item of real) if (!item.ok) return item.refusal;
  const [g, c, t] = real as { ok: true; path: string }[];
  return { kind: "work-tree", gitDir: g!.path, commonDir: c!.path, topLevel: t!.path };
}

// The main working tree of a clone, read from `git worktree list` run in one of its linked
// worktrees: the first record is the main working tree, or `bare` when the clone is bare.
// `-z` (NUL-separated, so any path is unambiguous) needs Git 2.36 or later; an older Git exits
// non-zero and registering through a linked worktree is refused. Git derives this path from the
// common directory (dropping a trailing `/.git`), which is not the working tree of a clone with a
// separate Git directory or of a submodule; the caller therefore confirms the answer.
async function mainWorkingTree(directory: string): Promise<{ path: string } | RepositoryRefusal> {
  const listed = await runGit(["worktree", "list", "--porcelain", "-z"], { cwd: directory });
  if (listed.kind === "failed") return { kind: "unavailable" };
  if (listed.code !== 0) return { kind: "not-repository" };
  const end = listed.stdout.indexOf("\0\0");
  if (end < 0) return { kind: "unavailable" };
  const fields = listed.stdout.slice(0, end).split("\0");
  if (!fields[0]?.startsWith("worktree ")) return { kind: "unavailable" };
  if (fields.includes("bare")) return { kind: "bare" };
  return { path: fields[0].slice("worktree ".length) };
}

// The working tree that contains `path` (a directory anywhere inside it, given through any symlink
// and with or without a trailing slash; the caller passes an absolute path): its real top level,
// Git directory and common directory. The common directory is the clone's identity, known before
// (and independently of) finding the clone's main working tree, so a caller can recognize an
// already registered clone even when that main working tree cannot be found from here.
export type WorkTreeDiscovery = Extract<Discovery, { kind: "work-tree" }>;

export async function discoverRepository(
  path: string,
): Promise<WorkTreeDiscovery | RepositoryRefusal> {
  if (!isAbsolute(path)) return { kind: "not-repository" };
  const directory = await realDirectory(path);
  if (!directory.ok) return directory.refusal;
  return discover(directory.path);
}

// The clone a discovered working tree belongs to.
//
// - The main working tree (its Git directory is the common directory) is the clone itself.
// - A linked worktree resolves to the clone's main working tree, which must still exist and
//   report the same common directory; otherwise the clone cannot be named reliably (its main
//   working tree was deleted, or Git cannot derive it, as for a separate Git directory or a
//   submodule) and the path is refused as not a repository.
// - A bare repository, or a linked worktree of one, is refused as bare (S1): Cove registers a
//   clone with a working tree that checkout mounts can use.
export async function cloneOf(
  found: WorkTreeDiscovery,
): Promise<RepositoryInspection | RepositoryRefusal> {
  if (found.gitDir === found.commonDir)
    return { kind: "clone", topLevel: found.topLevel, commonDir: found.commonDir };
  const main = await mainWorkingTree(found.topLevel);
  if (!("path" in main)) return main;
  const mainDirectory = await realDirectory(main.path);
  if (!mainDirectory.ok)
    return mainDirectory.refusal.kind === "unavailable"
      ? mainDirectory.refusal
      : { kind: "not-repository" };
  const confirmed = await discover(mainDirectory.path);
  if (confirmed.kind === "unavailable") return confirmed;
  if (
    confirmed.kind !== "work-tree" ||
    confirmed.topLevel !== mainDirectory.path ||
    confirmed.gitDir !== found.commonDir ||
    confirmed.commonDir !== found.commonDir
  )
    return { kind: "not-repository" };
  return { kind: "clone", topLevel: confirmed.topLevel, commonDir: confirmed.commonDir };
}

// discoverRepository followed by cloneOf.
export async function inspectRepository(
  path: string,
): Promise<RepositoryInspection | RepositoryRefusal> {
  const found = await discoverRepository(path);
  return found.kind === "work-tree" ? cloneOf(found) : found;
}

// HEAD of a working tree: the checked-out branch (null when detached) and the commit HEAD names
// (null on an unborn branch, such as a fresh `git init`). Consumers: checkout mounts and binding
// conversion.
//
// Only refs are read, never objects: `rev-parse --verify HEAD` resolves the ref to an object ID
// without opening the object, so a commit missing from a partial clone is reported as named, not
// fetched. Peeling (`HEAD^{commit}`) would open the object and, in a partial clone, fetch it from
// the promisor remote before Git 2.45's GIT_NO_LAZY_FETCH (set by run.ts) could prevent it.
export type HeadState =
  | { kind: "head"; branch: string | null; commit: string | null }
  | { kind: "not-repository" }
  | { kind: "unavailable" };

function exitedWith(
  result: GitRunResult,
  codes: readonly number[],
): result is Extract<GitRunResult, { kind: "exited" }> {
  return result.kind === "exited" && codes.includes(result.code);
}

export async function readHead(workTree: string): Promise<HeadState> {
  const [symbolic, commit] = await Promise.all([
    runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: workTree }),
    runGit(["rev-parse", "--quiet", "--verify", "HEAD"], { cwd: workTree }),
  ]);
  if (symbolic.kind === "failed" || commit.kind === "failed") return { kind: "unavailable" };
  // symbolic-ref exits 1 for a detached HEAD and 128 outside a repository; rev-parse --verify
  // exits 1 when HEAD has no commit yet and 128 outside a repository.
  if (symbolic.code === 128 || commit.code === 128) return { kind: "not-repository" };
  if (!exitedWith(symbolic, [0, 1]) || !exitedWith(commit, [0, 1])) return { kind: "unavailable" };
  const ref = symbolic.code === 0 ? lines(symbolic.stdout, 1)?.[0] : undefined;
  const sha = commit.code === 0 ? lines(commit.stdout, 1)?.[0] : undefined;
  if ((symbolic.code === 0 && !ref) || (commit.code === 0 && !/^[0-9a-f]{40,64}$/.test(sha ?? "")))
    return { kind: "unavailable" };
  return {
    kind: "head",
    branch: ref === undefined ? null : ref.startsWith("refs/heads/") ? ref.slice(11) : ref,
    commit: sha ?? null,
  };
}

// Whether `name` is a valid branch name by Git's own rules (`refs/heads/<name>` passes
// check-ref-format). Needs no repository; null when Git gave no answer.
export async function isValidBranchName(name: string): Promise<boolean | null> {
  const result = await runGit(["check-ref-format", `refs/heads/${name}`], { cwd: "/" });
  if (result.kind === "failed") return null;
  return result.code === 0;
}
