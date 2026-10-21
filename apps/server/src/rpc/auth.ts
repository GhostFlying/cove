import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Auth domain module (auth.invite.*, auth.device.*; m2 T1). Initial module: nothing is accepted
// until T1 replaces this export.
export const handle: RpcHandler<"auth"> = () => capabilityUnavailable();
