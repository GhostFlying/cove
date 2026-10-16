import { storeReadError } from "../operations/database-operations.js";
import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Config domain module (config.get, config.set; M1 T1). Every setting change is an ordinary write
// with an operation ID; `cove server init` is the only local bootstrap path (D7).
export const handle: RpcHandler<"config"> = async (core, { method, params, principalId }) => {
  const config = core.config;
  if (!config) return capabilityUnavailable();
  switch (method) {
    case "config.get":
      try {
        return { config: await config.record() };
      } catch (error) {
        return { error: storeReadError(error) };
      }
    case "config.set":
      return config.set(
        principalId,
        params as Parameters<typeof config.set>[1] & Record<string, unknown>,
      );
  }
};
