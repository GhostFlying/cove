import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Initial config domain module (config.get, config.set); docs/milestones/m1.md T1 replaces this handler.
export const handle: RpcHandler<"config"> = () => capabilityUnavailable();
