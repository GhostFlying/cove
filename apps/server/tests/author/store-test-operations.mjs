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
};
