import { domainError, type DomainError } from "@cove/protocol/errors";
import { RepoRecordSchema, type RepoRecord } from "@cove/protocol/workspace";
import type { OperationResultData } from "../../operations/receipt-records.js";
import { statement, type Connection } from "./statements.js";

// Repo registrations (docs/milestones/m1.md T2; the domain rules are in domain/repos.ts). The
// reads are named store operations; the writes are applied inside receipts.write
// (store/sql/receipts.ts), in the same transaction that rechecks the operation receipt and
// commits it, so each write checks its preconditions against the current rows.

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

function row(db: Connection, repoId: string): RepoRow | undefined {
  return statement(db, `SELECT ${COLUMNS} FROM repos WHERE repo_id = ?`).get(repoId) as
    RepoRow | undefined;
}

// A registration with its identity. The common directory is not part of RepoRecord (the wire
// record), but checkout admission (T3a, D2) compares a mounted worktree's common directory with it.
export type RegisteredRepo = { record: RepoRecord; commonDir: string };

// Reads one registration on the store's connection: for another domain's operation that needs it
// inside its own transaction (T3a, T3b).
export function findRepo(db: Connection, repoId: string): RegisteredRepo | null {
  const found = row(db, repoId);
  return found ? { record: toRecord(found), commonDir: found.common_dir } : null;
}

// The row an update or removal applies to, after its expected-revision precondition.
function current(
  db: Connection,
  args: { repoId: string; expectedRevision?: number },
  grows: boolean,
): { row: RepoRow } | { error: DomainError } {
  const found = row(db, args.repoId);
  if (!found) return { error: domainError("REPO_NOT_FOUND") };
  if (args.expectedRevision !== undefined && args.expectedRevision !== found.revision)
    return { error: domainError("REVISION_CONFLICT") };
  if (grows && found.revision === Number.MAX_SAFE_INTEGER)
    return { error: domainError("COUNTER_EXHAUSTED") };
  return { row: found };
}

export type RepoRegisterArgs = {
  repoId: string;
  displayName: string;
  path: string;
  commonDir: string;
  at: number;
};

export type RepoUpdateArgs = {
  repoId: string;
  expectedRevision?: number;
  displayName?: string;
  mainBranch?: string | null;
};

export type RepoRemoveArgs = { repoId: string; expectedRevision?: number };

type Applied = { result: OperationResultData } | { error: DomainError };

export const repoOperations = {
  "repos.get": (db: Connection, args: { repoId: string }): RegisteredRepo | null =>
    findRepo(db, args.repoId),

  // Pages in repoId order; `afterRepoId` need not exist any more (it may have been removed). One
  // row beyond the page tells the caller whether another page follows.
  "repos.list": (db: Connection, args: { afterRepoId: string; limit: number }): RepoRecord[] =>
    (
      statement(db, `SELECT ${COLUMNS} FROM repos WHERE repo_id > ? ORDER BY repo_id LIMIT ?`).all(
        args.afterRepoId,
        args.limit + 1,
      ) as RepoRow[]
    ).map(toRecord),

  "repos.commonDirRegistered": (db: Connection, args: { commonDir: string }): boolean =>
    statement(db, "SELECT 1 FROM repos WHERE common_dir = ?").get(args.commonDir) !== undefined,
};

export const repoWrites = {
  "repo.register": (db: Connection, args: RepoRegisterArgs): Applied => {
    const existing = statement(db, "SELECT 1 FROM repos WHERE common_dir = ? OR path = ?").get(
      args.commonDir,
      args.path,
    );
    if (existing) return { error: domainError("REPO_ALREADY_REGISTERED") };
    const record: RepoRecord = {
      repoId: args.repoId,
      revision: 0,
      displayName: args.displayName,
      path: args.path,
      mainBranch: null,
      registeredAtMs: args.at,
    };
    if (!RepoRecordSchema.safeParse(record).success)
      return { error: domainError("INVALID_ARGUMENT") };
    statement(db, `INSERT INTO repos (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      record.repoId,
      record.revision,
      record.displayName,
      record.path,
      args.commonDir,
      record.mainBranch,
      record.registeredAtMs,
    );
    return { result: { resource: { kind: "repo", id: record.repoId, revision: 0 } } };
  },

  // Every accepted update is one new revision, also when a value is set to what it already was.
  "repo.update": (db: Connection, args: RepoUpdateArgs): Applied => {
    const found = current(db, args, true);
    if ("error" in found) return found;
    const next = {
      revision: found.row.revision + 1,
      displayName: args.displayName ?? found.row.display_name,
      mainBranch: args.mainBranch === undefined ? found.row.main_branch : args.mainBranch,
    };
    statement(
      db,
      "UPDATE repos SET revision = ?, display_name = ?, main_branch = ? WHERE repo_id = ?",
    ).run(next.revision, next.displayName, next.mainBranch, found.row.repo_id);
    return {
      result: { resource: { kind: "repo", id: found.row.repo_id, revision: next.revision } },
    };
  },

  // Deletes the registration row only; the result names the revision that was removed. Refused
  // while any mount references the repo, whether its task is active or archived (REPO_IN_USE):
  // an archived task keeps its mounts, and unarchiving it must never find a mount whose
  // registration is gone. Checked here, in the transaction that deletes the row, so a concurrent
  // mount.add of the same repo either commits first (and this is refused) or finds the
  // registration gone (REPO_NOT_FOUND).
  "repo.remove": (db: Connection, args: RepoRemoveArgs): Applied => {
    const found = current(db, args, false);
    if ("error" in found) return found;
    if (statement(db, "SELECT 1 FROM mounts WHERE repo_id = ? LIMIT 1").get(found.row.repo_id))
      return { error: domainError("REPO_IN_USE") };
    statement(db, "DELETE FROM repos WHERE repo_id = ?").run(found.row.repo_id);
    return {
      result: {
        resource: { kind: "repo", id: found.row.repo_id, revision: found.row.revision },
      },
    };
  },
};
