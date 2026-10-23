import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createClient, credentialSupplier, type CallOutcome, type Client } from "@cove/client";
import { createDefaultScheduler, createUtf8Codec } from "@cove/client/web-ports";
import { nodeSession } from "@cove/node-client";
import { TsnetAuthKeySchema, type TsnetStatusResultSchema } from "@cove/protocol/auth";
import type { OperationRecord } from "@cove/protocol/rpc";
import { createNodePorts } from "../node-ports.js";
import { cliBuildVersion, readRendezvous, type Session } from "../session.js";
import {
  print,
  rendezvousPath,
  sleep,
  takeFlags,
  unwrap,
  UsageError,
  type Arguments,
} from "./_common.js";
import { acceptWrite, operationIdFor } from "./_pending.js";

// `cove server tsnet ...` (m2 D9, D10; T5b): the server's own tsnet node, on this host only (a
// remote login could cut the very entry the request came through, so the methods are local-owner
// and these subcommands are not in server.ts REMOTE_SUBCOMMANDS).
//
// The auth key is read from a hidden prompt, or from stdin when stdin is not a terminal; it is
// never an argument or an environment variable, is sent once as the request's input secret and
// is never saved (the pending record omits it, so the request cannot be resent: the operator runs
// the command again). Empty input starts an interactive login: the server answers with a login
// URL, shown here once on stderr; whoever opens it decides which tailnet the node joins. At the
// prompt that is an empty line submitted with Enter; Ctrl-C, Ctrl-D, or input that ends before
// Enter cancels the command before anything is saved or sent, since starting a login on an
// enrolled node holds it until the login is settled.
export const usage = `  server tsnet login [--operation-id ID]
  server tsnet status
  server tsnet logout [--operation-id ID]

server tsnet login reads an auth key from a hidden prompt, or from stdin when it is not a
terminal; empty input (Enter at the prompt) starts an interactive login and prints its URL once;
Ctrl-C, Ctrl-D or input ending before Enter cancels without sending anything. The node then serves
the business port, and the pairing port while an invitation is open. server tsnet logout removes
the node's state; if the control plane did not confirm it, remove the node in the admin console.`;

type TsnetStatus = ReturnType<typeof TsnetStatusResultSchema.parse>;

// The server answers a login live for up to 25 s (apps/server rpc/tsnet.ts); the request timeout
// must be longer than that, or a login still in progress would look lost.
const RPC_TIMEOUT_MS = 30_000;
// An auth-key login may take the helper's full 60 s; a running record is followed this long.
const OPERATION_WAIT_MS = 90_000;
// After an interactive login, how long the node is watched for the login to be completed.
const INTERACTIVE_WAIT_MS = 5 * 60_000;
const POLL_MS = 500;
const KEY_INPUT_BYTES = 1024;

export async function run(args: Arguments, input: KeyInput = process.stdin): Promise<number> {
  const sub = args.words[2];
  if (args.command) throw new UsageError("server tsnet takes no command after --");
  if (sub === "status") {
    takeFlags(args, []);
    if (args.words.length !== 3) throw new UsageError("server tsnet status takes no arguments");
    return withLocalSession(args, async (session) => {
      print(await currentStatus(session.client));
      return 0;
    });
  }
  if (sub === "login") {
    takeFlags(args, ["--operation-id"]);
    if (args.words.length !== 3) throw new UsageError("server tsnet login takes no arguments");
    return login(args, input);
  }
  if (sub === "logout") {
    takeFlags(args, ["--operation-id"]);
    if (args.words.length !== 3) throw new UsageError("server tsnet logout takes no arguments");
    return logout(args);
  }
  throw new UsageError("server tsnet is login, status or logout");
}

// A session with the local server whose requests may take RPC_TIMEOUT_MS (session.ts
// createSessionClient, with a longer request timeout).
async function withLocalSession<T>(
  args: Arguments,
  action: (session: Session) => Promise<T>,
): Promise<T> {
  const record = await readRendezvous(rendezvousPath(args));
  const client = createClient({
    expectedServerId: record.serverId,
    expectedRelayInstanceId: record.relayInstanceId,
    buildVersion: cliBuildVersion(),
    credentials: credentialSupplier(
      () => ({ kind: "local-secret", secret: record.secret }),
      record.serverId,
    ),
    codec: createUtf8Codec(),
    createOpaqueId: () => randomUUID(),
    scheduler: createDefaultScheduler(),
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    ...createNodePorts(record.endpoint),
  });
  try {
    const connected = await client.connect();
    if (!connected.ok)
      throw new Error(
        `Cannot connect to ${record.endpoint}: ${connected.error.category} ${connected.error.reason}`,
      );
    return await action(
      nodeSession(record, client, () => ({ kind: "local-secret", secret: record.secret })),
    );
  } finally {
    client.dispose();
  }
}

async function currentStatus(client: Client): Promise<TsnetStatus> {
  const outcome = await client.call("server.tsnet.status", {});
  if (!outcome.ok && outcome.kind === "rpc-error" && "kind" in outcome.error)
    if (outcome.error.kind === "BUSY")
      throw new Error("the tsnet node is busy with a login or logout; ask again shortly");
  return unwrap("server.tsnet.status", outcome) as TsnetStatus;
}

// Where the key is read from: stdin, or in tests a stream that says whether it is a terminal.
type KeyInput = NodeJS.ReadableStream & { readonly isTTY?: boolean };

// Reads the key without it ever being an argument: a prompt that does not echo when stdin is a
// terminal, otherwise stdin itself, bounded. Never printed, not even in an error. Null when the
// prompt was cancelled; undefined for an interactive login.
//
// At the prompt only a line ended with Enter is an answer. readline also ends a typed but
// unterminated line as a `line` when its input ends (EOF, a hangup); that text was never
// submitted, so it cancels like Ctrl-C, Ctrl-D at an empty prompt and a terminal that fails.
// Non-terminal stdin is read to its end as before, so a key piped without a newline still works.
async function readAuthKey(input: KeyInput): Promise<string | undefined | null> {
  let text: string;
  if (input.isTTY) {
    const prompt = createInterface({
      input,
      output: process.stderr,
      terminal: true,
    });
    process.stderr.write("Auth key (input is hidden; empty for an interactive login): ");
    // readline echoes typed input through _writeToOutput; silencing it hides the key.
    (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    let answer: string | null;
    try {
      answer = await new Promise<string | null>((resolve) => {
        // The input has ended when readline flushes an unterminated line at EOF.
        const ended = (): boolean => (input as { readableEnded?: boolean }).readableEnded === true;
        prompt.once("line", (line) => resolve(ended() ? null : line));
        // Without a SIGINT listener readline turns Ctrl-C into a close, which must not read as
        // an empty answer; a close without a line (Ctrl-D, a lost terminal) is no answer either.
        prompt.once("SIGINT", () => resolve(null));
        prompt.once("close", () => resolve(null));
        // readline passes an error of its input (a terminal that failed) on to the interface.
        prompt.on("error", () => resolve(null));
      });
    } finally {
      prompt.close();
      process.stderr.write("\n");
    }
    if (answer === null) return null;
    text = answer;
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of input as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > KEY_INPUT_BYTES) throw new Error("the input is too long for an auth key");
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  const key = text.trim();
  if (key === "") return undefined;
  if (!TsnetAuthKeySchema.safeParse(key).success)
    throw new UsageError("that is not an auth key (16-512 printable characters, no spaces)");
  return key;
}

// Sends one write and keeps the output secrets of its live answer in this process (the pending
// record and acceptWrite's return value never hold them).
async function sendWrite(
  args: Arguments,
  session: Session,
  method: "server.tsnet.login" | "server.tsnet.logout",
  params: Record<string, unknown> & { operationId: string },
): Promise<{ operation: OperationRecord; loginUrl: string | undefined }> {
  let loginUrl: string | undefined;
  const call = (async (name: string, value: unknown) => {
    const outcome = (await session.client.call(name as never, value as never)) as CallOutcome<{
      secrets?: { loginUrl?: unknown };
    }>;
    if (outcome.ok && typeof outcome.value.secrets?.loginUrl === "string")
      loginUrl = outcome.value.secrets.loginUrl;
    return outcome;
  }) as Client["call"];
  const client = new Proxy(session.client, {
    get: (target, key, receiver) =>
      key === "call" ? call : (Reflect.get(target, key, receiver) as unknown),
  });
  const accepted = await acceptWrite(args, { ...session, client }, method, params);
  return { operation: await followOperation(session.client, accepted), loginUrl };
}

// Follows an accepted operation to its terminal record (bounded); the write is never repeated.
async function followOperation(client: Client, initial: OperationRecord): Promise<OperationRecord> {
  const id = initial.operationId;
  let operation = initial;
  const deadline = Date.now() + OPERATION_WAIT_MS;
  while (
    operation.state === "accepted" ||
    operation.state === "running" ||
    operation.state === "recovering"
  ) {
    if (Date.now() > deadline)
      throw new Error(
        `operation ${id} was accepted and is still ${operation.state}; inspect it with ` +
          `\`cove operation get ${id}\` and \`cove server tsnet status\``,
      );
    await sleep(POLL_MS);
    const read = await client.getOperation(id);
    if (!read.ok)
      throw new Error(
        `operation ${id} was accepted, but reading its state failed; inspect it with ` +
          `\`cove operation get ${id}\` and \`cove server tsnet status\``,
      );
    operation = read.value.operation;
  }
  return operation;
}

const IDENTITY_CHANGED =
  "the login ended as another node than the enrolled one, so the node serves nothing. " +
  "Paired clients pin the enrolled node: run `cove server tsnet logout`, log in with the " +
  "intended key, then pair the clients again";

// The explanation of an operation that did not succeed, honest about what is known.
async function explainFailure(client: Client, operation: OperationRecord): Promise<string> {
  const id = operation.operationId;
  const kind = operation.error?.kind;
  if (operation.state === "requires_attention")
    return (
      `the outcome of operation ${id} is unknown (${kind ?? "RESULT_UNKNOWN"}); the node may or ` +
      "may not have changed. Check `cove server tsnet status` before trying again"
    );
  switch (kind) {
    case "TSNET_LOGIN_FAILED": {
      const status = await currentStatus(client).catch(() => undefined);
      if (status?.state === "running" && status.hold === null)
        return "the node is already logged in; nothing was changed (log out first to change it)";
      return "the login was refused or did not finish; the node is unchanged (`cove server tsnet status`)";
    }
    case "TSNET_IDENTITY_CHANGED":
      return IDENTITY_CHANGED;
    case "TSNET_LOGIN_UNCERTAIN":
      return (
        "the login did not finish and may still have completed, so the node serves nothing " +
        "until its identity is known; `cove server tsnet status` settles it"
      );
    case "ENTRY_UNAVAILABLE":
      return "the server's tsnet node is not available (`cove server tsnet status` says why)";
    default:
      return `operation ${id} ${operation.state}${kind ? `: ${kind}` : ""}`;
  }
}

async function login(args: Arguments, input: KeyInput): Promise<number> {
  const operationId = operationIdFor(args);
  const authKey = await readAuthKey(input);
  if (authKey === null) {
    process.stderr.write("cove: the login was cancelled; nothing was sent\n");
    return 130;
  }
  return withLocalSession(args, async (session) => {
    const { operation, loginUrl } = await sendWrite(args, session, "server.tsnet.login", {
      operationId,
      ...(authKey ? { secrets: { authKey } } : {}),
    });
    if (operation.state !== "succeeded") {
      print({ operation });
      process.stderr.write(`cove: ${await explainFailure(session.client, operation)}\n`);
      return 1;
    }
    if (operation.result?.secretDelivery && !loginUrl) {
      print({ operation });
      process.stderr.write(
        `cove: the login URL of operation ${operationId} was delivered only in the first answer, ` +
          "which this command did not receive; run `cove server tsnet login` again\n",
      );
      return 1;
    }
    let status = await currentStatus(session.client);
    if (loginUrl) {
      // Shown once, on stderr only: whoever opens it attaches the node to their tailnet.
      process.stderr.write(`To log the server's tsnet node in, open:\n  ${loginUrl}\n`);
      const deadline = Date.now() + INTERACTIVE_WAIT_MS;
      while (status.state !== "running" || status.hold === "login-uncertain") {
        if (status.hold === "identity-changed" || Date.now() > deadline) break;
        await sleep(POLL_MS * 2);
        status = await currentStatus(session.client).catch(() => status);
      }
    }
    print({ operation, status });
    if (status.hold === "identity-changed") {
      process.stderr.write(`cove: ${IDENTITY_CHANGED}\n`);
      return 1;
    }
    if (status.state !== "running") {
      process.stderr.write(
        `cove: the node is ${status.state}${status.warnings[0] ? ` (${status.warnings[0]})` : ""}\n`,
      );
      return 1;
    }
    return 0;
  });
}

async function logout(args: Arguments): Promise<number> {
  const operationId = operationIdFor(args);
  return withLocalSession(args, async (session) => {
    // A node that is not logged in has nothing to log out, and the helper would report the
    // control plane's confirmation as missing; say so instead of warning about the admin console.
    // An explicit --operation-id is always sent, so that a resend reads its operation's record.
    if (args.flags.get("--operation-id") === undefined) {
      const status = await currentStatus(session.client);
      if (status.state === "logged-out") {
        print({ status });
        process.stderr.write("cove: the server's tsnet node is not logged in; nothing was done\n");
        return 0;
      }
    }
    const { operation } = await sendWrite(args, session, "server.tsnet.logout", { operationId });
    print({ operation });
    if (operation.state !== "succeeded") {
      process.stderr.write(`cove: ${await explainFailure(session.client, operation)}\n`);
      return 1;
    }
    if (operation.result?.remoteLogoutConfirmed === false)
      process.stderr.write(
        "cove: the node's state was removed here, but the control plane did not confirm the " +
          "logout; remove the node in the tailnet's admin console\n",
      );
    return 0;
  });
}
