import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec } from "@cove/client/web-ports";
import { RendezvousSchema } from "@cove/protocol/bootstrap";
import { createNodePorts } from "./node-ports.js";

export const CLI_BUILD_VERSION = "0.0.0";

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

export function createSessionClient(record: Rendezvous): Client {
  return createClient({
    expectedServerId: record.serverId,
    expectedRelayInstanceId: record.relayInstanceId,
    buildVersion: CLI_BUILD_VERSION,
    credentials: () => ({
      authorization: `Bearer ${record.secret}`,
      terminalSecret: record.secret,
    }),
    codec: createUtf8Codec(),
    createOpaqueId: () => randomUUID(),
    scheduler: createDefaultScheduler(),
    ...createNodePorts(record.endpoint),
  });
}

export interface Session {
  readonly record: Rendezvous;
  readonly client: Client;
}

// Connects one client bound to the server identity published in the rendezvous record. The
// client verifies that both channels reach that exact server instance before any call.
export async function openSession(rendezvousPath?: string): Promise<Session> {
  const record = await readRendezvous(resolveRendezvousPath(rendezvousPath));
  const client = createSessionClient(record);
  const connected = await client.connect();
  if (!connected.ok) {
    client.dispose();
    const { error } = connected;
    throw new Error(
      `Cannot connect to ${record.endpoint}: ${error.category} ${error.reason}` +
        ("field" in error ? ` (${error.field})` : ""),
    );
  }
  return { record, client };
}
