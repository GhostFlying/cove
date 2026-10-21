import type { Store } from "../store/database.js";
import type { StoredDeviceCredential } from "../store/sql/auth.js";
import { sameHash, secretHash } from "./tokens.js";

export type EntryKind = "loopback" | "ssh" | "tsnet";

// The verdict on one presented device token. `pending`: the secret matched the device's rotated,
// not yet used token (D4 phase two), which `touch` then makes the current one.
export type DeviceVerdict =
  | { readonly kind: "device"; readonly deviceId: string; readonly pending: boolean }
  | { readonly kind: "revoked" }
  | { readonly kind: "unauthenticated" };

type Entry = {
  tokenHash: Uint8Array;
  pendingTokenHash: Uint8Array | null;
  revoked: boolean;
  lastUsedAtMs: number | null;
  lastEntry: EntryKind | null;
  // The touch write in flight for this device, and whether another is due after it.
  writing: Promise<void> | null;
  dirty: boolean;
  promotions: Uint8Array[];
};

// A device that authenticated again within this time is not written again just for its last-use
// time; a change of entry or a promoted token is always written.
const TOUCH_INTERVAL_MS = 60_000;
// Compared against when a token names an unknown device, so that an unknown device costs the same
// hash and comparison as a known one with a wrong secret.
const DUMMY_HASH = secretHash("cove-unknown-device");

// The device credentials of this server, held in memory so that every HTTP request and terminal
// first frame is verified synchronously in the transport (local-admission.ts). The store is the
// durable source: the authenticator is loaded from it at startup, and every change is made to the
// store first and mirrored here only after it committed (auth/service.ts), with one exception that
// is safe in both directions: a successful authentication (last use, and the promotion of a pending
// token) is applied here at once and written afterwards. If that write is lost, the store still
// holds the pending token, which the device presents again and which is promoted again.
export class DeviceAuthenticator {
  private readonly devices = new Map<string, Entry>();

  constructor(
    private readonly store: Store | undefined,
    private readonly now: () => number,
    private readonly onWriteFailure: (deviceId: string) => void = () => undefined,
  ) {}

  load(devices: readonly StoredDeviceCredential[]): void {
    for (const device of devices) this.add(device);
  }

  add(device: Omit<StoredDeviceCredential, "lastEntry"> & { lastEntry?: EntryKind | null }): void {
    this.devices.set(device.deviceId, {
      tokenHash: device.tokenHash,
      pendingTokenHash: device.pendingTokenHash,
      revoked: device.revoked,
      lastUsedAtMs: device.lastUsedAtMs,
      lastEntry: device.lastEntry ?? null,
      writing: null,
      dirty: false,
      promotions: [],
    });
  }

  // Checks a token's parts. Both hashes are always compared, in constant time, and an unknown
  // device is compared against a dummy hash: the answer for a wrong secret and for an unknown
  // device is the same UNAUTHENTICATED and costs the same. Only the correct secret of a revoked
  // device is told so (relay-protocol §11.8). Pure: nothing is recorded until `touch`.
  verify(deviceId: string, secret: string): DeviceVerdict {
    const hash = secretHash(secret);
    const entry = this.devices.get(deviceId);
    const current = sameHash(entry?.tokenHash ?? DUMMY_HASH, hash);
    const pending = sameHash(entry?.pendingTokenHash ?? DUMMY_HASH, hash);
    if (!entry || (!current && !pending)) return { kind: "unauthenticated" };
    if (entry.revoked) return { kind: "revoked" };
    return { kind: "device", deviceId, pending: pending && !current };
  }

  // Records a successful authentication that the transport admitted. Presenting the pending
  // token makes it the current one and invalidates the old token (D4); the order of promotions is
  // preserved in the writes (store/sql/auth.ts auth.devices.touch).
  touch(verdict: Extract<DeviceVerdict, { kind: "device" }>, entryKind: EntryKind): void {
    const entry = this.devices.get(verdict.deviceId);
    if (!entry || entry.revoked) return;
    const at = this.now();
    let due =
      entry.lastUsedAtMs === null ||
      entry.lastEntry !== entryKind ||
      at - entry.lastUsedAtMs >= TOUCH_INTERVAL_MS;
    if (verdict.pending && entry.pendingTokenHash) {
      entry.promotions.push(entry.pendingTokenHash);
      entry.tokenHash = entry.pendingTokenHash;
      entry.pendingTokenHash = null;
      due = true;
    }
    entry.lastUsedAtMs = at;
    entry.lastEntry = entryKind;
    if (due) this.write(verdict.deviceId, entry);
  }

  // One touch write at a time per device; one more is written after it when anything changed
  // meanwhile. A failure is reported and dropped: the store keeps the previous state, which stays
  // safe (see the class comment).
  private write(deviceId: string, entry: Entry): void {
    if (!this.store) return;
    if (entry.writing) {
      entry.dirty = true;
      return;
    }
    const promotions = entry.promotions.splice(0);
    const store = this.store;
    entry.writing = (async () => {
      try {
        // Each promotion is written in the order it was made; without one, the last use alone.
        const touch = { deviceId, at: entry.lastUsedAtMs!, entry: entry.lastEntry! };
        if (promotions.length === 0) await store.call("auth.devices.touch", touch);
        for (const promotedHash of promotions)
          await store.call("auth.devices.touch", { ...touch, promotedHash });
      } catch {
        this.onWriteFailure(deviceId);
      } finally {
        entry.writing = null;
        if (entry.dirty) {
          entry.dirty = false;
          this.write(deviceId, entry);
        }
      }
    })();
  }

  // D4 phase one committed: the new token is accepted beside the current one.
  setPending(deviceId: string, hash: Uint8Array): void {
    const entry = this.devices.get(deviceId);
    if (entry) entry.pendingTokenHash = hash;
  }

  // D8: committed revocation. From now on the device's token is DEVICE_REVOKED everywhere.
  markRevoked(deviceId: string): void {
    const entry = this.devices.get(deviceId);
    if (!entry) return;
    entry.revoked = true;
    entry.pendingTokenHash = null;
  }

  // The last use known here, which may be newer than the store's (touch writes after the fact).
  lastUse(deviceId: string): { lastUsedAtMs: number; lastEntry: EntryKind } | null {
    const entry = this.devices.get(deviceId);
    return entry && entry.lastUsedAtMs !== null && entry.lastEntry !== null
      ? { lastUsedAtMs: entry.lastUsedAtMs, lastEntry: entry.lastEntry }
      : null;
  }

  // Resolves when every touch write started so far has settled (orderly shutdown, tests).
  async settled(): Promise<void> {
    for (;;) {
      const writing = [...this.devices.values()]
        .map((entry) => entry.writing)
        .filter((value) => value !== null);
      if (writing.length === 0) return;
      await Promise.all(writing);
    }
  }
}
