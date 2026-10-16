import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { RendezvousSchema } from "@cove/protocol/bootstrap";
import { Store, StoreError, type StoreOptions } from "../store/database.js";
import { prepareHome, type HomeLayout } from "../store/home.js";
import {
  isRecordedInstance,
  loadOrCreateIdentity,
  type ServerIdentity,
} from "../store/identity.js";

export type ServerPersistence = {
  readonly layout: HomeLayout;
  readonly store: Store;
  readonly identity: ServerIdentity;
  // Whether this open created the identity (first start or `cove server init`).
  readonly created: boolean;
};

// Opens the data directory for one server process (D5, D7). The database lock is taken before
// anything else is touched, so a refused second server leaves the running one, its rendezvous and
// its files alone. The caller owns `store` and must close it last (Store.close releases the lock
// after the database is closed).
// `storeOptions` is passed only by test entries (ServerTestHooks in main.ts).
export async function openPersistence(
  home: string,
  now: () => number = Date.now,
  storeOptions: Pick<StoreOptions, "operationModules" | "limits"> = {},
): Promise<ServerPersistence> {
  const layout = await prepareHome(home);
  const store = await Store.open({
    ...storeOptions,
    databasePath: layout.databasePath,
    backupDirectory: layout.backupDirectory,
    now,
  });
  try {
    const identity = await loadOrCreateIdentity(store, now);
    return {
      layout,
      store,
      identity: { serverId: identity.serverId, principalId: identity.principalId },
      created: identity.created,
    };
  } catch {
    await store.close().catch(() => undefined);
    throw new StoreError("unavailable", "The Cove server identity cannot be read");
  }
}

export class RendezvousConflictError extends Error {
  constructor() {
    super(
      "Another server's rendezvous is published at this data directory's rendezvous path; it was " +
        "left in place. Stop that server or point it at another rendezvous path.",
    );
    this.name = "RendezvousConflictError";
  }
}

// D7: a record at the data directory's own rendezvous path is replaced only when it is provably
// this data directory's stale record: it names this server's serverId and a relay instance this
// database recorded earlier. Holding the database lock proves that no instance of this data
// directory is running, so such a record was left by a crash. The pathname alone proves nothing:
// a server of another data directory can be started with an explicit --rendezvous naming this
// path while this server is stopped, and its live record must be preserved (a conflict, reported
// to the operator). A rendezvous elsewhere (explicit --rendezvous) is never removed.
export async function replaceStaleRendezvous(
  layout: HomeLayout,
  rendezvousPath: string,
  owner: { readonly store: Store; readonly serverId: string; readonly relayInstanceId: string },
): Promise<boolean> {
  if (rendezvousPath !== layout.rendezvousPath) return false;
  let handle;
  try {
    handle = await open(rendezvousPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code === "ELOOP") throw new Error("Unexpected file at the rendezvous path");
    throw error;
  }
  let read;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.())
      throw new Error("Unexpected file at the rendezvous path");
    read = { dev: info.dev, ino: info.ino, text: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
  let record;
  try {
    record = RendezvousSchema.safeParse(JSON.parse(read.text));
  } catch {
    record = null;
  }
  if (
    !record?.success ||
    record.data.serverId !== owner.serverId ||
    record.data.relayInstanceId === owner.relayInstanceId ||
    !(await isRecordedInstance(owner.store, record.data.relayInstanceId))
  )
    throw new RendezvousConflictError();
  // Remove exactly the file that was read: a publisher only links a new file to a free path, so
  // the same inode still being there means it is still the stale record.
  const current = await lstat(rendezvousPath);
  if (current.dev !== read.dev || current.ino !== read.ino) throw new RendezvousConflictError();
  await unlink(rendezvousPath);
  return true;
}
