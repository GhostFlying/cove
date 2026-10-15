import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Initial task domain module (task.*, mount.add, mount.remove); docs/milestones/m1.md T3a replaces this handler.
export const handle: RpcHandler<"task"> = () => capabilityUnavailable();
