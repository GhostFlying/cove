#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type { CallOutcome, Client } from "@cove/client";
import { M0_LIMITS } from "@cove/protocol/budgets";
import type { OperationRecord, RunRecord } from "@cove/protocol/rpc";
import { openSession, readRendezvous, resolveRendezvousPath, type Session } from "./session.js";

const USAGE = `usage: cove [--rendezvous PATH] <command>

  server start [--port N] [--origin URL]...
  status
  terminal create [--cwd DIR] [--cols N] [--rows N] -- <executable> [args...]
  terminal list
  terminal get <runId>
  terminal stop <runId>
  operation get <operationId>

The rendezvous path defaults to $COVE_RENDEZVOUS or ~/.cove/m0/run/rendezvous.json.`;

const OPERATION_WAIT_MS = 30_000;
const POLL_MS = 100;
const RENDEZVOUS_WAIT_MS = 20_000;

class UsageError extends Error {}

interface Arguments {
  readonly words: string[];
  readonly flags: Map<string, string[]>;
  // Everything after `--`, passed through verbatim as the spawned command line.
  readonly command: string[] | undefined;
}

function parseArguments(argv: readonly string[]): Arguments {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (item === "--") return { words, flags, command: argv.slice(i + 1) };
    if (item.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${item} needs a value`);
      flags.set(item, [...(flags.get(item) ?? []), value]);
      i++;
    } else words.push(item);
  }
  return { words, flags, command: undefined };
}

function takeFlags(args: Arguments, allowed: readonly string[]): void {
  for (const name of args.flags.keys())
    if (name !== "--rendezvous" && !allowed.includes(name))
      throw new UsageError(`Unknown option ${name}`);
  for (const [name, values] of args.flags)
    if (name !== "--origin" && values.length > 1) throw new UsageError(`${name} given twice`);
}

function flag(args: Arguments, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function integerFlag(args: Arguments, name: string, fallback: number): number {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,6}$/.test(value)) throw new UsageError(`${name} must be a non-negative integer`);
  return Number(value);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function describeFailure(outcome: Exclude<CallOutcome<unknown>, { ok: true }>): string {
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

function unwrap<T>(method: string, outcome: CallOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw new Error(`${method} failed: ${describeFailure(outcome)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Writes are acknowledged once the server records the operation; poll its receipt until it
// reaches a terminal state so the command reports what actually happened to the run. The
// write was accepted, so every polling failure must still name the operation and point at
// its read-only receipt; the caller must never be left to guess or resend.
async function settle(client: Client, initial: OperationRecord): Promise<OperationRecord> {
  const id = initial.operationId;
  const inspect = `inspect it with \`cove operation get ${id}\``;
  let operation = initial;
  const deadline = Date.now() + OPERATION_WAIT_MS;
  while (operation.state === "accepted" || operation.state === "running") {
    if (Date.now() > deadline)
      throw new Error(`operation ${id} was accepted and is still ${operation.state}; ${inspect}`);
    await sleep(POLL_MS);
    try {
      operation = unwrap("operation.get", await client.getOperation(id)).operation;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `operation ${id} was accepted, but polling its state failed (${detail}); ${inspect}`,
      );
    }
  }
  return operation;
}

function requireSucceeded(operation: OperationRecord): OperationRecord {
  if (operation.state === "succeeded") return operation;
  const reason = operation.error ? `: ${operation.error.kind}` : "";
  throw new Error(`${operation.method} ${operation.operationId} ${operation.state}${reason}`);
}

function runRef(session: Session, runId: string) {
  return {
    serverId: session.record.serverId,
    relayInstanceId: session.record.relayInstanceId,
    runId,
  };
}

async function listRuns(client: Client): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let afterRunId: string | undefined;
  do {
    const page = unwrap(
      "terminal.list",
      await client.call("terminal.list", {
        limit: M0_LIMITS.listPage,
        ...(afterRunId ? { afterRunId } : {}),
      }),
    );
    runs.push(...page.runs);
    afterRunId = page.nextAfterRunId;
  } while (afterRunId);
  return runs;
}

function one(args: Arguments, what: string): string {
  if (args.words.length !== 3 || args.command) throw new UsageError(`expected exactly one ${what}`);
  return args.words[2]!;
}

async function withSession(args: Arguments, action: (session: Session) => Promise<void>) {
  const session = await openSession(flag(args, "--rendezvous"));
  try {
    await action(session);
  } finally {
    session.client.dispose();
  }
}

async function terminalCommand(args: Arguments): Promise<void> {
  const sub = args.words[1];
  if (sub === "create") {
    takeFlags(args, ["--cwd", "--cols", "--rows"]);
    const [executable, ...argv] = args.command ?? [];
    if (args.words.length !== 2 || !executable)
      throw new UsageError("terminal create needs `-- <executable> [args...]`");
    const geometry = {
      cols: integerFlag(args, "--cols", 80),
      rows: integerFlag(args, "--rows", 24),
    };
    const cwd = resolve(flag(args, "--cwd") ?? process.cwd());
    return withSession(args, async ({ client, record }) => {
      const created = unwrap(
        "terminal.create",
        await client.call("terminal.create", {
          executable,
          argv,
          cwd,
          geometry,
          operationId: randomUUID(),
          expectedRelayInstanceId: record.relayInstanceId,
        }),
      );
      const operation = requireSucceeded(await settle(client, created.operation));
      print(operation.result?.run ?? operation.run);
    });
  }
  if (sub === "list") {
    takeFlags(args, []);
    if (args.words.length !== 2 || args.command)
      throw new UsageError("terminal list takes no arguments");
    return withSession(args, async ({ client }) => print({ runs: await listRuns(client) }));
  }
  if (sub === "get") {
    takeFlags(args, []);
    const runId = one(args, "run id");
    return withSession(args, async (session) => {
      const run = runRef(session, runId);
      print(unwrap("terminal.get", await session.client.call("terminal.get", { run })).record);
    });
  }
  if (sub === "stop") {
    takeFlags(args, []);
    const runId = one(args, "run id");
    return withSession(args, async (session) => {
      const stopped = unwrap(
        "terminal.stop",
        await session.client.call("terminal.stop", {
          run: runRef(session, runId),
          operationId: randomUUID(),
          expectedRelayInstanceId: session.record.relayInstanceId,
        }),
      );
      print(requireSucceeded(await settle(session.client, stopped.operation)));
    });
  }
  throw new UsageError(`Unknown terminal command ${sub ?? ""}`.trim());
}

function serverEntry(): Promise<string> {
  // The CLI depends on @cove/server as a workspace package, so its installed manifest is the
  // single source for the executable path; no repository-relative path is assumed.
  const manifestPath = createRequire(import.meta.url).resolve("@cove/server/package.json");
  return readFile(manifestPath, "utf8").then((text) => {
    const bin = (JSON.parse(text) as { bin?: Record<string, string> }).bin?.["cove-server"];
    if (!bin) throw new Error("@cove/server does not declare the cove-server executable");
    return join(dirname(manifestPath), bin);
  });
}

// The server publishes the rendezvous only into an owner-only directory reached through no
// symlinked ancestor, and creates that final directory itself. Create the ancestors with 0700
// and canonicalize them (macOS /tmp and /var are symlinks) so the server's checks pass.
async function prepareRendezvousPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const runDirectory = dirname(absolute);
  const base = dirname(runDirectory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  return join(await realpath(base), basename(runDirectory), basename(absolute));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// The rendezvous record carries no pid, so a record cannot be traced back to the process
// that published it. Instead `server start` holds an exclusive lock beside the run directory
// from its existence check until readiness is announced: while the lock is held no other
// CLI start can spawn a server for this path, so a record that appears after our check was
// published by our child. Without it two concurrent starts both pass the check and the loser
// announces the winner's record while its own child fails to link the path and exits. A
// crashed CLI can leave the lock behind; that is reported rather than silently broken,
// because breaking a live start's lock would reintroduce the race.
async function acquireStartLock(path: string): Promise<() => Promise<void>> {
  const lock = `${dirname(path)}.start.lock`;
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `${lock} exists; another \`cove server start\` is in progress. ` +
        "Remove the file if no such command is running.",
    );
  }
  const owned = await handle.stat();
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return async () => {
    // Remove only the lock this process created, never one an operator replaced.
    try {
      const current = await lstat(lock);
      if (current.dev === owned.dev && current.ino === owned.ino) await unlink(lock);
    } catch {
      /* Already gone. */
    }
  };
}

async function waitForRendezvous(path: string, child: ChildProcess) {
  const running = () => child.exitCode === null && child.signalCode === null;
  let failed = false;
  child.once("error", () => (failed = true));
  const deadline = Date.now() + RENDEZVOUS_WAIT_MS;
  while (Date.now() < deadline) {
    if (failed || !running())
      throw new Error("cove-server exited before publishing its rendezvous");
    if (await exists(path)) {
      let record;
      try {
        record = await readRendezvous(path);
      } catch {
        // The server links a complete file atomically; a failed read is a foreign file.
        throw new Error(`Unexpected rendezvous content at ${path}`);
      }
      // A child that already exited cannot own the record it would be announced with.
      if (failed || !running())
        throw new Error("cove-server exited before its rendezvous could be confirmed");
      return record;
    }
    await sleep(50);
  }
  throw new Error("cove-server did not publish its rendezvous in time");
}

async function serverStart(args: Arguments): Promise<number> {
  takeFlags(args, ["--port", "--origin"]);
  if (args.words.length !== 2 || args.command)
    throw new UsageError("server start takes no arguments");
  const port = integerFlag(args, "--port", 0);
  const path = await prepareRendezvousPath(resolveRendezvousPath(flag(args, "--rendezvous")));
  const origins = args.flags.get("--origin") ?? [];
  const entry = await serverEntry();
  const releaseLock = await acquireStartLock(path);
  let exit: Promise<number>;
  try {
    if (await exists(path))
      throw new Error(
        `${path} already exists; another server may be running. ` +
          "Stop it, or remove the file if that server is gone.",
      );
    const child = spawn(
      process.execPath,
      [
        entry,
        ...["--mode", "m0-local", "--host", "127.0.0.1", "--port", String(port)],
        ...["--rendezvous", path],
        ...origins.flatMap((origin) => ["--origin", origin]),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    exit = new Promise<number>((done) => {
      child.once("error", () => done(1));
      child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
    // The server retires its rendezvous and PTYs on SIGINT/SIGTERM; forward them instead of
    // dying first so the operator's Ctrl-C always reaches an orderly shutdown.
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => child.kill(signal));
    try {
      const record = await waitForRendezvous(path, child);
      print({
        endpoint: record.endpoint,
        serverId: record.serverId,
        relayInstanceId: record.relayInstanceId,
        rendezvous: path,
        pid: child.pid,
      });
    } catch (error) {
      child.kill("SIGTERM");
      await exit;
      throw error;
    }
  } finally {
    await releaseLock();
  }
  return exit;
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const [group, sub] = args.words;
  if (group === "server" && sub === "start") return serverStart(args);
  if (group === "status") {
    takeFlags(args, []);
    if (args.words.length !== 1 || args.command) throw new UsageError("status takes no arguments");
    await withSession(args, async ({ client }) =>
      print(unwrap("server.status", await client.call("server.status", {}))),
    );
    return 0;
  }
  if (group === "terminal") {
    await terminalCommand(args);
    return 0;
  }
  if (group === "operation" && sub === "get") {
    takeFlags(args, []);
    const operationId = one(args, "operation id");
    await withSession(args, async ({ client }) =>
      print(unwrap("operation.get", await client.getOperation(operationId)).operation),
    );
    return 0;
  }
  throw new UsageError(group ? `Unknown command ${args.words.join(" ")}` : "missing command");
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cove: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
