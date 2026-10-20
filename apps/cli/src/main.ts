#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { parseArguments, StatusError, UsageError, type Arguments } from "./commands/_common.js";

// Each command group is a module in ./commands named after it (`cove repo ...` is
// commands/repo.ts). Modules are discovered at run time, so a domain adds its commands without
// changing this router; names starting with `_` are shared helpers, not groups.
interface CommandModule {
  readonly usage: string;
  // The group is one command without subcommands, so `cove <group>` alone runs it.
  readonly standalone?: boolean;
  run(args: Arguments): Promise<number>;
}

const COMMANDS = new URL("./commands/", import.meta.url);
const GROUP = /^[a-z][a-z0-9-]*$/;
const OPERATION_ID_NOTE = `Every write command accepts --operation-id ID; the request is saved under <home>/cli before it is
sent, and \`cove operation resend ID\` sends exactly that request again to the same server.`;

async function groups(): Promise<string[]> {
  return (await readdir(COMMANDS))
    .filter((name) => name.endsWith(".js") && !name.startsWith("_"))
    .map((name) => name.slice(0, -3))
    .filter((name) => GROUP.test(name))
    .sort();
}

async function load(group: string): Promise<CommandModule> {
  return (await import(new URL(`${group}.js`, COMMANDS).href)) as CommandModule;
}

async function isGroup(name: string | undefined): Promise<boolean> {
  return name !== undefined && GROUP.test(name) && (await groups()).includes(name);
}

// The full usage, or with `group` only that group's commands and notes. The operation-ID note
// goes with every usage that lists a write command.
async function usage(group?: string): Promise<string> {
  const sections = group
    ? [(await load(group)).usage]
    : await Promise.all((await groups()).map(async (name) => (await load(name)).usage));
  const text = sections.join("\n");
  const note = text.includes("--operation-id") ? `\n\n${OPERATION_ID_NOTE}` : "";
  return `usage: cove [--home DIR] [--rendezvous PATH] <command>\n\n${text}${note}`;
}

// A usage error inside a known group: the usage printed with it is that group's.
class GroupUsageError extends UsageError {
  constructor(
    message: string,
    readonly group: string,
  ) {
    super(message);
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const [group, ...rest] = args.words;
  // A help request asked for explicitly (`cove help [GROUP]`, or --help anywhere before `--`)
  // prints the usage on stdout and succeeds. A --help after `--` belongs to the spawned command.
  if (group === "help") {
    if (rest.length > 1) throw new UsageError("help takes at most one command group");
    if (rest[0] !== undefined && !(await isGroup(rest[0])))
      throw new UsageError(`Unknown command group ${rest[0]}`);
    process.stdout.write(`${await usage(rest[0])}\n`);
    return 0;
  }
  if (args.flags.has("--help")) {
    process.stdout.write(`${await usage((await isGroup(group)) ? group : undefined)}\n`);
    return 0;
  }
  if (!group) throw new UsageError("missing command");
  if (!(await isGroup(group))) throw new UsageError(`Unknown command ${args.words.join(" ")}`);
  const module = await load(group);
  // `cove <group>` alone is a usage error that shows only that group's commands, unless the
  // group is a whole command by itself (`cove status`).
  if (rest.length === 0 && !module.standalone)
    throw new GroupUsageError(`missing ${group} command`, group);
  try {
    return await module.run(args);
  } catch (error) {
    if (error instanceof UsageError && !(error instanceof GroupUsageError))
      throw new GroupUsageError(error.message, group);
    throw error;
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cove: ${message}\n`);
    if (error instanceof UsageError)
      process.stderr.write(
        `${await usage(error instanceof GroupUsageError ? error.group : undefined)}\n`,
      );
    process.exitCode =
      error instanceof UsageError ? 2 : error instanceof StatusError ? error.status : 1;
  },
);
