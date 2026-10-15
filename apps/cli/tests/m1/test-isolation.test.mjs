import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { isolatedEnv } from "../test-env.mjs";

// Tests must never reach the operator's data directory: the CLI resolves it from --home, then
// COVE_HOME, then ~/.cove, and a shell may export COVE_HOME or COVE_RENDEZVOUS.

const tests = resolve(import.meta.dirname, "..");
const cli = resolve(tests, "../dist/main.js");
const saved = { COVE_HOME: process.env.COVE_HOME, COVE_RENDEZVOUS: process.env.COVE_RENDEZVOUS };
const directories = [];

afterEach(async () => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cove-isolation-")));
  directories.push(path);
  return path;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.m?[jt]s$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("isolatedEnv replaces inherited data directory and rendezvous settings", async () => {
  const directory = await temporary();
  process.env.COVE_HOME = "/operator/real-cove-home";
  process.env.COVE_RENDEZVOUS = "/operator/real-rendezvous.json";
  const env = isolatedEnv(directory, { EXTRA: "1" });
  expect(env).toMatchObject({
    HOME: directory,
    COVE_HOME: join(directory, "cove-home"),
    EXTRA: "1",
  });
  expect(env.COVE_RENDEZVOUS).toBeUndefined();
  expect(isolatedEnv(directory, { COVE_RENDEZVOUS: "/t/r.json" }).COVE_RENDEZVOUS).toBe(
    "/t/r.json",
  );
});

test("a CLI started with isolatedEnv never uses the inherited COVE_HOME", async () => {
  const directory = await temporary();
  const operator = join(await temporary(), "operator-home");
  process.env.COVE_HOME = operator;
  const result = await new Promise((done) =>
    execFile(
      process.execPath,
      [cli, "server", "init"],
      { env: isolatedEnv(directory), timeout: 30_000 },
      (error, stdout, stderr) => done({ error, stdout, stderr }),
    ),
  );
  expect({ error: result.error, stderr: result.stderr }).toMatchObject({ error: null });
  expect(JSON.parse(result.stdout).home).toBe(join(directory, "cove-home"));
  expect(await exists(operator)).toBe(false);
});

test("every CLI test file builds child environments through isolatedEnv", async () => {
  const offenders = [];
  for (const path of await sources(tests)) {
    const name = relative(tests, path);
    if (name === "test-env.mjs") continue;
    const text = await readFile(path, "utf8");
    // A spread or direct pass of process.env inherits COVE_HOME/COVE_RENDEZVOUS unchanged.
    if (/\.\.\.\s*process\.env\b|env\s*:\s*process\.env\b/.test(text)) offenders.push(name);
    // A file that starts the CLI or server must take its environment from isolatedEnv.
    if (/dist\/main\.js/.test(text) && !/isolatedEnv\(/.test(text)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
