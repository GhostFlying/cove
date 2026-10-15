import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Initial tab domain module (tab.*); docs/milestones/m1.md T4 replaces this handler.
export const handle: RpcHandler<"tab"> = () => capabilityUnavailable();
