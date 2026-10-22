import {
  PAIRING_LIMITS,
  PAIRING_PATHS,
  PairingFailureSchema,
  PairingRedeemResultSchema,
  decodeInvitation,
  type InvitationPayload,
  type PairingRedeemResult,
} from "@cove/protocol/auth";
import type { ServerRecord } from "./credentials.js";
import { openPairingEntry, preAuthIdentity, RemoteError, type Via } from "./entries.js";
import { withEntryFailure } from "./entry-types.js";
import { postJson, TransportFailure } from "./http.js";

// Client side of pairing (m2 D6, "配对流程与状态" steps 2–5). The invitation string holds a
// one-time secret, so it is read only from a prompt or stdin (commands/remote.ts) and never
// appears in an argument, error or output of this module: every message names the step that
// failed, never the input.

const REDEEM_TIMEOUT_MS = 15_000;

// The payload of a pasted invitation, or a RemoteError that does not repeat it.
export function parseInvitation(text: string): InvitationPayload {
  const payload = decodeInvitation(text.trim());
  if (!payload)
    throw new RemoteError(
      "INVITATION_UNAVAILABLE",
      "the input is not a Cove invitation (cove-invite:v1:...); nothing was sent",
    );
  return payload;
}

// Redeems an invitation: reach its pairing listener over the chosen entry (loopback without `via`,
// the invitation's SSH target through a tunnel to its pairing port, or its tsnet node's pairing
// port through this client's node), whose channel checks its peer while it opens (the SSH host
// key, the tsnet node's stable ID), check that the server there is the invitation's
// (serverId) before anything secret is sent, then submit the secret and this device's name. A
// refusal is one answer for every reason (expired, redeemed, cancelled, wrong secret); a lost
// answer is not retried (D6): the operator creates a new invitation. The entry (an SSH tunnel)
// lives only for the redemption.
export async function redeemInvitation(
  payload: InvitationPayload,
  deviceName: string,
  via: Via | undefined,
  buildVersion: string,
  home: string,
): Promise<PairingRedeemResult> {
  const entry = await openPairingEntry(payload, via, home);
  try {
    return await redeemOver(entry.endpoint, payload, deviceName, buildVersion);
  } catch (error) {
    // The redemption's own connection can be a later tsnet stream (the identity check used the
    // first one); its refusal (a hold, PEER_MISMATCH) is otherwise only a closed connection here.
    throw withEntryFailure(error, entry);
  } finally {
    await entry.close();
  }
}

async function redeemOver(
  endpoint: string,
  payload: InvitationPayload,
  deviceName: string,
  buildVersion: string,
): Promise<PairingRedeemResult> {
  const identity = await preAuthIdentity(endpoint, buildVersion, "the invitation's pairing port");
  if (identity.serverId !== payload.serverId)
    throw new RemoteError(
      "SERVER_ID_MISMATCH",
      "the server at the invitation's pairing port is not the server that issued it; " +
        "the invitation was not sent",
    );
  let response;
  try {
    response = await postJson(
      endpoint,
      PAIRING_PATHS.redeem,
      {
        type: "cove-pairing-redeem",
        inviteId: payload.inviteId,
        secret: payload.secret,
        deviceName,
      },
      { maxResponseBytes: PAIRING_LIMITS.responseBytes, timeoutMs: REDEEM_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof TransportFailure && error.disposition === "not-sent")
      throw new RemoteError(
        "ENTRY_UNAVAILABLE",
        "the pairing port closed before the invitation was sent; nothing was sent",
      );
    throw new RemoteError(
      "INVITATION_UNAVAILABLE",
      "the pairing answer was lost; the invitation may have been used. Create a new invitation " +
        "on the server and pair again; a device this attempt left is listed never-connected " +
        "by `cove auth device list` and can be revoked",
    );
  }
  const result = PairingRedeemResultSchema.safeParse(response.body);
  if (response.status === 200 && result.success && result.data.serverId === payload.serverId)
    return result.data;
  const failure = PairingFailureSchema.safeParse(response.body);
  if (failure.success && failure.data.kind === "INVITATION_UNAVAILABLE")
    throw new RemoteError(
      "INVITATION_UNAVAILABLE",
      "the server refused the invitation (it is expired, cancelled, already used or not this " +
        "server's); create a new one",
    );
  throw new RemoteError(
    "INVITATION_UNAVAILABLE",
    failure.success
      ? `the pairing listener refused the request (${failure.data.kind}); try again later`
      : "the pairing listener gave an invalid answer",
  );
}

// The credential record of a redeemed invitation (D5, D11, S7). It holds every entry the
// invitation carries, so that one client can reach the server over SSH and over tsnet and switch
// with --via (m2 deliverable 6, S7):
// - the invitation's SSH target and tsnet node, if any, at the business port on that host: the
//   server's tailnet node serves the business port at the same number as its loopback port (an
//   interface requirement on the server's tsnet wiring, m2 T5b), and the SSH tunnel forwards to
//   the target host's loopback business port;
// - paired over loopback (no `via`), also the loopback business port: the server is on this host.
//   A client that paired over SSH or tsnet is on another host, where the server's loopback port
//   is not this host's, so it never records loopback.
// The default entry is the one the pairing went through: loopback without `via`, else `via`
// (with `--via`, the first entry this client uses is its operator's choice, not the invitation's
// order). `cove remote entry default` changes it; nothing switches it automatically.
//
// An entry the pairing did not go through is recorded unexercised. That is no weaker than the
// exercised one: an entry is never trusted because it was recorded, and every use verifies it
// again before the token is released, with the channel's own peer check (ssh checks the target's
// host key against the user's known_hosts; the dial daemon checks the server node's stable ID,
// which the invitation named, with WhoIs) and then the serverId the pairing established
// (entries.ts verifiedIdentity). An entry that fails that check fails its command, naming the
// entries and --via; Cove never tries another entry instead.
export function pairedRecord(
  alias: string,
  payload: InvitationPayload,
  result: PairingRedeemResult,
  via: Via | undefined,
  pairedAtMs: number = Date.now(),
): ServerRecord {
  const port = result.businessPort;
  const ssh = payload.entries.ssh ? { ssh: { target: payload.entries.ssh.target, port } } : {};
  const node = payload.entries.tsnet;
  const tsnet = node ? { tsnet: { nodeId: node.nodeId, name: node.name, port } } : {};
  const base = {
    version: 1 as const,
    alias,
    serverId: result.serverId,
    deviceId: result.deviceId,
    token: result.token,
    pairedAtMs,
  };
  // The pairing went through `via`, so the invitation has it (entries.ts openPairingEntry).
  if (via !== undefined && !payload.entries[via])
    throw new Error(`the invitation names no ${via} entry`);
  if (via !== undefined) return { ...base, defaultEntry: via, entries: { ...ssh, ...tsnet } };
  return { ...base, defaultEntry: "loopback", entries: { loopback: { port }, ...ssh, ...tsnet } };
}
