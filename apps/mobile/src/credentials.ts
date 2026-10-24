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
