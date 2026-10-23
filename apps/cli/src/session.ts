import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Client, ClientCredential, CredentialProvider } from "@cove/client";
import {
  createNodeClient,
  nodeSession,
  type NodeSession,
  type SessionTarget,
} from "@cove/node-client";
export type { SessionTarget } from "@cove/node-client";
import { RendezvousSchema } from "@cove/protocol/bootstrap";
import { buildId, sourceBuildId } from "@cove/server/build-id";
import { findServer, type ServerRecord } from "./remote/credentials.js";
import { RemoteError, type Via } from "./remote/entries.js";
import { nodeAdapters } from "./remote/adapters.js";

// This CLI's build (m2 D12): the server's computation over the same build, so the two agree when
// they come from one build. Computed on first use and cached for the process, so a command that
// never connects never hashes the build.
export function cliBuildVersion(): string {
  return buildId();
}

// The D12 warning's comparison (#175), or null when the builds match. The source builds are
// compared when both sides know theirs: they do not depend on the platform, so a CLI and a server
// of one commit on different machines or OSes match, while the install builds (buildVersion)
// differ with Node, native addons and cove-tsnet. Otherwise the build IDs are compared, as before
// sourceBuild existed. The text names the identity that was compared.
export function buildMismatch(
  server: { buildVersion: string; sourceBuild?: string | undefined },
  cliBuild: string,
  cliSource: string | null,
): string | null {
  if (server.sourceBuild !== undefined && cliSource !== null)
    return server.sourceBuild === cliSource
      ? null
      : `source build ${server.sourceBuild}, this CLI is source build ${cliSource}`;
  return server.buildVersion === cliBuild
    ? null
    : `build ${server.buildVersion}, this CLI is build ${cliBuild}`;
}

export interface Rendezvous {
  readonly bootstrapVersion: 1;
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly endpoint: string;
  readonly secret: string;
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
  return createNodeClient(target, provider, cliBuildVersion());
}

export function createSessionClient(record: Rendezvous): Client {
  // The local owner secret from the rendezvous file (m2 D7).
  return createTargetClient(record, () => ({ kind: "local-secret", secret: record.secret }));
}

export interface Session extends NodeSession {
  // A remote session: the paired server's record and the token in use, which `auth device
  // rotate` replaces (the client asks for the credential before every request).
  readonly remote?: { server: ServerRecord; token(): string; useToken(token: string): void };
  // Releases what the session's entry holds (an SSH tunnel) after the client is disposed.
  close?(): Promise<void>;
  // The entry's latest channel failure (a refused later tsnet stream), which the client alone
  // reports only as a closed connection; withSession adds it to a failing command's report.
  entryFailure?(): RemoteError | undefined;
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
  return nodeSession(record, client, () => ({ kind: "local-secret", secret: record.secret }));
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
  let token = server.token;
  const provider = (): ClientCredential => ({ kind: "device-token", token });
  const session = await nodeAdapters.openRemoteConnection(server, provider, {
    via,
    home,
    buildVersion: cliBuildVersion(),
    onIdentity(identity) {
      const mismatch = buildMismatch(identity, cliBuildVersion(), sourceBuildId());
      if (mismatch) process.stderr.write(`cove: warning: ${alias} runs ${mismatch}\n`);
    },
  });
  return {
    ...session,
    remote: { server, token: () => token, useToken: (next) => void (token = next) },
  };
}
