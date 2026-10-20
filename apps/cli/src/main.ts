#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import {
  parseArguments,
  StatusError,
  SWITCHES,
  UsageError,
  type Arguments,
} from "./commands/_common.js";

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

// The command group a `--help` before `--` asks about, or null when there is no such --help. It is
// recognized before parseArguments, so that a help request is answered even when the rest of the
// command is incomplete (`cove mount convert --branch --help`: --branch has no value). The words
// are read leniently: an option other than a switch is taken to consume the next item unless that
// is itself an option. Everything after `--` is the spawned command's and is never read here.
function helpTarget(argv: readonly string[]): { group: string | undefined } | null {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  if (!own.includes("--help")) return null;
  for (let i = 0; i < own.length; i++) {
    const item = own[i]!;
    if (!item.startsWith("--")) return { group: item };
    if (!SWITCHES.has(item) && own[i + 1] !== undefined && !own[i + 1]!.startsWith("--")) i++;
  }
  return { group: undefined };
}

async function run(argv: readonly string[]): Promise<number> {
  // A help request asked for explicitly (`cove help [GROUP]`, or --help anywhere before `--`)
  // prints the usage on stdout and succeeds. A --help after `--` belongs to the spawned command.
  const help = helpTarget(argv);
  if (help && help.group !== "help") {
    process.stdout.write(`${await usage((await isGroup(help.group)) ? help.group : undefined)}\n`);
    return 0;
  }
  const args = parseArguments(argv);
  const [group, ...rest] = args.words;
  if (group === "help") {
    if (rest.length > 1) throw new UsageError("help takes at most one command group");
    if (rest[0] !== undefined && !(await isGroup(rest[0])))
      throw new UsageError(`Unknown command group ${rest[0]}`);
    process.stdout.write(`${await usage(rest[0])}\n`);
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
