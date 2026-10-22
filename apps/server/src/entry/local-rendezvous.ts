import { randomBytes, randomUUID } from "node:crypto";
import { open, lstat, stat, realpath, unlink, link, mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
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
  private managedPaths: readonly string[] = [];
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
  private async managedComponents(parent: string): Promise<{
    paths: string[];
    parents: Set<string>;
    lexical: boolean;
  }> {
    const paths = new Set<string>();
    const parents = new Set<string>();
    let lexical = false;
    const below = (path: string, root: string): boolean =>
      path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
    const include = (root: string, selected: string): void => {
      const chain: string[] = [];
      for (let current = selected; current !== dirname(root); current = dirname(current))
        chain.unshift(current);
      for (const component of chain) paths.add(component);
      parents.add(selected);
    };
    let target: string;
    try {
      target = await realpath(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only the final leaf may be missing. Project it through its existing parent so an
      // alias of a managed subtree keeps the same rule when this publication creates it.
      target = join(await realpath(dirname(parent)), basename(parent));
    }
    // Retain traversal membership too: BIN/link may leave a real managed bin through a
    // symlink, so the final target alone cannot identify the managed lexical component chain.
    const ancestors: { path: string; actual: string }[] = [];
    for (let current = dirname(parent); ; current = dirname(current)) {
      ancestors.push({ path: current, actual: await realpath(current) });
      if (current === dirname(current)) break;
    }
    // Check every mapping: a supplied home alias can itself be nested inside the canonical
    // home. First-prefix selection would hide that alias's managed subtree.
    for (const home of this.homes) {
      for (const name of ["server", "tsnet", "install", "bin", "client", "cli", "tsnet-client"]) {
        const root = join(home, name);
        if (below(parent, root)) {
          lexical = true;
          include(root, parent);
        }
        let actualRoot: string;
        try {
          actualRoot = await realpath(root);
        } catch (error) {
          // Unresolvable unrelated layouts cannot name this resolved target. Lexically
          // selected layouts above still get lstat checks, including symlink refusal.
          if (
            ["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw error;
        }
        for (const ancestor of ancestors) {
          if (ancestor.actual === actualRoot)
            include(root, join(root, relative(ancestor.path, parent)));
        }
        if (below(target, actualRoot)) {
          // realpath uses native FS spelling, so CLIENT aliases client only on a case-folding
          // filesystem. Preserve the known lexical root to reject a restored symlink there.
          include(root, join(root, relative(actualRoot, target)));
        }
      }
    }
    return { paths: [...paths], parents, lexical };
  }
  private async prepareDirectory(): Promise<void> {
    if (!isAbsolute(this.path) || normalize(this.path) !== this.path || this.path.endsWith("/"))
      throw new RendezvousPathError(`${this.path} is not a normalized absolute path`);
    const parent = dirname(this.path);
    const components = await this.managedComponents(parent);
    this.managedPaths = components.paths;
    for (const current of this.managedPaths) {
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && components.parents.has(current))
          continue;
        throw error;
      }
      checkManagedDirectory(current, info);
    }
    // Existing user aliases may resolve to a managed target. Its known chain above is strict,
    // while this spelling is followed and identity-pinned without adopting the user alias.
    let created = false;
    let info;
    try {
      info = await (components.lexical ? lstat(parent) : stat(parent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(parent, { mode: 0o700 });
      created = true;
      info = await lstat(parent);
    }
    // Record before validation so cleanup knows which directory this start actually created.
    this.directory = {
      path: parent,
      dev: info.dev,
      ino: info.ino,
      created,
      managed: components.lexical || created,
    };
    await this.verifyDirectory();
  }
  private async verifyDirectory(): Promise<void> {
    const directory = this.directory;
    if (!directory) throw new RendezvousPathError("the rendezvous directory was not prepared");
    for (const path of this.managedPaths) checkManagedDirectory(path, await lstat(path));
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
