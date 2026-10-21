import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { saveServer } from "../../dist/remote/credentials.js";
import { cliEnv, endDaemon, removeRoot, shortRoot } from "./tsnet-fixtures.mjs";

// m2 S8 (D14): the development and test overrides (COVE_TSNET_BINARY, COVE_TSNET_CONTROL_URL)
// take effect only in a development workspace. A CLI running from an installed closure (a
// directory with the install stamp `cove-install.json`; T3 defines the full layout) refuses them
// with an error before it reads an auth key or starts anything, and otherwise uses the closure's
// own `bin/cove-tsnet`. The closure here is the CLI's built output copied under a stamped
// directory, outside the workspace, with the workspace's dependencies linked in; its
// `bin/cove-tsnet` is the scripted fake daemon (tsnet-fake-dial.mjs).

const fake = resolve(import.meta.dirname, "tsnet-fake-dial.mjs");
const cliPackage = resolve(import.meta.dirname, "../..");

let root;
let home;
let closure;
let configPath;
let ranLog;

// An executable that notes each run in `log` and then behaves as the fake daemon.
async function noting(path, log) {
  await writeFile(
    path,
    `#!/bin/sh\necho "$1" >> '${log}'\nexec '${process.execPath}' '${fake}' "$@"\n`,
  );
  await chmod(path, 0o755);
}

beforeEach(async () => {
  root = await shortRoot("ct4i");
  home = join(root, "c");
  closure = join(root, "closure");
  configPath = join(root, "fake.json");
  ranLog = join(root, "ran.log");
  await mkdir(join(closure, "bin"), { recursive: true });
  await writeFile(join(closure, "cove-install.json"), "{}\n");
  await noting(join(closure, "bin", "cove-tsnet"), ranLog);
  await cp(join(cliPackage, "dist"), join(closure, "cli", "dist"), { recursive: true });
  await cp(join(cliPackage, "package.json"), join(closure, "cli", "package.json"));
  await symlink(join(cliPackage, "node_modules"), join(closure, "cli", "node_modules"));
  await writeFile(configPath, JSON.stringify({ build: "closure-build", protocol: 1 }));
});

afterEach(async () => {
  await endDaemon(home);
  await removeRoot(root);
});

// Runs the closure's CLI with stdin left open (a command that read it would wait), to its exit.
function runInstalled(args, extra) {
  const env = cliEnv(root, { COVE_TEST_FAKE_DIAL: configPath, ...extra });
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [join(closure, "cli", "dist", "main.js"), "--home", home, ...args],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`cove ${args.join(" ")} did not exit: ${stderr}`));
    }, 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      done({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

const runs = () => readFile(ranLog, "utf8").catch(() => "");

test("an installed closure refuses the development overrides before reading a key or starting anything", async () => {
  const otherLog = join(root, "override-ran.log");
  const override = join(root, "override-tsnet");
  await noting(override, otherLog);

  const login = await runInstalled(["remote", "tsnet", "login"], { COVE_TSNET_BINARY: override });
  expect(login.code).toBe(1);
  expect(login.stdout).toBe("");
  expect(login.stderr).toContain("COVE_TSNET_BINARY is a development and test override");
  expect(login.stderr).toContain(`an installed closure (${closure})`);
  expect(login.stderr).toContain("Nothing was read, started or sent");
  expect(login.stderr).not.toContain("auth key");

  const status = await runInstalled(["remote", "tsnet", "status"], {
    COVE_TSNET_CONTROL_URL: "http://127.0.0.1:9/",
  });
  expect(status.code).toBe(1);
  expect(status.stderr).toContain("COVE_TSNET_CONTROL_URL is a development and test override");

  // A command over a tsnet entry refuses them as well, before anything is sent.
  await saveServer(home, {
    version: 1,
    alias: "box",
    serverId: "srv-closure-1",
    deviceId: "dev1",
    token: `cove_d1_dev1.${"A".repeat(43)}`,
    defaultEntry: "tsnet",
    entries: { tsnet: { nodeId: "nSERVER1", name: "cove-srv.tail-scale.ts.net", port: 7443 } },
    pairedAtMs: Date.now(),
  });
  const entry = await runInstalled(["--server", "box", "status"], {
    COVE_TSNET_BINARY: override,
    COVE_TSNET_CONTROL_URL: "http://127.0.0.1:9/",
  });
  expect(entry.code).toBe(1);
  expect(entry.stderr).toContain(
    "COVE_TSNET_BINARY and COVE_TSNET_CONTROL_URL are development and test overrides",
  );
  expect(entry.stderr).toContain("ENTRY_UNAVAILABLE");
  expect(entry.stderr).toContain("nothing was sent");

  // Neither executable ran, so no daemon was started.
  expect(await readFile(otherLog, "utf8").catch(() => "")).toBe("");
  expect(await runs()).toBe("");
}, 60_000);

test("without overrides an installed closure uses its own bin/cove-tsnet", async () => {
  const status = await runInstalled(["remote", "tsnet", "status"], {});
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).daemon).toMatchObject({ build: "closure-build", protocol: 1 });
  // `version` to identify it, then `dial` to start the daemon.
  expect((await runs()).split("\n").filter(Boolean)).toEqual(["version", "dial"]);
}, 60_000);
