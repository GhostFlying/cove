import { timingSafeEqual } from "node:crypto";
import { AUTH_LIMITS, type DeviceRecord, type InvitationRecord } from "@cove/protocol/auth";
import { domainError, type DomainError } from "@cove/protocol/errors";
import type { OperationResultData } from "../../operations/receipt-records.js";
import { statement, type Connection } from "./statements.js";

// Device authorization store operations (m2 T1; migration 006). Secrets never reach this module:
// the main thread hashes an invitation secret or a token secret (apps/server/src/auth/tokens.ts)
// and passes the 32-byte SHA-256 only, so nothing the store keeps, logs or returns can reveal one.

type EntryKind = "loopback" | "ssh" | "tsnet";

type InvitationRow = {
  invite_id: string;
  state: InvitationRecord["state"];
  secret_hash: Uint8Array | null;
  created_at_ms: number;
  expires_at_ms: number;
  created_by_device_id: string | null;
  pairing_port: number;
  wrong_secrets: number;
  redeemed_device_id: string | null;
};

type DeviceRow = {
  device_id: string;
  revision: number;
  name: string;
  invite_id: string;
  token_hash: Uint8Array;
  pending_token_hash: Uint8Array | null;
  created_at_ms: number;
  last_used_at_ms: number | null;
  last_entry: EntryKind | null;
  revoked_at_ms: number | null;
};

// What the main thread's device authenticator holds per device (auth/devices.ts).
export type StoredDeviceCredential = {
  deviceId: string;
  tokenHash: Uint8Array;
  pendingTokenHash: Uint8Array | null;
  revoked: boolean;
  lastUsedAtMs: number | null;
  lastEntry: EntryKind | null;
};

// An open invitation as the pairing listener needs it: whether and where it must listen.
export type OpenInvitation = { inviteId: string; expiresAtMs: number; pairingPort: number };

const INVITATION_COLUMNS = `invite_id, state, secret_hash, created_at_ms, expires_at_ms,
  created_by_device_id, pairing_port, wrong_secrets, redeemed_device_id`;
const DEVICE_COLUMNS = `device_id, revision, name, invite_id, token_hash, pending_token_hash,
  created_at_ms, last_used_at_ms, last_entry, revoked_at_ms`;

// A hash argument as SQLite binds it: arguments reach the store worker by structured clone, which
// turns a Buffer into a plain Uint8Array.
function blob(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

// An open invitation whose time is up is expired the moment it is looked at, whether or not the
// expiry sweep (auth.invitations.expire) has written it yet: a stale `open` row is never redeemed.
function effectiveState(row: InvitationRow, at: number): InvitationRecord["state"] {
  return row.state === "open" && row.expires_at_ms <= at ? "expired" : row.state;
}

function invitationRecord(row: InvitationRow, at: number): InvitationRecord {
  return {
    inviteId: row.invite_id,
    state: effectiveState(row, at),
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    createdByDeviceId: row.created_by_device_id,
    redeemedDeviceId: row.redeemed_device_id,
  };
}

function deviceRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    revision: row.revision,
    name: row.name,
    createdAtMs: row.created_at_ms,
    inviteId: row.invite_id,
    lastUsedAtMs: row.last_used_at_ms,
    lastEntry: row.last_entry,
    neverConnected: row.last_used_at_ms === null,
    revokedAtMs: row.revoked_at_ms,
  };
}

function invitation(db: Connection, inviteId: string): InvitationRow | undefined {
  return statement(
    db,
    `SELECT ${INVITATION_COLUMNS} FROM auth_invitations WHERE invite_id = ?`,
  ).get(inviteId) as InvitationRow | undefined;
}

function device(db: Connection, deviceId: string): DeviceRow | undefined {
  return statement(db, `SELECT ${DEVICE_COLUMNS} FROM auth_devices WHERE device_id = ?`).get(
    deviceId,
  ) as DeviceRow | undefined;
}

// Ends an open invitation. The secret hash goes with it (migration 006).
function endInvitation(
  db: Connection,
  inviteId: string,
  state: "redeemed" | "cancelled" | "expired",
  at: number,
  redeemedDeviceId: string | null = null,
): void {
  statement(
    db,
    `UPDATE auth_invitations SET state = ?, secret_hash = NULL, ended_at_ms = ?,
       redeemed_device_id = ? WHERE invite_id = ? AND state = 'open'`,
  ).run(state, at, redeemedDeviceId, inviteId);
}

function openInvitations(db: Connection, at: number): OpenInvitation[] {
  return (
    statement(
      db,
      `SELECT invite_id, expires_at_ms, pairing_port FROM auth_invitations
       WHERE state = 'open' AND expires_at_ms > ? ORDER BY expires_at_ms, invite_id`,
    ).all(at) as { invite_id: string; expires_at_ms: number; pairing_port: number }[]
  ).map((row) => ({
    inviteId: row.invite_id,
    expiresAtMs: row.expires_at_ms,
    pairingPort: row.pairing_port,
  }));
}

export type RedeemArgs = {
  inviteId: string;
  secretHash: Uint8Array;
  at: number;
  device: { deviceId: string; name: string; tokenHash: Uint8Array };
};

export const authOperations = Object.freeze({
  // Everything the main thread keeps in memory: each device's token hashes and state, and the
  // open invitations. Read once at startup (auth/service.ts).
  "auth.load": (
    db: Connection,
    args: { at: number },
  ): { devices: StoredDeviceCredential[]; openInvitations: OpenInvitation[] } => ({
    devices: (
      statement(
        db,
        `SELECT ${DEVICE_COLUMNS} FROM auth_devices ORDER BY device_id`,
      ).all() as DeviceRow[]
    ).map((row) => ({
      deviceId: row.device_id,
      tokenHash: row.token_hash,
      pendingTokenHash: row.pending_token_hash,
      revoked: row.revoked_at_ms !== null,
      lastUsedAtMs: row.last_used_at_ms,
      lastEntry: row.last_entry,
    })),
    openInvitations: openInvitations(db, args.at),
  }),

  "auth.invitations.open": (db: Connection, args: { at: number }): OpenInvitation[] =>
    openInvitations(db, args.at),

  // Writes the expiry of every open invitation whose time is up; the count it ended.
  "auth.invitations.expire": (db: Connection, args: { at: number }): number =>
    statement(
      db,
      `UPDATE auth_invitations SET state = 'expired', secret_hash = NULL, ended_at_ms = ?
       WHERE state = 'open' AND expires_at_ms <= ?`,
    ).run(args.at, args.at).changes,

  // The newest invitations first, open ones before ended ones (D6 states, AUTH_LIMITS).
  "auth.invitations.list": (db: Connection, args: { at: number }): InvitationRecord[] =>
    (
      statement(
        db,
        `SELECT ${INVITATION_COLUMNS} FROM auth_invitations
         ORDER BY (state = 'open' AND expires_at_ms > ?) DESC, created_at_ms DESC, invite_id
         LIMIT ?`,
      ).all(args.at, AUTH_LIMITS.listedInvitations) as InvitationRow[]
    ).map((row) => invitationRecord(row, args.at)),

  "auth.devices.list": (db: Connection, args: { includeRevoked: boolean }): DeviceRecord[] =>
    (
      statement(
        db,
        `SELECT ${DEVICE_COLUMNS} FROM auth_devices
         WHERE ? OR revoked_at_ms IS NULL ORDER BY created_at_ms, device_id LIMIT ?`,
      ).all(args.includeRevoked ? 1 : 0, AUTH_LIMITS.listedDevices) as DeviceRow[]
    ).map(deviceRecord),

  // Pairing redemption (D6), one transaction: the invitation is checked and, with the right
  // secret, redeemed together with the creation of its device, so no device ever exists without
  // the invitation that admitted it ending, and an invitation is redeemed at most once. A wrong
  // secret is counted and the count is committed (it is not rolled back with a refusal): the
  // invitation is cancelled at AUTH_LIMITS.invitationWrongSecrets. Every refusal is the same
  // answer, so the caller cannot tell an unknown invitation from an ended one or a wrong secret.
  "auth.redeem": (
    db: Connection,
    args: RedeemArgs,
  ): { redeemed: true; deviceId: string } | { redeemed: false } => {
    const row = invitation(db, args.inviteId);
    if (!row || row.state !== "open" || !row.secret_hash) return { redeemed: false };
    if (effectiveState(row, args.at) === "expired") {
      endInvitation(db, row.invite_id, "expired", args.at);
      return { redeemed: false };
    }
    if (!sameHash(row.secret_hash, args.secretHash)) {
      const wrong = row.wrong_secrets + 1;
      statement(db, "UPDATE auth_invitations SET wrong_secrets = ? WHERE invite_id = ?").run(
        wrong,
        row.invite_id,
      );
      if (wrong >= AUTH_LIMITS.invitationWrongSecrets)
        endInvitation(db, row.invite_id, "cancelled", args.at);
      return { redeemed: false };
    }
    statement(
      db,
      `INSERT INTO auth_devices (device_id, revision, name, invite_id, token_hash, created_at_ms)
       VALUES (?, 0, ?, ?, ?, ?)`,
    ).run(
      args.device.deviceId,
      args.device.name,
      row.invite_id,
      blob(args.device.tokenHash),
      args.at,
    );
    endInvitation(db, row.invite_id, "redeemed", args.at, args.device.deviceId);
    return { redeemed: true, deviceId: args.device.deviceId };
  },

  // A successful authentication of a device (auth/devices.ts), written after the fact and
  // coalesced there. `promotedHash` is set when the device authenticated with its pending token
  // (D4 phase two): that token becomes the current one. It is written unconditionally, and the
  // pending hash is cleared only while it is still the one promoted: a rotation that replaced it
  // meanwhile keeps its newer pending token. The authenticator issues promotions in the order it
  // made them and the store runs calls in order, so the stored current token is the last promoted.
  "auth.devices.touch": (
    db: Connection,
    args: { deviceId: string; at: number; entry: EntryKind; promotedHash?: Uint8Array },
  ): void => {
    statement(
      db,
      "UPDATE auth_devices SET last_used_at_ms = ?, last_entry = ? WHERE device_id = ?",
    ).run(args.at, args.entry, args.deviceId);
    if (args.promotedHash)
      statement(
        db,
        `UPDATE auth_devices SET token_hash = ?,
           pending_token_hash = CASE WHEN pending_token_hash = ? THEN NULL ELSE pending_token_hash END
         WHERE device_id = ?`,
      ).run(blob(args.promotedHash), blob(args.promotedHash), args.deviceId);
  },
});

type WriteOutcome = { result: OperationResultData } | { error: DomainError };

// Database writes applied inside receipts.write (store/sql/receipts.ts), in the same transaction
// as the receipt. Each result holds the references the M2 record projection allows for its method
// (rpc-methods.ts M2_RECORD_RESULT_KEYS), never a secret or a hash.
export const authWrites = {
  // A new open invitation. One created by a device needs that device unrevoked at commit: a
  // revocation committed while the request waited must not leave the revoked device a usable
  // invitation (D8).
  "auth.invite.create": (
    db: Connection,
    args: {
      inviteId: string;
      secretHash: Uint8Array;
      at: number;
      expiresAtMs: number;
      createdByDeviceId: string | null;
      pairingPort: number;
    },
  ): WriteOutcome => {
    if (args.createdByDeviceId !== null) {
      const creator = device(db, args.createdByDeviceId);
      if (!creator || creator.revoked_at_ms !== null)
        return { error: domainError("DEVICE_REVOKED") };
    }
    statement(
      db,
      `INSERT INTO auth_invitations (invite_id, state, secret_hash, created_at_ms, expires_at_ms,
         created_by_device_id, pairing_port) VALUES (?, 'open', ?, ?, ?, ?, ?)`,
    ).run(
      args.inviteId,
      blob(args.secretHash),
      args.at,
      args.expiresAtMs,
      args.createdByDeviceId,
      args.pairingPort,
    );
    return {
      result: {
        inviteId: args.inviteId,
        expiresAtMs: args.expiresAtMs,
        secretDelivery: "first-response-only",
      },
    };
  },

  // Cancels an open invitation. One that already ended cannot be cancelled: the refusal says
  // which family of reason without saying which state (the caller is the owner, so naming the
  // missing invitation apart is safe).
  "auth.invite.cancel": (db: Connection, args: { inviteId: string; at: number }): WriteOutcome => {
    const row = invitation(db, args.inviteId);
    if (!row) return { error: domainError("INVITATION_NOT_FOUND") };
    if (effectiveState(row, args.at) !== "open")
      return { error: domainError("INVITATION_UNAVAILABLE") };
    endInvitation(db, row.invite_id, "cancelled", args.at);
    return { result: { inviteId: row.invite_id } };
  },

  "auth.device.rename": (
    db: Connection,
    args: { deviceId: string; name: string; expectedRevision?: number },
  ): WriteOutcome => {
    const row = device(db, args.deviceId);
    if (!row) return { error: domainError("DEVICE_NOT_FOUND") };
    if (args.expectedRevision !== undefined && args.expectedRevision !== row.revision)
      return { error: domainError("REVISION_CONFLICT") };
    if (row.revision >= Number.MAX_SAFE_INTEGER) return { error: domainError("COUNTER_EXHAUSTED") };
    statement(db, "UPDATE auth_devices SET name = ?, revision = ? WHERE device_id = ?").run(
      args.name,
      row.revision + 1,
      row.device_id,
    );
    return { result: { deviceId: row.device_id } };
  },

  // Revocation (D8), one transaction: the device is marked revoked, a pending rotated token is
  // dropped, and every invitation it created that is still open is cancelled. Revoking an already
  // revoked device changes nothing and succeeds. Closing its connections follows the commit, on
  // the main thread (auth/service.ts).
  "auth.device.revoke": (db: Connection, args: { deviceId: string; at: number }): WriteOutcome => {
    const row = device(db, args.deviceId);
    if (!row) return { error: domainError("DEVICE_NOT_FOUND") };
    if (row.revoked_at_ms === null) {
      if (row.revision >= Number.MAX_SAFE_INTEGER)
        return { error: domainError("COUNTER_EXHAUSTED") };
      statement(
        db,
        `UPDATE auth_devices SET revoked_at_ms = ?, pending_token_hash = NULL, revision = ?
         WHERE device_id = ?`,
      ).run(args.at, row.revision + 1, row.device_id);
    }
    statement(
      db,
      `UPDATE auth_invitations SET state = 'cancelled', secret_hash = NULL, ended_at_ms = ?
       WHERE created_by_device_id = ? AND state = 'open'`,
    ).run(args.at, row.device_id);
    return { result: { deviceId: row.device_id } };
  },

  // D4 phase one: a new pending token for the calling device, replacing any earlier pending one
  // (a rotation whose answer was lost is recovered by rotating again with the old token). The
  // current token stays valid until the pending one first authenticates.
  "auth.device.rotate": (
    db: Connection,
    args: { deviceId: string; pendingTokenHash: Uint8Array },
  ): WriteOutcome => {
    const row = device(db, args.deviceId);
    if (!row || row.revoked_at_ms !== null) return { error: domainError("DEVICE_REVOKED") };
    statement(db, "UPDATE auth_devices SET pending_token_hash = ? WHERE device_id = ?").run(
      blob(args.pendingTokenHash),
      row.device_id,
    );
    return { result: { deviceId: row.device_id, secretDelivery: "first-response-only" } };
  },
};
