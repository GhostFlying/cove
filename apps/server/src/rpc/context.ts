import { domainError, type DomainError } from "@cove/protocol/errors";
import type { RpcDomain, RpcMethod } from "@cove/protocol/rpc";
import { RPC_METHODS } from "@cove/protocol/rpc";
import type { TerminalOperations } from "../operations/terminal-operations.js";
import type { LocalRuntime } from "../terminal/local-runtime.js";

// Server-side services an RPC handler may use. The server composition (entry/) builds it; domain
// tasks extend it with their services rather than changing the transport or the dispatch table.
export type LocalCore = {
  runtime: LocalRuntime;
  operations: TerminalOperations;
  buildVersion: string;
  // Durable local owner (relay-protocol §11.3). Until the store provides a persistent principal
  // (M1 T1), the M0 constant is used.
  principalId?: string;
};

export const M0_LOCAL_PRINCIPAL_ID = "m0-local";

// Methods whose table entry names the domain D.
export type DomainMethod<D extends RpcDomain> = {
  [M in RpcMethod]: (typeof RPC_METHODS)[M]["domain"] extends D ? M : never;
}[RpcMethod];

export type RpcCall<D extends RpcDomain> = {
  method: DomainMethod<D>;
  // Already validated against the method's params schema.
  params: Record<string, unknown>;
  principalId: string;
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
