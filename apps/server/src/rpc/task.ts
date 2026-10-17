import { M0_LIMITS } from "@cove/protocol/budgets";
import { WorkspaceService } from "../domain/workspaces.js";
import { capabilityUnavailable, type LocalCore, type RpcHandler } from "./context.js";

// Task domain module (task.create, task.list, task.get, task.update, task.archive,
// task.unarchive, mount.add, mount.remove; M1 T3a). The service is built from the composition's
// store, receipts and configuration once per core, like the repo module; a composition without
// them (unit tests) reports CAPABILITY_UNAVAILABLE for every method. The mount module
// (rpc/mount.ts) uses the same service, so one worktree executor serves both (T3b).
const services = new WeakMap<LocalCore, WorkspaceService>();
const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export function service(core: LocalCore): WorkspaceService | null {
  if (!core.store || !core.receipts || !core.config) return null;
  let found = services.get(core);
  if (!found) {
    found = new WorkspaceService({
      store: core.store,
      receipts: core.receipts,
      config: core.config,
      serverId: core.runtime.composition.serverId,
      encodeUtf8,
      // A result must fit both the per-response limit and the configured response budget
      // (transport/http-rpc.ts).
      responseBytes: Math.min(
        M0_LIMITS.rpcResponseBytes,
        core.runtime.composition.budgets.rpcResponseBytes,
      ),
    });
    services.set(core, found);
  }
  return found;
}

type Params<M extends keyof WorkspaceService> = WorkspaceService[M] extends (
  principalId: string,
  params: infer P,
  ...rest: never[]
) => unknown
  ? P
  : never;

export const handle: RpcHandler<"task"> = (core, { method, params, principalId }) => {
  const tasks = service(core);
  if (!tasks) return capabilityUnavailable();
  switch (method) {
    case "task.create":
      return tasks.create(principalId, params as Params<"create">);
    case "task.list":
      return tasks.list(params as Parameters<WorkspaceService["list"]>[0]);
    case "task.get":
      return tasks.get(params.taskId as string);
    case "task.update":
      return tasks.rename(principalId, params as Params<"rename">);
    case "task.archive":
      return tasks.setArchived(principalId, params as Params<"setArchived">, true);
    case "task.unarchive":
      return tasks.setArchived(principalId, params as Params<"setArchived">, false);
    case "mount.add":
      return tasks.addMount(principalId, params as Params<"addMount">);
    case "mount.remove":
      return tasks.removeMount(principalId, params as Params<"removeMount">);
  }
};
