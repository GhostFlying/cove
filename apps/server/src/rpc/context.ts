import { domainError, type DomainError } from "@cove/protocol/errors";
import type { RpcDomain, RpcMethod } from "@cove/protocol/rpc";
import { RPC_METHODS } from "@cove/protocol/rpc";
import type { AuthService } from "../auth/service.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { TerminalOperations } from "../operations/terminal-operations.js";
import type { ConfigService } from "../store/config.js";
import type { Store } from "../store/database.js";
import type { LocalRuntime } from "../terminal/local-runtime.js";

// Server-side services an RPC handler may use. The server composition (entry/) builds it; domain
// tasks extend it with their services rather than changing the transport or the dispatch table.
export type LocalCore = {
  runtime: LocalRuntime;
  operations: TerminalOperations;
  buildVersion: string;
  // Durable local owner (relay-protocol §11.3), read from the store. A composition without a
  // store (unit tests) uses the M0 constant.
  principalId?: string;
  // The server database (M1 T1). Domain modules run their queries and writes through it, one
  // complete business operation per Store.call (D6; registered in store/sql/registry.ts and, for
  // receipt-checked writes, store/sql/writes.ts). Absent in store-less unit tests, where every
  // domain write reports CAPABILITY_UNAVAILABLE.
  store?: Store;
  // Operation receipts shared by every write of this server (durable when `store` is present).
  receipts?: OperationReceipts;
  config?: ConfigService;
  // Device authorization (m2 T1): credentials, invitations, devices and the pairing listener.
  // Absent without a store; the auth domain then reports CAPABILITY_UNAVAILABLE.
  auth?: AuthService;
};

export const M0_LOCAL_PRINCIPAL_ID = "m0-local";

// Who is calling, as the transport authenticated it (m2 D7). Never taken from params. There is
// one owner: `principalId` is always the durable local owner, so operation receipts stay keyed
// by it whichever device sent the request (relay-protocol §11.3), and a device's own identity
// travels beside it for audit, device management and the local-owner check.
export type Principal =
  | { readonly kind: "local-owner"; readonly principalId: string }
  | { readonly kind: "device"; readonly principalId: string; readonly deviceId: string };

// The local owner of this composition: the only principal before device authentication (T1).
export function localOwner(core: LocalCore): Principal {
  return { kind: "local-owner", principalId: core.principalId ?? M0_LOCAL_PRINCIPAL_ID };
}

// Methods whose table entry names the domain D.
export type DomainMethod<D extends RpcDomain> = {
  [M in RpcMethod]: (typeof RPC_METHODS)[M]["domain"] extends D ? M : never;
}[RpcMethod];

export type RpcCall<D extends RpcDomain> = {
  method: DomainMethod<D>;
  // Already validated against the method's params schema, without its `secrets` member: a
  // handler can hand these params to receipts and records without carrying a secret along.
  params: Record<string, unknown>;
  // The method's declared input secrets (params.secrets), for its live use only. Never stored,
  // logged or returned.
  secrets?: Record<string, unknown>;
  // principal.principalId; kept for the M1 handlers.
  principalId: string;
  principal: Principal;
};

// A handler returns the method's result (validated against the result schema before it is sent)
// or a domain error.
export type RpcHandlerResult = unknown | { error: DomainError };
export type RpcHandler<D extends RpcDomain> = (
  core: LocalCore,
  call: RpcCall<D>,
) => RpcHandlerResult | Promise<RpcHandlerResult>;

// Initial handler of a domain whose implementation has not landed. Nothing was accepted, so a
// client reports it as an ordinary RPC error rather than an unknown operation outcome.
export function capabilityUnavailable(): { error: DomainError } {
  return { error: domainError("CAPABILITY_UNAVAILABLE") };
}
