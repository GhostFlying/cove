import { z } from "zod";
import { M0_LIMITS } from "./budgets.js";
import { BuildVersionSchema, DeviceIdSchema, DeviceTokenSchema } from "./bootstrap.js";
import { OpaqueIdSchema, RunRefSchema, SequenceSchema } from "./identity.js";
import { ResourceIdSchema, TimestampMsSchema } from "./workspace.js";

// M2 contract (docs/milestones/m2.md): device authorization, network entries, the service and the
// server's tsnet node. Like the M1 contract it is pre-release: no protocol version bump (D12).
//
// Secrets. A method that takes or returns a secret declares it in the method table
// (rpc-methods.ts, `secrets`) and carries it in one member named `secrets`: `params.secrets` for
// input, `result.secrets` for output. Nothing else in a request or result may hold a secret.
// The dispatch layer, the receipt fingerprint, operation records and CLI pending files all drop
// that one member (m2 "秘密与操作记录的分界"), so a secret cannot leak into them by being given an
// ordinary field name.

export const AUTH_LIMITS = Object.freeze({
  // Invitation lifetime (D6): default 10 minutes, at most 24 hours.
  invitationDefaultTtlMs: 10 * 60_000,
  invitationMinTtlMs: 60_000,
  invitationMaxTtlMs: 24 * 60 * 60_000,
  // Wrong secrets after which an open invitation is cancelled (D6).
  invitationWrongSecrets: 5,
  // Rows one list answer may carry. Older terminal invitations are not listed.
  listedInvitations: 64,
  listedDevices: 256,
  deviceNameChars: 64,
  invitationChars: 2048,
});

export const InviteIdSchema = DeviceIdSchema;
// A device name is shown in lists only; it is never a path, argument or identity.
export const DeviceNameSchema = z
  .string()
  .min(1)
  .max(AUTH_LIMITS.deviceNameChars)
  .refine((value) => ![...value].some((char) => char < " " || char === "\u007f"));
// The kind of entry a request arrived through (D3, D9). Recorded for display and audit only.
export const EntryKindSchema = z.enum(["loopback", "ssh", "tsnet"]);

// Tailscale data is third-party input (m2 threat model): bounded and character-restricted
// before Cove keeps or shows it. The stable node ID is what clients verify (never the name).
// Letters and digits only, as real stable IDs (`n…CNTRL`) are and as `cove-tsnet dial` accepts
// for a dial target (native/tailscale/PROTOCOL.md bounds): an ID this schema admitted but the
// dial socket refused would pair a client that could never connect.
export const TsnetNodeIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/);
export const TsnetNodeNameSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
// The tsnet node's hostname request: one DNS label (D10; default `cove-<host name>`).
export const TsnetHostnameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
// An auth key reaches the server only in params.secrets and goes to `cove-tsnet` on its stdin
// (D10). Printable ASCII without spaces; the content is Tailscale's (real keys are far longer
// than the minimum, which also keeps the dispatch leak check free of false matches).
export const TsnetAuthKeySchema = z.string().regex(/^[\x21-\x7e]{16,512}$/);

// The SSH target a server advertises in its invitations: `[user@]host` or an ssh_config alias.
// A redeeming client passes it to `ssh` as an argument, so it must never start with `-`
// (it would be read as an option) and holds no whitespace or shell syntax.
export const SshTargetSchema = z
  .string()
  .max(255)
  .regex(/^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/);
// User-level services bind unprivileged loopback ports only (D3).
export const PortSchema = z.number().int().min(1024).max(65535);

// ---------------------------------------------------------------------------------------------
// Invitations and devices (D4–D8)

export const InvitationSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// `cove-invite:v1:<base64url of the JSON payload>` (D6). The CLI reads it from a prompt or stdin
// only, never from argv.
export const InvitationStringSchema = z
  .string()
  .max(AUTH_LIMITS.invitationChars)
  .regex(/^cove-invite:v1:[A-Za-z0-9_-]+$/);
// The decoded payload. Everything but the secret tells the redeeming client where to go and
// whom to expect: it verifies the channel peer (SSH host key, or the tsnet node's stable ID) and
// the serverId before it submits the secret. Empty entries explicitly mean same-host loopback
// pairing only; creating a local device must not require advertising a remote entry.
export const InvitationPayloadSchema = z.object({
  serverId: OpaqueIdSchema,
  inviteId: InviteIdSchema,
  secret: InvitationSecretSchema,
  expiresAtMs: TimestampMsSchema,
  pairingPort: PortSchema,
  entries: z.object({
    ssh: z.object({ target: SshTargetSchema }).optional(),
    tsnet: z.object({ nodeId: TsnetNodeIdSchema, name: TsnetNodeNameSchema }).optional(),
  }),
});
export type InvitationPayload = z.infer<typeof InvitationPayloadSchema>;

export const InvitationStateSchema = z.enum(["open", "redeemed", "cancelled", "expired"]);
export const InvitationRecordSchema = z.object({
  inviteId: InviteIdSchema,
  state: InvitationStateSchema,
  createdAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
  // null: created by the local owner.
  createdByDeviceId: DeviceIdSchema.nullable(),
  // The device the redemption created.
  redeemedDeviceId: DeviceIdSchema.nullable(),
});
export type InvitationRecord = z.infer<typeof InvitationRecordSchema>;

export const DeviceRecordSchema = z
  .object({
    deviceId: DeviceIdSchema,
    revision: SequenceSchema,
    name: DeviceNameSchema,
    createdAtMs: TimestampMsSchema,
    // The invitation it was paired with.
    inviteId: InviteIdSchema,
    // Last successful authentication; null for a device that never connected (D6: left by a lost
    // redemption response, revocable like any other).
    lastUsedAtMs: TimestampMsSchema.nullable(),
    lastEntry: EntryKindSchema.nullable(),
    neverConnected: z.boolean(),
    revokedAtMs: TimestampMsSchema.nullable(),
  })
  .refine((value) => value.neverConnected === (value.lastUsedAtMs === null));
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

const NoParamsSchema = z.object({});

export const AuthInviteCreateParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  // Omitted: AUTH_LIMITS.invitationDefaultTtlMs, resolved by the server.
  ttlMs: z
    .number()
    .int()
    .min(AUTH_LIMITS.invitationMinTtlMs)
    .max(AUTH_LIMITS.invitationMaxTtlMs)
    .optional(),
});
export const AuthInviteCreateSecretsSchema = z.object({ invitation: InvitationStringSchema });
export const AuthInviteListParamsSchema = NoParamsSchema;
export const AuthInviteListResultSchema = z.object({
  invitations: z.array(InvitationRecordSchema).max(AUTH_LIMITS.listedInvitations),
});
export const AuthInviteCancelParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  inviteId: InviteIdSchema,
});
export const AuthDeviceListParamsSchema = z.object({ includeRevoked: z.boolean().optional() });
export const AuthDeviceListResultSchema = z.object({
  devices: z.array(DeviceRecordSchema).max(AUTH_LIMITS.listedDevices),
  // The calling device; null when the caller is the local owner.
  currentDeviceId: DeviceIdSchema.nullable(),
});
export const AuthDeviceRenameParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  deviceId: DeviceIdSchema,
  name: DeviceNameSchema,
  expectedRevision: SequenceSchema.optional(),
});
export const AuthDeviceRevokeParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  deviceId: DeviceIdSchema,
});
// Rotates the calling device's own token (D4): a new token is useless to anyone but the device
// that receives it. The local owner has no token to rotate (FORBIDDEN).
export const AuthDeviceRotateParamsSchema = z.object({ operationId: OpaqueIdSchema });
export const AuthDeviceRotateSecretsSchema = z.object({ token: DeviceTokenSchema });

// ---------------------------------------------------------------------------------------------
// Entry configuration (D3, D10). Ports apply when the server next starts; the SSH target applies
// to invitations created afterwards. null means "not configured": a server without a fixed
// business port picks a free one at each start (M1 behavior), no SSH target is advertised, and
// the tsnet hostname defaults to `cove-<host name>`.

export const EntrySettingsSchema = z.object({
  businessPort: PortSchema.nullable(),
  pairingPort: PortSchema.nullable(),
  sshTarget: SshTargetSchema.nullable(),
  tsnetHostname: TsnetHostnameSchema.nullable(),
});
export type EntrySettings = z.infer<typeof EntrySettingsSchema>;
export const EntryRecordSchema = z.object({
  revision: SequenceSchema,
  settings: EntrySettingsSchema,
  // A stored port or hostname differs from what the running server listens with.
  restartRequired: z.boolean(),
});
export const EntryGetParamsSchema = NoParamsSchema;
export const EntryGetResultSchema = z.object({ entry: EntryRecordSchema });
const entryFields = ["businessPort", "pairingPort", "sshTarget", "tsnetHostname"] as const;
export const EntrySetParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  expectedRevision: SequenceSchema.optional(),
  // Field-level patch; null clears a field.
  patch: EntrySettingsSchema.partial().refine((patch) =>
    entryFields.some((key) => patch[key] !== undefined),
  ),
});

// ---------------------------------------------------------------------------------------------
// Service status and restart impact (D2, S1, S2)

export const ServiceManagerSchema = z.enum(["systemd-user", "launchd-agent", "foreground"]);
export const ServiceStatusSchema = z.object({
  manager: ServiceManagerSchema,
  // The build `install/current` names; null when nothing is installed (foreground from a
  // checkout).
  installedBuild: BuildVersionSchema.nullable(),
  // An installed build that is not the running one: it takes effect only on an explicit restart.
  pendingBuild: BuildVersionSchema.nullable(),
  lastStart: z.enum(["manual", "crash-restart", "boot", "login", "unknown"]),
  // Linux systemd only: whether lingering is enabled for the user; null elsewhere.
  linger: z.boolean().nullable(),
});
// What stopping the service ends, by platform (D2). Tokens, not prose: the CLI words them.
// - live-runs-end: every live run ends and is recorded interrupted; none is re-run.
// - cgroup-processes-end: Linux systemd stops the whole cgroup, including processes detached in a
//   Cove terminal with nohup or tmux.
// - detached-processes-launchd: macOS; whether detached processes survive is launchd's decision.
// - logout-stops-server: macOS LaunchAgent; logging out also stops the server and every run.
export const ImpactConsequenceSchema = z.enum([
  "live-runs-end",
  "cgroup-processes-end",
  "detached-processes-launchd",
  "logout-stops-server",
]);
export const ServerImpactParamsSchema = NoParamsSchema;
export const ServerImpactResultSchema = z.object({
  platform: z.enum(["linux", "darwin"]),
  manager: ServiceManagerSchema,
  liveRuns: z
    .array(
      z.object({
        run: RunRefSchema,
        taskId: ResourceIdSchema.nullable(),
        tabId: ResourceIdSchema.nullable(),
      }),
    )
    .max(M0_LIMITS.maxRuns),
  consequences: z.array(ImpactConsequenceSchema).max(ImpactConsequenceSchema.options.length),
});

// ---------------------------------------------------------------------------------------------
// The server's tsnet node (D10)

// Without an auth key the node starts an interactive login; its URL is returned once, as a
// secret, because whoever opens it decides which tailnet the server node joins.
export const TsnetLoginParamsSchema = z.object({
  operationId: OpaqueIdSchema,
  secrets: z.object({ authKey: TsnetAuthKeySchema }).optional(),
});
export const TsnetLoginSecretsSchema = z.object({
  loginUrl: z.string().regex(/^https:\/\/[\x21-\x7e]{8,2040}$/),
});
export const TsnetStatusParamsSchema = NoParamsSchema;
export const TSNET_LIMITS = Object.freeze({
  // Tailnet ports one status lists (the business and the pairing port in practice); the helper
  // accepts at most 16 (native/tailscale/PROTOCOL.md).
  ports: 16,
  warnings: 4,
  warningChars: 512,
});
// The node's identity hold (native/tailscale/PROTOCOL.md "Identity hold"): while its identity is
// not known to be the enrolled one the node serves nothing. identity-changed: a login ended as
// another node (nodeId is that node); only a logout ends it. login-uncertain: a login did not
// finish, or an interactive login is pending; a later status settles it.
export const TsnetHoldSchema = z.enum(["identity-changed", "login-uncertain"]);
// A warning is the helper's or the server's explanation, third-party text in part (control-plane
// errors): bounded, without control characters, and never holding an auth key or a login URL.
export const TsnetWarningSchema = z
  .string()
  .max(TSNET_LIMITS.warningChars)
  .refine((value) => ![...value].some((char) => char < " " || char === "\u007f"));
export const TsnetStatusResultSchema = z.object({
  // logged-out: no node state; stopped, starting, needs-login, running: the node's backend state;
  // failed: the node or its helper is not available (the first warning says why).
  state: z.enum(["logged-out", "stopped", "starting", "needs-login", "running", "failed"]),
  hostname: TsnetHostnameSchema.nullable(),
  // The node's stable ID and MagicDNS name once it is logged in.
  nodeId: TsnetNodeIdSchema.nullable(),
  nodeName: TsnetNodeNameSchema.nullable(),
  hold: TsnetHoldSchema.nullable(),
  // The tailnet ports the node listens on now: the business port, and the pairing port while an
  // invitation is open (D6). Empty while logged out or held.
  ports: z.array(z.number().int().min(1).max(65535)).max(TSNET_LIMITS.ports),
  warnings: z.array(TsnetWarningSchema).max(TSNET_LIMITS.warnings),
});
export const TsnetLogoutParamsSchema = z.object({ operationId: OpaqueIdSchema });

// ---------------------------------------------------------------------------------------------
// Operation result fields of the M2 writes. A record holds references only; a secret the write
// produced is in the live response's `secrets` alone, and the record says so with
// `secretDelivery`, so that `operation get` and a resend explain why it is absent.
export const M2_RESULT_FIELDS = {
  inviteId: InviteIdSchema.optional(),
  deviceId: DeviceIdSchema.optional(),
  expiresAtMs: TimestampMsSchema.optional(),
  secretDelivery: z.literal("first-response-only").optional(),
  // Revocation (D8): connections of the device still open when the bounded wait ended.
  unclosedConnections: z.number().int().min(0).max(65_536).optional(),
  // entry.set: some changed setting takes effect only when the server next starts.
  appliesAfterRestart: z.literal(true).optional(),
  // server.tsnet.logout: whether the control plane acknowledged the logout. false: the node state
  // was deleted locally, but the node may still be listed in the tailnet (remove it there).
  remoteLogoutConfirmed: z.boolean().optional(),
} as const;
export const M2_RESULT_KEYS = Object.keys(M2_RESULT_FIELDS) as (keyof typeof M2_RESULT_FIELDS)[];

// ---------------------------------------------------------------------------------------------
// Invitation strings and pairing redemption (D6). Added by m2 T1, the protocol writer for this
// wave; additive to the T0 contract above.

// The invitation string of a payload, and the payload of a string. Decoding is bounded by the
// string schema (AUTH_LIMITS.invitationChars) and returns null for anything that is not a valid
// payload, so a pasted string is checked before any part of it is used. The secret is part of the
// payload: whatever holds a decoded payload holds the secret, and must keep it out of logs,
// errors and stored records. Every field of a valid payload is ASCII, so the JSON text is encoded
// as base64url of its characters directly (this module has no text codec).
const INVITATION_PREFIX = "cove-invite:v1:";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(ascii: string): string {
  let out = "";
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : 0;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : 0;
    const bits = (a << 16) | (b << 8) | c;
    out += BASE64URL[(bits >> 18) & 63]! + BASE64URL[(bits >> 12) & 63]!;
    if (i + 1 < ascii.length) out += BASE64URL[(bits >> 6) & 63]!;
    if (i + 2 < ascii.length) out += BASE64URL[bits & 63]!;
  }
  return out;
}

// The ASCII text of unpadded base64url, or null when it is not canonical base64url of ASCII.
function fromBase64url(encoded: string): string | null {
  if (encoded.length % 4 === 1) return null;
  let out = "";
  for (let i = 0; i < encoded.length; i += 4) {
    const chunk = encoded.slice(i, i + 4);
    const values = [...chunk].map((char) => BASE64URL.indexOf(char));
    if (values.some((value) => value < 0)) return null;
    const bits = values.reduce((sum, value, index) => sum | (value << (18 - 6 * index)), 0);
    const bytes = [(bits >> 16) & 255, (bits >> 8) & 255, bits & 255].slice(0, chunk.length - 1);
    if (bytes.some((byte) => byte > 127)) return null;
    out += String.fromCharCode(...bytes);
  }
  return base64url(out) === encoded ? out : null;
}

export function encodeInvitation(payload: InvitationPayload): string {
  const text = JSON.stringify(InvitationPayloadSchema.parse(payload));
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("An invitation payload is ASCII");
  return InvitationStringSchema.parse(`${INVITATION_PREFIX}${base64url(text)}`);
}
export function decodeInvitation(text: unknown): InvitationPayload | null {
  const string = InvitationStringSchema.safeParse(text);
  if (!string.success) return null;
  const json = fromBase64url(string.data.slice(INVITATION_PREFIX.length));
  if (json === null) return null;
  try {
    const payload = InvitationPayloadSchema.safeParse(JSON.parse(json));
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}

// The pairing listener (D6) answers two requests, both POST with a JSON body:
// - PAIRING_PATHS.identity: a bootstrap request, answered with BootstrapIdentitySchema exactly as
//   the business port answers one without credentials, so the redeeming client can check the
//   invitation's serverId before it submits the secret.
// - PAIRING_PATHS.redeem: the redemption below. It is not an RPC and leaves no operation record:
//   the server redeems the invitation and creates the device in one transaction and answers once.
//   A lost answer is not retried; the user creates a new invitation, and the device it left is
//   listed never-connected (D6).
export const PAIRING_PATHS = Object.freeze({ identity: "/bootstrap", redeem: "/pair" });
// Both bodies are small; the listener refuses larger ones before parsing.
export const PAIRING_LIMITS = Object.freeze({ requestBytes: 4096, responseBytes: 4096 });

export const PairingRedeemRequestSchema = z.strictObject({
  type: z.literal("cove-pairing-redeem"),
  inviteId: InviteIdSchema,
  secret: InvitationSecretSchema,
  deviceName: DeviceNameSchema,
});
export type PairingRedeemRequest = z.infer<typeof PairingRedeemRequestSchema>;
// `token` is the device's long-lived credential (D4): this answer is its only delivery, and the
// client keeps it only in its 0600 credential file (D5). `businessPort` is the server's loopback
// business port, which the invitation does not carry (it names the pairing port only) and every
// entry forwards to (D3).
export const PairingRedeemResultSchema = z
  .strictObject({
    type: z.literal("cove-pairing-result"),
    serverId: OpaqueIdSchema,
    deviceId: DeviceIdSchema,
    token: DeviceTokenSchema,
    businessPort: PortSchema,
  })
  .refine((value) => value.token.startsWith(`cove_d1_${value.deviceId}.`));
export type PairingRedeemResult = z.infer<typeof PairingRedeemResultSchema>;
// A refusal says nothing about the invitation: INVITATION_UNAVAILABLE for an unknown, redeemed,
// cancelled or expired one and for a wrong secret alike. BUSY: an attempt or connection limit of
// the listener was reached and nothing was checked. INVALID_ARGUMENT: the request was malformed.
export const PairingFailureSchema = z.strictObject({
  type: z.literal("cove-pairing-error"),
  kind: z.enum(["INVITATION_UNAVAILABLE", "BUSY", "INVALID_ARGUMENT"]),
});
export type PairingFailure = z.infer<typeof PairingFailureSchema>;
