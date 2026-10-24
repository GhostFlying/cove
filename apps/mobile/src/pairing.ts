import { decodeInvitation, DeviceNameSchema, PairingRedeemResultSchema } from "@cove/protocol/auth";
import { postJSON, verifyServer } from "./entry.js";
import { saveServer, type SavedServer, type SecureTokenStore } from "./credentials.js";
import type { NativePorts } from "./native-ports.js";

export async function pairServer(
  ports: NativePorts,
  invitation: string,
  deviceName: string,
  store: SecureTokenStore,
): Promise<SavedServer> {
  const payload = decodeInvitation(invitation.trim());
  if (!payload || !payload.entries.tsnet || !DeviceNameSchema.safeParse(deviceName).success)
    throw new Error("A valid tsnet invitation and device name are required");
  const entry = ports.entry(payload.entries.tsnet.nodeId, payload.pairingPort);
  try {
    await verifyServer(entry.http, payload.serverId);
    // A lost redemption response is terminal for this attempt. This function
    // has no automatic retry; create a new invitation if the result is unknown.
    const response = await postJSON(
      entry.http,
      "/pair",
      {
        type: "cove-pairing-redeem",
        inviteId: payload.inviteId,
        secret: payload.secret,
        deviceName,
      },
      4096,
    );
    const redeemed = PairingRedeemResultSchema.safeParse(response);
    if (!redeemed.success || redeemed.data.serverId !== payload.serverId)
      throw new Error("Pairing did not return a matching server identity");
    const server: SavedServer = {
      serverId: payload.serverId,
      peerID: payload.entries.tsnet.nodeId,
      port: redeemed.data.businessPort,
      token: redeemed.data.token,
    };
    // Persistence failure never becomes a successful pairing indication. The
    // server may already have created the device; no redemption is repeated.
    await saveServer(store, server);
    return server;
  } finally {
    entry.close();
  }
}
