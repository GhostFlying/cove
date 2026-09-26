import { z } from "zod";
import { M0_LIMITS, EffectiveBudgetsSchema, validateEffectiveBudgets } from "./budgets.js";
import { ConnectionRefSchema, OpaqueIdSchema } from "./identity.js";
import { BASELINE_ENCODING, BaselineEncodingSchema, PROFILE, ProfileSchema } from "./profile.js";

export const BOOTSTRAP_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const LOCAL_PATHS = Object.freeze({
  bootstrap: "/bootstrap",
  rpc: "/rpc",
  terminal: "/terminal",
});
export const BUSINESS_HEADERS = Object.freeze([
  "Authorization",
  "Cove-Protocol",
  "Cove-Server-Id",
  "Cove-Instance-Id",
] as const);
export const M0_CAPABILITIES = Object.freeze([
  "terminal-framing-v1",
  "logical-grid-recovery-v1",
  "worker-pipe-v1",
  "terminal-preview-v1",
  "operation-receipts-v1",
] as const);
export const REQUIRED_CAPABILITIES = Object.freeze([
  "terminal-framing-v1",
  "logical-grid-recovery-v1",
] as const);

const build = z.string().min(1).max(128);
const capabilities = z.array(z.string().min(1).max(64)).max(M0_LIMITS.capabilityCount);
export const BootstrapRequestSchema = z.object({
  type: z.literal("cove-bootstrap"),
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  expectedServerId: OpaqueIdSchema.optional(),
  expectedRelayInstanceId: OpaqueIdSchema.optional(),
  protocolVersion: z.number().int().min(1).max(255),
  buildVersion: build,
  capabilities,
  profiles: z.array(z.string().min(1).max(64)).max(M0_LIMITS.capabilityCount),
  encodings: z.array(z.string().min(1).max(64)).max(M0_LIMITS.capabilityCount),
});
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export const WsBootstrapSchema = BootstrapRequestSchema.extend({
  secret: z
    .string()
    .min(43)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export function validateWsFirstMessage(
  input: unknown,
  byteCount: number,
  elapsedMs: number,
  authenticated: boolean,
): BootstrapRequest | null {
  if (
    !Number.isSafeInteger(byteCount) ||
    byteCount < 1 ||
    byteCount > M0_LIMITS.bootstrapBytes ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > 5000 ||
    !authenticated
  )
    return null;
  const parsed = WsBootstrapSchema.safeParse(input);
  if (!parsed.success) return null;
  const { secret: _secret, ...request } = parsed.data;
  return request;
}
export const BootstrapSuccessSchema = z.object({
  type: z.literal("cove-bootstrap-result"),
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION),
  buildVersion: build,
  capabilities,
  profile: ProfileSchema,
  encoding: BaselineEncodingSchema,
  effectiveBudgets: EffectiveBudgetsSchema,
  connection: ConnectionRefSchema.optional(),
});
export type BootstrapSuccess = z.infer<typeof BootstrapSuccessSchema>;
export const BootstrapFailureSchema = z.object({
  type: z.literal("cove-bootstrap-error"),
  kind: z.enum([
    "BOOTSTRAP_UNSUPPORTED",
    "PROTOCOL_MISMATCH",
    "INSTANCE_MISMATCH",
    "CAPABILITY_UNAVAILABLE",
    "PROFILE_UNSUPPORTED",
    "INVALID_SIZE",
  ]),
  message: z.string().min(1).max(256),
  supportedVersions: z.object({
    bootstrap: z.array(z.number().int()).max(4),
    protocol: z.array(z.number().int()).max(4),
  }),
});
export type BootstrapFailure = z.infer<typeof BootstrapFailureSchema>;

const failure = (kind: BootstrapFailure["kind"]): BootstrapFailure => ({
  type: "cove-bootstrap-error",
  kind,
  message: kind.replaceAll("_", " "),
  supportedVersions: { bootstrap: [BOOTSTRAP_VERSION], protocol: [PROTOCOL_VERSION] },
});

export function negotiateBootstrap(
  request: unknown,
  server: {
    serverId: string;
    relayInstanceId: string;
    buildVersion: string;
    effectiveBudgets: unknown;
  },
  connection?: z.infer<typeof ConnectionRefSchema>,
): BootstrapSuccess | BootstrapFailure {
  const parsed = BootstrapRequestSchema.safeParse(request);
  if (!parsed.success) return failure("BOOTSTRAP_UNSUPPORTED");
  const input = parsed.data;
  if (input.protocolVersion !== PROTOCOL_VERSION) return failure("PROTOCOL_MISMATCH");
  if (
    (input.expectedServerId && input.expectedServerId !== server.serverId) ||
    (input.expectedRelayInstanceId && input.expectedRelayInstanceId !== server.relayInstanceId)
  )
    return failure("INSTANCE_MISMATCH");
  const budgets = validateEffectiveBudgets(server.effectiveBudgets);
  if (
    !budgets ||
    !OpaqueIdSchema.safeParse(server.serverId).success ||
    !OpaqueIdSchema.safeParse(server.relayInstanceId).success ||
    !build.safeParse(server.buildVersion).success ||
    (connection && !ConnectionRefSchema.safeParse(connection).success)
  )
    return failure("BOOTSTRAP_UNSUPPORTED");
  if (REQUIRED_CAPABILITIES.some((capability) => !input.capabilities.includes(capability)))
    return failure("CAPABILITY_UNAVAILABLE");
  if (!input.profiles.includes(PROFILE) || !input.encodings.includes(BASELINE_ENCODING))
    return failure("PROFILE_UNSUPPORTED");
  return {
    type: "cove-bootstrap-result",
    bootstrapVersion: BOOTSTRAP_VERSION,
    serverId: server.serverId,
    relayInstanceId: server.relayInstanceId,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: server.buildVersion,
    capabilities: M0_CAPABILITIES.filter((capability) => input.capabilities.includes(capability)),
    profile: PROFILE,
    encoding: BASELINE_ENCODING,
    effectiveBudgets: budgets,
    ...(connection ? { connection } : {}),
  };
}

export const RendezvousSchema = z.object({
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  endpoint: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/),
  secret: WsBootstrapSchema.shape.secret,
});

export type AdmissionKind =
  | "accepted"
  | "malformed"
  | "unauthenticated"
  | "forbidden"
  | "mismatch"
  | "too-large"
  | "busy"
  | "unavailable";
export const ADMISSION_STATUS: Record<AdmissionKind, number> = Object.freeze({
  accepted: 200,
  malformed: 400,
  unauthenticated: 401,
  forbidden: 403,
  mismatch: 409,
  "too-large": 413,
  busy: 429,
  unavailable: 503,
});
export type AdmissionRequest = {
  method: "POST" | "OPTIONS";
  path: string;
  host: string;
  boundAuthority: string;
  origin?: string;
  allowedOrigins: readonly string[];
  browser: boolean;
  authenticated: boolean;
  requestedMethod?: string;
  requestedHeaders?: readonly string[];
  bodyBytes: number;
  expectedServerId?: string;
  expectedRelayInstanceId?: string;
  expectedProtocol?: number;
  serverId: string;
  relayInstanceId: string;
  capacityAvailable: boolean;
};

// Transport verifies the secret; this predicate only consumes its authenticated verdict.
export function evaluateAdmission(input: AdmissionRequest): AdmissionKind {
  if (
    !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(input.boundAuthority) ||
    input.host !== input.boundAuthority
  )
    return "forbidden";
  if (
    input.origin !== undefined &&
    (input.origin === "null" || !input.allowedOrigins.includes(input.origin))
  )
    return "forbidden";
  if (input.browser && input.origin === undefined) return "forbidden";
  if (input.method === "OPTIONS") {
    const allowed = new Set([
      "authorization",
      "content-type",
      "cove-protocol",
      "cove-server-id",
      "cove-instance-id",
    ]);
    return (input.path === LOCAL_PATHS.bootstrap || input.path === LOCAL_PATHS.rpc) &&
      input.requestedMethod === "POST" &&
      (input.requestedHeaders ?? []).every((header) => allowed.has(header.toLowerCase()))
      ? "accepted"
      : "forbidden";
  }
  if (!input.authenticated) return "unauthenticated";
  if (!input.capacityAvailable) return "busy";
  const cap = input.path === LOCAL_PATHS.rpc ? M0_LIMITS.rpcRequestBytes : M0_LIMITS.bootstrapBytes;
  if (!Number.isSafeInteger(input.bodyBytes) || input.bodyBytes < 0 || input.bodyBytes > cap)
    return "too-large";
  if (
    input.path === LOCAL_PATHS.rpc &&
    (input.expectedProtocol === undefined ||
      input.expectedServerId === undefined ||
      input.expectedRelayInstanceId === undefined)
  )
    return "malformed";
  if (
    (input.expectedProtocol !== undefined && input.expectedProtocol !== PROTOCOL_VERSION) ||
    (input.expectedServerId !== undefined && input.expectedServerId !== input.serverId) ||
    (input.expectedRelayInstanceId !== undefined &&
      input.expectedRelayInstanceId !== input.relayInstanceId)
  )
    return "mismatch";
  if (
    input.method === "POST" &&
    (input.path === LOCAL_PATHS.bootstrap || input.path === LOCAL_PATHS.rpc)
  )
    return "accepted";
  return "malformed";
}

export function evaluateWsUpgrade(input: {
  path: string;
  host: string;
  boundAuthority: string;
  origin?: string;
  allowedOrigins: readonly string[];
  capacityAvailable: boolean;
}): AdmissionKind {
  if (
    input.path !== LOCAL_PATHS.terminal ||
    !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(input.boundAuthority) ||
    input.host !== input.boundAuthority ||
    input.origin === undefined ||
    input.origin === "null" ||
    !input.allowedOrigins.includes(input.origin)
  )
    return "forbidden";
  return input.capacityAvailable ? "accepted" : "busy";
}
