import { storeReadError } from "../operations/database-operations.js";
import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Service module (server.impact; m2 T3, D2, S2): what a restart or stop of this server would end,
// with the platform's consequences. A read any owner may make, a paired device included; acting on
// it (restart, upgrade, stop) is a local CLI action, never an RPC (D7).
export const handle: RpcHandler<"service"> = async (core) => {
  const service = core.service;
  if (!service) return capabilityUnavailable();
  try {
    return await service.impact();
  } catch (error) {
    return { error: storeReadError(error) };
  }
};
