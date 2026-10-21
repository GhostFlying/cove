import { isIP } from "node:net";
import { OpaqueIdSchema } from "@cove/protocol/identity";
import { timingSafeEqual } from "node:crypto";
import {
  evaluateAdmission,
  evaluateWsUpgrade,
  type AdmissionKind,
  PROTOCOL_VERSION,
} from "@cove/protocol/bootstrap";
import type { EffectiveBudgets } from "@cove/protocol/budgets";
import { MAX_FRAME_BYTES } from "@cove/protocol/terminal";
import type { RuntimeRetainedBytes } from "../terminal/runtime-retained-bytes.js";
import type { Authentication } from "../auth/service.js";
import type { M0LocalOptions } from "../entry/m0-local-options.js";
import { localAuthority } from "../entry/m0-local-options.js";

export type LocalHeaders = Record<string, string | string[] | undefined>;
export function header(headers: LocalHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return typeof value === "string" ? value : value === undefined ? undefined : "";
}
export function actualHeaders(headers: LocalHeaders, raw: readonly string[]): LocalHeaders {
  const copy = { ...headers };
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (seen.has(name)) copy[name] = [raw[i + 1] ?? ""];
    seen.add(name);
  }
  return copy;
}
function malformedHeaders(headers: LocalHeaders): boolean {
  const names = [
    "host",
    "origin",
    "authorization",
    "cove-protocol",
    "cove-server-id",
    "cove-instance-id",
  ];
  if (names.some((name) => Array.isArray(headers[name]))) return true;
  const host = header(headers, "host");
  if (!host || /[\s/@?#]/.test(host)) return true;
  const match = /^(\[[^\]]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]+))?$/.exec(host);
  if (!match || (match[1]!.startsWith("[") && isIP(match[1]!.slice(1, -1)) !== 6)) return true;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return true;
  const protocol = header(headers, "cove-protocol");
  if (
    protocol !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(protocol) || !Number.isSafeInteger(Number(protocol)))
  )
    return true;
  return ["cove-server-id", "cove-instance-id"].some((name) => {
    const value = header(headers, name);
    return value !== undefined && !OpaqueIdSchema.safeParse(value).success;
  });
}
// What verifies a presented credential (auth/service.ts AuthService). Without one (store-less
// unit compositions) only the local owner secret is accepted.
export interface CredentialVerifier {
  authenticate(value: string | undefined): Authentication;
}

// The credential of an HTTP request, or `anonymous` for the one request that needs none: a POST
// /bootstrap without an Authorization header, answered with the pre-authentication identity only
// (relay-protocol §11.8).
export type HttpCredential = Authentication | { readonly kind: "anonymous" };

function bearer(headers: LocalHeaders): string | undefined {
  const value = header(headers, "authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

export class LocalAdmission {
  private authority: string | undefined;
  private counts = { unauthenticated: 0, authenticated: 0, rpc: 0 };
  constructor(
    readonly options: M0LocalOptions,
    private readonly secret: string,
    readonly identity: { serverId: string; relayInstanceId: string },
    readonly budgets: EffectiveBudgets,
    private readonly bytes: RuntimeRetainedBytes,
    private readonly verifier?: CredentialVerifier,
  ) {
    if (options.port) this.authority = localAuthority(options.host, options.port);
  }
  bind(port: number): void {
    const authority = localAuthority(this.options.host, port);
    if (this.authority && this.authority !== authority) throw new Error("Bound authority changed");
    this.authority = authority;
  }
  get boundAuthority(): string {
    return this.authority ?? "";
  }
  // The verdict on a credential string: the local owner secret of this start or a device token
  // (m2 D4, D7). Pure; the transport reports an admitted device to the verifier itself.
  authenticate(value: string | undefined): Authentication {
    if (this.verifier) return this.verifier.authenticate(value);
    if (!value || value.length !== this.secret.length) return { kind: "unauthenticated" };
    const expected = Buffer.from(this.secret);
    const actual = Buffer.from(value);
    return actual.length === expected.length && timingSafeEqual(actual, expected)
      ? { kind: "local-owner" }
      : { kind: "unauthenticated" };
  }
  verifies(value: string | undefined): boolean {
    const verdict = this.authenticate(value).kind;
    return verdict === "local-owner" || verdict === "device";
  }
  // The credential an HTTP request presents (see HttpCredential).
  credential(method: "POST" | "OPTIONS", path: string, headers: LocalHeaders): HttpCredential {
    if (
      method === "POST" &&
      path === "/bootstrap" &&
      header(headers, "authorization") === undefined
    )
      return { kind: "anonymous" };
    return this.authenticate(bearer(headers));
  }
  http(
    method: "POST" | "OPTIONS",
    path: string,
    headers: LocalHeaders,
    bytes: number,
    ownsClaim = false,
  ): AdmissionKind {
    if (malformedHeaders(headers)) return "malformed";
    if (
      method === "POST" &&
      path === "/rpc" &&
      ["cove-protocol", "cove-server-id", "cove-instance-id"].some(
        (name) => header(headers, name) === undefined,
      )
    )
      return "malformed";
    const cap = path === "/rpc" ? this.budgets.rpcRequestBytes : this.budgets.bootstrapBytes;
    const protocol = header(headers, "cove-protocol");
    const server = header(headers, "cove-server-id");
    const instance = header(headers, "cove-instance-id");
    const origin = header(headers, "origin");
    const requested = header(headers, "access-control-request-method");
    const requestedHeaders = header(headers, "access-control-request-headers");
    const credential = this.credential(method, path, headers);
    const result = evaluateAdmission({
      method,
      path,
      host: header(headers, "host") ?? "",
      boundAuthority: this.boundAuthority,
      ...(origin !== undefined ? { origin } : {}),
      allowedOrigins: this.options.allowedOrigins,
      browser:
        header(headers, "sec-fetch-mode") !== undefined ||
        header(headers, "sec-fetch-site") !== undefined,
      // An anonymous identity request passes the same Host, Origin, size and identity checks as
      // an authenticated one; it is answered with the identity alone (http-rpc.ts).
      authenticated: credential.kind !== "unauthenticated" && credential.kind !== "revoked",
      ...(requested !== undefined ? { requestedMethod: requested } : {}),
      ...(requestedHeaders !== undefined
        ? { requestedHeaders: requestedHeaders.split(",").map((h) => h.trim()) }
        : {}),
      bodyBytes: bytes,
      ...(server !== undefined ? { expectedServerId: server } : {}),
      ...(instance !== undefined ? { expectedRelayInstanceId: instance } : {}),
      ...(protocol !== undefined
        ? { expectedProtocol: /^(0|[1-9][0-9]*)$/.test(protocol) ? Number(protocol) : -1 }
        : {}),
      ...this.identity,
      // An anonymous identity request is counted with the unauthenticated connections, so that
      // requests nobody authenticated cannot use up the slots of authenticated RPC.
      capacityAvailable:
        ownsClaim ||
        (credential.kind === "anonymous"
          ? this.counts.unauthenticated < this.budgets.unauthenticatedSockets
          : this.counts.rpc < this.budgets.rpcInflight),
    });
    // The correct token of a revoked device is told so; every other failure stays UNAUTHENTICATED.
    if (result === "unauthenticated" && credential.kind === "revoked") return "revoked";
    return result === "accepted" && method === "POST" && bytes > cap ? "too-large" : result;
  }
  upgrade(path: string, headers: LocalHeaders): AdmissionKind {
    if (malformedHeaders(headers)) return "malformed";
    const origin = header(headers, "origin");
    return evaluateWsUpgrade({
      path,
      host: header(headers, "host") ?? "",
      boundAuthority: this.boundAuthority,
      ...(origin !== undefined ? { origin } : {}),
      allowedOrigins: this.options.allowedOrigins,
      capacityAvailable: this.counts.unauthenticated < this.budgets.unauthenticatedSockets,
    });
  }
  claim(kind: keyof LocalAdmission["counts"]): { retireAdmission(): void; release(): void } | null {
    const cap =
      kind === "rpc"
        ? this.budgets.rpcInflight
        : kind === "authenticated"
          ? this.budgets.authenticatedSockets
          : this.budgets.unauthenticatedSockets;
    if (this.counts[kind] >= cap) return null;
    const size =
      kind === "rpc"
        ? this.budgets.rpcRequestBytes + 4096
        : kind === "authenticated"
          ? 2 * MAX_FRAME_BYTES + 4096
          : this.budgets.bootstrapBytes + 4096;
    const lease = this.bytes.reserve(size);
    if (!lease) return null;
    this.counts[kind]++;
    let admitted = true;
    const retireAdmission = (): void => {
      if (!admitted) return;
      admitted = false;
      this.counts[kind]--;
    };
    let owned = true;
    return {
      retireAdmission,
      release: () => {
        if (!owned) return;
        owned = false;
        retireAdmission();
        lease.release();
      },
    };
  }
  snapshot() {
    return { ...this.counts, protocol: PROTOCOL_VERSION };
  }
}
