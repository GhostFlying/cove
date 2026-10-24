import { z } from "zod";
import { DeviceTokenSchema } from "@cove/protocol/bootstrap";
import { TsnetNodeIdSchema, PortSchema } from "@cove/protocol/auth";
import { OpaqueIdSchema } from "@cove/protocol/identity";

export const savedServerSchema = z
  .object({
    serverId: OpaqueIdSchema,
    peerID: TsnetNodeIdSchema,
    port: PortSchema,
    token: DeviceTokenSchema,
  })
  .strict();
export type SavedServer = z.infer<typeof savedServerSchema>;

// The real host supplies only platform SecureStore methods. Test injection
// verifies persistence failures without introducing a plaintext fallback.
export interface SecureTokenStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export type SecureStoreFailureReason =
  "missing-entitlement" | "interaction-disallowed" | "unavailable" | "read-mismatch" | "unknown";

// Pinned Expo KeyChainException emits these fixed platform reasons. Reflect
// only their classifications, never the original error, key or stored value.
export function secureStoreFailureReason(error: unknown): SecureStoreFailureReason {
  if (typeof error !== "object" || error === null || !("message" in error)) return "unknown";
  const message = error.message;
  if (typeof message !== "string" || message.length > 4096) return "unknown";
  if (message.includes("A required entitlement isn't present.")) return "missing-entitlement";
  if (message.includes("User interaction is not allowed.")) return "interaction-disallowed";
  if (message.includes("No keychain is available.")) return "unavailable";
  return "unknown";
}

type StoreOperation = "write" | "read" | "delete";

class NativeStoreProbeFailure extends Error {
  readonly code: string;

  constructor(
    operation: StoreOperation,
    reason: SecureStoreFailureReason,
    cleanup: "confirmed" | "unverified",
  ) {
    super(`SecureStore ${operation}: ${reason}; synthetic-key cleanup ${cleanup}.`);
    this.code = `COVE_NATIVE_STORE_${reason.toUpperCase().replaceAll("-", "_")}`;
  }
}

// The caller supplies a fresh synthetic key using exactly the real credential
// API/options. This probe never reads or overwrites the saved pairing record.
export async function probeSecureStore(store: SecureTokenStore): Promise<void> {
  const synthetic = "cove-native-secure-store-probe-v1";
  let operation: StoreOperation = "write";
  let failedOperation: StoreOperation | undefined;
  let reason: SecureStoreFailureReason = "unknown";
  let cleanup: "confirmed" | "unverified" = "unverified";
  try {
    await store.write(synthetic);
    operation = "read";
    if ((await store.read()) !== synthetic) {
      failedOperation = "read";
      reason = "read-mismatch";
    }
  } catch (error) {
    failedOperation = operation;
    reason = secureStoreFailureReason(error);
  }
  try {
    await store.remove();
    cleanup = "confirmed";
  } catch (error) {
    if (!failedOperation) {
      failedOperation = "delete";
      reason = secureStoreFailureReason(error);
    }
  }
  if (failedOperation) throw new NativeStoreProbeFailure(failedOperation, reason, cleanup);
}

export async function saveServer(store: SecureTokenStore, server: SavedServer): Promise<void> {
  const raw = JSON.stringify(savedServerSchema.parse(server));
  if (raw.length > 2048) throw new Error("Native credential record exceeded bound");
  await store.write(raw);
}

export async function loadServer(store: SecureTokenStore): Promise<SavedServer | null> {
  const raw = await store.read();
  if (raw === null) return null;
  if (raw.length > 2048) throw new Error("Native credential record exceeded bound");
  return savedServerSchema.parse(JSON.parse(raw));
}
