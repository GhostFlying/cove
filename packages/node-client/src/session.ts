import { randomUUID } from "node:crypto";
import {
  createClient,
  credentialSupplier,
  type Client,
  type CredentialProvider,
  type CredentialSupplier,
  type TerminalPort,
} from "@cove/client";
import {
  createDefaultScheduler,
  createUtf8Codec,
  createWebSocketPort,
} from "@cove/client/web-ports";
import { createNodePorts } from "./node-ports.js";

export interface SessionTarget {
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly endpoint: string;
}

export interface NodeSession {
  readonly record: SessionTarget;
  readonly client: Client;
  // Trusted host code only: the supplier reflects rotation, and no storage policy lives here.
  readonly credentials: CredentialSupplier;
  socketPort(path: string): TerminalPort;
}

export function createNodeClient(
  target: SessionTarget,
  provider: CredentialProvider,
  buildVersion: string,
): Client {
  return createClient({
    expectedServerId: target.serverId,
    expectedRelayInstanceId: target.relayInstanceId,
    buildVersion,
    credentials: credentialSupplier(provider, target.serverId),
    codec: createUtf8Codec(),
    createOpaqueId: () => randomUUID(),
    scheduler: createDefaultScheduler(),
    ...createNodePorts(target.endpoint),
  });
}

export function nodeSession(
  target: SessionTarget,
  client: Client,
  provider: CredentialProvider,
): NodeSession {
  return {
    record: target,
    client,
    credentials: credentialSupplier(provider, target.serverId),
    socketPort: (path) => createWebSocketPort({ endpoint: target.endpoint, path }),
  };
}
