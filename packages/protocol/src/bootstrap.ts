import { z } from "zod";
import { M0_LIMITS, EffectiveBudgetsSchema, validateEffectiveBudgets } from "./budgets.js";
import { ConnectionRefSchema, OpaqueIdSchema } from "./identity.js";
import { BASELINE_ENCODING, BaselineEncodingSchema, PROFILE, ProfileSchema } from "./profile.js";

export const BOOTSTRAP_VERSION = 1;
export const PROTOCOL_VERSION = 2;
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
  "terminal-framing-v2",
  "logical-grid-recovery-v1",
  "worker-pipe-v2",
  "terminal-preview-v1",
  "operation-receipts-v1",
] as const);
export const REQUIRED_CAPABILITIES = Object.freeze([
  "terminal-framing-v2",
  "logical-grid-recovery-v1",
] as const);

const build = z.string().min(1).max(128);
export const BuildVersionSchema = build;

// Build identity (m2 D1, D12). A Cove build is named `<packageVersion>+<digest>`: the root
// package version and the first 16 hex digits of a SHA-256 over the build's own compiled files
// (apps/server/src/build-id.ts computes it). Content addressing, not the Git commit, because two
// builds of one dirty checkout must not share an install directory, and an unchanged rebuild
// keeps its name. The version part is informational: equality of the whole string is the only
// comparison clients make, and a mismatch is a warning, never a refusal (D12). Other build
// strings (a test peer's "author", the worker pipe's internal "0.0.0") stay valid on the wire:
// the schema above bounds them, and this pattern only recognizes a real build.
export const BUILD_ID_DIGEST_HEX = 16;
const BUILD_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,63}\+[0-9a-f]{16}$/;
export function formatBuildId(packageVersion: string, digestHex: string): string {
  const id = `${packageVersion}+${digestHex.slice(0, BUILD_ID_DIGEST_HEX)}`;
  if (!/^[0-9a-f]+$/.test(digestHex) || !BUILD_ID_PATTERN.test(id))
    throw new Error("Invalid build identity");
  return id;
}
export function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}

// The two credential kinds (m2 D4, D7), carried the same way on every channel: as
// `Authorization: Bearer <credential>` on HTTP and as the `secret` of the terminal WebSocket's
// first frame. Their alphabets are disjoint (only a device token contains "."), so a server tells
// them apart without a separate kind field.
//
// - Local owner secret: the per-start secret the server writes into its 0600 rendezvous file in
//   the data directory. Whoever can read it is the same OS user, the irrevocable local owner.
// - Device token: `cove_d1_<deviceId>.<secret>`, issued once at pairing or rotation. The server
//   looks the device up by deviceId and compares a SHA-256 of the 256-bit secret in constant
//   time; it stores only that hash.
export const LocalSecretSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
// A device ID is chosen by the server; it never contains ".", which ends it inside a token.
export const DeviceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/);
export const DEVICE_TOKEN_PREFIX = "cove_d1_";
const DEVICE_TOKEN_PATTERN = /^cove_d1_([A-Za-z0-9][A-Za-z0-9_-]{0,39})\.([A-Za-z0-9_-]{43})$/;
export const DeviceTokenSchema = z.string().regex(DEVICE_TOKEN_PATTERN);
export const CredentialSchema = z.union([LocalSecretSchema, DeviceTokenSchema]);
export type Credential =
  | { kind: "local-secret"; secret: string }
  | { kind: "device-token"; deviceId: string; secret: string };

// Classifies a presented credential string. Null for anything malformed; a well-formed
// credential still has to be verified by the server.
export function parseCredential(value: unknown): Credential | null {
  if (typeof value !== "string") return null;
  const device = DEVICE_TOKEN_PATTERN.exec(value);
  if (device) return { kind: "device-token", deviceId: device[1]!, secret: device[2]! };
  return LocalSecretSchema.safeParse(value).success
    ? { kind: "local-secret", secret: value }
    : null;
}

export function formatDeviceToken(deviceId: string, secret: string): string {
  const token = `${DEVICE_TOKEN_PREFIX}${deviceId}.${secret}`;
  if (!DEVICE_TOKEN_PATTERN.test(token)) throw new Error("Invalid device token parts");
  return token;
}

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
// The field keeps its M0 name `secret`; it carries either credential kind.
export const WsBootstrapSchema = BootstrapRequestSchema.extend({ secret: CredentialSchema });

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
const BootstrapFailureFieldsSchema = z.object({
  type: z.literal("cove-bootstrap-error"),
  kind: z.enum([
    "BOOTSTRAP_UNSUPPORTED",
    "PROTOCOL_MISMATCH",
    "INSTANCE_MISMATCH",
    "CAPABILITY_UNAVAILABLE",
    "PROFILE_UNSUPPORTED",
    "INVALID_SIZE",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "BUSY",
    "UNAVAILABLE",
    // The correct token of a revoked device (m2 D8).
    "DEVICE_REVOKED",
  ]),
  message: z.string().min(1).max(256),
  supportedVersions: z.object({
    bootstrap: z.array(z.number().int()).max(4),
    protocol: z
      .array(z.number().int().min(1).max(255))
      .min(1)
      .max(4)
      .refine((versions) => new Set(versions).size === versions.length),
  }),
});
// A mismatch must be readable before peers share a business protocol version. Keep
// bootstrap itself exact, but validate the peer's bounded protocol set independently
// of the versions implemented by this process. Local failure generation below remains
// the authority for what this process truthfully advertises.
export const BootstrapFailureSchema = BootstrapFailureFieldsSchema.refine(
  (value) =>
    value.message === value.kind.replaceAll("_", " ") &&
    value.supportedVersions.bootstrap.length === 1 &&
    value.supportedVersions.bootstrap[0] === BOOTSTRAP_VERSION,
);
export type BootstrapFailure = z.infer<typeof BootstrapFailureSchema>;

export const bootstrapFailure = (kind: BootstrapFailure["kind"]): BootstrapFailure => ({
  type: "cove-bootstrap-error",
  kind,
  message: kind.replaceAll("_", " "),
  supportedVersions: { bootstrap: [BOOTSTRAP_VERSION], protocol: [PROTOCOL_VERSION] },
});
const failure = bootstrapFailure;

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

// Pre-authentication identity (m2 "认证前可达的面"). A POST /bootstrap without credentials is
// answered with this and nothing else, so that a client can check the serverId (and, from its
// channel, the peer) before it sends any token. It carries no task, path, device or terminal
// information and no capabilities or budgets; serverId identifies a server but proves nothing.
// The client compares serverId itself, so the answer does not depend on what the request
// expected. A request that is not a well-formed bootstrap request gets BOOTSTRAP_UNSUPPORTED.
// T1 serves it; T2 and the client call it before asking the credential provider.
export const BootstrapIdentitySchema = z.object({
  type: z.literal("cove-bootstrap-identity"),
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  protocolVersion: z.number().int().min(1).max(255),
  buildVersion: build,
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
});
export type BootstrapIdentity = z.infer<typeof BootstrapIdentitySchema>;

export function bootstrapIdentity(
  request: unknown,
  server: { serverId: string; relayInstanceId: string; buildVersion: string },
): BootstrapIdentity | BootstrapFailure {
  if (!BootstrapRequestSchema.safeParse(request).success) return failure("BOOTSTRAP_UNSUPPORTED");
  // Built field by field, so nothing else the server knows can reach an unauthenticated peer.
  const identity = BootstrapIdentitySchema.safeParse({
    type: "cove-bootstrap-identity",
    bootstrapVersion: BOOTSTRAP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: server.buildVersion,
    serverId: server.serverId,
    relayInstanceId: server.relayInstanceId,
  });
  return identity.success ? identity.data : failure("BOOTSTRAP_UNSUPPORTED");
}

export const RendezvousSchema = z.object({
  bootstrapVersion: z.literal(BOOTSTRAP_VERSION),
  serverId: OpaqueIdSchema,
  relayInstanceId: OpaqueIdSchema,
  endpoint: z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/),
  // The rendezvous holds the local owner secret, never a device token.
  secret: LocalSecretSchema,
});

export type AdmissionKind =
  | "accepted"
  | "malformed"
  | "unauthenticated"
  | "revoked"
  | "forbidden"
  | "mismatch"
  | "too-large"
  | "busy"
  | "unavailable";
export const ADMISSION_STATUS: Record<AdmissionKind, number> = Object.freeze({
  accepted: 200,
  malformed: 400,
  unauthenticated: 401,
  // The status of a failed authentication; the body (DEVICE_REVOKED) tells the device why.
  revoked: 401,
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

// The Host a loopback server accepts (user decision 2026-10-22): any loopback IP literal with a
// port in 1..65535, not only the server's own bound authority. The Host check is a pre-auth defense
// against DNS rebinding, and a rebinding request always carries a domain-name Host, never a literal
// loopback IP. The server cannot tell traffic forwarded by a local tunnel (an SSH -L forward
// arrives with the tunnel's local port in Host) from local traffic anyway; trust comes from the
// token or local secret every business request needs. `localhost` stays refused: rebinding cannot
// produce it, but browsers treat it differently from the literals, so it is not widened here.
export function isLoopbackLiteralHost(host: string): boolean {
  const match = /^(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(host);
  return match !== null && Number(match[1]) <= 65_535;
}

// Transport verifies the secret; this predicate only consumes its authenticated verdict.
export function evaluateAdmission(input: AdmissionRequest): AdmissionKind {
  if (
    !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(input.boundAuthority) ||
    !isLoopbackLiteralHost(input.host)
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

// Origin absence permits only unauthenticated CLI-compatible bootstrap; all peers still authenticate.
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
    !isLoopbackLiteralHost(input.host) ||
    (input.origin !== undefined &&
      (input.origin === "null" || !input.allowedOrigins.includes(input.origin)))
  )
    return "forbidden";
  return input.capacityAvailable ? "accepted" : "busy";
}
