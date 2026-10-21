import type { EntrySettings } from "@cove/protocol/auth";
import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Entry configuration module (entry.get, entry.set; m2 T3, D3). Ports and the tsnet hostname
// apply when the server next starts (the result says appliesAfterRestart, entry.get says
// restartRequired); the SSH target applies to the next invitation. Changing a setting is an
// ordinary write with an operation ID; the only local bootstrap path is `cove server install`,
// which fixes unset ports while no server runs (entry/main.ts init).
export const handle: RpcHandler<"entry"> = async (core, { method, params, principalId }) => {
  const entry = core.entry;
  if (!entry) return capabilityUnavailable();
  switch (method) {
    case "entry.get": {
      const record = await entry.record();
      return "error" in record ? record : { entry: record };
    }
    case "entry.set":
      return entry.set(
        principalId,
        params as {
          operationId: string;
          expectedRevision?: number;
          patch: Partial<EntrySettings>;
        },
      );
  }
};
