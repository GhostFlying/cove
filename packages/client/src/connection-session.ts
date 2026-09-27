import {
  BOOTSTRAP_VERSION,
  BootstrapFailureSchema,
  BootstrapRequestSchema,
  BootstrapSuccessSchema,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  WsBootstrapSchema,
  type BootstrapFailure,
  type BootstrapRequest,
  type BootstrapSuccess,
} from "@cove/protocol/bootstrap";
import { M0_LIMITS, validateEffectiveBudgets, type EffectiveBudgets } from "@cove/protocol/budgets";
import type { ConnectionRef } from "@cove/protocol/identity";

export type NegotiationField =
  | "bootstrap-version"
  | "server"
  | "instance"
  | "protocol-version"
  | "server-build"
  | "capabilities"
  | "profile"
  | "encoding"
  | "effective-budgets"
  | "connection";

export interface FrozenOffer {
  readonly expectedServerId: string;
  readonly expectedRelayInstanceId: string;
  readonly buildVersion: string;
  readonly capabilities: readonly string[];
  readonly profiles: readonly string[];
  readonly encodings: readonly string[];
}

export interface NegotiatedConnection {
  readonly bootstrapVersion: number;
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly protocolVersion: number;
  readonly buildVersion: string;
  readonly capabilities: readonly string[];
  readonly profile: string;
  readonly encoding: string;
  readonly effectiveBudgets: Readonly<EffectiveBudgets>;
  readonly connection: Readonly<ConnectionRef>;
}

export type DecodedBootstrap =
  | { readonly kind: "success"; readonly value: BootstrapSuccess }
  | { readonly kind: "failure"; readonly value: BootstrapFailure }
  | { readonly kind: "invalid" };

export type CheckedBootstrap =
  | { readonly ok: true; readonly value: BootstrapSuccess }
  | { readonly ok: false; readonly field: NegotiationField | "remote-failure" };

export function createBootstrapRequest(offer: FrozenOffer): BootstrapRequest {
  return {
    type: "cove-bootstrap",
    bootstrapVersion: BOOTSTRAP_VERSION,
    expectedServerId: offer.expectedServerId,
    expectedRelayInstanceId: offer.expectedRelayInstanceId,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: offer.buildVersion,
    capabilities: [...offer.capabilities],
    profiles: [...offer.profiles],
    encodings: [...offer.encodings],
  };
}

export function validOffer(offer: FrozenOffer): boolean {
  return (
    BootstrapRequestSchema.safeParse(createBootstrapRequest(offer)).success &&
    new Set(offer.capabilities).size === offer.capabilities.length &&
    new Set(offer.profiles).size === offer.profiles.length &&
    new Set(offer.encodings).size === offer.encodings.length &&
    REQUIRED_CAPABILITIES.every((capability) => offer.capabilities.includes(capability))
  );
}

export function createTerminalBootstrap(
  request: BootstrapRequest,
  terminalSecret: string,
): Record<string, unknown> | null {
  const candidate = { ...request, secret: terminalSecret };
  return WsBootstrapSchema.safeParse(candidate).success ? candidate : null;
}

export function decodeBootstrap(
  bytes: Uint8Array,
  decodeFatal: (bytes: Uint8Array) => string,
): DecodedBootstrap {
  if (bytes.byteLength < 1 || bytes.byteLength > M0_LIMITS.bootstrapBytes)
    return { kind: "invalid" };
  try {
    // Copy the visible range so a hostile adapter cannot keep a large backing buffer
    // reachable through a small view while the decoder runs.
    const text = decodeFatal(new Uint8Array(bytes));
    const decoded: unknown = JSON.parse(text);
    const success = BootstrapSuccessSchema.safeParse(decoded);
    if (success.success) return { kind: "success", value: success.data };
    const failure = BootstrapFailureSchema.safeParse(decoded);
    return failure.success ? { kind: "failure", value: failure.data } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function checkBootstrap(
  decoded: DecodedBootstrap,
  channel: "http" | "terminal",
  offer: FrozenOffer,
): CheckedBootstrap {
  if (decoded.kind === "failure") return { ok: false, field: "remote-failure" };
  if (decoded.kind !== "success") return { ok: false, field: "bootstrap-version" };
  const value = decoded.value;
  if (value.serverId !== offer.expectedServerId) return { ok: false, field: "server" };
  if (value.relayInstanceId !== offer.expectedRelayInstanceId)
    return { ok: false, field: "instance" };
  if (value.protocolVersion !== PROTOCOL_VERSION) return { ok: false, field: "protocol-version" };
  if (channel === "http" ? value.connection !== undefined : value.connection === undefined)
    return { ok: false, field: "connection" };
  if (!offer.profiles.includes(value.profile)) return { ok: false, field: "profile" };
  if (!offer.encodings.includes(value.encoding)) return { ok: false, field: "encoding" };
  const selected = new Set(value.capabilities);
  if (value.capabilities.some((capability) => !offer.capabilities.includes(capability)))
    return { ok: false, field: "capabilities" };
  if (REQUIRED_CAPABILITIES.some((capability) => !selected.has(capability)))
    return { ok: false, field: "capabilities" };
  if (!validateEffectiveBudgets(value.effectiveBudgets))
    return { ok: false, field: "effective-budgets" };
  return { ok: true, value };
}

function sameCapabilitySet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size && [...leftSet].every((capability) => rightSet.has(capability))
  );
}

function firstBudgetDifference(
  left: EffectiveBudgets,
  right: EffectiveBudgets,
): NegotiationField | null {
  for (const key of Object.keys(M0_LIMITS) as (keyof EffectiveBudgets)[]) {
    if (left[key] !== right[key]) return "effective-budgets";
  }
  return null;
}

export function agreeBootstraps(
  http: BootstrapSuccess,
  terminal: BootstrapSuccess,
):
  | { readonly ok: true; readonly value: NegotiatedConnection }
  | { readonly ok: false; readonly field: NegotiationField } {
  const scalarFields: readonly [keyof BootstrapSuccess, NegotiationField][] = [
    ["bootstrapVersion", "bootstrap-version"],
    ["serverId", "server"],
    ["relayInstanceId", "instance"],
    ["protocolVersion", "protocol-version"],
    ["buildVersion", "server-build"],
    ["profile", "profile"],
    ["encoding", "encoding"],
  ];
  for (const [key, field] of scalarFields) {
    if (http[key] !== terminal[key]) return { ok: false, field };
  }
  if (!sameCapabilitySet(http.capabilities, terminal.capabilities))
    return { ok: false, field: "capabilities" };
  const budgetDifference = firstBudgetDifference(http.effectiveBudgets, terminal.effectiveBudgets);
  if (budgetDifference) return { ok: false, field: budgetDifference };
  if (http.connection !== undefined || terminal.connection === undefined)
    return { ok: false, field: "connection" };
  const capabilities = Object.freeze([...new Set(http.capabilities)].sort());
  const effectiveBudgets = Object.freeze({ ...http.effectiveBudgets });
  const connection = Object.freeze({ ...terminal.connection });
  return {
    ok: true,
    value: Object.freeze({
      bootstrapVersion: http.bootstrapVersion,
      serverId: http.serverId,
      relayInstanceId: http.relayInstanceId,
      protocolVersion: http.protocolVersion,
      buildVersion: http.buildVersion,
      capabilities,
      profile: http.profile,
      encoding: http.encoding,
      effectiveBudgets,
      connection,
    }),
  };
}
