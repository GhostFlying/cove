// Migration 002: workspace entry materialization and mount lookups by repo (M1 T3a).
//
// - workspaces.materialized_revision: the workspace revision whose entry directory and mount
//   manifest were last written and flushed, NULL before the first write. The database is changed
//   first and the filesystem follows it (domain/workspaces.ts), so a revision ahead of this
//   column is recorded intent still to be written.
// - workspaces.entry_attempted_revision: the latest revision for which a publication of an
//   absent entry was attempted, NULL when none was (or the last one left nothing behind). Every
//   workspace revision, committed in the transaction that advances workspaces.revision, carries
//   exactly one entitlement to publish an absent entry: whoever attempts it first (the call that
//   committed the change, or a read after that call died or lost its answer) takes it by setting
//   this column to the revision, in one statement, durably and before the entry directory is
//   created. An entry absent while its current revision was materialized or its publication
//   already attempted was published (or may have been) and is gone: reads report it missing and
//   only the next change of the workspace, which brings a new entitlement, recreates it.
// - mounts_by_repo: repo.remove refuses a registration that any mount references (REPO_IN_USE)
//   inside its own transaction; the index keeps that check from scanning every mount.
export const MIGRATION_002 = `
ALTER TABLE workspaces ADD COLUMN materialized_revision INTEGER;
ALTER TABLE workspaces ADD COLUMN entry_attempted_revision INTEGER;
CREATE INDEX mounts_by_repo ON mounts (repo_id);
`;
