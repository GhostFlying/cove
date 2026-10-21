import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { formatDeviceToken } from "@cove/protocol/bootstrap";

// Secret material of device authorization (m2 D4, D6). A secret is 256 random bits in base64url
// (43 characters, the InvitationSecretSchema and device-token alphabet). The server keeps only a
// SHA-256 of each secret: they are high-entropy, so a slow hash adds nothing (D4). A secret value
// lives only in the call that issues or checks it; nothing here logs, stores or returns one
// except to the caller that must deliver it.

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function secretHash(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret, "utf8").digest());
}

// Constant-time equality of two hashes. Both are SHA-256 digests, so the lengths only differ for
// a missing hash, which compares unequal without inspecting content.
export function sameHash(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

// Device and invitation IDs are chosen by the server. A UUID fits DeviceIdSchema (it never
// contains ".", which ends the ID inside a token) and says nothing about the secret.
export function newResourceId(): string {
  return randomUUID();
}

// A new token for `deviceId` and the hash the server keeps of its secret part.
export function issueToken(deviceId: string): { token: string; hash: Uint8Array } {
  const secret = newSecret();
  return { token: formatDeviceToken(deviceId, secret), hash: secretHash(secret) };
}
