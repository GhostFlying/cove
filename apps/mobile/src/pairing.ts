import { decodeInvitation, DeviceNameSchema, PairingRedeemResultSchema } from "@cove/protocol/auth";
import type { TransferDisposition } from "@cove/client";
import { NativeRequestFailure, postJSON, verifyServer } from "./entry.js";
import { saveServer, type SavedServer, type SecureTokenStore } from "./credentials.js";
import type { NativePorts } from "./native-ports.js";

type PairingStage = "invitation" | "entry" | "identity" | "redeem" | "persist";

// Keep native delivery receipts while discarding exception text, which may
// contain the invitation, a device token, or an untrusted server response.
export class NativePairingFailure extends Error {
  readonly code: string;

  constructor(
    readonly stage: PairingStage,
    readonly disposition: TransferDisposition,
    readonly redemptionDisposition: TransferDisposition,
  ) {
    super(
      `Pairing ${stage}; request ${disposition}; redemption ${redemptionDisposition}; no automatic retry.`,
    );
    this.code = `COVE_NATIVE_PAIRING_${stage.toUpperCase()}`;
  }
}

export async function pairServer(
  ports: NativePorts,
  invitation: string,
  deviceName: string,
  store: SecureTokenStore,
): Promise<SavedServer> {
  let stage: PairingStage = "invitation";
  let disposition: TransferDisposition = "not-sent";
  let redemptionDisposition: TransferDisposition = "not-sent";
  let entry: ReturnType<NativePorts["entry"]> | undefined;
  try {
    const payload = decodeInvitation(invitation.trim());
    if (!payload || !payload.entries.tsnet || !DeviceNameSchema.safeParse(deviceName).success)
      throw new Error("Invalid invitation");
    stage = "entry";
    entry = ports.entry(payload.entries.tsnet.nodeId, payload.pairingPort);
    stage = "identity";
    disposition = "unknown";
    await verifyServer(entry.http, payload.serverId);
    // A lost redemption response is terminal for this attempt. This function
    // has no automatic retry; create a new invitation if the result is unknown.
    stage = "redeem";
    redemptionDisposition = "unknown";
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
    disposition = "handed-off";
    redemptionDisposition = "handed-off";
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
    stage = "persist";
    await saveServer(store, server);
    return server;
  } catch (error) {
    if (error instanceof NativeRequestFailure) {
      disposition = error.disposition;
      if (stage === "redeem") redemptionDisposition = disposition;
    }
    throw new NativePairingFailure(stage, disposition, redemptionDisposition);
  } finally {
    entry?.close();
  }
}
