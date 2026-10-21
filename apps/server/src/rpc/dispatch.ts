import { domainError } from "@cove/protocol/errors";
import {
  RPC_METHODS,
  isWriteRpcMethod,
  splitSecrets,
  type RpcDomain,
  type RpcMethod,
} from "@cove/protocol/rpc";
import {
  localOwner,
  type LocalCore,
  type Principal,
  type RpcCall,
  type RpcHandler,
  type RpcHandlerResult,
} from "./context.js";
import { handle as auth } from "./auth.js";
import { handle as binding } from "./binding.js";
import { handle as config } from "./config.js";
import { handle as entry } from "./entry.js";
import { handle as mount } from "./mount.js";
import { handle as operation } from "./operation.js";
import { handle as repo } from "./repo.js";
import { handle as server } from "./server.js";
import { handle as service } from "./service.js";
import { handle as tab } from "./tab.js";
import { handle as task } from "./task.js";
import { handle as terminal } from "./terminal.js";
import { handle as tsnet } from "./tsnet.js";

// One handler module per domain of the method table. Each domain task replaces the `handle` export
// of its own module; neither this table nor the transport changes when a domain is implemented.
const RPC_HANDLERS: { readonly [D in RpcDomain]: RpcHandler<D> } = Object.freeze({
  server,
  terminal,
  operation,
  config,
  repo,
  task,
  mount,
  tab,
  binding,
  auth,
  entry,
  service,
  tsnet,
});

// Every string inside a secrets object, for the leak check below. The schemas make every secret
// at least 16 characters long, so a short value cannot match ordinary result text by chance.
function secretValues(secrets: Record<string, unknown> | undefined, into: string[]): void {
  for (const value of Object.values(secrets ?? {}))
    if (typeof value === "string" && value.length >= 16) into.push(value);
}

// The secret boundary of a result (m2 "秘密与操作记录的分界"). Only a method that declares output
// secrets may answer with a `secrets` member, and only beside its record; any other `secrets` is
// dropped. Then no part of the answer outside that member may contain a secret of this call,
// input or output: such an answer is a defect of its handler (the record it shows is the one it
// stored), so it is refused with an internal error rather than sent. Stored records are already
// stripped of undeclared members by their schema (checkedReceiptRecord); this check also covers
// a secret copied into a declared field.
function guardSecrets(
  method: RpcMethod,
  result: RpcHandlerResult,
  inputSecrets: Record<string, unknown> | undefined,
): RpcHandlerResult {
  if (!result || typeof result !== "object" || Array.isArray(result) || "error" in result)
    return result;
  const { value, secrets } = splitSecrets(result as Record<string, unknown>);
  const declared = RPC_METHODS[method].secrets.output.length > 0;
  const kept = declared && isWriteRpcMethod(method) && secrets ? secrets : undefined;
  const values: string[] = [];
  secretValues(inputSecrets, values);
  secretValues(kept, values);
  if (values.length > 0) {
    const text = JSON.stringify(value);
    if (values.some((secret) => text.includes(secret)))
      throw new Error(`A ${method} result outside its secrets member holds a secret`);
  }
  return kept ? { ...value, secrets: kept } : value;
}

// Routes a validated call to the module that owns its method, as `principal` (the local owner
// unless the transport authenticated a device).
export function dispatchRpc(
  core: LocalCore,
  method: RpcMethod,
  params: Record<string, unknown>,
  principal: Principal = localOwner(core),
): Promise<RpcHandlerResult> {
  return callHandler(
    RPC_HANDLERS[RPC_METHODS[method].domain] as RpcHandler<RpcDomain>,
    core,
    method,
    params,
    principal,
  );
}

// The permission and secret boundary around one handler call. The handler sees the params
// without their secrets and the declared input secrets apart; its answer passes guardSecrets.
export async function callHandler(
  handler: RpcHandler<RpcDomain>,
  core: LocalCore,
  method: RpcMethod,
  params: Record<string, unknown>,
  principal: Principal,
): Promise<RpcHandlerResult> {
  const spec = RPC_METHODS[method];
  // Refused before anything runs, so nothing was accepted (m2 D7).
  if (spec.permission === "local-owner" && principal.kind !== "local-owner")
    return { error: domainError("FORBIDDEN") };
  const { value, secrets } = splitSecrets(params);
  const declaresInput = spec.secrets.input.length > 0;
  const call = {
    method,
    params: value,
    ...(declaresInput && secrets ? { secrets } : {}),
    principalId: principal.principalId,
    principal,
  } as RpcCall<RpcDomain>;
  return guardSecrets(method, await handler(core, call), declaresInput ? secrets : undefined);
}
