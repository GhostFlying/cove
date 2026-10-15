import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Initial binding domain module (binding.convert, binding.delete, binding.list); docs/milestones/m1.md T5 replaces this handler.
export const handle: RpcHandler<"binding"> = () => capabilityUnavailable();
