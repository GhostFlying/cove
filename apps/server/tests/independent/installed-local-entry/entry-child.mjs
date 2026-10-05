// Future exact-head entry only; --check does not execute imports or launch anything.
import { pathToFileURL } from "node:url";
import { openSync, writeSync, fsyncSync, closeSync, lstatSync } from "node:fs";
import { Server } from "node:net";
import { observeMethods } from "./public-method-observation.mjs";
async function main() {
  const [mainPath, workerPath, rendezvousPath, recordPath, optionsJSON] = process.argv.slice(2);
  let fd,
    observed,
    entry,
    closing,
    primary,
    requested = false;
  const cleanup = [];
  let requestResolve;
  const requestedClose = new Promise((resolve) => {
    requestResolve = resolve;
  });
  const persist = (row) => {
    const bytes = Buffer.from(JSON.stringify(row) + "\n");
    let n = 0;
    while (n < bytes.length) {
      const wrote = writeSync(fd, bytes, n);
      if (wrote <= 0) throw new Error("Receipt write made no progress");
      n += wrote;
    }
    fsyncSync(fd);
  };
  const fileStat = (path) => {
    try {
      const s = lstatSync(path);
      return {
        dev: s.dev,
        ino: s.ino,
        uid: s.uid,
        mode: s.mode & 0o777,
        symlink: s.isSymbolicLink(),
      };
    } catch (error) {
      return { notCaptured: error.code };
    }
  };
  const close = () =>
    (closing ??= (async () => {
      if (entry) await entry.close();
    })());
  const terminate = () => {
    requested = true;
    requestResolve();
  };
  try {
    fd = openSync(recordPath, "wx", 0o600);
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
    const { startLocalEntry } = await import(pathToFileURL(mainPath).href);
    const { WorkerProcess } = await import(pathToFileURL(workerPath).href);
    const { LocalRendezvous } = await import(pathToFileURL(rendezvousPath).href);
    observed = observeMethods(
      [
        {
          object: Server.prototype,
          method: "listen",
          before: (self, args, scope) => {
            scope.listen(
              self,
              "listening",
              () => observed.record("real-listening-event", { address: self.address() }),
              true,
            );
            return args.map((x) => (typeof x === "function" ? "<original-callback>" : x));
          },
          after: (self) => ({ address: self.address() }),
        },
        {
          object: Server.prototype,
          method: "close",
          after: (self) => ({ address: self.address() }),
        },
        {
          object: LocalRendezvous.prototype,
          method: "publish",
          before: (self, args) => ({
            path: self.path,
            serverId: args[0].serverId,
            relayInstanceId: args[0].relayInstanceId,
            endpoint: args[0].endpoint,
            secret: "<private-slot-redacted>",
          }),
          after: (self) => ({ path: self.path, actualStat: fileStat(self.path) }),
        },
        {
          object: LocalRendezvous.prototype,
          method: "close",
          after: (self) => ({ path: self.path, actualStat: fileStat(self.path) }),
        },
        {
          object: WorkerProcess.prototype,
          method: "start",
          after: (self) => ({
            worker: self.snapshot(),
            ref: self.session.worker,
            ledger: self.runtime.composition.bytes.snapshot(),
            session: self.session.snapshot(),
          }),
        },
        {
          object: WorkerProcess.prototype,
          method: "close",
          after: (self, result) => ({
            worker: self.snapshot(),
            ref: self.session.worker,
            ledger: self.runtime.composition.bytes.snapshot(),
            result: result instanceof Promise ? "actual pending original promise" : result,
          }),
        },
      ],
      persist,
    );
    const options = JSON.parse(optionsJSON);
    observed.record("entry.start", { options, pid: process.pid });
    entry = await startLocalEntry(options);
    observed.record("entry.ready", { endpoint: entry.endpoint });
    // Original clock/worker/socket remain real; early signal closes after original startup settles.
    if (!requested) await requestedClose;
    await close();
    observed.record("entry.actual-close-settled", {});
  } catch (error) {
    primary = error;
  } finally {
    // Independent attempts: no earlier error can bypass a later owned cleanup action.
    try {
      await close();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      process.removeListener("SIGTERM", terminate);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      process.removeListener("SIGINT", terminate);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      observed?.record("entry.finally", {
        primary: primary?.name,
        cleanup: cleanup.map((e) => e.name),
      });
    } catch (error) {
      cleanup.push(error);
    }
    try {
      observed?.restore();
    } catch (error) {
      cleanup.push(error);
    }
    if (fd !== undefined) {
      try {
        fsyncSync(fd);
      } catch (error) {
        cleanup.push(error);
      }
      try {
        closeSync(fd);
      } catch (error) {
        cleanup.push(error);
      }
    }
  }
  if (cleanup.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanup],
      "Entry body/observer/cleanup failed",
    );
  if (primary) throw primary;
}
void main().catch((error) => {
  process.exitCode = 1;
  // Fail-closed diagnostic; no force exit or unproven native-group assertion.
  process.stderr.write(
    JSON.stringify({
      kind: "entry-support-failure",
      name: error.name,
      primary: error instanceof AggregateError ? error.errors[0]?.name : error.name,
      errors: error instanceof AggregateError ? error.errors.map((e) => e?.name) : [error.name],
    }) + "\n",
  );
});
