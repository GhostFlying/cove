import { isAbsolute, sep } from "node:path";
import type { Client } from "@cove/client";
import { M1_LIMITS, type RepoRecord } from "@cove/protocol/workspace";
import {
  flag,
  one,
  optionalIntegerFlag,
  print,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { operationIdFor, printSucceeded, submitWrite } from "./_pending.js";

export const usage = `  repo register <PATH> [--name NAME] [--operation-id ID]
  repo list
  repo get <repoId>
  repo set <repoId> mainBranch <BRANCH> [--expected-revision N] [--operation-id ID]
  repo set <repoId> displayName <NAME> [--expected-revision N] [--operation-id ID]
  repo reset <repoId> mainBranch [--expected-revision N] [--operation-id ID]
  repo remove <repoId> [--expected-revision N] [--operation-id ID]

A registration names one clone by its real top level; its existing worktrees are not imported.
mainBranch is only stored here; unset, worktree creation resolves it from the remote.
repo remove deletes the registration only and never touches the clone directory.`;

async function listRepos(client: Client): Promise<RepoRecord[]> {
  const repos: RepoRecord[] = [];
  let afterRepoId: string | undefined;
  do {
    const page = unwrap(
      "repo.list",
      await client.call("repo.list", {
        limit: M1_LIMITS.listPage,
        ...(afterRepoId ? { afterRepoId } : {}),
      }),
    );
    repos.push(...page.repos);
    afterRepoId = page.nextAfterRepoId;
  } while (afterRepoId);
  return repos;
}

// The path the server should inspect. A relative path is made absolute against this command's
// directory without normalizing it: `..` after a symlink means something else than lexical
// normalization says, and the server resolves the real path (and drops a trailing slash) itself.
// Rebuilding the command from the same directory produces the same intent.
function hostPath(path: string): string {
  if (isAbsolute(path)) return path;
  const cwd = process.cwd();
  return cwd.endsWith(sep) ? `${cwd}${path}` : `${cwd}${sep}${path}`;
}

function expectedRevision(args: Arguments): { expectedRevision?: number } {
  const value = optionalIntegerFlag(args, "--expected-revision");
  return value === undefined ? {} : { expectedRevision: value };
}

const SETTINGS = new Set(["mainBranch", "displayName"]);

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "register") {
    takeFlags(args, ["--name", "--operation-id"]);
    const path = one(args, "clone path");
    const displayName = flag(args, "--name");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(
        await submitWrite(args, session, "repo.register", {
          operationId,
          path: hostPath(path),
          ...(displayName === undefined ? {} : { displayName }),
        }),
      );
      return 0;
    });
  }
  if (sub === "list") {
    takeFlags(args, []);
    if (args.words.length !== 2 || args.command)
      throw new UsageError("repo list takes no arguments");
    return withSession(args, async ({ client }) => {
      print({ repos: await listRepos(client) });
      return 0;
    });
  }
  if (sub === "get") {
    takeFlags(args, []);
    const repoId = one(args, "repo id");
    return withSession(args, async ({ client }) => {
      print(unwrap("repo.get", await client.call("repo.get", { repoId })).repo);
      return 0;
    });
  }
  if (sub === "set" || sub === "reset") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    const [, , repoId, key, value] = args.words;
    if (!repoId || !key || !SETTINGS.has(key) || args.command)
      throw new UsageError(`repo ${sub} needs a repo id and a setting (mainBranch, displayName)`);
    if (sub === "reset" && key !== "mainBranch")
      throw new UsageError("only mainBranch can be reset");
    if (args.words.length !== (sub === "set" ? 5 : 4))
      throw new UsageError(
        sub === "set" ? "repo set needs one value" : "repo reset takes no value",
      );
    // reset clears the setting (null), so worktree creation resolves the branch from the remote.
    const patch = key === "displayName" ? { displayName: value! } : { mainBranch: value ?? null };
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(
        await submitWrite(args, session, "repo.update", {
          operationId,
          repoId,
          ...expectedRevision(args),
          ...patch,
        }),
      );
      return 0;
    });
  }
  if (sub === "remove") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    const repoId = one(args, "repo id");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(
        await submitWrite(args, session, "repo.remove", {
          operationId,
          repoId,
          ...expectedRevision(args),
        }),
      );
      return 0;
    });
  }
  throw new UsageError(`Unknown repo command ${sub ?? ""}`.trim());
}
