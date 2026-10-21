import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The compiled server's modules, as auth-server-entry.mjs loads them.
const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const dist = (path) => import(pathToFileURL(join(serverPackage, "dist", path)).href);
const { DeviceAuthenticator } = await dist("auth/devices.js");
const { secretHash } = await dist("auth/tokens.js");
const { StoreUnavailableError } = await dist("store/store-errors.js");

// The device authenticator against a scripted store (auth/devices.ts): when a rotated token is
// trusted, what a failed promotion leaves behind, and when a last use is written.

const OLD = "old-secret";
const NEW = "new-secret";

function scriptedStore(answer) {
  const calls = [];
  return {
    calls,
    call(name, args) {
      calls.push({ name, args });
      return answer(name, args);
    },
  };
}

function authenticator(store, clock = { at: 1_000 }) {
  const devices = new DeviceAuthenticator(store, () => clock.at);
  devices.add({
    deviceId: "d",
    tokenHash: secretHash(OLD),
    pendingTokenHash: secretHash(NEW),
    revoked: false,
    lastUsedAtMs: null,
  });
  return devices;
}

const promoted = (args) => ({
  promoted: true,
  device: {
    deviceId: "d",
    tokenHash: args.hash,
    pendingTokenHash: null,
    revoked: false,
    lastUsedAtMs: args.at,
    lastEntry: args.entry,
  },
});

describe("rotated token promotion", () => {
  it("trusts the new token only after the store committed the promotion", async () => {
    let commit;
    const store = scriptedStore(
      (name, args) =>
        new Promise(
          (done) => (commit = () => done(name === "auth.devices.promote" && promoted(args))),
        ),
    );
    const devices = authenticator(store);
    const verdict = devices.verify("d", NEW);
    expect(verdict).toMatchObject({ kind: "device", deviceId: "d" });
    expect(verdict.confirm).toBeInstanceOf(Uint8Array);
    const confirming = devices.promote(verdict, "loopback");
    // Until the commit, the copy here is unchanged: both tokens still need what they needed.
    expect(devices.verify("d", OLD)).toEqual({ kind: "device", deviceId: "d" });
    expect(devices.verify("d", NEW).confirm).toBeInstanceOf(Uint8Array);
    commit();
    expect(await confirming).toEqual({ kind: "device", deviceId: "d" });
    expect(devices.verify("d", NEW)).toEqual({ kind: "device", deviceId: "d" });
    expect(devices.verify("d", OLD)).toEqual({ kind: "unauthenticated" });
    expect(store.calls.map(({ name }) => name)).toEqual(["auth.devices.promote"]);
  });

  it("answers a refused promotion unavailable and keeps both tokens", async () => {
    const store = scriptedStore(() =>
      Promise.reject(new StoreUnavailableError("busy", "not-sent")),
    );
    const devices = authenticator(store);
    expect(await devices.promote(devices.verify("d", NEW), "loopback")).toEqual({
      kind: "unavailable",
    });
    expect(devices.verify("d", OLD)).toEqual({ kind: "device", deviceId: "d" });
    expect(devices.verify("d", NEW).confirm).toBeInstanceOf(Uint8Array);
  });

  it("confirms both tokens again after a promotion whose outcome is unknown", async () => {
    let failing = true;
    const store = scriptedStore((name, args) => {
      if (failing) return Promise.reject(new StoreUnavailableError("failed", "unknown"));
      // The lost promotion had committed: the store already holds the new token as current.
      return Promise.resolve({ ...promoted({ ...args, hash: secretHash(NEW) }), promoted: false });
    });
    const devices = authenticator(store);
    expect(await devices.promote(devices.verify("d", NEW), "loopback")).toEqual({
      kind: "unavailable",
    });
    // The old token may already be invalid in the store, so it is not trusted from memory.
    const old = devices.verify("d", OLD);
    expect(old.confirm).toBeInstanceOf(Uint8Array);
    failing = false;
    expect(await devices.promote(old, "loopback")).toEqual({ kind: "unauthenticated" });
    expect(devices.verify("d", NEW)).toEqual({ kind: "device", deviceId: "d" });
  });

  it("runs one promotion for concurrent first uses", async () => {
    const store = scriptedStore((_name, args) => Promise.resolve(promoted(args)));
    const devices = authenticator(store);
    const results = await Promise.all([
      devices.promote(devices.verify("d", NEW), "loopback"),
      devices.promote(devices.verify("d", NEW), "loopback"),
    ]);
    expect(results).toEqual([
      { kind: "device", deviceId: "d" },
      { kind: "device", deviceId: "d" },
    ]);
    expect(store.calls).toHaveLength(1);
  });
});

describe("last use", () => {
  it("is written at the interval under steady traffic", async () => {
    const clock = { at: 0 };
    const store = scriptedStore(() => Promise.resolve());
    const devices = authenticator(store, clock);
    const written = () => store.calls.map(({ args }) => args.at);
    // A use every 30 s for three minutes: written at first use and whenever the last written use
    // is a minute old, although the device was never idle for a minute.
    for (clock.at = 0; clock.at <= 180_000; clock.at += 30_000) {
      devices.touch({ deviceId: "d" }, "loopback");
      await devices.settled();
    }
    expect(written()).toEqual([0, 60_000, 120_000, 180_000]);
    expect(devices.lastUse("d")).toEqual({ lastUsedAtMs: 180_000, lastEntry: "loopback" });
  });

  it("is written at once when the entry changes", async () => {
    const clock = { at: 0 };
    const store = scriptedStore(() => Promise.resolve());
    const devices = authenticator(store, clock);
    devices.touch({ deviceId: "d" }, "loopback");
    await devices.settled();
    clock.at = 1_000;
    devices.touch({ deviceId: "d" }, "ssh");
    await devices.settled();
    expect(store.calls.map(({ args }) => [args.at, args.entry])).toEqual([
      [0, "loopback"],
      [1_000, "ssh"],
    ]);
  });
});
