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
import type { InvitationPayload } from "@cove/protocol/auth";
import type { EntryKind, ServerRecord } from "./credentials.js";
import { RemoteError, type OpenedEntry, type Via } from "./entry-types.js";
import { postJson, TransportFailure } from "./http.js";
import { openSshTunnel } from "./ssh-tunnel.js";
import { openTsnetEntry, openTsnetPairing } from "./tsnet.js";

export { RemoteError, type OpenedEntry, type Via } from "./entry-types.js";

// Entry selection of a remote command (m2 D11). The entry is `--via` when given, otherwise the
// record's fixed default. There is no automatic fallback: a failure to open or verify the selected
// entry fails the command, naming the entry tried and the entries the record has, and no other
// entry is tried (Cove never switches entries on its own, for reads or writes alike). Every
// failure here is raised before the credential is released, so nothing was sent.
//
// - loopback: the server's business port on this host.
// - ssh: an `ssh -L` tunnel to the target host's loopback business port (ssh-tunnel.ts). Requests
//   carry the tunnel's local authority as Host, which the server accepts as a loopback literal
//   (user decision 2026-10-22, protocol bootstrap.ts), so no Host rewriting is needed.
// - tsnet: tsnet.ts, which T4 replaces; until then ENTRY_UNAVAILABLE.
// The channel's own peer check (the SSH host key) happens while it opens; verifiedIdentity checks
// the serverId over it next. Both precede any token or invitation secret.

const IDENTITY_TIMEOUT_MS = 10_000;

function available(record: ServerRecord): string {
  const kinds = Object.keys(record.entries);
  return kinds.length ? kinds.join(", ") : "none";
}

// The hint every entry failure ends with.
function choices(record: ServerRecord): string {
  return (
    `Entries of ${record.alias}: ${available(record)} (choose one with --via ssh|tsnet, or ` +
    "`cove remote entry default`; Cove never switches entries on its own)"
  );
}

// An SSH tunnel to `remotePort` on `target`'s loopback; the endpoint is the tunnel's local end.
async function openSsh(target: string, remotePort: number): Promise<OpenedEntry> {
  const tunnel = await openSshTunnel({ target, remotePort });
  return {
    kind: "ssh",
    endpoint: `http://127.0.0.1:${tunnel.localPort}`,
    close: () => tunnel.close(),
  };
}

async function open(record: ServerRecord, kind: EntryKind): Promise<OpenedEntry> {
  const missing = () =>
    new RemoteError("ENTRY_UNAVAILABLE", `${record.alias} has no ${kind} entry; nothing was sent`);
  if (kind === "loopback") {
    const entry = record.entries.loopback;
    if (!entry) throw missing();
    return { kind, endpoint: `http://127.0.0.1:${entry.port}`, close: async () => undefined };
  }
  if (kind === "ssh") {
    const entry = record.entries.ssh;
    if (!entry) throw missing();
    return openSsh(entry.target, entry.port);
  }
  return openTsnetEntry(record);
}

// Opens the selected entry of `record`: `via`, else the record's default. Nothing else is tried.
export async function openEntry(record: ServerRecord, via: Via | undefined): Promise<OpenedEntry> {
  const kind: EntryKind = via ?? record.defaultEntry;
  try {
    return await open(record, kind);
  } catch (error) {
    if (!(error instanceof RemoteError)) throw error;
    throw new RemoteError(
      error.kind,
      `cannot open the ${kind} entry of ${record.alias}: ${error.detail}. ${choices(record)}`,
    );
  }
}

// The pairing listener of an invitation over the chosen entry: loopback (a server on this host)
// when `via` is absent, else the invitation's entry of that kind, forwarded to its pairing port.
export async function openPairingEntry(
  payload: InvitationPayload,
  via: Via | undefined,
): Promise<OpenedEntry> {
  if (via === undefined)
    return {
      kind: "loopback",
      endpoint: `http://127.0.0.1:${payload.pairingPort}`,
      close: async () => undefined,
    };
  if (via === "tsnet") return openTsnetPairing(payload);
  const ssh = payload.entries.ssh;
  if (!ssh)
    throw new RemoteError(
      "ENTRY_UNAVAILABLE",
      "the invitation names no SSH entry; the invitation was not sent",
    );
  return openSsh(ssh.target, payload.pairingPort);
}

// The pre-authentication identity of a server (relay-protocol §11.8): a bootstrap request
// without credentials. Its serverId is compared with the expected one before any secret or token
// is sent; serverId identifies, it does not prove. The channel's own peer check proves it: the
// SSH host key (ssh-tunnel.ts), and the tsnet node's stable ID (T4); loopback has none.
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
    throw new RemoteError(error.kind, `${error.detail}. ${choices(record)}`);
  });
  if (identity.serverId !== record.serverId)
    throw new RemoteError(
      "SERVER_ID_MISMATCH",
      `the server at ${record.alias}'s ${entry.kind} entry is not the paired server; ` +
        `no token was sent`,
    );
  return identity;
}
