import { mkdir, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PendingOperation, SavedServer } from "../shared/api.js";

export interface StoredServer extends SavedServer {
  readonly token: string;
}
export interface SecretCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Uint8Array>;
  decrypt(value: Uint8Array): Promise<string>;
}

const MAX_FILE_BYTES = 1024 * 1024;

/** Atomic replacement only inside the app-owned data directory; existing HOME/ancestors are never hardened. */
async function replaceFile(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    const file = await open(path, "r");
    try {
      if ((await file.stat()).size > MAX_FILE_BYTES)
        throw new Error("Desktop state exceeds its size limit");
      return await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class DesktopStorage {
  private tail: Promise<unknown> = Promise.resolve();
  private servers: StoredServer[] = [];
  private operations: PendingOperation[] = [];
  constructor(
    private readonly directory: string,
    private readonly cipher: SecretCipher,
  ) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  async load(): Promise<void> {
    const [encrypted, ledger] = await Promise.all([
      readBytes(join(this.directory, "credentials.sealed")),
      readBytes(join(this.directory, "operations.json")),
    ]);
    if (encrypted) {
      if (!(await this.cipher.available()))
        throw new Error("macOS Keychain is unavailable; credentials remain sealed");
      const parsed: unknown = JSON.parse(await this.cipher.decrypt(encrypted));
      if (!Array.isArray(parsed) || parsed.length > 64 || !parsed.every(validStoredServer))
        throw new Error("Invalid Desktop credential store; it was preserved");
      this.servers = parsed;
    }
    if (ledger) {
      const parsed: unknown = JSON.parse(ledger.toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length > 256 || !parsed.every(validOperation))
        throw new Error("Invalid Desktop operation ledger; it was preserved");
      this.operations = parsed;
    }
  }
  serverRecords(): readonly StoredServer[] {
    return this.servers.map((server) => structuredClone(server));
  }
  pendingOperations(): readonly PendingOperation[] {
    return this.operations.map((operation) => structuredClone(operation));
  }
  saveServer(server: StoredServer): Promise<void> {
    return this.serial(async () => {
      if (!validStoredServer(server)) throw new Error("Invalid server record");
      if (
        this.servers.some(
          (value) => value.serverId === server.serverId || value.alias === server.alias,
        )
      )
        throw new Error(
          "This server or alias is already paired; explicitly forget and revoke the old device before pairing again",
        );
      if (this.servers.length >= 64) throw new Error("Desktop server capacity reached");
      await this.writeServers([...this.servers, server]);
    });
  }
  forgetServer(serverId: string): Promise<void> {
    return this.serial(() =>
      this.writeServers(this.servers.filter((server) => server.serverId !== serverId)),
    );
  }
  private async writeServers(next: StoredServer[]): Promise<void> {
    if (!(await this.cipher.available()))
      throw new Error("macOS Keychain is unavailable; nothing was saved");
    const encrypted = await this.cipher.encrypt(JSON.stringify(next));
    if (!encrypted.byteLength || encrypted.byteLength > MAX_FILE_BYTES)
      throw new Error("Invalid sealed credential size");
    await replaceFile(this.directory, "credentials.sealed", encrypted);
    this.servers = structuredClone(next);
  }
  recordOperation(operation: PendingOperation): Promise<void> {
    return this.serial(async () => {
      if (!validOperation(operation)) throw new Error("Invalid operation reference");
      const next = this.operations.filter(
        (value) =>
          value.serverId !== operation.serverId || value.operationId !== operation.operationId,
      );
      if (next.length >= 256)
        throw new Error("Operation capacity reached; acknowledge completed observations first");
      next.push(operation);
      await this.writeOperations(next);
    });
  }
  acknowledgeOperation(serverId: string, operationId: string): Promise<void> {
    return this.serial(async () => {
      const found = this.operations.find(
        (value) => value.serverId === serverId && value.operationId === operationId,
      );
      if (found && found.status !== "observed" && found.status !== "not-sent")
        throw new Error("An unresolved operation must remain available for read-only verification");
      if (
        found?.status === "observed" &&
        (!found.result ||
          typeof found.result !== "object" ||
          !["succeeded", "failed", "cancelled"].includes(
            String((found.result as { state?: unknown }).state),
          ))
      )
        throw new Error("An operation still in progress must remain available for verification");
      await this.writeOperations(this.operations.filter((value) => value !== found));
    });
  }
  private async writeOperations(next: PendingOperation[]): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.byteLength > MAX_FILE_BYTES)
      throw new Error("Operation ledger exceeds its size limit");
    await replaceFile(this.directory, "operations.json", bytes);
    this.operations = structuredClone(next);
  }
}

function validStoredServer(value: unknown): value is StoredServer {
  if (!value || typeof value !== "object") return false;
  const row = value as StoredServer;
  return (
    typeof row.alias === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.alias) &&
    typeof row.serverId === "string" &&
    typeof row.deviceId === "string" &&
    typeof row.token === "string" &&
    ["loopback", "ssh", "tsnet"].includes(row.defaultEntry) &&
    !!row.entries &&
    typeof row.entries === "object"
  );
}
function validOperation(value: unknown): value is PendingOperation {
  if (!value || typeof value !== "object") return false;
  const row = value as PendingOperation;
  return (
    [row.serverId, row.relayInstanceId, row.operationId, row.method].every(
      (part) => typeof part === "string" && part.length > 0 && part.length <= 128,
    ) &&
    Number.isSafeInteger(row.createdAtMs) &&
    ["pending", "unknown", "observed", "not-sent"].includes(row.status)
  );
}
