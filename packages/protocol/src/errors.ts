import { z } from "zod";

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
]);
const DomainErrorFieldsSchema = z.object({
  kind: z.enum(DOMAIN_ERROR_KINDS),
  code: z.number().int().min(1000).max(1020),
  message: z.string().max(256),
  acceptance: AcceptanceSchema,
  nextAction: NextActionSchema,
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
};

export const DomainErrorSchema = DomainErrorFieldsSchema.refine(
  (value) =>
    value.code === ERROR_CODES[value.kind] &&
    value.message === value.kind.replaceAll("_", " ") &&
    value.nextAction === actions[value.kind],
);
export type DomainError = z.infer<typeof DomainErrorSchema>;

// Fixed messages do not interpolate user paths, VT, credentials or command bytes.
export function domainError(
  kind: DomainErrorKind,
  acceptance: z.infer<typeof AcceptanceSchema> = "not-accepted",
): DomainError {
  return {
    kind,
    code: ERROR_CODES[kind],
    message: kind.replaceAll("_", " "),
    acceptance,
    nextAction: actions[kind],
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
