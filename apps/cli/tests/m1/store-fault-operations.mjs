// Store operations that only the store-fault test server adds (store-fault-server.mjs), through
// the store's test `operationModules`. They run inside the store worker, one transaction each.

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const operations = {
  // Ends the store worker thread inside a transaction (process.exit in a worker ends only that
  // thread): the server must fail closed.
  "test.crash": () => process.exit(9),
  // Occupies the store worker, so calls behind it fill the bounded queue.
  "test.sleep": (_db, { ms }) => {
    pause(ms);
    return null;
  },
  "test.all": (db, { sql, params = [] }) => db.prepare(sql).all(...params),
};
