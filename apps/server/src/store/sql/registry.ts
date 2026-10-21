import { authOperations } from "./auth.js";
import { bindingOperations } from "./bindings.js";
import { configOperations } from "./config.js";
import { identityOperations } from "./identity.js";
import { processOperations } from "./processes.js";
import { receiptOperations } from "./receipts.js";
import { repoOperations } from "./repos.js";
import { runOperations } from "./runs.js";
import { tabOperations } from "./tabs.js";
import { workspaceOperations } from "./workspaces.js";
import { worktreeOperations } from "./worktrees.js";

// Every business operation the store executes, by name. Store.call (store/database.ts) sends a
// name and arguments; the store looks the function up here and runs it as one transaction on its
// connection. A domain task adds its read and write operations here (one writer per change, like
// the RPC dispatch table); writes that need an operation receipt go to writes.ts instead.
export const STORE_OPERATIONS = Object.freeze({
  ...identityOperations,
  ...configOperations,
  ...receiptOperations,
  ...runOperations,
  ...processOperations,
  ...repoOperations,
  ...workspaceOperations,
  ...tabOperations,
  ...worktreeOperations,
  ...bindingOperations,
  ...authOperations,
});

export type StoreOperations = typeof STORE_OPERATIONS;
export type StoreOperationName = keyof StoreOperations;
export type StoreArgs<N extends StoreOperationName> =
  Parameters<StoreOperations[N]> extends [unknown, infer A] ? A : undefined;
export type StoreResult<N extends StoreOperationName> = ReturnType<StoreOperations[N]>;
