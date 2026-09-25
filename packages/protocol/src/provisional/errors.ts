import { z } from "zod";

export const ProbeErrorSchema = z.object({
  kind: z.enum(["INVALID_ARGUMENT", "IDENTITY_MISMATCH", "PROBE_FAILED"]),
  message: z.string().max(256),
});
export type ProbeError = z.infer<typeof ProbeErrorSchema>;

export type ProtocolFailureCode =
  | "INVALID_HEADER"
  | "INVALID_METADATA"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_KIND"
  | "CAPACITY_EXCEEDED"
  | "IDENTITY_MISMATCH"
  | "TRUNCATED_FRAME"
  | "DECODER_CLOSED";

export type ProtocolFailure = { code: ProtocolFailureCode; offset: number };
export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: ProtocolFailure };

export function failure(code: ProtocolFailureCode, offset = 0): ProtocolResult<never> {
  return { ok: false, error: { code, offset } };
}
