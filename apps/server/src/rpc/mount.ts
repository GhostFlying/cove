import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Initial mount domain module (mount.retry, operation.continue, operation.abandon); docs/milestones/m1.md T3b replaces this handler.
export const handle: RpcHandler<"mount"> = () => capabilityUnavailable();
