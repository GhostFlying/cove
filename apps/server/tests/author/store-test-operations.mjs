// Store operations that only tests add, through Store.open's `operationModules`. They run where
// the store runs its own operations (inside one transaction each, on the store's connection), so
// tests can inspect rows and pragmas of the live database and inject failures without a second
// connection, which would break the store's process-wide locks.

export const operations = {
  "test.all": (db, { sql, params = [] }) => db.prepare(sql).all(...params),
  "test.get": (db, { sql, params = [] }) => db.prepare(sql).get(...params) ?? null,
  "test.run": (db, { sql, params = [] }) => db.prepare(sql).run(...params).changes,
  "test.pragma": (db, { pragma }) => db.pragma(pragma, { simple: true }),
  // Writes, then fails: the whole transaction must roll back.
  "test.failAfterWrite": (db, { sql }) => {
    db.prepare(sql).run();
    throw Object.assign(new Error("injected failure"), { code: "SQLITE_IOERR_WRITE" });
  },
  "test.failPlain": () => {
    throw Object.assign(new Error("plain failure"), { code: "ENOTSQLITE" });
  },
  // Holds the store worker inside a transaction until the test sets the shared flag, so tests
  // can fill the in-flight window and the queue deterministically. Optionally writes first and
  // crashes (process.exit in a worker ends only that thread) after being released.
  "test.block": (db, { flag, sql, crash = false }) => {
    if (sql) db.prepare(sql).run();
    Atomics.wait(new Int32Array(flag), 0, 0);
    if (crash) process.exit(7);
    return "released";
  },
  // Ends the worker thread a moment after answering, while no call is in flight.
  "test.exitSoon": () => {
    setTimeout(() => process.exit(3), 20);
    return "answered";
  },
  // A result that cannot be structured-cloned.
  "test.unanswerable": () => ({ fn: () => 1 }),
};
