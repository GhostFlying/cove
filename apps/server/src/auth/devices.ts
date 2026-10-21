import type { Store } from "../store/database.js";
import type { StoredDeviceCredential } from "../store/sql/auth.js";
import { StoreUnavailableError } from "../store/store-errors.js";
import { sameHash, secretHash } from "./tokens.js";

export type EntryKind = "loopback" | "ssh" | "tsnet";

// The verdict on one presented device token. `confirm`: the token may be used only once the store
// confirmed it (`promote`): it is the device's rotated token that never authenticated before (D4
// phase two), or a store answer about this device was lost and the copy here may be stale.
export type DeviceVerdict =
  | { readonly kind: "device"; readonly deviceId: string; readonly confirm?: Uint8Array }
  | { readonly kind: "revoked" }
  | { readonly kind: "unauthenticated" };

// What `promote` makes of a verdict that needed confirmation. `unavailable`: the store could not
// confirm it now; the token may be valid and the caller is told to retry (never UNAUTHENTICATED).
export type ConfirmedVerdict =
  | { readonly kind: "device"; readonly deviceId: string }
  | { readonly kind: "revoked" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "unavailable" };

type Entry = {
  tokenHash: Uint8Array;
  pendingTokenHash: Uint8Array | null;
  revoked: boolean;
  // A promotion failed with an unknown outcome: the store may hold a newer credential than this
  // copy, so every token of the device is confirmed against the store before it is used again.
  uncertain: boolean;
  // The last use known here, and the last one written to the store. They differ under steady
  // traffic: a use within TOUCH_INTERVAL_MS of the last written one is not written by itself.
  lastUsedAtMs: number | null;
  lastEntry: EntryKind | null;
  persistedAtMs: number | null;
  persistedEntry: EntryKind | null;
  // The touch write in flight for this device, and whether another is due after it.
  writing: Promise<void> | null;
  dirty: boolean;
  // The promotion in flight for this device. One at a time: concurrent first uses of a new token
  // wait for it and then find the token current.
  promoting: Promise<ConfirmedVerdict> | null;
};

// A device that authenticated again within this time of its last written use is not written again
// just for its last-use time; a change of entry is always written.
const TOUCH_INTERVAL_MS = 60_000;
// Compared against when a token names an unknown device, so that an unknown device costs the same
// hash and comparison as a known one with a wrong secret.
const DUMMY_HASH = secretHash("cove-unknown-device");

// The device credentials of this server, held in memory so that every HTTP request and terminal
// first frame is verified synchronously in the transport (local-admission.ts). The store is the
// durable source: the authenticator is loaded from it at startup, and every change is made to the
// store first and mirrored here only after it committed (auth/service.ts). That includes the
// promotion of a rotated token (D4 phase two): the first request presenting it waits for `promote`
// to commit before it is admitted, so no answer to a new-token request precedes the durable
// invalidation of the old token, and a restart cannot bring the old token back. Only the last-use
// time is written after the fact; losing it loses no authorization state.
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
      uncertain: false,
      lastUsedAtMs: device.lastUsedAtMs,
      lastEntry: device.lastEntry ?? null,
      persistedAtMs: device.lastUsedAtMs,
      persistedEntry: device.lastEntry ?? null,
      writing: null,
      dirty: false,
      promoting: null,
    });
  }

  // Checks a token's parts. Both hashes are always compared, in constant time, and an unknown
  // device is compared against a dummy hash: the answer for a wrong secret and for an unknown
  // device is the same UNAUTHENTICATED and costs the same. Only the correct secret of a revoked
  // device is told so (relay-protocol §11.8). Pure: nothing is recorded until `touch`/`promote`.
  verify(deviceId: string, secret: string): DeviceVerdict {
    const hash = secretHash(secret);
    const entry = this.devices.get(deviceId);
    const current = sameHash(entry?.tokenHash ?? DUMMY_HASH, hash);
    const pending = sameHash(entry?.pendingTokenHash ?? DUMMY_HASH, hash);
    if (!entry || (!current && !pending)) return { kind: "unauthenticated" };
    if (entry.revoked) return { kind: "revoked" };
    if (entry.uncertain || !current) return { kind: "device", deviceId, confirm: hash };
    return { kind: "device", deviceId };
  }

  // Confirms a verdict against the store before the transport admits anything with it. A pending
  // token is promoted in one committed transaction (store/sql/auth.ts auth.devices.promote), and
  // only then is the copy here updated: from the store's committed credential for the device,
  // whatever the update did, which also repairs a copy left stale by a lost answer. A store failure
  // leaves the copy unchanged and answers `unavailable`; a failure whose outcome is unknown also
  // marks the device uncertain, so both of its tokens are confirmed again next time rather than
  // trusting a copy the store may have moved past.
  async promote(
    verdict: Extract<DeviceVerdict, { kind: "device" }>,
    entryKind: EntryKind,
  ): Promise<ConfirmedVerdict> {
    const hash = verdict.confirm;
    if (!hash) return { kind: "device", deviceId: verdict.deviceId };
    const entry = this.devices.get(verdict.deviceId);
    if (!entry || !this.store) return { kind: "unavailable" };
    // A promotion in flight may already settle this token (two first uses at once).
    while (entry.promoting) await entry.promoting;
    const before = this.check(entry, hash);
    if (before !== "confirm") return this.answer(verdict.deviceId, before);
    const promotion = this.runPromotion(this.store, verdict.deviceId, entry, hash, entryKind);
    entry.promoting = promotion;
    try {
      return await promotion;
    } finally {
      entry.promoting = null;
    }
  }

  private async runPromotion(
    store: Store,
    deviceId: string,
    entry: Entry,
    hash: Uint8Array,
    entryKind: EntryKind,
  ): Promise<ConfirmedVerdict> {
    const at = this.now();
    let result: { promoted: boolean; device: StoredDeviceCredential | null };
    try {
      result = await store.call("auth.devices.promote", { deviceId, hash, at, entry: entryKind });
    } catch (error) {
      if (!(error instanceof StoreUnavailableError) || error.outcome !== "not-sent")
        entry.uncertain = true;
      return { kind: "unavailable" };
    }
    if (!result.device) return { kind: "unauthenticated" };
    entry.tokenHash = result.device.tokenHash;
    entry.pendingTokenHash = result.device.pendingTokenHash;
    entry.revoked = entry.revoked || result.device.revoked;
    entry.uncertain = false;
    if (result.promoted) {
      entry.lastUsedAtMs = entry.persistedAtMs = at;
      entry.lastEntry = entry.persistedEntry = entryKind;
    }
    const after = this.check(entry, hash);
    // Still unconfirmed: the token is the store's pending one and yet was not promoted, which only
    // a store change between the update and this check can cause; a retry sees the settled state.
    return after === "confirm" ? { kind: "unavailable" } : this.answer(deviceId, after);
  }

  // A token hash against the copy here: usable now, refused, or still to be confirmed.
  private check(
    entry: Entry,
    hash: Uint8Array,
  ): "device" | "revoked" | "unauthenticated" | "confirm" {
    const current = sameHash(entry.tokenHash, hash);
    const pending = entry.pendingTokenHash !== null && sameHash(entry.pendingTokenHash, hash);
    if (!current && !pending) return "unauthenticated";
    if (entry.revoked) return "revoked";
    return current && !entry.uncertain ? "device" : "confirm";
  }

  private answer(
    deviceId: string,
    kind: "device" | "revoked" | "unauthenticated",
  ): ConfirmedVerdict {
    return kind === "device" ? { kind, deviceId } : { kind };
  }

  // Records the last use of a device the transport admitted with a confirmed verdict. It is
  // written when the store has no use of the device, the entry changed, or the last written use is
  // TOUCH_INTERVAL_MS old, so steady traffic still updates it at that interval.
  touch(verdict: { readonly deviceId: string }, entryKind: EntryKind): void {
    const entry = this.devices.get(verdict.deviceId);
    if (!entry || entry.revoked) return;
    const at = this.now();
    entry.lastUsedAtMs = at;
    entry.lastEntry = entryKind;
    const due =
      entry.persistedAtMs === null ||
      entry.persistedEntry !== entryKind ||
      at - entry.persistedAtMs >= TOUCH_INTERVAL_MS;
    if (due) this.write(verdict.deviceId, entry);
  }

  // One touch write at a time per device; one more is written after it when a use came meanwhile.
  // A failure is reported and dropped: the last-use time is informational.
  private write(deviceId: string, entry: Entry): void {
    if (!this.store) return;
    if (entry.writing) {
      entry.dirty = true;
      return;
    }
    const store = this.store;
    const touch = { deviceId, at: entry.lastUsedAtMs!, entry: entry.lastEntry! };
    entry.writing = (async () => {
      try {
        await store.call("auth.devices.touch", touch);
        if (entry.persistedAtMs === null || touch.at >= entry.persistedAtMs) {
          entry.persistedAtMs = touch.at;
          entry.persistedEntry = touch.entry;
        }
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

  // Resolves when every touch write and promotion started so far has settled (orderly shutdown,
  // tests).
  async settled(): Promise<void> {
    for (;;) {
      const writing = [...this.devices.values()]
        .flatMap((entry) => [entry.writing, entry.promoting])
        .filter((value) => value !== null);
      if (writing.length === 0) return;
      await Promise.all(writing);
    }
  }
}
