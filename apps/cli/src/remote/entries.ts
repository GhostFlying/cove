import {
  BootstrapFailureSchema,
  BootstrapIdentitySchema,
  BOOTSTRAP_VERSION,
  LOCAL_PATHS,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  type BootstrapIdentity,
} from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { BASELINE_ENCODING, PROFILE } from "@cove/protocol/profile";
import type { EntryKind, ServerRecord } from "./credentials.js";
import { postJson, TransportFailure } from "./http.js";

// Entry selection of a remote command (m2 D11). The entry is `--via` when given, otherwise the
// record's fixed default; a failure is reported with the entries the record has and never
// answered by trying another one. T1 implements the loopback entry only; ssh and tsnet are
// ENTRY_UNAVAILABLE until T2 (SSH, and the selection itself) and T4 (tsnet) replace this module's
// branches for them.

export type Via = "ssh" | "tsnet";

// A failure of a remote command that is not an RPC answer. `kind` is the protocol error kind
// (errors.ts) it corresponds to; nothing was sent to the server when it is raised before the
// credential was released, which every raise in this module is.
export class RemoteError extends Error {
  constructor(
    readonly kind: "ENTRY_UNAVAILABLE" | "SERVER_ID_MISMATCH" | "INVITATION_UNAVAILABLE",
    readonly detail: string,
  ) {
    super(`${detail} (${kind})`);
  }
}

// An opened entry: the local endpoint that reaches the server, and what to release afterwards
// (an SSH tunnel's process, T2). The loopback entry has nothing to release.
export type OpenedEntry = {
  readonly kind: EntryKind;
  readonly endpoint: string;
  close(): Promise<void>;
};

const IDENTITY_TIMEOUT_MS = 10_000;

function available(record: ServerRecord): string {
  const kinds = Object.keys(record.entries);
  return kinds.length ? kinds.join(", ") : "none";
}

function unsupported(kind: EntryKind): RemoteError {
  return new RemoteError(
    "ENTRY_UNAVAILABLE",
    `the ${kind} entry is not available in this build; nothing was sent`,
  );
}

// Opens the selected entry of `record`.
export async function openEntry(record: ServerRecord, via: Via | undefined): Promise<OpenedEntry> {
  const kind: EntryKind = via ?? record.defaultEntry;
  if (kind !== "loopback") throw unsupported(kind);
  const entry = record.entries.loopback;
  if (!entry)
    throw new RemoteError(
      "ENTRY_UNAVAILABLE",
      `${record.alias} has no verified ${kind} entry (entries: ${available(record)}); nothing was sent`,
    );
  return { kind, endpoint: `http://127.0.0.1:${entry.port}`, close: async () => undefined };
}

// The endpoint of an invitation's pairing listener over the chosen entry. Pairing in T1 is over
// loopback only: the pairing listener of a server on this host.
export function pairingEndpoint(pairingPort: number, via: Via | undefined): string {
  if (via !== undefined) throw unsupported(via);
  return `http://127.0.0.1:${pairingPort}`;
}

// The pre-authentication identity of a server (relay-protocol §11.8): a bootstrap request
// without credentials. Its serverId is compared with the expected one before any secret or token
// is sent; serverId identifies, it does not prove (the channel's own check does that, T2/T4).
export async function preAuthIdentity(
  endpoint: string,
  buildVersion: string,
  what: string,
): Promise<BootstrapIdentity> {
  let response;
  try {
    response = await postJson(
      endpoint,
      LOCAL_PATHS.bootstrap,
      {
        type: "cove-bootstrap",
        bootstrapVersion: BOOTSTRAP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        buildVersion,
        capabilities: [...REQUIRED_CAPABILITIES],
        profiles: [PROFILE],
        encodings: [BASELINE_ENCODING],
      },
      { maxResponseBytes: M0_LIMITS.bootstrapBytes, timeoutMs: IDENTITY_TIMEOUT_MS },
    );
  } catch (error) {
    const reason = error instanceof TransportFailure ? error.message : "it failed";
    throw new RemoteError(
      "ENTRY_UNAVAILABLE",
      `cannot reach ${what} (${reason}); nothing was sent`,
    );
  }
  const identity = BootstrapIdentitySchema.safeParse(response.body);
  if (response.status === 200 && identity.success) return identity.data;
  const failure = BootstrapFailureSchema.safeParse(response.body);
  throw new RemoteError(
    "ENTRY_UNAVAILABLE",
    `${what} did not answer with a Cove identity` +
      (failure.success ? ` (${failure.data.kind})` : "") +
      "; nothing was sent",
  );
}

// The identity of the server behind an opened entry, which must be the recorded server.
export async function verifiedIdentity(
  record: ServerRecord,
  entry: OpenedEntry,
  buildVersion: string,
): Promise<BootstrapIdentity> {
  const identity = await preAuthIdentity(
    entry.endpoint,
    buildVersion,
    `${record.alias} over ${entry.kind}`,
  ).catch((error: unknown) => {
    if (!(error instanceof RemoteError)) throw error;
    throw new RemoteError(
      error.kind,
      `${error.detail}. Entries of ${record.alias}: ${available(record)} ` +
        "(choose one with --via; Cove never switches entries on its own)",
    );
  });
  if (identity.serverId !== record.serverId)
    throw new RemoteError(
      "SERVER_ID_MISMATCH",
      `the server at ${record.alias}'s ${entry.kind} entry is not the paired server; ` +
        `no token was sent`,
    );
  return identity;
}
