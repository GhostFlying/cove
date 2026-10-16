import type Database from "better-sqlite3";

// Shared pieces of the store's SQL operations (store/sql/*.ts). These modules run where the
// database connection lives and nowhere else: the main thread reaches them only through
// Store.call (store/database.ts), never by importing them for execution.

export type Connection = Database.Database;

// One business operation: a synchronous function of the connection and structured-clone-safe
// arguments, returning a structured-clone-safe result. The store runs every call as exactly one
// transaction (database.ts), so an operation never commits part of its work, never spans an await
// and never runs interleaved with another operation.
export type SqlOperation<A, R> = (db: Connection, args: A) => R;

// Thrown by an operation to roll its transaction back and still answer the caller with `value`
// (for example a domain refusal found after earlier statements of the same transaction ran).
export class Rollback<T> {
  constructor(readonly value: T) {}
}

const caches = new WeakMap<Connection, Map<string, Database.Statement>>();

// Prepared statements are cached per connection and SQL text: preparing is not free, and every
// operation runs on the store's single connection.
export function statement(db: Connection, sql: string): Database.Statement {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}
