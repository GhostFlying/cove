import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Initial repo domain module (repo.register, repo.list, repo.get, repo.update, repo.remove); docs/milestones/m1.md T2 replaces this handler.
export const handle: RpcHandler<"repo"> = () => capabilityUnavailable();
