import { domainError, type DomainError } from "@cove/protocol/errors";
import type { MountSpec } from "@cove/protocol/workspace";
import type { LocalCore } from "../rpc/context.js";

// Seam between workspace preparation (T3a: task.create, mount.add) and managed worktree creation
// (T3b). The workspace module calls prepareWorktreeMount once for each `source: "worktree"` mount
// and records the outcome per mount; T3b replaces only this module. Until then no worktree mount
// can be prepared and nothing is created.

export type WorktreeMountRequest = {
  // The task.create or mount.add operation that owns this preparation. Its intent is recorded
  // under this identity before any Git side effect, so a restart can verify it (relay-protocol
  // §11.4) and operation.continue/abandon can address it.
  principalId: string;
  operationId: string;
  taskId: string;
  mountId: string;
  // Target directory `<workspace entry>/<mount name>`, chosen by the workspace layout (D1).
  path: string;
  // Fixed task slug; the default branch is `cove/<slug>` (D1).
  slug: string;
  spec: Extract<MountSpec, { source: "worktree" }>;
};

export type WorktreeMountOutcome =
  { ok: true; branch: string; baseCommit: string } | { ok: false; error: DomainError };

export async function prepareWorktreeMount(
  _core: LocalCore,
  _request: WorktreeMountRequest,
): Promise<WorktreeMountOutcome> {
  return { ok: false, error: domainError("CAPABILITY_UNAVAILABLE") };
}
