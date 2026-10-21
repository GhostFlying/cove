import { domainError } from "@cove/protocol/errors";
import {
  RPC_METHODS,
  checkedOutputSecrets,
  holdsSecret,
  isWriteRpcMethod,
  nestedSecretsMember,
  secretStrings,
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

// The secret boundary of an answer (m2 "秘密与操作记录的分界"). Only a write that declares
// output secrets may answer with a top-level `secrets` member, and that member must be exactly a
// valid instance of its declaration; any other top-level `secrets` is dropped. Outside that
// member, no decoded string of the answer, a refusal's details included, may contain a secret of
// this call (input or output), and no `secrets` member may sit deeper in it. Such an answer is a
// defect of its handler, so it is refused with an internal error rather than sent. The durable
// half of the boundary is the receipt transaction (store/sql/receipts.ts), which refuses to store
// a record holding a secret, so a refused answer leaves nothing that a later operation.get or
// resend could return.
function guardSecrets(
  method: RpcMethod,
  result: RpcHandlerResult,
  inputSecrets: Record<string, unknown> | undefined,
): RpcHandlerResult {
  const inputs = secretStrings(inputSecrets ?? {});
  if (!result || typeof result !== "object" || Array.isArray(result) || "error" in result) {
    if (holdsSecret(result, inputs))
      throw new Error(`A ${method} refusal holds a secret of its request`);
    return result;
  }
  const { value, secrets } = splitSecrets(result as Record<string, unknown>);
  let kept: Record<string, string> | undefined;
  if (RPC_METHODS[method].secrets.output.length > 0 && isWriteRpcMethod(method) && secrets) {
    const checked = checkedOutputSecrets(method, secrets);
    if (!checked) throw new Error(`A ${method} result has undeclared or invalid secrets`);
    kept = checked;
  }
  // Only a method with secrets can misplace one; other answers skip the walk.
  const fields = RPC_METHODS[method].secrets;
  if (fields.input.length + fields.output.length > 0 && nestedSecretsMember(value))
    throw new Error(`A ${method} result holds a misplaced secrets member`);
  if (holdsSecret(value, [...inputs, ...secretStrings(kept ?? {})]))
    throw new Error(`A ${method} result outside its secrets member holds a secret`);
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
