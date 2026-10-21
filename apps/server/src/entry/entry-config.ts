import type { EntrySettings } from "@cove/protocol/auth";
import type { DomainError } from "@cove/protocol/errors";
import {
  executeDatabaseWrite,
  storeReadError,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { EntryConfigState } from "../store/config-rules.js";
import type { Store } from "../store/database.js";

// What this server instance actually listens with, fixed at start: the bound business port, the
// pairing port the auth service was told to use (undefined: the open invitations' or a free one)
// and the tsnet hostname its node was started with.
export type ListeningEntries = {
  businessPort: number;
  pairingPort: number | undefined;
  tsnetHostname: string | null;
};

// Entry configuration (m2 D3, D10; entry.get, entry.set). The store holds the settings
// (store/sql/entry.ts); this service keeps a copy of the committed state for the two readers that
// cannot wait for the store: the SSH target an invitation advertises (auth/service.ts reads it
// synchronously when an invitation is created, so a change applies at once) and the restart flag
// of entry.get. The copy is replaced after every entry.set this server answers, whether it
// committed or found an earlier receipt. Every write of the configuration goes through this
// server (`cove server install` writes ports only while no server runs, entry/main.ts init), so
// the copy cannot fall behind the store while this instance runs.
export class EntryConfigService {
  private state: EntryConfigState;
  private listening: ListeningEntries | undefined;

  constructor(
    private readonly options: {
      store: Store;
      receipts: OperationReceipts;
      serverId: string;
      encodeUtf8: (text: string) => Uint8Array;
      initial: EntryConfigState;
      // A startup flag that overrides the stored SSH target (m0-local-options.ts).
      sshTargetOverride?: string;
      now?: () => number;
    },
  ) {
    this.state = options.initial;
  }

  // The settings the server read when it started.
  get initial(): EntryConfigState {
    return this.options.initial;
  }

  // The SSH target invitations advertise now: the startup override, else the stored one.
  get sshTarget(): string | undefined {
    return this.options.sshTargetOverride ?? this.state.sshTarget ?? undefined;
  }

  // Called once the listeners are bound.
  bound(listening: ListeningEntries): void {
    this.listening = listening;
  }

  async record(): Promise<
    { revision: number; settings: EntrySettings; restartRequired: boolean } | { error: DomainError }
  > {
    let state: EntryConfigState;
    try {
      state = await this.options.store.call("entry.read", undefined);
    } catch (error) {
      return { error: storeReadError(error) };
    }
    this.state = state;
    const { revision, ...settings } = state;
    return { revision, settings, restartRequired: this.restartRequired(state) };
  }

  // A stored port or hostname this instance does not listen with. A setting that is not
  // configured (null) asks for nothing, so it never requires a restart.
  private restartRequired(state: EntryConfigState): boolean {
    const listening = this.listening;
    if (!listening) return false;
    return (
      (state.businessPort !== null && state.businessPort !== listening.businessPort) ||
      (state.pairingPort !== null && state.pairingPort !== listening.pairingPort) ||
      (state.tsnetHostname ?? null) !== listening.tsnetHostname
    );
  }

  async set(
    principalId: string,
    params: {
      operationId: string;
      expectedRevision?: number;
      patch: Partial<EntrySettings>;
    },
  ): Promise<DatabaseWriteOutcome> {
    const outcome = await executeDatabaseWrite(
      {
        serverId: this.options.serverId,
        receipts: this.options.receipts,
        encodeUtf8: this.options.encodeUtf8,
      },
      principalId,
      "entry.set",
      params,
      {
        name: "entry.set",
        args: {
          ...(params.expectedRevision === undefined
            ? {}
            : { expectedRevision: params.expectedRevision }),
          patch: { ...params.patch },
          at: (this.options.now ?? Date.now)(),
        },
      },
    );
    // Refresh the copy whatever the outcome: a refusal or an unknown outcome may still mean that
    // the store changed (an identical request committed meanwhile). A failed read keeps the old
    // copy; the next record() or set() refreshes it.
    try {
      this.state = await this.options.store.call("entry.read", undefined);
    } catch {
      // See above.
    }
    return outcome;
  }
}
