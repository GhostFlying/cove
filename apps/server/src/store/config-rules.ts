import { isAbsolute, normalize } from "node:path";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { HostPathSchema } from "@cove/protocol/workspace";
import type { OperationResultData } from "../operations/receipt-records.js";

// Pure configuration rules, shared by the store's SQL operation (store/sql/config.ts, executed in
// the store worker) and the D6 probe's in-memory control phase (entry/d6-probe.ts), so both apply
// exactly the same change.

// The stored settings: NULL means the default (server-architecture §9.2).
export type ConfigState = { revision: number; workspaceRoot: string | null };

export type ConfigSetArgs = {
  expectedRevision?: number;
  patch: { workspaceRoot?: string | null };
};

// A workspace root is interpreted by this host: it must be absolute and already normalized, so
// the same request always names the same directory. It need not exist yet; the workspace module
// creates it when the first workspace under it is created.
export function validateWorkspaceRoot(value: string): DomainError | null {
  if (
    !HostPathSchema.safeParse(value).success ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    (value.length > 1 && value.endsWith("/"))
  )
    return domainError("INVALID_ARGUMENT");
  return null;
}

// The successor of `current` under a config.set, or the domain refusal.
export function nextConfig(
  current: ConfigState,
  args: ConfigSetArgs,
): { next: ConfigState; result: OperationResultData } | { error: DomainError } {
  if (args.expectedRevision !== undefined && args.expectedRevision !== current.revision)
    return { error: domainError("REVISION_CONFLICT") };
  if (current.revision === Number.MAX_SAFE_INTEGER)
    return { error: domainError("COUNTER_EXHAUSTED") };
  const next: ConfigState = {
    revision: current.revision + 1,
    workspaceRoot:
      args.patch.workspaceRoot === undefined ? current.workspaceRoot : args.patch.workspaceRoot,
  };
  return {
    next,
    result: { resource: { kind: "config", id: "server", revision: next.revision } },
  };
}
