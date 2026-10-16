import { MIGRATION_001 } from "./migrations/001-initial.js";
import { MIGRATION_002 } from "./migrations/002-workspace-entry.js";

export type Migration = { readonly version: number; readonly name: string; readonly sql: string };

// Hand-written numbered migrations (docs/milestones/m1.md D5). The database schema version is
// PRAGMA user_version: the number of the last migration applied. It is independent of the
// protocol version and of the configuration schema. A task that needs a schema change adds the
// next file with the number the coordinator assigned; merged migrations never change.
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: "initial", sql: MIGRATION_001 },
  { version: 2, name: "workspace-entry", sql: MIGRATION_002 },
]);

export const SCHEMA_VERSION = MIGRATIONS.length;

for (const [index, migration] of MIGRATIONS.entries())
  if (migration.version !== index + 1) throw new Error("Migrations must be numbered 1, 2, 3, ...");
