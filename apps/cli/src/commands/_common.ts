import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { CallOutcome, Client } from "@cove/client";
import type { OperationRecord } from "@cove/protocol/rpc";
import { ALIAS_PATTERN } from "../remote/credentials.js";
import type { Via } from "../remote/entries.js";
import { openRemoteSession, openSession, type Session } from "../session.js";

// Shared CLI plumbing for the command modules. A module named `<group>.ts` in this directory
// serves `cove <group> ...` (main.ts discovers it); modules whose names start with `_` are helpers.

export class UsageError extends Error {}

// A failure that should end the CLI with a specific status, such as a server child's own.
export class StatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Arguments {
  readonly words: string[];
  readonly flags: Map<string, string[]>;
  // Everything after `--`, passed through verbatim as the spawned command line.
  readonly command: string[] | undefined;
}

// Options every command accepts: where the data directory and the server rendezvous are, and
// which paired server a command addresses (m2 D11): `--server ALIAS` (or COVE_SERVER) and the
// entry `--via ssh|tsnet` (otherwise the alias's fixed default entry). Commands that only act on
// this host refuse --server (main.ts `localOnly`).
export const GLOBAL_FLAGS = ["--home", "--rendezvous", "--server", "--via"] as const;

// Flags that take no value. main.ts answers --help before a command runs.
export const SWITCHES: ReadonlySet<string> = new Set([
  "--harness",
  "--reset",
  "--no-fetch",
  "--yes",
  "--help",
  "--include-revoked",
]);

export function parseArguments(argv: readonly string[]): Arguments {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (item === "--") return { words, flags, command: argv.slice(i + 1) };
    if (SWITCHES.has(item)) {
      flags.set(item, [...(flags.get(item) ?? []), ""]);
    } else if (item.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${item} needs a value`);
      flags.set(item, [...(flags.get(item) ?? []), value]);
      i++;
    } else words.push(item);
  }
  return { words, flags, command: undefined };
}

// `repeatable` names the allowed flags that may be given more than once (their values are kept in
// order, see flagValues).
export function takeFlags(
  args: Arguments,
  allowed: readonly string[],
  repeatable: readonly string[] = [],
): void {
  for (const name of args.flags.keys())
    if (!(GLOBAL_FLAGS as readonly string[]).includes(name) && !allowed.includes(name))
      throw new UsageError(`Unknown option ${name}`);
  for (const [name, values] of args.flags)
    if (name !== "--origin" && !repeatable.includes(name) && values.length > 1)
      throw new UsageError(`${name} given twice`);
}

export function flagValues(args: Arguments, name: string): string[] {
  return args.flags.get(name) ?? [];
}

// The paired server this command addresses, or null for the local server (m2 D11). Set once by
// main.ts (selectTarget) before the command runs; path arguments depend on it (hostPath).
export type RemoteTarget = { readonly alias: string; readonly via?: Via };
let remoteTarget: RemoteTarget | null = null;

// Chooses the target from --server, then COVE_SERVER, and checks --via. `localOnly`: the command
// acts on this host only (server setup, the client's own pairing records), so --server is refused
// and COVE_SERVER does not apply; such a command reads --via itself if it has a use for it.
export function selectTarget(args: Arguments, localOnly: boolean): RemoteTarget | null {
  const flagged = flag(args, "--server");
  const via = flag(args, "--via");
  if (via !== undefined && via !== "ssh" && via !== "tsnet")
    throw new UsageError("--via is ssh or tsnet");
  if (localOnly) {
    if (flagged !== undefined)
      throw new UsageError("this command acts on this host only; --server does not apply");
    remoteTarget = null;
    return null;
  }
  const alias = flagged ?? (process.env.COVE_SERVER || undefined);
  if (alias === undefined) {
    if (via !== undefined) throw new UsageError("--via needs --server (or COVE_SERVER)");
    remoteTarget = null;
    return null;
  }
  if (!ALIAS_PATTERN.test(alias))
    throw new UsageError("a server alias is 1-64 of a-z, 0-9, '.', '_' or '-'");
  if (flag(args, "--rendezvous") !== undefined)
    throw new UsageError("--rendezvous names a local server; it cannot be combined with --server");
  remoteTarget = { alias, ...(via ? { via: via as Via } : {}) };
  return remoteTarget;
}

// Whether this command addresses a paired server rather than the local one.
export function isRemote(): boolean {
  return remoteTarget !== null;
}

// The path the server should inspect.
//
// Local mode (M1): a relative path is made absolute against this command's directory without
// normalizing it: `..` after a symlink means something else than lexical normalization says, and
// the server resolves the real path (and drops a trailing slash) itself. Rebuilding the command
// from the same directory produces the same intent.
//
// Remote mode (m2 D11, S13): the path is the execution host's, and this host's directory says
// nothing about that one, so only an absolute path is accepted and it is sent exactly as given;
// a relative one is a usage error before anything is saved or sent.
export function hostPath(path: string): string {
  if (isAbsolute(path)) return path;
  if (remoteTarget)
    throw new UsageError(
      `${path} is relative: with --server, paths are absolute paths on the server's host`,
    );
  const cwd = process.cwd();
  return cwd.endsWith(sep) ? `${cwd}${path}` : `${cwd}${sep}${path}`;
}

export function flag(args: Arguments, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

export function integerFlag(args: Arguments, name: string, fallback: number): number {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,6}$/.test(value)) throw new UsageError(`${name} must be a non-negative integer`);
  return Number(value);
}

export function optionalIntegerFlag(args: Arguments, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new UsageError(`${name} must be a non-negative integer`);
  return Number(value);
}

export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function one(args: Arguments, what: string): string {
  if (args.words.length !== 3 || args.command) throw new UsageError(`expected exactly one ${what}`);
  return args.words[2]!;
}

// The data directory (D5): --home, then COVE_HOME, then ~/.cove. The CLI keeps its own state
// (pending operation records, start locks) under `<home>/cli` and passes the home to the server.
export function homeDirectory(args: Arguments): string {
  return resolve(flag(args, "--home") ?? (process.env.COVE_HOME || join(homedir(), ".cove")));
}

// The rendezvous the server of this data directory publishes, unless --rendezvous or
// COVE_RENDEZVOUS names another one.
export function homeRendezvousPath(home: string): string {
  return join(home, "server", "run", "rendezvous.json");
}

export function rendezvousPath(args: Arguments): string {
  return resolve(
    flag(args, "--rendezvous") ??
      (process.env.COVE_RENDEZVOUS || homeRendezvousPath(homeDirectory(args))),
  );
}

export function describeFailure(outcome: Exclude<CallOutcome<unknown>, { ok: true }>): string {
  switch (outcome.kind) {
    case "local-error":
      return `${outcome.error.category} ${outcome.error.reason}`;
    case "rpc-error":
      return "kind" in outcome.error
        ? `${outcome.error.kind} (${outcome.error.acceptance}, next: ${outcome.error.nextAction})`
        : `${outcome.error.code} ${outcome.error.message}`;
    case "operation-not-sent":
      return `operation ${outcome.operation.operationId} was not sent; nothing was executed`;
    case "operation-unknown":
      // The write may have taken effect. Never resend it; point at the read-only receipt.
      return (
        `operation ${outcome.operation.operationId} outcome is unknown (${outcome.error.kind}); ` +
        `inspect it with \`cove operation get ${outcome.operation.operationId}\``
      );
  }
}

export function unwrap<T>(method: string, outcome: CallOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw new Error(`${method} failed: ${describeFailure(outcome)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

const OPERATION_WAIT_MS = 30_000;
const POLL_MS = 100;
const UNSETTLED: ReadonlySet<OperationRecord["state"]> = new Set([
  "accepted",
  "running",
  "recovering",
]);

// Writes are acknowledged once the server records the operation; poll its receipt until it
// reaches a terminal state so the command reports what actually happened. The write was
// accepted, so every polling failure must still name the operation and point at its read-only
// receipt; the caller must never be left to guess or resend. `observed`, when given, is told each
// record read, so a caller that reports a failed poll can print the latest record rather than the
// one it started from.
export async function settle(
  client: Client,
  initial: OperationRecord,
  observed?: (operation: OperationRecord) => void,
): Promise<OperationRecord> {
  const id = initial.operationId;
  const inspect = `inspect it with \`cove operation get ${id}\``;
  let operation = initial;
  const deadline = Date.now() + OPERATION_WAIT_MS;
  while (UNSETTLED.has(operation.state)) {
    if (Date.now() > deadline)
      throw new Error(`operation ${id} was accepted and is still ${operation.state}; ${inspect}`);
    await sleep(POLL_MS);
    try {
      operation = unwrap("operation.get", await client.getOperation(id)).operation;
      observed?.(operation);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `operation ${id} was accepted, but polling its state failed (${detail}); ${inspect}`,
      );
    }
  }
  return operation;
}

export function requireSucceeded(operation: OperationRecord): OperationRecord {
  if (operation.state === "succeeded") return operation;
  const reason = operation.error ? `: ${operation.error.kind}` : "";
  throw new Error(`${operation.method} ${operation.operationId} ${operation.state}${reason}`);
}

// Runs `action` with a session to the command's target: the local server of the rendezvous, or
// the paired server selectTarget chose, over its selected entry.
export async function withSession<T>(
  args: Arguments,
  action: (session: Session) => Promise<T>,
): Promise<T> {
  const session = remoteTarget
    ? await openRemoteSession(homeDirectory(args), remoteTarget.alias, remoteTarget.via)
    : await openSession(rendezvousPath(args));
  try {
    return await action(session);
  } finally {
    session.client.dispose();
    await session.close?.();
  }
}
