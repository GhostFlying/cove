import { RPC_METHODS, type RpcDomain, type RpcMethod } from "@cove/protocol/rpc";
import {
  M0_LOCAL_PRINCIPAL_ID,
  type LocalCore,
  type RpcCall,
  type RpcHandler,
  type RpcHandlerResult,
} from "./context.js";
import { handle as binding } from "./binding.js";
import { handle as config } from "./config.js";
import { handle as mount } from "./mount.js";
import { handle as operation } from "./operation.js";
import { handle as repo } from "./repo.js";
import { handle as server } from "./server.js";
import { handle as tab } from "./tab.js";
import { handle as task } from "./task.js";
import { handle as terminal } from "./terminal.js";

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
});

// Routes a validated call to the module that owns its method.
export function dispatchRpc(
  core: LocalCore,
  method: RpcMethod,
  params: Record<string, unknown>,
): RpcHandlerResult | Promise<RpcHandlerResult> {
  const domain = RPC_METHODS[method].domain;
  const handler = RPC_HANDLERS[domain] as RpcHandler<RpcDomain>;
  const call = {
    method,
    params,
    principalId: core.principalId ?? M0_LOCAL_PRINCIPAL_ID,
  } as RpcCall<RpcDomain>;
  return handler(core, call);
}
