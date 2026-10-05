// Real owned-FS component controls; no startLocalEntry/native proof by this file alone.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const digest = (b) => createHash("sha256").update(b).digest("hex");
async function facts(path) {
  try {
    const s = await fs.lstat(path);
    return {
      exists: true,
      dev: s.dev,
      ino: s.ino,
      uid: s.uid,
      mode: s.mode & 0o777,
      symlink: s.isSymbolicLink(),
      directory: s.isDirectory(),
      bytes: s.isFile() ? digest(await fs.readFile(path)) : undefined,
      link: s.isSymbolicLink() ? await fs.readlink(path) : undefined,
    };
  } catch (e) {
    if (e.code === "ENOENT") return { exists: false };
    if (e.code === "ENOTDIR") return { exists: false, pathError: "ENOTDIR" };
    throw e;
  }
}
export async function runOwnedRendezvous(
  row,
  { LocalRendezvous, launchIdentity },
  ownedRoot,
  persist,
) {
  if (row.id === "DN02.unowned-file")
    throw new Error("NOT_EXERCISED: authentic different UID provisioning required");
  // ownedRoot must be fresh task-owned 0700 and its ancestor chain verified before this call.
  const leaf = join(ownedRoot, "leaf"),
    path = join(leaf, "rendezvous.json"),
    foreign = join(ownedRoot, "sentinel");
  let a, b, primary;
  const cleanup = [];
  try {
    await fs.mkdir(leaf, { mode: 0o700 });
    await fs.writeFile(foreign, Buffer.from("DN02_FOREIGN_SENTINEL\0"), {
      flag: "wx",
      mode: 0o600,
    });
    const beforeForeign = await facts(foreign),
      identities = [launchIdentity(), launchIdentity()];
    const data = (i) => ({
      bootstrapVersion: 1,
      ...identities[i],
      endpoint: "http://127.0.0.1:19041",
    });
    const record = async (label) =>
      persist({
        label,
        file: await facts(path),
        directory: await facts(leaf),
        foreign: await facts(foreign),
      });
    persist({
      label: "identity-generation",
      freshInstance: identities[0].relayInstanceId !== identities[1].relayInstanceId,
      freshSecret: identities[0].secret !== identities[1].secret,
      serverIds: identities.map((x) => x.serverId),
      secretPublishedOutsidePrivateFile: false,
    });
    // These are actual FS faults, not an fs module shim or UID override.
    if (row.id === "DN02.foreign-existing-file" || row.id === "DN02.fail-after-owned-file")
      await fs.writeFile(path, Buffer.from("DN02_EXISTING_TARGET\0"), { flag: "wx", mode: 0o600 });
    if (row.id === "DN02.symlink-path") await fs.symlink(foreign, path);
    if (row.id === "DN02.insecure-directory") await fs.chmod(leaf, 0o755);
    if (row.id === "DN02.fail-before-owned-file") {
      await fs.rmdir(leaf);
      await fs.writeFile(leaf, Buffer.from("DN02_NON_DIRECTORY\0"), { flag: "wx", mode: 0o600 });
    }
    const beforePath = await facts(path);
    await record("before-publish");
    a = new LocalRendezvous(path);
    let refusal;
    try {
      await a.publish(data(0));
    } catch (e) {
      refusal = e;
    }
    await record("after-publish-before-guards");
    persist({ label: "public-publish-result", refused: !!refusal, error: refusal?.message });
    const rejects = [
      "DN02.foreign-existing-file",
      "DN02.symlink-path",
      "DN02.insecure-directory",
      "DN02.fail-before-owned-file",
      "DN02.fail-after-owned-file",
    ];
    if (rejects.includes(row.id)) {
      assert.ok(refusal);
      assert.deepEqual(await facts(foreign), beforeForeign);
      if (beforePath.exists) assert.deepEqual(await facts(path), beforePath);
      // fail-after temp acquisition/order is source-bound; actual temp inode requires receipt qualification.
    } else {
      assert.equal(refusal, undefined);
      const owned = await facts(path);
      assert.equal(owned.mode, 0o600);
      assert.equal((await facts(leaf)).mode, 0o700);
      if (row.id === "DN02.late-cleanup") {
        const old = join(leaf, "old-owned-inode");
        await fs.rename(path, old);
        b = new LocalRendezvous(path);
        await b.publish(data(1));
        const replacement = await facts(path);
        await a.close();
        await record("after-original-close");
        assert.deepEqual(await facts(path), replacement);
        await b.close();
        await record("after-replacement-close");
        assert.equal((await facts(path)).exists, false);
        // Old inode removal is fixture cleanup only after exact inode match, never product credit.
        const s = await facts(old);
        if (s.dev === owned.dev && s.ino === owned.ino) await fs.unlink(old);
      } else {
        await a.close();
        if (row.id === "DN02.duplicate-cleanup") await a.close();
        await record("after-close-before-guards");
        assert.equal((await facts(path)).exists, false);
        b = new LocalRendezvous(path);
        await b.publish(data(1));
        await record("second-real-publication");
        await b.close();
        await record("second-real-close");
        assert.equal((await facts(path)).exists, false);
      }
      assert.deepEqual(await facts(foreign), beforeForeign);
    }
  } catch (e) {
    primary = e;
  } finally {
    // Real original class close on every body/assert/persistence exit; capture cleanup errors separately.
    for (const x of [a, b])
      if (x)
        try {
          await x.close();
        } catch (e) {
          cleanup.push(e);
        }
    try {
      await recordFinally();
    } catch (e) {
      cleanup.push(e);
    }
    async function recordFinally() {
      persist({
        label: "actual-finally",
        file: await facts(path),
        directory: await facts(leaf),
        foreign: await facts(foreign),
        primary: primary?.message,
        cleanup: cleanup.map((e) => e.message),
      });
    }
  }
  if (cleanup.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanup],
      "Rendezvous cleanup incomplete",
    );
  if (primary) throw primary;
}
