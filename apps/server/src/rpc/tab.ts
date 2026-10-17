import { M0_LIMITS } from "@cove/protocol/budgets";
import { TabService } from "../domain/tabs.js";
import { capabilityUnavailable, type LocalCore, type RpcHandler } from "./context.js";

// Tab domain module (tab.create, tab.list, tab.get, tab.runs, tab.reopen, tab.stop, tab.close;
// M1 T4). The service is built from the composition's store, receipts and terminal operations
// once per core, like the repo and task modules; a composition without a store (unit tests)
// reports CAPABILITY_UNAVAILABLE for every method.
const services = new WeakMap<LocalCore, TabService>();
const encoder = new TextEncoder();
const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

function service(core: LocalCore): TabService | null {
  if (!core.store || !core.receipts) return null;
  let found = services.get(core);
  if (!found) {
    found = new TabService({
      store: core.store,
      receipts: core.receipts,
      operations: core.operations,
      encodeUtf8,
      // A result must fit both the per-response limit and the configured response budget
      // (transport/http-rpc.ts).
      responseBytes: Math.min(
        M0_LIMITS.rpcResponseBytes,
        core.runtime.composition.budgets.rpcResponseBytes,
      ),
    });
    services.set(core, found);
  }
  return found;
}

type Params<M extends keyof TabService> = TabService[M] extends (
  first: infer A,
  second: infer B,
  ...rest: never[]
) => unknown
  ? B extends undefined
    ? A
    : B
  : never;

export const handle: RpcHandler<"tab"> = (core, { method, params, principalId }) => {
  const tabs = service(core);
  if (!tabs) return capabilityUnavailable();
  switch (method) {
    case "tab.create":
      return tabs.create(principalId, params as Params<"create">);
    case "tab.list":
      return tabs.list(params as Parameters<TabService["list"]>[0]);
    case "tab.get":
      return tabs.get(params.tabId as string);
    case "tab.runs":
      return tabs.runs(params as Parameters<TabService["runs"]>[0]);
    case "tab.reopen":
      return tabs.reopen(principalId, params as Params<"reopen">);
    case "tab.stop":
      return tabs.stop(principalId, params as Params<"stop">);
    case "tab.close":
      return tabs.close(principalId, params as Params<"close">);
  }
};
