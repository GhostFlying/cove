import { randomBytes, randomUUID } from "node:crypto";
import { open, lstat, unlink, link } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { RendezvousSchema } from "@cove/protocol/bootstrap";

export function launchIdentity() {
  return {
    serverId: randomUUID(),
    relayInstanceId: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
  };
}

// The open handle's identity prevents cleanup from removing a replaced foreign file.
export class LocalRendezvous {
  private handle: FileHandle | undefined;
  private ownership: { dev: number; ino: number } | undefined;
  private pending: Promise<void> | undefined;
  private temporary: string | undefined;
  private published = false;
  private retired = false;
  private closing: Promise<void> | undefined;
  constructor(readonly path: string) {}
  async publish(input: unknown): Promise<void> {
    const parsed = RendezvousSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid local rendezvous");
    if (this.pending || this.handle || this.retired)
      throw new Error("Rendezvous already owned or retired");
    this.pending = this.write(parsed.data);
    return this.pending;
  }
  private async write(data: unknown): Promise<void> {
    try {
      this.temporary = `${this.path}.${randomUUID()}.tmp`;
      this.handle = await open(this.temporary, "wx", 0o600);
      const stat = await this.handle.stat();
      this.ownership = { dev: stat.dev, ino: stat.ino };
      await this.handle.chmod(0o600);
      await this.handle.writeFile(JSON.stringify(data), "utf8");
      await this.handle.sync();
      if (this.retired) throw new Error("Rendezvous retired before publication");
      // A complete inode is published atomically; link refuses a pre-existing path.
      await link(this.temporary, this.path);
      this.published = true;
      await this.removeOwned(this.temporary);
      this.temporary = undefined;
    } catch {
      this.retired = true;
      await this.cleanup();
      throw new Error("Local rendezvous publication failed");
    }
  }
  private async removeOwned(path: string): Promise<void> {
    if (!this.ownership) throw new Error("Rendezvous ownership unverifiable");
    try {
      const current = await lstat(path);
      if (current.dev === this.ownership.dev && current.ino === this.ownership.ino)
        await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Owned rendezvous cleanup unverifiable");
    }
  }
  close(): Promise<void> {
    this.retired = true;
    return (this.closing ??= (async () => {
      try {
        await this.pending;
      } catch {
        /* The publisher retains its original failure. */
      }
      await this.cleanup();
    })());
  }
  private async cleanup(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    let failed = false;
    try {
      await handle?.close();
    } catch {
      failed = true;
    }
    for (const path of [this.published ? this.path : undefined, this.temporary]) {
      if (!path) continue;
      try {
        await this.removeOwned(path);
      } catch {
        failed = true;
      }
    }
    if (!failed) {
      this.ownership = undefined;
      this.published = false;
      this.temporary = undefined;
    }
    if (failed) throw new Error("Owned rendezvous cleanup unverifiable");
  }
}
