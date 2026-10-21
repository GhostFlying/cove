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

// The credential record of a redeemed invitation (D5, D11). Its entries are the ones this pairing
// reached and the invitation's own:
// - paired over loopback (no `via`): the loopback business port, which is the default, and the
//   invitation's SSH target and tsnet node, if any, at the same business port on that host;
// - paired over SSH: that SSH target only, which is the default (the client is on another host,
//   so the server's loopback port is not reachable as this host's);
// - paired over tsnet: the invitation's tsnet node only, which is the default, at the business
//   port: the server's tailnet node serves the business port at the same number as its loopback
//   port (an interface requirement on the server's tsnet wiring, m2 T5b).
// Every entry is verified again on each use (the SSH host key or the tsnet node's stable ID, then
// the serverId), not trusted because it was recorded.
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
  if (via === "ssh" && payload.entries.ssh)
    return {
      ...base,
      defaultEntry: "ssh",
      entries: { ssh: { target: payload.entries.ssh.target, port } },
    };
  if (via === "tsnet" && node)
    return {
      ...base,
      defaultEntry: "tsnet",
      entries: { tsnet: { nodeId: node.nodeId, name: node.name, port } },
    };
  if (via !== undefined) throw new Error(`the invitation names no ${via} entry`);
  return { ...base, defaultEntry: "loopback", entries: { loopback: { port }, ...ssh, ...tsnet } };
}
