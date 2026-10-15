import { lstat, unlink } from "node:fs/promises";
import { Store, StoreError } from "../store/database.js";
import { prepareHome, type HomeLayout } from "../store/home.js";
import { loadOrCreateIdentity, type ServerIdentity } from "../store/identity.js";

export type ServerPersistence = {
  readonly layout: HomeLayout;
  readonly store: Store;
  readonly identity: ServerIdentity;
  // Whether this open created the identity (first start or `cove server init`).
  readonly created: boolean;
};

// Opens the data directory for one server process (D5, D7). The database lock is taken before
// anything else is touched, so a refused second server leaves the running one, its rendezvous and
// its files alone. The caller owns `store` and must close it last.
export async function openPersistence(
  home: string,
  now: () => number = Date.now,
): Promise<ServerPersistence> {
  const layout = await prepareHome(home);
  const store = await Store.open({
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    now,
  });
  try {
    const identity = loadOrCreateIdentity(store, now);
    return {
      layout,
      store,
      identity: { serverId: identity.serverId, principalId: identity.principalId },
      created: identity.created,
    };
  } catch {
    store.close();
    throw new StoreError("unavailable", "The Cove server identity cannot be read");
  }
}

// D7: holding the database lock proves that no other server of this data directory is running,
// so a rendezvous left at the data directory's own path is a crashed server's and can be removed
// before publishing. A rendezvous elsewhere (explicit --rendezvous) is never removed: another data
// directory's live server may own it.
export async function replaceStaleRendezvous(
  layout: HomeLayout,
  rendezvousPath: string,
): Promise<boolean> {
  if (rendezvousPath !== layout.rendezvousPath) return false;
  let info;
  try {
    info = await lstat(rendezvousPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() || info.uid !== process.getuid?.())
    throw new Error("Unexpected file at the rendezvous path");
  await unlink(rendezvousPath);
  return true;
}
