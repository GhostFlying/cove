import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { canonicalWriteIntent, type WriteRpcMethod } from "@cove/protocol/rpc";
import {
  DisplayNameSchema,
  HostPathSchema,
  M1_LIMITS,
  type RepoRecord,
} from "@cove/protocol/workspace";
import {
  executeDatabaseWrite,
  storeReadError,
  type DatabaseWriteApply,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { Store } from "../store/database.js";
import {
  cloneOf,
  discoverRepository,
  isValidBranchName,
  type RepositoryRefusal,
} from "../git/repository.js";

// Repo registration (docs/milestones/m1.md T2, S1). A registration names one local clone:
//
// - Identity: the real path of the clone's Git common directory (repos.common_dir, UNIQUE). Every
//   spelling of the same clone (a symlink, a trailing slash, a subdirectory, one of its linked
//   worktrees) has the same common directory, so registering it again is refused with
//   REPO_ALREADY_REGISTERED rather than returning the existing registration: the operator learns
//   that nothing new was created, and the existing repoId is one `repo list` away.
// - Path: the real top level of the clone's main working tree (repos.path, UNIQUE).
// - Registering never imports the clone's existing worktrees and never writes to the clone; the
//   Git queries are read-only (git/repository.ts). Removing a registration only deletes the row.
// - mainBranch stores Cove's setting as configured (null = not set). Resolving the main branch
//   from the remote is worktree creation's job (T3b, D1), so nothing here contacts a remote.
//
// Write order (relay-protocol §11.3, m1 "操作身份跨重启"): the receipt is looked up first, so a
// resend of an executed register returns its original record even though the clone is registered
// by now (the duplicate check would refuse a new request). Only a request without a receipt runs
// the Git checks, which are asynchronous and therefore outside the database transaction;
// executeDatabaseWrite then makes one store call, receipts.write, whose single transaction looks
// the receipt up again and runs the named write (store/sql/repos.ts), which checks the duplicate
// and revision preconditions against the current rows before it writes; the receipt commits with
// the row. Two concurrent registrations of one clone thus serialize on that transaction: one
// succeeds, the other is refused (or, with the same operation ID, returns the first's record).
// The store runs in a worker thread (D6), so the receipt lookup and every store read are awaits
// too. Every refusal decided after an await looks the receipt up once more before it is returned
// (see RepoService.refuse), so a request never reports "not accepted" for an operation ID whose
// identical request was accepted meanwhile. A refused request leaves no receipt and changes
// nothing.

// The rows, their record mapping, the writes and the in-transaction reader for other domains
// (findRepo, RegisteredRepo) live with the SQL in store/sql/repos.ts.

// Fixed refusals of a clone path. A path Cove cannot read (missing, permission) is refused like
// any other path that does not lead to a clone; the fixed error messages carry no path either
// way. When Git gave no answer at all (timeout, overflow, git missing or killed; also an
// unexpected filesystem error while resolving the path) nothing is known about the path, so the
// request is refused as GIT_UNAVAILABLE (not accepted, nothing done) instead of being misreported
// as "not a repository" or as a capacity refusal.
function refusalError(refusal: RepositoryRefusal): DomainError {
  switch (refusal.kind) {
    case "bare":
      return domainError("BARE_REPOSITORY");
    case "unavailable":
      return domainError("GIT_UNAVAILABLE");
    case "missing":
    case "inaccessible":
    case "not-repository":
      return domainError("NOT_A_GIT_REPOSITORY");
  }
}

// The default display name is the top level's directory name, cut to the display-name limit.
function defaultDisplayName(topLevel: string): string {
  const name = [...basename(topLevel)].slice(0, M1_LIMITS.displayNameChars).join("");
  return DisplayNameSchema.safeParse(name).success ? name : "repo";
}

type RegisterParams = { operationId: string; path: string; displayName?: string };
type UpdateParams = {
  operationId: string;
  repoId: string;
  expectedRevision?: number;
  displayName?: string;
  mainBranch?: string | null;
};
type RemoveParams = { operationId: string; repoId: string; expectedRevision?: number };

export type RepoServiceOptions = {
  store: Store;
  serverId: string;
  receipts: OperationReceipts;
  encodeUtf8: (text: string) => Uint8Array;
  now?: () => number;
  newId?: () => string;
  // The Git queries; tests replace them to order concurrent requests deterministically.
  git?: Partial<RepoGit>;
};

export type RepoGit = {
  discoverRepository: typeof discoverRepository;
  cloneOf: typeof cloneOf;
  isValidBranchName: typeof isValidBranchName;
};

export class RepoService {
  private readonly git: RepoGit;

  constructor(private readonly options: RepoServiceOptions) {
    this.git = { discoverRepository, cloneOf, isValidBranchName, ...options.git };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // The answer for a request that already has a receipt, or null when it has none and must be
  // checked and executed. Mirrors executeDatabaseWrite's own lookup, which runs again inside the
  // transaction; this earlier one exists so that a resend never depends on a precondition that
  // needs Git (the clone may have moved or be registered by now).
  private async recorded(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
  ): Promise<DatabaseWriteOutcome | null> {
    const intent = canonicalWriteIntent(method, params, this.options.encodeUtf8);
    if (!intent) return { error: domainError("INVALID_ARGUMENT") };
    const found = await this.options.receipts.lookup(
      { serverId: this.options.serverId, principalId, operationId: params.operationId },
      intent,
    );
    if (found.kind === "existing") return { operation: found.record };
    if (found.kind === "conflict") return { error: domainError("OPERATION_ID_CONFLICT") };
    if (found.kind !== "reserve") return { error: domainError("BUSY") };
    return null;
  }

  private write(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    apply: DatabaseWriteApply,
  ): Promise<DatabaseWriteOutcome> {
    return executeDatabaseWrite(
      {
        serverId: this.options.serverId,
        receipts: this.options.receipts,
        encodeUtf8: this.options.encodeUtf8,
      },
      principalId,
      method,
      params,
      apply,
    );
  }

  async get(repoId: string): Promise<{ repo: RepoRecord } | { error: DomainError }> {
    try {
      const found = await this.options.store.call("repos.get", { repoId });
      return found ? { repo: found.record } : { error: domainError("REPO_NOT_FOUND") };
    } catch (error) {
      return { error: storeReadError(error) };
    }
  }

  // Pages in repoId order; `afterRepoId` need not exist any more (it may have been removed).
  async list(params: {
    limit: number;
    afterRepoId?: string;
  }): Promise<{ repos: RepoRecord[]; nextAfterRepoId?: string } | { error: DomainError }> {
    let rows: RepoRecord[];
    try {
      rows = await this.options.store.call("repos.list", {
        afterRepoId: params.afterRepoId ?? "",
        limit: params.limit,
      });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    const page = rows.slice(0, params.limit);
    return rows.length > params.limit
      ? { repos: page, nextAfterRepoId: page[page.length - 1]!.repoId }
      : { repos: page };
  }

  // A refusal decided after an await. While this request waited for Git, another request with the
  // same operation ID may have committed: its receipt then answers this one too (the same record,
  // or OPERATION_ID_CONFLICT for a changed intent), never this request's late refusal, which would
  // contradict an operation that was in fact accepted.
  private async refuse(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    error: DomainError,
  ): Promise<DatabaseWriteOutcome> {
    return (await this.recorded(principalId, method, params)) ?? { error };
  }

  async register(principalId: string, params: RegisterParams): Promise<DatabaseWriteOutcome> {
    const recorded = await this.recorded(principalId, "repo.register", params);
    if (recorded) return recorded;
    const refuse = (error: DomainError) => this.refuse(principalId, "repo.register", params, error);
    // The path is interpreted on this host; a relative path has no meaning to the server. It is
    // decided after the receipt lookup's await, so it is refused like any other late refusal.
    if (!isAbsolute(params.path)) return refuse(domainError("INVALID_ARGUMENT"));
    const found = await this.git.discoverRepository(params.path);
    if (found.kind !== "work-tree") return refuse(refusalError(found));
    // The common directory is the identity. A clone already registered is recognized by it before
    // its main working tree is looked for: from a linked worktree of a clone with a separate Git
    // directory, of a submodule or of a relocated Git directory, Git cannot name the main working
    // tree, and the request must still be reported as the duplicate it is (the registration's
    // stored path is that clone's main working tree). This early answer is advisory; the
    // transaction below checks again.
    let registered: boolean;
    try {
      registered = await this.options.store.call("repos.commonDirRegistered", {
        commonDir: found.commonDir,
      });
    } catch (error) {
      return refuse(storeReadError(error));
    }
    if (registered) return refuse(domainError("REPO_ALREADY_REGISTERED"));
    const clone = await this.git.cloneOf(found);
    if (clone.kind !== "clone") return refuse(refusalError(clone));
    if (
      !HostPathSchema.safeParse(clone.topLevel).success ||
      !HostPathSchema.safeParse(clone.commonDir).success
    )
      return refuse(domainError("INVALID_ARGUMENT"));
    const displayName = params.displayName ?? defaultDisplayName(clone.topLevel);
    return this.write(principalId, "repo.register", params, {
      name: "repo.register",
      args: {
        repoId: (this.options.newId ?? randomUUID)(),
        displayName,
        path: clone.topLevel,
        commonDir: clone.commonDir,
        at: this.now(),
      },
    });
  }

  // Changes the display name and/or the main-branch setting. Every accepted update is one new
  // revision, also when a value is set to what it already was.
  async update(principalId: string, params: UpdateParams): Promise<DatabaseWriteOutcome> {
    const recorded = await this.recorded(principalId, "repo.update", params);
    if (recorded) return recorded;
    if (typeof params.mainBranch === "string") {
      // The contract's GitRefSchema excludes option-like and whitespace values; Git's own rules
      // also refuse names such as `a..b` or `x.lock`, which no remote branch can have.
      const valid = await this.git.isValidBranchName(params.mainBranch);
      if (valid !== true)
        return this.refuse(
          principalId,
          "repo.update",
          params,
          domainError(valid === null ? "GIT_UNAVAILABLE" : "INVALID_ARGUMENT"),
        );
    }
    return this.write(principalId, "repo.update", params, {
      name: "repo.update",
      args: {
        repoId: params.repoId,
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
        ...(params.displayName === undefined ? {} : { displayName: params.displayName }),
        ...(params.mainBranch === undefined ? {} : { mainBranch: params.mainBranch }),
      },
    });
  }

  // Deletes the registration row only; the clone directory is never touched. The result names
  // the revision that was removed.
  //
  // Mounts are not consulted: no mount can exist before T3a, and whether a mounted repo may be
  // unregistered is still open (reported with T2). A mount keeps its own repoId and real path.
  remove(principalId: string, params: RemoveParams): Promise<DatabaseWriteOutcome> {
    return this.write(principalId, "repo.remove", params, {
      name: "repo.remove",
      args: {
        repoId: params.repoId,
        ...(params.expectedRevision === undefined
          ? {}
          : { expectedRevision: params.expectedRevision }),
      },
    });
  }
}
