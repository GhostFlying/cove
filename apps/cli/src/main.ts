#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { parseArguments, StatusError, UsageError, type Arguments } from "./commands/_common.js";

// Each command group is a module in ./commands named after it (`cove repo ...` is
// commands/repo.ts). Modules are discovered at run time, so a domain adds its commands without
// changing this router; names starting with `_` are shared helpers, not groups.
interface CommandModule {
  readonly usage: string;
  run(args: Arguments): Promise<number>;
}

const COMMANDS = new URL("./commands/", import.meta.url);
const GROUP = /^[a-z][a-z0-9-]*$/;

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

async function usage(): Promise<string> {
  const sections = await Promise.all(
    (await groups()).map(async (group) => (await load(group)).usage),
  );
  return `usage: cove [--home DIR] [--rendezvous PATH] <command>

${sections.join("\n")}

Every write command accepts --operation-id ID; the request is saved under <home>/cli before it is
sent, and \`cove operation resend ID\` sends exactly that request again to the same server.`;
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const group = args.words[0];
  if (!group) throw new UsageError("missing command");
  if (!GROUP.test(group) || !(await groups()).includes(group))
    throw new UsageError(`Unknown command ${args.words.join(" ")}`);
  return (await load(group)).run(args);
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cove: ${message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${await usage()}\n`);
    process.exitCode =
      error instanceof UsageError ? 2 : error instanceof StatusError ? error.status : 1;
  },
);
