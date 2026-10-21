import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  credentialSupplier,
  type Client,
  type ClientCredential,
  type CredentialProvider,
} from "@cove/client";
import { createDefaultScheduler, createUtf8Codec } from "@cove/client/web-ports";
import { RendezvousSchema } from "@cove/protocol/bootstrap";
import { buildId } from "@cove/server/build-id";
import { createNodePorts } from "./node-ports.js";
import { findServer, type ServerRecord } from "./remote/credentials.js";
import { openEntry, RemoteError, verifiedIdentity, type Via } from "./remote/entries.js";

// This CLI's build (m2 D12): the server's computation over the same build, so the two agree when
// they come from one build. Computed on first use and cached for the process, so a command that
// never connects never hashes the build.
export function cliBuildVersion(): string {
  return buildId();
}

export interface Rendezvous {
  readonly bootstrapVersion: 1;
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly endpoint: string;
  readonly secret: string;
}

// The server instance a session is bound to and where it is reached.
export interface SessionTarget {
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly endpoint: string;
}

export function defaultRendezvousPath(): string {
  return join(homedir(), ".cove", "m0", "run", "rendezvous.json");
}

// An explicit flag wins over the environment so a test or a second server can be addressed
// without touching the user's default local server.
export function resolveRendezvousPath(explicit?: string): string {
  return explicit ?? (process.env.COVE_RENDEZVOUS || defaultRendezvousPath());
}

export async function readRendezvous(path: string): Promise<Rendezvous> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No local server rendezvous at ${path}; run \`cove server start\``);
    throw new Error(`Cannot read rendezvous ${path}`);
  }
  let parsed;
  try {
    parsed = RendezvousSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) throw new Error(`Invalid rendezvous record at ${path}`);
  return parsed.data;
}

// A client bound to one server instance, with the credential `provider` gives for it.
export function createTargetClient(target: SessionTarget, provider: CredentialProvider): Client {
  return createClient({
    expectedServerId: target.serverId,
    expectedRelayInstanceId: target.relayInstanceId,
    buildVersion: cliBuildVersion(),
    credentials: credentialSupplier(provider, target.serverId),
    codec: createUtf8Codec(),
    createOpaqueId: () => randomUUID(),
    scheduler: createDefaultScheduler(),
    ...createNodePorts(target.endpoint),
  });
}

export function createSessionClient(record: Rendezvous): Client {
  // The local owner secret from the rendezvous file (m2 D7).
  return createTargetClient(record, () => ({ kind: "local-secret", secret: record.secret }));
}

export interface Session {
  readonly record: SessionTarget;
  readonly client: Client;
  // A remote session: the paired server's record and the token in use, which `auth device
  // rotate` replaces (the client asks for the credential before every request).
  readonly remote?: { server: ServerRecord; token(): string; useToken(token: string): void };
  // Releases what the session's entry holds (an SSH tunnel) after the client is disposed.
  close?(): Promise<void>;
}

async function connected(client: Client, endpoint: string): Promise<void> {
  const outcome = await client.connect();
  if (outcome.ok) return;
  client.dispose();
  const { error } = outcome;
  throw new Error(
    `Cannot connect to ${endpoint}: ${error.category} ${error.reason}` +
      ("field" in error ? ` (${error.field})` : ""),
  );
}

// Connects one client bound to the server identity published in the rendezvous record. The
// client verifies that both channels reach that exact server instance before any call.
export async function openSession(rendezvousPath?: string): Promise<Session> {
  const record = await readRendezvous(resolveRendezvousPath(rendezvousPath));
  const client = createSessionClient(record);
  await connected(client, record.endpoint);
  return { record, client };
}

// A session with a paired server (m2 D5, D11): its record under `home`, the selected entry, and
// its pre-authentication identity, which must name the recorded serverId before the device token
// is released to the client. A build other than this CLI's is a warning only (D12).
export async function openRemoteSession(
  home: string,
  alias: string,
  via: Via | undefined,
): Promise<Session> {
  const server = await findServer(home, alias);
  if (!server)
    throw new RemoteError(
      "ENTRY_UNAVAILABLE",
      `no paired server is named ${alias} (\`cove remote list\`); nothing was sent`,
    );
  const entry = await openEntry(server, via, home);
  try {
    const identity = await verifiedIdentity(server, entry, cliBuildVersion());
    if (identity.buildVersion !== cliBuildVersion())
      process.stderr.write(
        `cove: warning: ${alias} runs build ${identity.buildVersion}, this CLI is ` +
          `${cliBuildVersion()}\n`,
      );
    let token = server.token;
    const credential = (): ClientCredential => ({ kind: "device-token", token });
    const target = {
      serverId: server.serverId,
      relayInstanceId: identity.relayInstanceId,
      endpoint: entry.endpoint,
    };
    const client = createTargetClient(target, credential);
    await connected(client, `${alias} over ${entry.kind}`);
    return {
      record: target,
      client,
      remote: { server, token: () => token, useToken: (next) => void (token = next) },
      close: () => entry.close(),
    };
  } catch (error) {
    await entry.close();
    throw error;
  }
}
