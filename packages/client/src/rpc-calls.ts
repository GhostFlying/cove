import { M0_LIMITS, type EffectiveBudgets } from "@cove/protocol/budgets";
import { sameRunRef, type RunRef } from "@cove/protocol/identity";
import {
  RPC_METHODS,
  STANDARD_RPC_ERRORS,
  validateRpcMethodParams,
  validateRpcResponse,
  validateRpcResultForCall,
  type OperationRecord,
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

export function prepareCall<M extends RpcMethod>(
  method: M,
  params: ParamsFor<M>,
  requestId: string,
  binding: RpcBinding,
): PreparedCall<M> | null {
  const parsed = validateRpcMethodParams(method, params);
  if (!parsed || parsed.method !== method) return null;
  const stableParams = parsed.params as ParamsFor<M>;
  if (!paramsMatchInstance(method, stableParams, binding)) return null;
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

function paramsMatchInstance<M extends RpcMethod>(
  method: M,
  params: ParamsFor<M>,
  binding: RpcBinding,
): boolean {
  const value = params as Record<string, unknown>;
  if (
    (method === "terminal.create" || method === "terminal.stop" || method === "operation.get") &&
    value.expectedRelayInstanceId !== binding.relayInstanceId
  )
    return false;
  if (method === "terminal.get" || method === "terminal.stop") return boundRun(value.run, binding);
  return true;
}

function boundRun(value: unknown, binding: RpcBinding): value is RunRef {
  return (
    !!value &&
    typeof value === "object" &&
    (value as RunRef).serverId === binding.serverId &&
    (value as RunRef).relayInstanceId === binding.relayInstanceId
  );
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
  if (method === "terminal.list") {
    return (result as ResultFor<"terminal.list">).runs.every((record) =>
      boundRun(record.run, binding),
    );
  }
  if (method === "terminal.get")
    return boundRun((result as ResultFor<"terminal.get">).record.run, binding);
  if (method === "terminal.create" || method === "terminal.stop" || method === "operation.get") {
    const operation = (result as { operation: OperationRecord }).operation;
    return (
      boundRun(operation.run, binding) &&
      (!operation.result?.run || sameRunRef(operation.run, operation.result.run))
    );
  }
  return false;
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
