import { capabilityUnavailable, type RpcHandler } from "./context.js";

// The server tsnet node module (server.tsnet.login/status/logout; m2 T5b). Initial module:
// nothing is accepted until T5b replaces this export.
export const handle: RpcHandler<"tsnet"> = () => capabilityUnavailable();
