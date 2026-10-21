import { capabilityUnavailable, type RpcHandler } from "./context.js";

// Auth domain module (auth.invite.*, auth.device.*; m2 T1). Every method acts as the calling
// principal: there is one owner (D7), so a device may manage invitations and every device, the
// local owner included; only rotation is the caller's own (D4). The service keeps every secret
// it creates out of records and errors and returns it only through executeSecretWrite.
export const handle: RpcHandler<"auth"> = (core, { method, params, principal }) => {
  const auth = core.auth;
  if (!auth) return capabilityUnavailable();
  switch (method) {
    case "auth.invite.create":
      return auth.createInvitation(principal, params as { operationId: string; ttlMs?: number });
    case "auth.invite.list":
      return auth.listInvitations();
    case "auth.invite.cancel":
      return auth.cancelInvitation(principal, params as { operationId: string; inviteId: string });
    case "auth.device.list":
      return auth.listDevices(principal, params as { includeRevoked?: boolean });
    case "auth.device.rename":
      return auth.renameDevice(
        principal,
        params as {
          operationId: string;
          deviceId: string;
          name: string;
          expectedRevision?: number;
        },
      );
    case "auth.device.revoke":
      return auth.revokeDevice(principal, params as { operationId: string; deviceId: string });
    case "auth.device.rotate":
      return auth.rotateToken(principal, params as { operationId: string });
  }
};
