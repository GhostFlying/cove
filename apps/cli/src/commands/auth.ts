import type { CallOutcome, Client } from "@cove/client";
import { AUTH_LIMITS, DeviceNameSchema, InviteIdSchema } from "@cove/protocol/auth";
import { DeviceIdSchema } from "@cove/protocol/bootstrap";
import type { OperationRecord, WriteRpcMethod } from "@cove/protocol/rpc";
import { findServer, readServer, saveServer, withServerLock } from "../remote/credentials.js";
import { directCallClient } from "../remote/direct-rpc.js";
import type { Session } from "../session.js";
import {
  currentRemote,
  homeDirectory,
  isRemote,
  optionalIntegerFlag,
  print,
  requireSucceeded,
  settle,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { acceptWrite, operationIdFor } from "./_pending.js";

export const usage = `  auth invite create [--ttl-minutes N] [--operation-id ID]
  auth invite list
  auth invite cancel <INVITE_ID> [--operation-id ID]
  auth device list [--include-revoked]
  auth device rename <DEVICE_ID> <NAME> [--expected-revision N] [--operation-id ID]
  auth device revoke <DEVICE_ID> [--operation-id ID]
  auth device rotate --server ALIAS [--operation-id ID]

auth invite create prints a one-time invitation for \`cove remote add\` on the new device; it
is shown once only (a resent request shows the record without it), expires after 10 minutes by
default (24 hours at most), and the pairing port is open only while an invitation is. auth device
revoke closes the device's connections and fails when one did not close in time. auth device
rotate replaces this client's own token for the paired server; the current token keeps working
until the new one is first used.`;

// Wraps a client so that the output secrets of the one write sent through it are kept here, in
// this process, rather than dropped: acceptWrite (shared with every write) saves the request and
// returns only the accepted record. The secrets are taken from the live answer only; nothing
// stores or prints them on the way.
function capturingSecrets(session: Session): {
  session: Session;
  secrets: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const call = (async (method: string, params: unknown) => {
    const outcome = (await session.client.call(method as never, params as never)) as CallOutcome<{
      secrets?: Record<string, unknown>;
    }>;
    if (outcome.ok) captured = outcome.value.secrets;
    return outcome;
  }) as Client["call"];
  const client = new Proxy(session.client, {
    get: (target, key, receiver) =>
      key === "call" ? call : (Reflect.get(target, key, receiver) as unknown),
  });
  return { session: { ...session, client }, secrets: () => captured };
}

async function secretWrite(
  args: Arguments,
  session: Session,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
): Promise<{ operation: OperationRecord; secrets: Record<string, unknown> | undefined }> {
  const capture = capturingSecrets(session);
  const accepted = await acceptWrite(args, capture.session, method, params);
  return {
    operation: requireSucceeded(await settle(session.client, accepted)),
    secrets: capture.secrets(),
  };
}

async function write(
  args: Arguments,
  session: Session,
  method: WriteRpcMethod,
  params: Record<string, unknown> & { operationId: string },
): Promise<OperationRecord> {
  return requireSucceeded(
    await settle(session.client, await acceptWrite(args, session, method, params)),
  );
}

function id(value: string | undefined, schema: typeof DeviceIdSchema, what: string): string {
  if (value === undefined || !schema.safeParse(value).success)
    throw new UsageError(
      `${what} is 1-40 letters, digits, '_' or '-', starting with a letter or digit`,
    );
  return value;
}

async function invite(args: Arguments): Promise<number> {
  const sub = args.words[2];
  if (sub === "create") {
    takeFlags(args, ["--ttl-minutes", "--operation-id"]);
    if (args.words.length !== 3 || args.command)
      throw new UsageError("auth invite create takes no arguments");
    const minutes = optionalIntegerFlag(args, "--ttl-minutes");
    const ttlMs = minutes === undefined ? undefined : minutes * 60_000;
    if (
      ttlMs !== undefined &&
      (ttlMs < AUTH_LIMITS.invitationMinTtlMs || ttlMs > AUTH_LIMITS.invitationMaxTtlMs)
    )
      throw new UsageError(
        `--ttl-minutes is ${AUTH_LIMITS.invitationMinTtlMs / 60_000}-` +
          `${AUTH_LIMITS.invitationMaxTtlMs / 60_000}`,
      );
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const { operation, secrets } = await secretWrite(args, session, "auth.invite.create", {
        operationId,
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });
      const invitation = secrets?.invitation;
      print({ operation, ...(typeof invitation === "string" ? { invitation } : {}) });
      if (typeof invitation === "string") return 0;
      process.stderr.write(
        `cove: invitation ${String(operation.result?.inviteId)} exists, but its secret was shown ` +
          `only in the first answer to operation ${operationId}; cancel it (\`cove auth invite ` +
          `cancel\`) and create a new one\n`,
      );
      return 1;
    });
  }
  if (sub === "list") {
    takeFlags(args, []);
    if (args.words.length !== 3 || args.command)
      throw new UsageError("auth invite list takes no arguments");
    return withSession(args, async ({ client }) => {
      print(unwrap("auth.invite.list", await client.call("auth.invite.list", {})));
      return 0;
    });
  }
  if (sub === "cancel") {
    takeFlags(args, ["--operation-id"]);
    if (args.words.length !== 4 || args.command)
      throw new UsageError("auth invite cancel takes one invitation ID");
    const inviteId = id(args.words[3], InviteIdSchema, "an invitation ID");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      print(await write(args, session, "auth.invite.cancel", { operationId, inviteId }));
      return 0;
    });
  }
  throw new UsageError(`Unknown auth invite command ${sub ?? ""}`.trim());
}

// auth device rotate (D4). Phase one is the server's: it answers with a new token and keeps the
// current one valid. Phase two is this client's: the new token is saved over the old one in the
// credential file first, and only then used, so that its first use (which promotes it on the
// server and ends the old one) can never come before the client can survive a crash with it. A
// token that could not be saved is never used, and the old one keeps working.
async function rotate(args: Arguments): Promise<number> {
  takeFlags(args, ["--operation-id"]);
  if (args.words.length !== 3 || args.command)
    throw new UsageError("auth device rotate takes no arguments");
  if (!isRemote())
    throw new UsageError(
      "auth device rotate replaces a paired device's own token; name the server with --server " +
        "(the local owner has no token)",
    );
  const operationId = operationIdFor(args);
  const home = homeDirectory(args);
  // The record lock is held from reading the record (the session's token) through the rotation,
  // the save and the first use, so a concurrent rotation or record change of another command
  // waits instead of writing over this one (credentials.ts withServerLock).
  const paired = await findServer(home, currentRemote()!.alias);
  if (!paired) return withSession(args, () => Promise.resolve(1));
  return withServerLock(home, paired.serverId, () => rotateLocked(args, home, operationId));
}

async function rotateLocked(args: Arguments, home: string, operationId: string): Promise<number> {
  return withSession(args, async (session) => {
    const remote = session.remote!;
    const { operation, secrets } = await secretWrite(args, session, "auth.device.rotate", {
      operationId,
    });
    const token = secrets?.token;
    const retry = "the current token still works; run `cove auth device rotate` again";
    if (typeof token !== "string") {
      print({ operation });
      process.stderr.write(
        `cove: the new token was shown only in the first answer to operation ${operationId}; ${retry}\n`,
      );
      return 1;
    }
    try {
      // Merged into the record as it is now; under the lock it still holds the session's token.
      const latest = await readServer(home, remote.server.serverId);
      if (!latest || latest.token !== remote.server.token) throw new Error("the record changed");
      await saveServer(home, { ...latest, token });
    } catch {
      print({ operation });
      process.stderr.write(`cove: the new token could not be saved; ${retry}\n`);
      return 1;
    }
    remote.useToken(token);
    // The first request with the new token makes it the device's only token.
    const confirmed = await session.client.call("auth.device.list", {});
    print({ operation });
    if (confirmed.ok) return 0;
    process.stderr.write(
      "cove: the new token was saved, but its first use did not get an answer; the next " +
        "command uses it\n",
    );
    return 1;
  });
}

async function device(args: Arguments): Promise<number> {
  const sub = args.words[2];
  if (sub === "list") {
    takeFlags(args, ["--include-revoked"]);
    if (args.words.length !== 3 || args.command)
      throw new UsageError("auth device list takes no arguments");
    const includeRevoked = args.flags.has("--include-revoked");
    return withSession(args, async ({ client }) => {
      print(
        unwrap(
          "auth.device.list",
          await client.call("auth.device.list", includeRevoked ? { includeRevoked } : {}),
        ),
      );
      return 0;
    });
  }
  if (sub === "rename") {
    takeFlags(args, ["--expected-revision", "--operation-id"]);
    if (args.words.length !== 5 || args.command)
      throw new UsageError("auth device rename takes a device ID and a name");
    const deviceId = id(args.words[3], DeviceIdSchema, "a device ID");
    const name = args.words[4]!;
    if (!DeviceNameSchema.safeParse(name).success)
      throw new UsageError(
        `a device name is 1-${AUTH_LIMITS.deviceNameChars} printable characters`,
      );
    const expectedRevision = optionalIntegerFlag(args, "--expected-revision");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      print(
        await write(args, session, "auth.device.rename", {
          operationId,
          deviceId,
          name,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        }),
      );
      return 0;
    });
  }
  if (sub === "revoke") {
    takeFlags(args, ["--operation-id"]);
    if (args.words.length !== 4 || args.command)
      throw new UsageError("auth device revoke takes one device ID");
    const deviceId = id(args.words[3], DeviceIdSchema, "a device ID");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      // A device revoking itself: the server closes this client's terminal channel before it
      // answers, so the request goes on an HTTP request of its own (remote/direct-rpc.ts).
      const remote = session.remote;
      const sender =
        remote && remote.server.deviceId === deviceId
          ? {
              ...session,
              client: directCallClient(
                session.client,
                session.record,
                () => `Bearer ${remote.token()}`,
                "auth.device.revoke",
              ),
            }
          : session;
      // The live answer counts connections that did not close within the server's wait (D8);
      // only that answer has it, so it is read before polling.
      const accepted = await acceptWrite(args, sender, "auth.device.revoke", {
        operationId,
        deviceId,
      });
      const unclosed = accepted.result?.unclosedConnections;
      const operation = requireSucceeded(await settle(session.client, accepted));
      print(operation);
      if (typeof unclosed !== "number" || unclosed === 0) return 0;
      process.stderr.write(
        `cove: device ${deviceId} is revoked and refused from now on, but ${unclosed} of its ` +
          "connections had not closed when the server answered\n",
      );
      return 1;
    });
  }
  if (sub === "rotate") return rotate(args);
  throw new UsageError(`Unknown auth device command ${sub ?? ""}`.trim());
}

export async function run(args: Arguments): Promise<number> {
  const group = args.words[1];
  if (group === "invite") return invite(args);
  if (group === "device") return device(args);
  throw new UsageError(`Unknown auth command ${group ?? ""}`.trim());
}
