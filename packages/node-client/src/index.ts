import type { CredentialProvider } from "@cove/client";
import type { BootstrapIdentity } from "@cove/protocol/bootstrap";
import type { InvitationPayload } from "@cove/protocol/auth";
import type { ConnectionRecord } from "./connection-types.js";
import { createEntryAdapters, verifiedIdentity } from "./entries.js";
import { withEntryFailure, type Via } from "./entry-types.js";
import { redeemInvitation } from "./pairing.js";
import { createNodeClient, nodeSession } from "./session.js";
import { createTsnetDaemon, type TsnetRuntime } from "./tsnet-daemon.js";
import { createTsnetEntries } from "./tsnet.js";

export * from "./connection-types.js";
export { RemoteError, withEntryFailure } from "./entry-types.js";
export type { OpenedEntry, Via } from "./entry-types.js";
export {
  openSshTunnel,
  resolvedPins,
  sshArguments,
  OPTIONAL_PINS,
  SUPERVISOR,
} from "./ssh-tunnel.js";
export type { SshTunnel, SshTunnelOptions } from "./ssh-tunnel.js";
export { postJson, TransportFailure } from "./http.js";
export { preAuthIdentity, verifiedIdentity } from "./entries.js";
export { parseInvitation } from "./pairing.js";
export { createNodeHttpPort, createNodePorts } from "./node-ports.js";
export { createNodeClient, nodeSession } from "./session.js";
export type { NodeSession, SessionTarget } from "./session.js";
export { binaryIdentity, DIAL_PROTOCOL, TsnetBinaryError } from "./tsnet-binary.js";
export type { BinaryIdentity } from "./tsnet-binary.js";
export {
  Channel,
  ChannelBroken,
  DaemonUnavailable,
  DialError,
  MAX_FRAME_BYTES,
  describeStreams,
  printable,
  socketPath,
  tsnetHome,
} from "./tsnet-daemon.js";
export type { Daemon, Hello, OpenOptions, StreamInfo, TsnetRuntime } from "./tsnet-daemon.js";
export { PendingStream } from "./tsnet.js";
export type { TsnetConfig } from "./tsnet-config.js";
export {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  MAX_IDLE_TIMEOUT_SECONDS,
  parseIdleTimeout,
  readTsnetConfig,
  writeTsnetConfig,
} from "./tsnet-config.js";

export interface RemoteConnectionOptions {
  readonly via: Via | undefined;
  readonly home: string;
  readonly buildVersion: string;
  readonly onIdentity?: (identity: BootstrapIdentity) => void;
}

// Hosts inject executable-location and warning policy. Instances share the per-user resident node
// through its socket, while keeping binary/warning caches separate from any other host's policy.
export function createNodeConnectionAdapters(options: {
  readonly tsnet: TsnetRuntime;
  readonly onSshWarning?: (message: string) => void;
}) {
  const daemon = createTsnetDaemon(options.tsnet);
  const tsnet = createTsnetEntries(daemon);
  const entries = createEntryAdapters(tsnet, options.onSshWarning);
  return {
    ...daemon,
    ...tsnet,
    ...entries,
    redeemInvitation: (
      payload: InvitationPayload,
      deviceName: string,
      via: Via | undefined,
      buildVersion: string,
      home: string,
    ) => redeemInvitation(payload, deviceName, via, buildVersion, home, entries),
    async openRemoteConnection(
      record: ConnectionRecord,
      provider: CredentialProvider,
      connection: RemoteConnectionOptions,
    ) {
      const entry = await entries.openEntry(record, connection.via, connection.home);
      try {
        // A token is never requested until the selected channel's peer and serverId were checked.
        const identity = await verifiedIdentity(record, entry, connection.buildVersion);
        connection.onIdentity?.(identity);
        const target = {
          serverId: record.serverId,
          relayInstanceId: identity.relayInstanceId,
          endpoint: entry.endpoint,
        };
        const client = createNodeClient(target, provider, connection.buildVersion);
        const outcome = await client.connect();
        if (!outcome.ok) {
          client.dispose();
          const { error } = outcome;
          throw new Error(
            `Cannot connect to ${record.alias} over ${entry.kind}: ${error.category} ${error.reason}` +
              ("field" in error ? ` (${error.field})` : ""),
          );
        }
        return {
          ...nodeSession(target, client, provider),
          close: () => entry.close(),
          entryFailure: () => entry.failure?.(),
        };
      } catch (error) {
        await entry.close();
        throw withEntryFailure(error, entry);
      }
    },
  };
}
