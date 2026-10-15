import type { RpcHandler } from "./context.js";

// operation.continue and operation.abandon are served by the mount module (see the method table).
export const handle: RpcHandler<"operation"> = (core, { params, principalId }) =>
  core.operations.get(principalId, params.operationId as string);
