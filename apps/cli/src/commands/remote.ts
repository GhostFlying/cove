import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { AUTH_LIMITS, DeviceNameSchema } from "@cove/protocol/auth";
import {
  ALIAS_PATTERN,
  describeServer,
  findServer,
  isEntryKind,
  listServers,
  readServer,
  removeServer,
  saveServer,
  withServerLock,
  type ServerRecord,
} from "../remote/credentials.js";
import type { Via } from "../remote/entries.js";
import { pairedRecord, parseInvitation, redeemInvitation } from "../remote/pairing.js";
import { cliBuildVersion } from "../session.js";
import { flag, homeDirectory, print, takeFlags, UsageError, type Arguments } from "./_common.js";
import { run as runTsnet, usage as tsnetUsage } from "./_remote_tsnet.js";

export const usage = `  remote add <ALIAS> [--name DEVICE_NAME] [--via ssh|tsnet]
  remote list
  remote remove <ALIAS>
  remote entry default <ALIAS> loopback|ssh|tsnet
${tsnetUsage}

remote add pairs this client with a server: it reads an invitation (from \`cove auth invite
create\` on the server, or on another paired device) from a hidden prompt, or from stdin when
stdin is not a terminal; the invitation is never accepted as an argument. The client's token is
kept in <home>/client/servers/<serverId>.json (0600). A lost pairing answer is not retried:
create a new invitation and pair again; \`cove auth device list\` shows the device the lost
attempt left as never-connected, and \`cove auth device revoke\` removes it. remote remove
forgets the server on this client only; revoke the device on the server as well. Without --via,
remote add pairs with a server on this host (loopback); with --via ssh it pairs through the
invitation's SSH target, which ssh must already know (known_hosts); with --via tsnet it pairs
through the invitation's tsnet node from this client's own node (\`cove remote tsnet login\`
first). Either way the record holds every entry the invitation names (its SSH target and tsnet
node), plus loopback when paired on the server's host; the entry the pairing went through is the
default. A command uses --via ssh|tsnet or the default, and never switches entries on its own;
\`remote entry default\` changes the default.`;

// These commands manage this client's own records; they never address a server with --server.
export const localOnly = true;

const INVITATION_INPUT_BYTES = AUTH_LIMITS.invitationChars + 64;

// Reads the invitation without it ever being an argument (m2 "秘密与操作记录的分界" item 5): a
// prompt that does not echo when stdin is a terminal, otherwise stdin itself, bounded.
async function readInvitation(): Promise<string> {
  if (process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    process.stderr.write("Invitation (input is hidden): ");
    // readline echoes typed input through _writeToOutput; silencing it hides the secret.
    (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        prompt.once("line", resolve);
        prompt.once("close", () => reject(new Error("no invitation was entered")));
      });
    } finally {
      prompt.close();
      process.stderr.write("\n");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > INVITATION_INPUT_BYTES) throw new Error("the input is too long for an invitation");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The default device name: this host's name, cut to a valid name. The server shows it in lists
// only.
function defaultDeviceName(): string {
  const name = [...hostname()]
    .filter((char) => char >= " " && char !== "\u007f")
    .join("")
    .slice(0, AUTH_LIMITS.deviceNameChars);
  return name || "cove-client";
}

function alias(value: string | undefined): string {
  if (value === undefined || !ALIAS_PATTERN.test(value))
    throw new UsageError(
      "an alias is 1-64 of a-z, 0-9, '.', '_' or '-', starting with a letter or digit",
    );
  return value;
}

function alreadyPaired(record: ServerRecord, reason: string): Error {
  return new Error(
    `${reason} (entries: ${Object.keys(record.entries).join(", ")}); one record holds every entry ` +
      `of a server. To pair again, run \`cove remote remove ${record.alias}\` first and ` +
      `revoke its device (${record.deviceId}) on the server. The invitation was not used`,
  );
}

async function add(args: Arguments): Promise<number> {
  takeFlags(args, ["--name"]);
  if (args.words.length !== 3 || args.command) throw new UsageError("remote add takes one alias");
  const name = alias(args.words[2]);
  const deviceName = flag(args, "--name") ?? defaultDeviceName();
  if (!DeviceNameSchema.safeParse(deviceName).success)
    throw new UsageError(`--name is 1-${AUTH_LIMITS.deviceNameChars} printable characters`);
  const via = flag(args, "--via") as Via | undefined;
  const home = homeDirectory(args);
  const named = await findServer(home, name);
  if (named) throw alreadyPaired(named, `a server is already named ${name}`);
  const payload = parseInvitation(await readInvitation());
  const existing = (await listServers(home)).find((record) => record.serverId === payload.serverId);
  if (existing)
    throw alreadyPaired(
      existing,
      `this client is already paired with that server as ${existing.alias}`,
    );
  const result = await redeemInvitation(payload, deviceName, via, cliBuildVersion(), home);
  // The entries this pairing reached and the invitation's (remote/pairing.ts pairedRecord).
  const record = pairedRecord(name, payload, result, via);
  try {
    await saveServer(home, record);
  } catch {
    throw new Error(
      `device ${result.deviceId} was paired, but its token could not be saved under ${home}; ` +
        `revoke it on the server (\`cove auth device revoke ${result.deviceId}\`) and pair again`,
    );
  }
  print(describeServer(record));
  return 0;
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "add") return add(args);
  if (sub === "tsnet") return runTsnet(args);
  if (flag(args, "--via") !== undefined) throw new UsageError("--via applies to remote add only");
  const home = homeDirectory(args);
  if (sub === "list") {
    takeFlags(args, []);
    if (args.words.length !== 2 || args.command)
      throw new UsageError("remote list takes no arguments");
    print({ servers: (await listServers(home)).map(describeServer) });
    return 0;
  }
  if (sub === "remove") {
    takeFlags(args, []);
    if (args.words.length !== 3 || args.command)
      throw new UsageError("remote remove takes one alias");
    const found = await findServer(home, alias(args.words[2]));
    if (!found) throw new Error(`no paired server is named ${args.words[2]}`);
    // Under the record lock: a rotation in progress finishes (or a removal comes first) rather
    // than saving its token into a record removed meanwhile.
    return withServerLock(home, found.serverId, async () => {
      const record = await readServer(home, found.serverId);
      if (!record) throw new Error(`no paired server is named ${args.words[2]}`);
      await removeServer(home, record);
      print({ removed: describeServer(record) });
      return 0;
    });
  }
  if (sub === "entry") {
    takeFlags(args, []);
    const [, , verb, target, kind] = args.words;
    if (verb !== "default" || args.words.length !== 5 || args.command || !isEntryKind(kind))
      throw new UsageError("remote entry default takes an alias and loopback, ssh or tsnet");
    const found = await findServer(home, alias(target));
    if (!found) throw new Error(`no paired server is named ${target}`);
    // The default entry is merged into the record as it is under the lock, so a token a
    // concurrent rotation saved is kept (credentials.ts withServerLock).
    return withServerLock(home, found.serverId, async () => {
      const record = await readServer(home, found.serverId);
      if (!record) throw new Error(`no paired server is named ${target}`);
      if (!Object.hasOwn(record.entries, kind))
        throw new Error(
          `${record.alias} has no verified ${kind} entry (entries: ${Object.keys(record.entries).join(", ")})`,
        );
      const updated: ServerRecord = { ...record, defaultEntry: kind };
      await saveServer(home, updated);
      print(describeServer(updated));
      return 0;
    });
  }
  throw new UsageError(`Unknown remote command ${sub ?? ""}`.trim());
}
