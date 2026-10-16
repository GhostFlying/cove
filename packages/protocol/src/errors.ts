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
  if (kind === "UNAUTHENTICATED" || kind === "FORBIDDEN") return WS_CLOSE_CODES.policy;
  if (kind === "BUSY" || kind === "WORKER_UNAVAILABLE") return WS_CLOSE_CODES.capacity;
  return WS_CLOSE_CODES.protocol;
}
