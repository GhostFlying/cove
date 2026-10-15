import { M0_LIMITS, type EffectiveBudgets } from "@cove/protocol/budgets";
import {
  RPC_METHODS,
  STANDARD_RPC_ERRORS,
  validateRpcMethodParams,
  validateRpcResponse,
  validateRpcResultForCall,
  type RpcMethod,
  type RpcResponse,
} from "@cove/protocol/rpc";

export type ParamsFor<M extends RpcMethod> = (typeof RPC_METHODS)[M]["params"]["_output"];
export type ResultFor<M extends RpcMethod> = (typeof RPC_METHODS)[M]["result"]["_output"];

export interface RpcBinding {
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly protocolVersion: number;
  readonly buildVersion: string;
  readonly profile: string;
  readonly effectiveBudgets: Readonly<EffectiveBudgets>;
}

export type PreparedCall<M extends RpcMethod> = {
  readonly method: M;
  readonly params: ParamsFor<M>;
  readonly request: Readonly<{
    jsonrpc: "2.0";
    id: string;
    method: M;
    params: ParamsFor<M>;
  }>;
};

// Transport binding and execution preconditions are separate (m1 "操作身份跨重启"). The
// transport binding (server, current instance, protocol) is checked on every request and response
// by headers. Params only have to name this server: a write may carry the execution precondition
// of an earlier instance so that a resend reaches server-side deduplication, which decides whether
// it is the original operation or a stale new one. Only instance-scoped reads must name the
// current instance.
export function prepareCall<M extends RpcMethod>(
  method: M,
  params: ParamsFor<M>,
  requestId: string,
  binding: RpcBinding,
): PreparedCall<M> | null {
  const parsed = validateRpcMethodParams(method, params);
  if (!parsed || parsed.method !== method) return null;
  const stableParams = parsed.params as ParamsFor<M>;
  if (!referencesMatchBinding(stableParams, RPC_METHODS[method].scope, binding)) return null;
  return {
    method,
    params: stableParams,
    request: Object.freeze({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params: stableParams,
    }),
  };
}

// Every server reference (any object with a string serverId, such as a RunRef) must name the bound
// server; in an instance-scoped method it must also name the current relay instance. Inputs are
// schema-validated, bounded JSON, so the walk is bounded too.
function referencesMatchBinding(
  value: unknown,
  scope: "instance" | "server",
  binding: RpcBinding,
): boolean {
  if (Array.isArray(value))
    return value.every((element) => referencesMatchBinding(element, scope, binding));
  if (!value || typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  if (typeof record.serverId === "string" && record.serverId !== binding.serverId) return false;
  if (
    scope === "instance" &&
    typeof record.relayInstanceId === "string" &&
    record.relayInstanceId !== binding.relayInstanceId
  )
    return false;
  return Object.values(record).every((element) => referencesMatchBinding(element, scope, binding));
}

function sameBudgets(left: EffectiveBudgets, right: Readonly<EffectiveBudgets>): boolean {
  return (Object.keys(M0_LIMITS) as (keyof EffectiveBudgets)[]).every(
    (key) => left[key] === right[key],
  );
}

function resultMatchesBinding<M extends RpcMethod>(
  method: M,
  result: ResultFor<M>,
  binding: RpcBinding,
): boolean {
  if (method === "server.status") {
    const status = result as ResultFor<"server.status">;
    return (
      status.serverId === binding.serverId &&
      status.relayInstanceId === binding.relayInstanceId &&
      status.protocolVersion === binding.protocolVersion &&
      status.buildVersion === binding.buildVersion &&
      status.profile === binding.profile &&
      sameBudgets(status.effectiveBudgets, binding.effectiveBudgets)
    );
  }
  // Server-scoped results, including every operation record, may reference runs of earlier
  // instances of the same server: a resent write or operation.get returns the historical record.
  return referencesMatchBinding(result, RPC_METHODS[method].scope, binding);
}

export type CheckedRpcResponse<M extends RpcMethod> =
  | { readonly kind: "success"; readonly value: ResultFor<M> }
  | { readonly kind: "rpc-error"; readonly response: Extract<RpcResponse, { error: unknown }> }
  | { readonly kind: "invalid" };

export function rpcErrorProvesWriteNotAccepted(
  response: Extract<RpcResponse, { error: unknown }>,
): boolean {
  if (response.error.data) return response.error.data.acceptance === "not-accepted";
  const code = response.error.code;
  return code === STANDARD_RPC_ERRORS.methodNotFound || code === STANDARD_RPC_ERRORS.invalidParams;
}

export function checkRpcResponse<M extends RpcMethod>(
  method: M,
  params: ParamsFor<M>,
  requestId: string,
  decoded: unknown,
  binding: RpcBinding,
): CheckedRpcResponse<M> {
  const response = validateRpcResponse(decoded);
  if (!response || response.id !== requestId) return { kind: "invalid" };
  if ("error" in response) return { kind: "rpc-error", response };
  if (!validateRpcResultForCall(method, params, response.result)) return { kind: "invalid" };
  const parsed = RPC_METHODS[method].result.safeParse(response.result);
  if (!parsed.success) return { kind: "invalid" };
  const value = parsed.data as ResultFor<M>;
  return resultMatchesBinding(method, value, binding)
    ? { kind: "success", value }
    : { kind: "invalid" };
}
