import { domainError, type DomainError } from "@cove/protocol/errors";
import type { RpcDomain, RpcMethod } from "@cove/protocol/rpc";
import { RPC_METHODS } from "@cove/protocol/rpc";
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
