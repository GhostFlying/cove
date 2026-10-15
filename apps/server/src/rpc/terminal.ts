import { domainError } from "@cove/protocol/errors";
import type { RunRef } from "@cove/protocol/identity";
import type { RpcHandler } from "./context.js";

export const handle: RpcHandler<"terminal"> = (core, { method, params, principalId }) => {
  const runtime = core.runtime;
  switch (method) {
    case "terminal.list":
      return runtime.previews.cache.list(params as { limit: number; afterRunId?: string });
    case "terminal.get": {
      const record = runtime.previews.cache.getRecord(params.run as RunRef);
      return record ? { record } : { error: domainError("RUN_NOT_FOUND") };
    }
    case "terminal.create":
      return core.operations.create(principalId, params);
    case "terminal.stop":
      return core.operations.stop(principalId, params);
  }
};
