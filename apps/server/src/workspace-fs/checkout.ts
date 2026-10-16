import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

// The directory of a checkout binding as it is now, before Git is asked what it is. The recorded
// path is the real top level of the working tree the admission check found, so it is the
// directory itself only while that path still resolves to itself: a symlink put in its place, or
// in place of a directory above it, makes it something else even when the link leads to the same
// repository (a tool following the recorded path would no longer reach what was admitted).
// - present: a directory, reached without any symlink;
// - missing: nothing there, something other than a directory, or a symlink on the way;
// - unavailable: it cannot be checked (permission denied, an I/O error).
export async function checkoutDirectory(
  path: string,
): Promise<"present" | "missing" | "unavailable"> {
  try {
    const found = await lstat(path);
    if (!found.isDirectory()) return "missing";
    return (await realpath(path)) === path ? "present" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "missing" : "unavailable";
  }
}

// Whether the checkout directory still has Git metadata at its top level, consulted only after
// Git refused to treat the directory as a working tree. Git gives the same answer ("not a git
// repository") for a directory whose metadata is gone and for one whose metadata it may not read
// (permissions, a safe.directory ownership refusal, corruption), so only proof of absence is
// reported as absent: no `.git` entry, or a `.git` file (a linked worktree) whose `gitdir:` target
// does not exist, as when its clone was moved or the worktree pruned. While metadata is there the
// check is reported as not possible.
// - absent: proven gone (see above);
// - present: Git metadata is there, whether or not Git may read it;
// - unavailable: it cannot be checked.
export async function gitMetadata(path: string): Promise<"present" | "absent" | "unavailable"> {
  const dotGit = join(path, ".git");
  let found;
  try {
    found = await lstat(dotGit);
  } catch (error) {
    return gone(error) ? "absent" : "unavailable";
  }
  if (!found.isFile()) return "present";
  let text: string;
  try {
    const handle = await open(
      dotGit,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const buffer = Buffer.alloc(GITLINK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, GITLINK_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "unavailable";
  }
  const match = /^gitdir: (.+?)\r?\n?$/.exec(text);
  if (!match) return "present";
  try {
    await lstat(resolve(path, match[1]!));
    return "present";
  } catch (error) {
    return gone(error) ? "absent" : "unavailable";
  }
}

// A `.git` file holds one `gitdir:` line with a path; HostPathSchema bounds paths to 4096.
const GITLINK_BYTES = 8 + 4 * 4096 + 2;

function gone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
