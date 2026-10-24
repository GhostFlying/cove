import { z } from "zod";
import { RunRefSchema } from "./provisional/identity.js";

export const DOMAIN_ERROR_KINDS = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "BOOTSTRAP_UNSUPPORTED",
  "PROTOCOL_MISMATCH",
  "INSTANCE_MISMATCH",
  "CAPABILITY_UNAVAILABLE",
  "PROFILE_UNSUPPORTED",
  "RUN_NOT_FOUND",
  "STALE_CONNECTION",
  "STALE_CONTROL",
  "INVALID_SIZE",
  "RESYNC_REQUIRED",
  "RECOVERY_EXPIRED",
  "RECOVERY_UNAVAILABLE",
  "BUSY",
  "OPERATION_ID_CONFLICT",
  "OPERATION_NOT_FOUND",
  "INPUT_REJECTED",
  "RESULT_UNKNOWN",
  "WORKER_UNAVAILABLE",
  "COUNTER_EXHAUSTED",
  // M1 domain kinds. They are appended so that every earlier kind keeps its code.
  "INVALID_ARGUMENT",
  "REVISION_CONFLICT",
  "REPO_NOT_FOUND",
  "TASK_NOT_FOUND",
  "MOUNT_NOT_FOUND",
  "TAB_NOT_FOUND",
  "NOT_A_GIT_REPOSITORY",
  "BARE_REPOSITORY",
  "REPO_ALREADY_REGISTERED",
  "MANAGED_WORKTREE_NOT_MOUNTABLE",
  "MOUNT_NAME_CONFLICT",
  "TASK_ARCHIVED",
  "BRANCH_EXISTS",
  "FETCH_FAILED",
  "MAIN_BRANCH_UNRESOLVED",
  "LIVE_RUNS_PRESENT",
  "OPERATION_NOT_RESUMABLE",
  "OPERATION_EFFECTS_ACTIVE",
  // The execution host's Git gave no answer (timeout, output over its bound, git missing or
  // killed). Nothing is known about the repository or path the request named: it is neither
  // "not a repository" nor a capacity refusal (BUSY). The request was not accepted.
  "GIT_UNAVAILABLE",
  // A repo registration cannot be removed while a mount of any task, archived ones included,
  // references it: an archived task keeps its mounts, and unarchiving it must not find a mount
  // whose repo is gone. Nothing was removed; the operator removes those mounts first.
  "REPO_IN_USE",
  // A task cannot get its workspace entry: the workspace root cannot be created, or something
  // already occupies the entry path (Cove never takes over a directory it did not publish). The
  // request was not accepted and nothing was recorded. An entry that fails after the task was
  // recorded is reported by the task record (entryState), never by this refusal.
  "WORKSPACE_ENTRY_UNAVAILABLE",
  // M2 kinds (device authorization, entries and operation retention), appended likewise.
  // The device's token was valid but the device has been revoked (m2 D8). Only a caller that
  // presented the device's correct secret learns this; a wrong or unknown token is
  // UNAUTHENTICATED, which never tells a missing device from a wrong secret.
  "DEVICE_REVOKED",
  // Pairing refusal (m2 D6): the invitation is redeemed, cancelled, expired or unknown, or the
  // secret is wrong. One kind for all of them, so a guesser learns nothing about which.
  "INVITATION_UNAVAILABLE",
  // An authenticated device-management request names an invitation or device this server has
  // no record of. Unlike pairing, the caller is already the owner, so the distinction is safe.
  "INVITATION_NOT_FOUND",
  "DEVICE_NOT_FOUND",
  // The client reached a server whose serverId is not the one it recorded for this alias; it
  // stopped before sending any device token (m2 S7).
  "SERVER_ID_MISMATCH",
  // The channel peer (SSH host key, or the server tsnet node's stable ID) is not the one the
  // client recorded; it stopped before sending any device token (m2 S6, S8).
  "PEER_IDENTITY_MISMATCH",
  // The selected entry (loopback, ssh or tsnet) could not be reached or started. Nothing was
  // sent; the client never switches to another entry on its own (m2 D11).
  "ENTRY_UNAVAILABLE",
  // The operation ID is known but its full record was cleared after the retention period
  // (m2 D13). The request is never executed again under this ID.
  "OPERATION_HISTORY_EXPIRED",
  // The server's tsnet node (m2 D10, T5b), appended likewise. A login of the node was refused
  // and changed nothing: the control plane rejected the key, the login timed out before a node
  // without state was enrolled (its partial state is removed), or the node is already logged in.
  "TSNET_LOGIN_FAILED",
  // A login of the enrolled node ended as another node. That node is stopped and serves nothing
  // until a logout; paired clients pin the enrolled node's stable ID and must pair again.
  "TSNET_IDENTITY_CHANGED",
  // A login of the enrolled node did not finish and may still have completed. The node serves
  // nothing until `server.tsnet.status` confirms its identity.
  "TSNET_LOGIN_UNCERTAIN",
  // Programmatic input never acquires or overrides a human controller.
  "CONTROL_HELD",
] as const;
export type DomainErrorKind = (typeof DOMAIN_ERROR_KINDS)[number];

export const ERROR_CODES = Object.freeze(
  Object.fromEntries(DOMAIN_ERROR_KINDS.map((kind, index) => [kind, 1000 + index])) as Record<
    DomainErrorKind,
    number
  >,
);

export const AcceptanceSchema = z.enum(["not-accepted", "accepted", "unknown"]);
export const NextActionSchema = z.enum([
  "none",
  "reauthenticate",
  "renegotiate",
  "refresh-control",
  "new-subscription",
  "query-operation",
  "inspect-run",
  "refresh-resource",
  "fix-request",
]);
// Live runs that block a binding change or a worktree deletion (D10). Only references are
// carried: paths, commands and terminal content never enter error data.
export const DomainErrorDetailsSchema = z.object({
  runs: z.array(RunRefSchema).min(1).max(128),
});
export type DomainErrorDetails = z.infer<typeof DomainErrorDetailsSchema>;
const kindsWithDetails: ReadonlySet<string> = new Set(["LIVE_RUNS_PRESENT"]);
const DomainErrorFieldsSchema = z.object({
  kind: z.enum(DOMAIN_ERROR_KINDS),
  code: z
    .number()
    .int()
    .min(1000)
    .max(1000 + DOMAIN_ERROR_KINDS.length - 1),
  message: z.string().max(256),
  acceptance: AcceptanceSchema,
  nextAction: NextActionSchema,
  subject: z.literal("input").optional(),
  details: DomainErrorDetailsSchema.optional(),
});

const actions: Record<DomainErrorKind, z.infer<typeof NextActionSchema>> = {
  UNAUTHENTICATED: "reauthenticate",
  FORBIDDEN: "none",
  BOOTSTRAP_UNSUPPORTED: "renegotiate",
  PROTOCOL_MISMATCH: "renegotiate",
  INSTANCE_MISMATCH: "inspect-run",
  CAPABILITY_UNAVAILABLE: "renegotiate",
  PROFILE_UNSUPPORTED: "renegotiate",
  RUN_NOT_FOUND: "inspect-run",
  STALE_CONNECTION: "new-subscription",
  STALE_CONTROL: "refresh-control",
  INVALID_SIZE: "none",
  RESYNC_REQUIRED: "new-subscription",
  RECOVERY_EXPIRED: "new-subscription",
  RECOVERY_UNAVAILABLE: "inspect-run",
  BUSY: "none",
  OPERATION_ID_CONFLICT: "query-operation",
  OPERATION_NOT_FOUND: "query-operation",
  INPUT_REJECTED: "refresh-control",
  RESULT_UNKNOWN: "query-operation",
  WORKER_UNAVAILABLE: "inspect-run",
  COUNTER_EXHAUSTED: "new-subscription",
  INVALID_ARGUMENT: "fix-request",
  REVISION_CONFLICT: "refresh-resource",
  REPO_NOT_FOUND: "refresh-resource",
  TASK_NOT_FOUND: "refresh-resource",
  MOUNT_NOT_FOUND: "refresh-resource",
  TAB_NOT_FOUND: "refresh-resource",
  NOT_A_GIT_REPOSITORY: "fix-request",
  BARE_REPOSITORY: "fix-request",
  REPO_ALREADY_REGISTERED: "refresh-resource",
  MANAGED_WORKTREE_NOT_MOUNTABLE: "fix-request",
  MOUNT_NAME_CONFLICT: "fix-request",
  TASK_ARCHIVED: "refresh-resource",
  BRANCH_EXISTS: "fix-request",
  // The fix is usually an explicit --no-fetch, which the CLI states; Cove never drops the
  // fetch on its own (D1).
  FETCH_FAILED: "fix-request",
  MAIN_BRANCH_UNRESOLVED: "fix-request",
  LIVE_RUNS_PRESENT: "inspect-run",
  OPERATION_NOT_RESUMABLE: "query-operation",
  OPERATION_EFFECTS_ACTIVE: "query-operation",
  // Not retried automatically: the cause (a missing git, a hung credential helper, a huge repo)
  // is on the host, and the operator decides whether to fix it and send the request again.
  GIT_UNAVAILABLE: "none",
  // The operator removes the mounts that reference the repo (`cove mount remove`) and asks again.
  REPO_IN_USE: "fix-request",
  // The cause is on the host (permissions, a file in the way); the operator fixes it and retries.
  WORKSPACE_ENTRY_UNAVAILABLE: "none",
  // Pair again with a new invitation; repeating the request with the revoked token never helps.
  DEVICE_REVOKED: "reauthenticate",
  // A new invitation is the only recovery (m2 D6).
  INVITATION_UNAVAILABLE: "none",
  INVITATION_NOT_FOUND: "refresh-resource",
  DEVICE_NOT_FOUND: "refresh-resource",
  // The operator checks the entry or the client record; nothing is retried automatically.
  SERVER_ID_MISMATCH: "none",
  PEER_IDENTITY_MISMATCH: "none",
  ENTRY_UNAVAILABLE: "none",
  // Inspect the resources the operation affected; the same ID is never executed again.
  OPERATION_HISTORY_EXPIRED: "refresh-resource",
  // Another key, or log out first; the status says which (server.tsnet.status).
  TSNET_LOGIN_FAILED: "fix-request",
  // Log out, log in with the intended key, pair the clients again: the operator's decision.
  TSNET_IDENTITY_CHANGED: "none",
  // server.tsnet.status settles the hold; nothing is repeated on its own.
  TSNET_LOGIN_UNCERTAIN: "none",
  CONTROL_HELD: "refresh-control",
};

export const DomainErrorSchema = DomainErrorFieldsSchema.refine(
  (value) =>
    value.code === ERROR_CODES[value.kind] &&
    value.message === value.kind.replaceAll("_", " ") &&
    (value.subject === undefined ||
      (value.kind === "RESULT_UNKNOWN" && value.acceptance === "unknown")) &&
    value.nextAction === (value.subject === "input" ? "inspect-run" : actions[value.kind]) &&
    (value.details === undefined || kindsWithDetails.has(value.kind)),
);
export type DomainError = z.infer<typeof DomainErrorSchema>;

// Fixed messages do not interpolate user paths, VT, credentials or command bytes.
export function domainError(
  kind: DomainErrorKind,
  acceptance: z.infer<typeof AcceptanceSchema> = "not-accepted",
  subject?: "input",
  details?: DomainErrorDetails,
): DomainError {
  if (subject && (kind !== "RESULT_UNKNOWN" || acceptance !== "unknown"))
    throw new Error("Input subject requires unknown result");
  // Parsing also detaches the details from the caller's objects.
  const parsed = details === undefined ? undefined : DomainErrorDetailsSchema.safeParse(details);
  if (parsed && (!kindsWithDetails.has(kind) || !parsed.success))
    throw new Error("Error details are not allowed for this kind");
  return {
    kind,
    code: ERROR_CODES[kind],
    message: kind.replaceAll("_", " "),
    acceptance,
    nextAction: subject === "input" ? "inspect-run" : actions[kind],
    ...(subject ? { subject } : {}),
    ...(parsed?.success ? { details: parsed.data } : {}),
  };
}

export const WS_CLOSE_CODES = Object.freeze({
  protocol: 1002,
  policy: 1008,
  size: 1009,
  capacity: 1013,
});

export function closeCodeForError(kind: DomainErrorKind): number {
  if (kind === "UNAUTHENTICATED" || kind === "FORBIDDEN" || kind === "DEVICE_REVOKED")
    return WS_CLOSE_CODES.policy;
  if (kind === "BUSY" || kind === "WORKER_UNAVAILABLE") return WS_CLOSE_CODES.capacity;
  return WS_CLOSE_CODES.protocol;
}
