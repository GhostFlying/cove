import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { canonicalWriteIntent, type WriteRpcMethod } from "@cove/protocol/rpc";
import {
  DisplayNameSchema,
  HostPathSchema,
  M1_LIMITS,
  RepoRecordSchema,
  type RepoRecord,
} from "@cove/protocol/workspace";
import {
  executeDatabaseWrite,
  type DatabaseWriteOutcome,
  type OperationResultData,
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
// executeDatabaseWrite then looks the receipt up again and checks the duplicate and revision
// preconditions against the current rows in the same transaction that inserts the row and the
// receipt. Two concurrent registrations of one clone thus serialize on that transaction: one
// succeeds, the other is refused (or, with the same operation ID, returns the first's record).
// A refusal decided after a Git check looks the receipt up once more before it is returned (see
// RepoService.refuse), so a request never reports "not accepted" for an operation ID whose
// identical request was accepted meanwhile. A refused request leaves no receipt and changes
// nothing.

type RepoRow = {
  repo_id: string;
  revision: number;
  display_name: string;
  path: string;
  common_dir: string;
  main_branch: string | null;
  registered_at_ms: number;
};

const COLUMNS = "repo_id, revision, display_name, path, common_dir, main_branch, registered_at_ms";

function toRecord(row: RepoRow): RepoRecord {
  return {
    repoId: row.repo_id,
    revision: row.revision,
    displayName: row.display_name,
    path: row.path,
    mainBranch: row.main_branch,
    registeredAtMs: row.registered_at_ms,
  };
}

// A registration with its identity. The common directory is not part of RepoRecord (the wire
// record), but checkout admission (T3a, D2) compares a mounted worktree's common directory with it.
export type RegisteredRepo = { record: RepoRecord; commonDir: string };

// Reads one registration; for use inside another domain's transaction (T3a, T3b).
export function findRepo(store: Store, repoId: string): RegisteredRepo | null {
  const row = store.db.prepare(`SELECT ${COLUMNS} FROM repos WHERE repo_id = ?`).get(repoId) as
    RepoRow | undefined;
  return row ? { record: toRecord(row), commonDir: row.common_dir } : null;
}

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

  private get db() {
    return this.options.store.db;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // The answer for a request that already has a receipt, or null when it has none and must be
  // checked and executed. Mirrors executeDatabaseWrite's own lookup, which runs again inside the
  // transaction; this earlier one exists so that a resend never depends on a precondition that
  // needs Git (the clone may have moved or be registered by now).
  private recorded(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
  ): DatabaseWriteOutcome | null {
    const intent = canonicalWriteIntent(method, params, this.options.encodeUtf8);
    if (!intent) return { error: domainError("INVALID_ARGUMENT") };
    const found = this.options.receipts.lookup(
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
    apply: () => { result: OperationResultData } | { error: DomainError },
  ): DatabaseWriteOutcome {
    return executeDatabaseWrite(
      {
        serverId: this.options.serverId,
        receipts: this.options.receipts,
        encodeUtf8: this.options.encodeUtf8,
        transaction: (fn) => this.options.store.transaction(fn),
      },
      principalId,
      method,
      params,
      apply,
    );
  }

  get(repoId: string): { repo: RepoRecord } | { error: DomainError } {
    const found = findRepo(this.options.store, repoId);
    return found ? { repo: found.record } : { error: domainError("REPO_NOT_FOUND") };
  }

  // Pages in repoId order; `afterRepoId` need not exist any more (it may have been removed).
  list(params: { limit: number; afterRepoId?: string }): {
    repos: RepoRecord[];
    nextAfterRepoId?: string;
  } {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM repos WHERE repo_id > ? ORDER BY repo_id LIMIT ?`)
      .all(params.afterRepoId ?? "", params.limit + 1) as RepoRow[];
    const page = rows.slice(0, params.limit).map(toRecord);
    return rows.length > params.limit
      ? { repos: page, nextAfterRepoId: page[page.length - 1]!.repoId }
      : { repos: page };
  }

  // A refusal decided after an await. While this request waited for Git, another request with the
  // same operation ID may have committed: its receipt then answers this one too (the same record,
  // or OPERATION_ID_CONFLICT for a changed intent), never this request's late refusal, which would
  // contradict an operation that was in fact accepted.
  private refuse(
    principalId: string,
    method: WriteRpcMethod,
    params: Record<string, unknown> & { operationId: string },
    error: DomainError,
  ): DatabaseWriteOutcome {
    return this.recorded(principalId, method, params) ?? { error };
  }

  private registeredCommonDir(commonDir: string): boolean {
    return this.db.prepare("SELECT 1 FROM repos WHERE common_dir = ?").get(commonDir) !== undefined;
  }

  async register(principalId: string, params: RegisterParams): Promise<DatabaseWriteOutcome> {
    const recorded = this.recorded(principalId, "repo.register", params);
    if (recorded) return recorded;
    // The path is interpreted on this host; a relative path has no meaning to the server.
    if (!isAbsolute(params.path)) return { error: domainError("INVALID_ARGUMENT") };
    const refuse = (error: DomainError) => this.refuse(principalId, "repo.register", params, error);
    const found = await this.git.discoverRepository(params.path);
    if (found.kind !== "work-tree") return refuse(refusalError(found));
    // The common directory is the identity. A clone already registered is recognized by it before
    // its main working tree is looked for: from a linked worktree of a clone with a separate Git
    // directory, of a submodule or of a relocated Git directory, Git cannot name the main working
    // tree, and the request must still be reported as the duplicate it is (the registration's
    // stored path is that clone's main working tree). This early answer is advisory; the
    // transaction below checks again.
    if (this.registeredCommonDir(found.commonDir))
      return refuse(domainError("REPO_ALREADY_REGISTERED"));
    const clone = await this.git.cloneOf(found);
    if (clone.kind !== "clone") return refuse(refusalError(clone));
    if (
      !HostPathSchema.safeParse(clone.topLevel).success ||
      !HostPathSchema.safeParse(clone.commonDir).success
    )
      return refuse(domainError("INVALID_ARGUMENT"));
    const displayName = params.displayName ?? defaultDisplayName(clone.topLevel);
    return this.write(principalId, "repo.register", params, () => {
      const existing = this.db
        .prepare("SELECT 1 FROM repos WHERE common_dir = ? OR path = ?")
        .get(clone.commonDir, clone.topLevel);
      if (existing) return { error: domainError("REPO_ALREADY_REGISTERED") };
      const record: RepoRecord = {
        repoId: (this.options.newId ?? randomUUID)(),
        revision: 0,
        displayName,
        path: clone.topLevel,
        mainBranch: null,
        registeredAtMs: this.now(),
      };
      if (!RepoRecordSchema.safeParse(record).success)
        return { error: domainError("INVALID_ARGUMENT") };
      this.db
        .prepare(`INSERT INTO repos (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.repoId,
          record.revision,
          record.displayName,
          record.path,
          clone.commonDir,
          record.mainBranch,
          record.registeredAtMs,
        );
      return { result: { resource: { kind: "repo", id: record.repoId, revision: 0 } } };
    });
  }

  // Changes the display name and/or the main-branch setting. Every accepted update is one new
  // revision, also when a value is set to what it already was.
  async update(principalId: string, params: UpdateParams): Promise<DatabaseWriteOutcome> {
    const recorded = this.recorded(principalId, "repo.update", params);
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
    return this.write(principalId, "repo.update", params, () => {
      const current = this.current(params);
      if ("error" in current) return current;
      const row = current.row;
      const next = {
        revision: row.revision + 1,
        displayName: params.displayName ?? row.display_name,
        mainBranch: params.mainBranch === undefined ? row.main_branch : params.mainBranch,
      };
      this.db
        .prepare(
          "UPDATE repos SET revision = ?, display_name = ?, main_branch = ? WHERE repo_id = ?",
        )
        .run(next.revision, next.displayName, next.mainBranch, row.repo_id);
      return { result: { resource: { kind: "repo", id: row.repo_id, revision: next.revision } } };
    });
  }

  // Deletes the registration row only; the clone directory is never touched. The result names
  // the revision that was removed.
  //
  // Mounts are not consulted: no mount can exist before T3a, and whether a mounted repo may be
  // unregistered is still open (reported with T2). A mount keeps its own repoId and real path.
  remove(principalId: string, params: RemoveParams): DatabaseWriteOutcome {
    return this.write(principalId, "repo.remove", params, () => {
      const current = this.current(params, false);
      if ("error" in current) return current;
      this.db.prepare("DELETE FROM repos WHERE repo_id = ?").run(current.row.repo_id);
      return {
        result: {
          resource: { kind: "repo", id: current.row.repo_id, revision: current.row.revision },
        },
      };
    });
  }

  // The row an update or removal applies to, after its expected-revision precondition.
  private current(
    params: { repoId: string; expectedRevision?: number },
    grows = true,
  ): { row: RepoRow } | { error: DomainError } {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM repos WHERE repo_id = ?`)
      .get(params.repoId) as RepoRow | undefined;
    if (!row) return { error: domainError("REPO_NOT_FOUND") };
    if (params.expectedRevision !== undefined && params.expectedRevision !== row.revision)
      return { error: domainError("REVISION_CONFLICT") };
    if (grows && row.revision === Number.MAX_SAFE_INTEGER)
      return { error: domainError("COUNTER_EXHAUSTED") };
    return { row };
  }
}
