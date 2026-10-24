import { inputService } from "./tab.js";
import type { WorktreeService } from "../domain/worktrees.js";
import { capabilityUnavailable, type RpcHandler } from "./context.js";
import { service as bindings } from "./binding.js";
import { service } from "./task.js";

// Mount domain module (mount.retry, operation.continue, operation.abandon; M1 T3b). It drives the
// worktree executor of the task module's WorkspaceService, so a retry or a continuation is
// serialized with the creation that started it and writes the same entry. A composition without
// a store (unit tests) reports CAPABILITY_UNAVAILABLE for every method.
export const handle: RpcHandler<"mount"> = async (core, { method, params, principalId }) => {
  if (method === "operation.continue" || method === "operation.abandon") {
    const outcome = await inputService(core)?.act(
      principalId,
      method,
      params as { operationId: string; targetOperationId: string },
    );
    if (outcome) return outcome;
  }
  const worktrees = service(core)?.worktrees;
  if (!worktrees) return capabilityUnavailable();
  // Built before a continue so that the binding module has registered how a binding.delete
  // requiring attention is resumed (domain/bindings.ts).
  bindings(core);
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
