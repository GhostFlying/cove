import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Entry configuration module (entry.get, entry.set; m2 T3, which adds the storage and the
// `cove server entry` CLI). Initial module: nothing is accepted until T3 replaces this export.
export const handle: RpcHandler<"entry"> = () => capabilityUnavailable();
