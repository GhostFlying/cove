import { isAbsolute, join, normalize } from "node:path";
import { domainError, type DomainError } from "@cove/protocol/errors";
import { HostPathSchema, type ConfigRecord } from "@cove/protocol/workspace";
import {
  executeDatabaseWrite,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { Store } from "./database.js";

// The stored settings: NULL means the default (server-architecture §9.2).
export type ConfigState = { revision: number; workspaceRoot: string | null };

// Where configuration lives. The SQLite state is the real one; the in-memory state exists only for
// the D6 probe's control phase (same RPC path, no synchronous SQLite transaction).
export interface ConfigBackend {
  read(): ConfigState;
  write(next: ConfigState, at: number): void;
  transaction<T>(fn: () => T): T;
}

export function sqliteConfigState(store: Store): ConfigBackend {
  const read = store.db.prepare("SELECT revision, workspace_root FROM config WHERE id = 1");
  const write = store.db.prepare(
    "UPDATE config SET revision = ?, workspace_root = ?, updated_at_ms = ? WHERE id = 1",
  );
  return {
    read: () => {
      const row = read.get() as { revision: number; workspace_root: string | null } | undefined;
      if (!row) throw new Error("Server configuration is not initialized");
      return { revision: row.revision, workspaceRoot: row.workspace_root };
    },
    write: (next, at) => {
      if (write.run(next.revision, next.workspaceRoot, at).changes !== 1)
        throw new Error("Server configuration is not initialized");
    },
    transaction: (fn) => store.transaction(fn),
  };
}

export function memoryConfigState(initial: ConfigState): ConfigBackend {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    write: (next) => {
      state = { ...next };
    },
    transaction: (fn) => fn(),
  };
}

// A workspace root is interpreted by this host: it must be absolute and already normalized, so
// the same request always names the same directory. It need not exist yet; the workspace module
// creates it when the first workspace under it is created.
export function validateWorkspaceRoot(value: string): DomainError | null {
  if (
    !HostPathSchema.safeParse(value).success ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    (value.length > 1 && value.endsWith("/"))
  )
    return domainError("INVALID_ARGUMENT");
  return null;
}

// Server configuration (T1). The default workspaceRoot is `<home>/workspace` (D1).
export class ConfigService {
  constructor(
    private readonly options: {
      home: string;
      serverId: string;
      receipts: OperationReceipts;
      state: ConfigBackend;
      encodeUtf8: (text: string) => Uint8Array;
      now?: () => number;
    },
  ) {}

  defaultWorkspaceRoot(): string {
    return join(this.options.home, "workspace");
  }

  record(state = this.options.state.read()): ConfigRecord {
    return {
      revision: state.revision,
      settings: {
        workspaceRoot:
          state.workspaceRoot === null
            ? { value: this.defaultWorkspaceRoot(), isDefault: true }
            : { value: state.workspaceRoot, isDefault: false },
      },
    };
  }

  // The root a workspace created now must use; later changes never move existing workspaces.
  workspaceRoot(): string {
    return this.record().settings.workspaceRoot.value;
  }

  set(
    principalId: string,
    params: {
      operationId: string;
      expectedRevision?: number;
      patch: { workspaceRoot?: string | null };
    },
  ): DatabaseWriteOutcome {
    const { state } = this.options;
    if (params.patch.workspaceRoot) {
      const invalid = validateWorkspaceRoot(params.patch.workspaceRoot);
      if (invalid) return { error: invalid };
    }
    return executeDatabaseWrite(
      {
        serverId: this.options.serverId,
        receipts: this.options.receipts,
        encodeUtf8: this.options.encodeUtf8,
        transaction: state.transaction,
      },
      principalId,
      "config.set",
      params,
      () => {
        const current = state.read();
        if (params.expectedRevision !== undefined && params.expectedRevision !== current.revision)
          return { error: domainError("REVISION_CONFLICT") };
        if (current.revision === Number.MAX_SAFE_INTEGER)
          return { error: domainError("COUNTER_EXHAUSTED") };
        const next: ConfigState = {
          revision: current.revision + 1,
          workspaceRoot:
            params.patch.workspaceRoot === undefined
              ? current.workspaceRoot
              : params.patch.workspaceRoot,
        };
        state.write(next, (this.options.now ?? Date.now)());
        return { result: { resource: { kind: "config", id: "server", revision: next.revision } } };
      },
    );
  }
}

// `cove server init` (D7): a local bootstrap while no server runs. It may set the initial
// workspaceRoot of a database whose identity was created by this very init; changing it later is
// an ordinary `config.set` through the running server.
export function initializeWorkspaceRoot(store: Store, workspaceRoot: string, at: number): void {
  const invalid = validateWorkspaceRoot(workspaceRoot);
  if (invalid) throw new Error("workspaceRoot must be an absolute, normalized path");
  const state = sqliteConfigState(store);
  store.transaction(() => {
    const current = state.read();
    state.write({ revision: current.revision + 1, workspaceRoot }, at);
  });
}
