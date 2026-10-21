import { isAbsolute, normalize } from "node:path";
import type { EntrySettings } from "@cove/protocol/auth";
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

// Entry configuration (m2 D3, D10; entry.set). Pure like nextConfig, so that the store operation
// T3 adds and any probe apply the same change. The protocol schema already bounds each field;
// these are the rules across fields and revisions.
export type EntryConfigState = { revision: number } & EntrySettings;
export type EntryConfigSetArgs = { expectedRevision?: number; patch: Partial<EntrySettings> };

// Settings the running server reads only when it starts. The SSH target is read when an
// invitation is created, so it applies at once.
const RESTART_FIELDS = ["businessPort", "pairingPort", "tsnetHostname"] as const;

export function nextEntryConfig(
  current: EntryConfigState,
  args: EntryConfigSetArgs,
): { next: EntryConfigState; result: OperationResultData } | { error: DomainError } {
  if (args.expectedRevision !== undefined && args.expectedRevision !== current.revision)
    return { error: domainError("REVISION_CONFLICT") };
  if (current.revision === Number.MAX_SAFE_INTEGER)
    return { error: domainError("COUNTER_EXHAUSTED") };
  const next: EntryConfigState = { ...current, revision: current.revision + 1 };
  for (const key of ["businessPort", "pairingPort", "sshTarget", "tsnetHostname"] as const)
    if (args.patch[key] !== undefined) Object.assign(next, { [key]: args.patch[key] });
  // Pairing has a listener of its own (D6); one port cannot serve both.
  if (next.businessPort !== null && next.businessPort === next.pairingPort)
    return { error: domainError("INVALID_ARGUMENT") };
  const restart = RESTART_FIELDS.some((key) => next[key] !== current[key]);
  return {
    next,
    result: {
      resource: { kind: "config", id: "entry", revision: next.revision },
      ...(restart ? { appliesAfterRestart: true as const } : {}),
    },
  };
}
