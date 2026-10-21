// Migration 007: entry configuration and service starts (m2 T3; D2, D3, S1, S2).
//
// entry_config has exactly one row, created here so that a database migrated from an earlier
// schema has it too. It holds the settings of entry.get / entry.set (store/sql/entry.ts; the pure
// rules are config-rules.ts nextEntryConfig). NULL means "not configured": a server without a
// fixed business port binds a free one at each start (M1 behavior), and a server without a fixed
// pairing port opens the pairing listener on the port its open invitations advertise or a free
// one. `cove server install` fixes both ports (D3) so that a paired loopback record and the SSH
// forwards of its clients survive a restart. The ports apply when the server next starts; the SSH
// target applies to invitations created afterwards. The CHECKs repeat the protocol bounds
// (PortSchema) and the distinct-ports rule, so no path can store a pair the server cannot bind.
//
// service_starts has one row per relay instance started by this or a later build: how it was
// started (the service manager, or a foreground `cove server start`), the host boot it ran in, and
// the start reason that server.status reports (service-start.ts). The boot ID is what tells a
// service manager's restart after a crash (same boot, the previous instance never recorded its
// stop) from the first start after a reboot (another boot). An instance of an earlier build has no
// row; such a predecessor's boot is unknown and is never taken to be this boot.
export const MIGRATION_007 = `
CREATE TABLE entry_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  business_port INTEGER CHECK (business_port IS NULL OR business_port BETWEEN 1024 AND 65535),
  pairing_port INTEGER CHECK (pairing_port IS NULL OR pairing_port BETWEEN 1024 AND 65535),
  ssh_target TEXT,
  tsnet_hostname TEXT,
  updated_at_ms INTEGER NOT NULL,
  CHECK (business_port IS NULL OR pairing_port IS NULL OR business_port <> pairing_port)
) STRICT;
INSERT INTO entry_config (id, revision, updated_at_ms) VALUES (1, 0, 0);
CREATE TABLE service_starts (
  relay_instance_id TEXT PRIMARY KEY REFERENCES relay_instances (relay_instance_id),
  manager TEXT NOT NULL CHECK (manager IN ('systemd-user', 'launchd-agent', 'foreground')),
  boot_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'crash-restart', 'boot', 'login', 'unknown'))
) STRICT;
`;
