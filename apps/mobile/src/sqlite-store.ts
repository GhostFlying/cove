import * as SQLite from "expo-sqlite";
import { LocalStore, type SQL } from "../dist/local-store.js";

export async function openLocalStore(): Promise<{ store: LocalStore; close(): Promise<void> }> {
  const db = await SQLite.openDatabaseAsync("cove-mobile-v1.db");
  const store = new LocalStore({
    read: db as SQL,
    transaction: async <T>(body: (tx: SQL) => Promise<T>): Promise<T> => {
      let result!: T;
      await db.withExclusiveTransactionAsync(async (tx) => {
        result = await body(tx as SQL);
      });
      return result;
    },
  });
  return { store, close: () => db.closeAsync() };
}
