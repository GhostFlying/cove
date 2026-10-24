import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { _electron } from "playwright";
import { closeNativeApp } from "./native-app.mjs";

// Actual Electron profile ownership, without activation, Keychain or terminal input.
// A normal second process must exit before profile storage loads, and quitting the
// owner must release the SDK lock so a later ordinary launch can recover its ledger.
assert.equal(process.platform, "darwin");
const execute = promisify(execFile);
const desktop = resolve(import.meta.dirname, "..");
const source = (await execute("git", ["rev-parse", "HEAD"], { cwd: desktop })).stdout.trim();
const delta = (await execute("git", ["diff", "--name-only"], { cwd: desktop })).stdout.trim();
const executablePath = createRequire(new URL("../package.json", import.meta.url))("electron");
const data = await mkdtemp(join(tmpdir(), "cove-profile-owner-"));
const entry = join(desktop, "dist/main/index.js");
const environment = {
  ...process.env,
  COVE_DESKTOP_PROFILE: `profile-${randomUUID()}`,
  COVE_DESKTOP_DATA_DIR: data,
  COVE_HOME: join(data, "network-home"),
};
delete environment.ELECTRON_RUN_AS_NODE;
const operation = {
  serverId: "own-server",
  relayInstanceId: "own-instance",
  operationId: randomUUID(),
  method: "task.create",
  createdAtMs: 1,
  status: "not-sent",
};
await writeFile(join(data, "operations.json"), JSON.stringify([operation]), { mode: 0o600 });
let owner;
let second;
let failed;
const result = { source, delta, runtime: null, checks: [], cleanup: false };
async function launchOwner() {
  owner = await _electron.launch({
    executablePath,
    args: [entry],
    env: environment,
    timeout: 30_000,
  });
  result.runtime = await owner.evaluate(() => ({
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
  }));
  const page = await owner.firstWindow();
  await page.waitForFunction(async () => (await window.cove.snapshot()).ready);
  return page;
}
try {
  const page = await launchOwner();
  assert.deepEqual(await page.evaluate(async () => (await window.cove.snapshot()).operations), [
    operation,
  ]);
  const before = await readFile(join(data, "operations.json"), "utf8");
  second = spawn(executablePath, [entry], { env: environment, stdio: "ignore" });
  const [code, signal] = await Promise.race([
    once(second, "exit"),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Second profile owner did not exit")),
        10_000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(code, 0);
  assert.equal(signal, null);
  second = undefined;
  assert.equal(owner.process().exitCode, null);
  assert.equal(await readFile(join(data, "operations.json"), "utf8"), before);
  assert.deepEqual(await page.evaluate(async () => (await window.cove.snapshot()).operations), [
    operation,
  ]);
  result.checks.push("second-normal-process-exited-zero-first-owner-and-ledger-preserved");
  await closeNativeApp(owner);
  owner = undefined;
  const reopened = await launchOwner();
  assert.deepEqual(await reopened.evaluate(async () => (await window.cove.snapshot()).operations), [
    operation,
  ]);
  const acknowledged = await reopened.evaluate(
    async ({ serverId, operationId }) =>
      await window.cove.acknowledgeOperation(serverId, operationId),
    operation,
  );
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(JSON.parse(await readFile(join(data, "operations.json"), "utf8")), []);
  result.checks.push("owner-quit-releases-profile-lock-and-reopen-recovers-writable-ledger");
} catch (error) {
  failed = error;
  result.error = String(error);
} finally {
  try {
    if (second && second.exitCode === null && second.signalCode === null) {
      const exited = once(second, "exit");
      second.kill("SIGKILL");
      await exited;
    }
    if (owner) await closeNativeApp(owner);
    await rm(data, { recursive: true });
    result.cleanup = true;
  } catch (error) {
    result.cleanupError = String(error);
    failed ||= error;
  }
  const output = process.env.COVE_DESKTOP_PROFILE_EVIDENCE;
  if (output) await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (failed) throw failed;
