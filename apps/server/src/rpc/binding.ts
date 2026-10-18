import { M0_LIMITS } from "@cove/protocol/budgets";
import { BindingService } from "../domain/bindings.js";
import { capabilityUnavailable, type LocalCore, type RpcHandler } from "./context.js";
import { service as tasks } from "./task.js";

// Binding domain module (binding.convert, binding.delete, binding.list; M1 T5). The service is
// built once per core on the task module's worktree executor, so a conversion's preparation and a
// deletion share its seats, Git slots and filesystem permits, and operation.continue (rpc/mount.ts)
// resumes a deletion through it. A composition without a store (unit tests) reports
// CAPABILITY_UNAVAILABLE for every method.
const services = new WeakMap<LocalCore, BindingService>();
const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export function service(core: LocalCore): BindingService | null {
  const worktrees = tasks(core)?.worktrees;
  if (!worktrees || !core.store || !core.receipts) return null;
  let found = services.get(core);
  if (!found) {
    found = new BindingService({
      store: core.store,
      receipts: core.receipts,
      serverId: core.runtime.composition.serverId,
      encodeUtf8,
      runtime: core.runtime,
      worktrees,
      // As for the task module (rpc/task.ts).
      responseBytes: Math.min(
        M0_LIMITS.rpcResponseBytes,
        core.runtime.composition.budgets.rpcResponseBytes,
      ),
    });
    services.set(core, found);
  }
  return found;
}

type Params<M extends "convert" | "delete"> = Parameters<BindingService[M]>[1];

export const handle: RpcHandler<"binding"> = (core, { method, params, principalId }) => {
  const bindings = service(core);
  if (!bindings) return capabilityUnavailable();
  switch (method) {
    case "binding.convert":
      return bindings.convert(principalId, params as Params<"convert">);
    case "binding.delete":
      return bindings.delete(principalId, params as Params<"delete">);
    case "binding.list":
      return bindings.history(params as Parameters<BindingService["history"]>[0]);
  }
};
