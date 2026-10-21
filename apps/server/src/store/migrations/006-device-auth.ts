// Migration 006: device authorization (m2 T1, D4–D8; store/sql/auth.ts, apps/server/src/auth/).
//
// auth_invitations has one row per invitation. Only the SHA-256 of its one-time secret is kept,
// and only while the invitation is open: the transaction that ends it (redeemed, cancelled,
// expired, or cancelled after AUTH_LIMITS.invitationWrongSecrets wrong secrets) clears
// secret_hash, so an ended invitation holds nothing that could be matched again. Every end state
// is final. expires_at_ms is wall-clock time: an invitation outlives a restart and expires on time
// (m2 S12). pairing_port is the port the invitation advertised, which the pairing listener reopens
// on after a restart while the invitation is still open.
//
// auth_devices has one row per paired device. token_hash is the SHA-256 of the secret part of its
// current token; pending_token_hash that of a token issued by auth.device.rotate that has not
// authenticated yet (D4 two-phase rotation: both are accepted until the pending one is first used,
// which makes it the current one). A revoked device keeps its hashes, so that its correct token is
// told DEVICE_REVOKED rather than UNAUTHENTICATED (relay-protocol §11.8), but it never
// authenticates again. last_used_at_ms is NULL for a device that never authenticated (D6:
// never-connected).
//
// Neither table has a foreign key to operations: the invitation and device writes run inside
// receipts.write before it inserts the receipt, and redemption is not an operation at all.
export const MIGRATION_006 = `
CREATE TABLE auth_invitations (
  invite_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open', 'redeemed', 'cancelled', 'expired')),
  secret_hash BLOB CHECK ((state = 'open') = (secret_hash IS NOT NULL)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_by_device_id TEXT,
  pairing_port INTEGER NOT NULL,
  wrong_secrets INTEGER NOT NULL DEFAULT 0,
  redeemed_device_id TEXT,
  ended_at_ms INTEGER
) STRICT;
CREATE INDEX auth_invitations_by_state ON auth_invitations (state, expires_at_ms);
CREATE INDEX auth_invitations_by_creator ON auth_invitations (created_by_device_id, state);
CREATE TABLE auth_devices (
  device_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  invite_id TEXT NOT NULL REFERENCES auth_invitations (invite_id),
  token_hash BLOB NOT NULL,
  pending_token_hash BLOB,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  last_entry TEXT CHECK (last_entry IN ('loopback', 'ssh', 'tsnet')),
  revoked_at_ms INTEGER
) STRICT;
`;
