import type { CallOutcome } from "@cove/client";
import { ActionError } from "./action-error.js";

export function requireResult<T>(outcome: CallOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  if (outcome.kind === "operation-unknown")
    throw new ActionError(
      "Operation result is unknown. Query its original ID in Operations; it will not be replayed.",
    );
  if (outcome.kind === "operation-not-sent")
    throw new ActionError(
      "Operation was not sent. Its original reference is retained in Operations.",
    );
  if (outcome.kind === "rpc-error") {
    const kind = "kind" in outcome.error ? outcome.error.kind : "RPC_ERROR";
    throw new ActionError(
      `${kind}: refresh the server facts and review the requested action. No write was automatically repeated.`,
    );
  }
  throw new ActionError("Connection or request is unavailable. No automatic retry was made.");
}
