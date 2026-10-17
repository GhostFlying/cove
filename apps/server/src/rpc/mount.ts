import type { WorktreeService } from "../domain/worktrees.js";
import { capabilityUnavailable, type RpcHandler } from "./context.js";
import { service } from "./task.js";

// Mount domain module (mount.retry, operation.continue, operation.abandon; M1 T3b). It drives the
// worktree executor of the task module's WorkspaceService, so a retry or a continuation is
// serialized with the creation that started it and writes the same entry. A composition without
// a store (unit tests) reports CAPABILITY_UNAVAILABLE for every method.
export const handle: RpcHandler<"mount"> = (core, { method, params, principalId }) => {
  const worktrees = service(core)?.worktrees;
  if (!worktrees) return capabilityUnavailable();
  switch (method) {
    case "mount.retry":
      return worktrees.retry(principalId, params as Parameters<WorktreeService["retry"]>[1]);
    case "operation.continue":
      return worktrees.continueOperation(
        principalId,
        params as Parameters<WorktreeService["continueOperation"]>[1],
      );
    case "operation.abandon":
      return worktrees.abandonOperation(
        principalId,
        params as Parameters<WorktreeService["abandonOperation"]>[1],
      );
  }
};
