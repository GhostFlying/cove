import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Service module (server.impact; m2 T3, which also extends server.status in rpc/server.ts).
// Initial module: nothing is answered until T3 replaces this export.
export const handle: RpcHandler<"service"> = () => capabilityUnavailable();
