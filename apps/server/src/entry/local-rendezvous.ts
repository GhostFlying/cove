import { randomBytes, randomUUID } from "node:crypto";
import { open, lstat, stat, unlink, link, mkdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { RendezvousSchema } from "@cove/protocol/bootstrap";
import { checkManagedDirectory, HomeError } from "../store/home.js";

export function launchIdentity(): { serverId: string; relayInstanceId: string; secret: string } {
  return {
    serverId: randomUUID(),
    relayInstanceId: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
  };
}

// A publication failure with its cause (#172): a refused directory or a failed system call is what
// the person starting the server has to fix. The cause names paths, uids, modes and system call
// codes only; the record's contents (the secret) never appear in it.
export class RendezvousPublicationError extends Error {
  constructor(cause: string) {
    super(`Local rendezvous publication failed: ${cause}`);
    this.name = "RendezvousPublicationError";
  }
}

// A refusal of this module's own, whose message is safe to report.
class RendezvousPathError extends Error {}

function publicationCause(error: unknown): string {
  if (error instanceof HomeError || error instanceof RendezvousPathError) return error.message;
  const errno = error as NodeJS.ErrnoException | undefined;
  if (typeof errno?.code === "string")
    return `${errno.syscall ?? "a file operation"}${errno.path ? ` ${errno.path}` : ""} failed with ${errno.code}`;
  return "an unexpected error";
}

// The open handle's identity prevents cleanup from removing a replaced foreign file.
export class LocalRendezvous {
  private handle: FileHandle | undefined;
  private ownership: { dev: number; ino: number } | undefined;
  private directory:
    { path: string; dev: number; ino: number; created: boolean; managed: boolean } | undefined;
  private pending: Promise<void> | undefined;
  private temporary: string | undefined;
  private published = false;
  private retired = false;
  private closing: Promise<void> | undefined;
  // `homes`: the data directory in each spelling the rendezvous path may use (managedComponents).
  constructor(
    readonly path: string,
    private readonly homes: readonly string[] = [],
  ) {}
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
      await this.prepareDirectory();
      this.temporary = `${this.path}.${randomUUID()}.tmp`;
      this.handle = await open(this.temporary, "wx", 0o600);
      const stat = await this.handle.stat();
      this.ownership = { dev: stat.dev, ino: stat.ino };
      await this.handle.chmod(0o600);
      await this.handle.writeFile(JSON.stringify(data), "utf8");
      await this.handle.sync();
      if (this.retired) throw new RendezvousPathError("the server stopped before publication");
      // A complete inode is published atomically; link refuses a pre-existing path.
      await this.verifyDirectory();
      await link(this.temporary, this.path);
      this.published = true;
      await this.removeOwned(this.temporary);
      this.temporary = undefined;
    } catch (error) {
      this.retired = true;
      let cleanup = "";
      try {
        await this.cleanup();
      } catch {
        cleanup = "; removing its own files is unverifiable";
      }
      throw new RendezvousPublicationError(`${publicationCause(error)}${cleanup}`);
    }
  }
  // The directories Cove manages on the way to the rendezvous (#172; store/home.ts states the
  // rule): the known application-owned subtrees, including paths created on earlier starts.
  // Mere containment below home does not make an arbitrary custom directory Cove's. Existing
  // user-selected parents elsewhere (inside or outside home), home itself and its ancestors keep
  // their owner, mode and symlink spelling. A missing leaf we actually create is held to Cove's
  // rule. verifyDirectory pins the target directory identity for publication and cleanup.
  private managedComponents(parent: string): string[] {
    const home = this.homes.find(
      (candidate) =>
        parent === candidate ||
        parent.startsWith(candidate.endsWith("/") ? candidate : `${candidate}/`),
    );
    if (!home) return [];
    // Server state, installation/launcher, client credentials, CLI operations/locks and the
    // client's dial-node state have concrete Cove-owned layouts. User repo/workspace paths do not.
    const known = ["server", "tsnet", "install", "bin", "client", "cli", "tsnet-client"].some(
      (name) => {
        const root = join(home, name);
        return parent === root || parent.startsWith(`${root}/`);
      },
    );
    if (!known) return [];
    const managed: string[] = [];
    for (let current = parent; current !== home; current = dirname(current))
      managed.unshift(current);
    return managed;
  }
  private async prepareDirectory(): Promise<void> {
    if (!isAbsolute(this.path) || normalize(this.path) !== this.path || this.path.endsWith("/"))
      throw new RendezvousPathError(`${this.path} is not a normalized absolute path`);
    const parent = dirname(this.path);
    const components = this.managedComponents(parent);
    if (components.length === 0) {
      // Existing user directories may be symlinks; follow and pin their target. If this
      // publication creates a missing leaf, record ownership before validating for cleanup.
      let created = false;
      let info;
      try {
        info = await stat(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(parent, { mode: 0o700 });
        created = true;
        info = await lstat(parent);
      }
      this.directory = {
        path: parent,
        dev: info.dev,
        ino: info.ino,
        created,
        managed: created,
      };
    }
    for (const current of components) {
      let created = false;
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || current !== parent) throw error;
        await mkdir(current, { mode: 0o700 });
        created = true;
        info = await lstat(current);
        // Recorded before the check, so that cleanup removes the directory this start created.
        this.directory = { path: parent, dev: info.dev, ino: info.ino, created, managed: true };
      }
      checkManagedDirectory(current, info);
      if (current === parent)
        this.directory = { path: parent, dev: info.dev, ino: info.ino, created, managed: true };
    }
    await this.verifyDirectory();
  }
  private async verifyDirectory(): Promise<void> {
    const directory = this.directory;
    if (!directory) throw new RendezvousPathError("the rendezvous directory was not prepared");
    const current = await (directory.managed ? lstat(directory.path) : stat(directory.path));
    if (directory.managed) checkManagedDirectory(directory.path, current);
    else if (!current.isDirectory())
      throw new RendezvousPathError(`the rendezvous parent ${directory.path} is not a directory`);
    if (current.dev !== directory.dev || current.ino !== directory.ino)
      throw new RendezvousPathError(
        `the rendezvous directory ${directory.path} was replaced during publication`,
      );
  }
  private async removeOwned(path: string): Promise<void> {
    await this.verifyDirectory();
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
    const directory = this.directory;
    if (!failed && directory?.created) {
      try {
        await this.verifyDirectory();
        await rmdir(directory.path);
        this.directory = undefined;
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          failed = true;
      }
    }
    if (failed) throw new Error("Owned rendezvous cleanup unverifiable");
  }
}
