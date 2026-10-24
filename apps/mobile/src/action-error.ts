import type { TransferDisposition } from "@cove/client";
/** Only app-authored messages and fixed categories reach product UI. Never wrap raw errors. */
export class ActionError extends Error {}
export type ConnectionStage =
  "credentials" | "entry" | "identity" | "protocol" | "authentication" | "connection" | "shutdown";
export type ConnectionCategory =
  | "store-unavailable"
  | "missing-slot"
  | "peer-transport-unverified"
  | "invalid-response"
  | "server-mismatch"
  | "protocol-mismatch"
  | "revoked"
  | "unauthenticated"
  | "unavailable"
  | "shutdown-unverified";
export interface ConnectionFailure {
  stage: ConnectionStage;
  category: ConnectionCategory;
}
export class ConnectionError extends ActionError {
  constructor(
    readonly failure: ConnectionFailure,
    readonly disposition: TransferDisposition = "unknown",
  ) {
    super(`${failure.stage}: ${failure.category}. No automatic retry or alternate entry was used.`);
  }
}
export function actionMessage(error: unknown): string {
  if (error instanceof ActionError) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^COVE_NATIVE_PAIRING_(INVITATION|ENTRY|IDENTITY|REDEEM|PERSIST)$/.test(error.code) &&
    "redemptionDisposition" in error &&
    ["not-sent", "handed-off", "unknown"].includes(String(error.redemptionDisposition))
  )
    return `${error.code}: redemption ${error.redemptionDisposition}. Check the saved pairing or request a new invitation; the previous redemption is never repeated.`;
  return "Action could not be verified. Its effect may be unknown; inspect Operations before trying a new action.";
}
export function connectionReason(reason: string): ConnectionFailure {
  const value = reason.toUpperCase();
  if (value.includes("DEVICE_REVOKED")) return { stage: "authentication", category: "revoked" };
  if (value.includes("UNAUTHENTICATED") || value.includes("FORBIDDEN"))
    return { stage: "authentication", category: "unauthenticated" };
  if (value.includes("PROTOCOL") || value.includes("CAPABILITY") || value.includes("PROFILE"))
    return { stage: "protocol", category: "protocol-mismatch" };
  return { stage: "connection", category: "unavailable" };
}
