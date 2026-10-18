import { statement, type Connection } from "./statements.js";

// The other half of the live-run guard of binding.delete (m1 T5, D10; migration 004). A deletion
// is refused while a run without an end record uses the worktree, and once it is accepted no run
// may start using it: every transaction that accepts a run (tabs.launch, runs.started) asks this
// first and refuses when the run's cwd or any path of its mount mapping is the path of a pending
// deletion's worktree or lies below it. Both checks run inside store transactions, which the store
// serializes, so a run and a deletion of the path it uses are never both accepted: Cove's own
// overlapping work cannot start a run between the deletion's last run check and its
// `git worktree remove --force`. (Comparison is on the recorded paths, as in tabs.liveRunsUsing.)
export function deletionPending(db: Connection, paths: readonly string[]): boolean {
  const deleting = (
    statement(
      db,
      `SELECT g.path FROM worktree_deletions d
         JOIN managed_worktrees g ON g.worktree_id = d.worktree_id
       WHERE d.outcome = 'pending'`,
    ).all() as { path: string }[]
  ).map((row) => row.path);
  return deleting.some((path) => {
    const below = path.endsWith("/") ? path : `${path}/`;
    return paths.some((candidate) => candidate === path || candidate.startsWith(below));
  });
}
