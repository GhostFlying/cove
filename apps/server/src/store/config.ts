import { join } from "node:path";
import type { ConfigRecord } from "@cove/protocol/workspace";
import {
  executeDatabaseWrite,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import { validateWorkspaceRoot, type ConfigState } from "./config-rules.js";
import type { Store } from "./database.js";

export { validateWorkspaceRoot, type ConfigState };

// Where configuration is read from. The store is the real source; the D6 probe's control phase
// reads its in-memory copy instead (entry/d6-probe.ts). Writes go through the operation receipts'
// backend (receipts.write with the `config.set` write, store/sql/config.ts).
export interface ConfigReader {
  read(): Promise<ConfigState>;
}

export function sqliteConfigState(store: Store): ConfigReader {
  return { read: () => store.call("config.read", undefined) };
}

// Server configuration (T1). The default workspaceRoot is `<home>/workspace` (D1).
export class ConfigService {
  constructor(
    private readonly options: {
      home: string;
      serverId: string;
      receipts: OperationReceipts;
      state: ConfigReader;
      encodeUtf8: (text: string) => Uint8Array;
      now?: () => number;
    },
  ) {}

  defaultWorkspaceRoot(): string {
    return join(this.options.home, "workspace");
  }

  async record(): Promise<ConfigRecord> {
    const state = await this.options.state.read();
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
  async workspaceRoot(): Promise<string> {
    return (await this.record()).settings.workspaceRoot.value;
  }

  async set(
    principalId: string,
    params: {
      operationId: string;
      expectedRevision?: number;
      patch: { workspaceRoot?: string | null };
    },
  ): Promise<DatabaseWriteOutcome> {
    if (params.patch.workspaceRoot) {
      const invalid = validateWorkspaceRoot(params.patch.workspaceRoot);
      if (invalid) return { error: invalid };
    }
    return executeDatabaseWrite(
      {
        serverId: this.options.serverId,
        receipts: this.options.receipts,
        encodeUtf8: this.options.encodeUtf8,
      },
      principalId,
      "config.set",
      params,
      {
        name: "config.set",
        args: {
          ...(params.expectedRevision === undefined
            ? {}
            : { expectedRevision: params.expectedRevision }),
          patch: { ...params.patch },
          at: (this.options.now ?? Date.now)(),
        },
      },
    );
  }
}

// `cove server init` (D7): a local bootstrap while no server runs. It may set the initial
// workspaceRoot of a database whose identity was created by this very init; changing it later is
// an ordinary `config.set` through the running server.
export async function initializeWorkspaceRoot(
  store: Store,
  workspaceRoot: string,
  at: number,
): Promise<void> {
  const invalid = validateWorkspaceRoot(workspaceRoot);
  if (invalid) throw new Error("workspaceRoot must be an absolute, normalized path");
  await store.call("config.initialize", { workspaceRoot, at });
}
