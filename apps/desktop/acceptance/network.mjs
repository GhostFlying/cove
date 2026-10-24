import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron } from "playwright";
import { createAuthFixture, portOf } from "../../cli/tests/m2/auth-fixtures.mjs";
import { tsnetBuilds } from "../../cli/tests/m2/s9-tsnet-fixture.mjs";
import {
  clientEnv,
  daemonHello,
  endDaemon,
  removeRoot,
  shortRoot,
  startServeNode,
  startTailnet,
  withTsnetEntry,
} from "../../cli/tests/m2/tsnet-fixtures.mjs";
import { waitFor } from "../../cli/tests/recording-view.mjs";
import { closeNativeApp, cleanKeychain } from "./native-app.mjs";

// Actual Electron + actual cove-tsnet against Cove's isolated loopback control/DERP/STUN.
// This never joins a production tailnet or adopts an existing client node. Run only in an
// assigned native resource segment; the first invocation builds the pinned Go artifacts.
assert.equal(process.platform, "darwin");
const execute = promisify(execFile);
const desktop = resolve(import.meta.dirname, "..");
const require = createRequire(new URL("../package.json", import.meta.url));
const source = (await execute("git", ["rev-parse", "HEAD"], { cwd: desktop })).stdout.trim();
const output = process.env.COVE_DESKTOP_ACCEPTANCE_DIR || (await shortRoot("c196-proof"));
await mkdir(output, { recursive: true });
const root = await shortRoot("c196-net");
const home = join(root, "client");
const profile = `m3-net-${randomUUID()}`;
const steps = [];
const logs = [];
let electron;
let page;
let fixture;
let tailnet;
let serverNode;
let runtime;
let failed = false;

async function step(name, action) {
  process.stdout.write(`Starting: ${name}\n`);
  await action();
  steps.push({ name, status: "PASS" });
  process.stdout.write(`PASS: ${name}\n`);
}
async function closeApp() {
  if (!electron) return;
  const current = electron;
  electron = undefined;
  await closeNativeApp(current);
}
async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function installFixtureHelper(binary, bin, controlUrl) {
  const real = join(bin, "cove-tsnet-fixture-real");
  await copyFile(binary, real);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  // Desktop deliberately does not read the CLI's development control-plane override. Route
  // its cold-started helper to this fixture too, while version/ownership probes stay intact.
  // exec keeps the actual Go process and exit status; the production-control panic guard stays on.
  await writeFile(
    join(bin, "cove-tsnet"),
    [
      "#!/bin/sh",
      'if [ "$1" = dial ]; then',
      `  exec ${quote(real)} "$@" --control-url ${quote(controlUrl)}`,
      "fi",
      `exec ${quote(real)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

try {
  const builds = await tsnetBuilds();
  tailnet = await startTailnet(builds);
  fixture = await createAuthFixture();
  fixture.remember(tailnet.authKey);
  Object.assign(fixture.env, clientEnv(tailnet, builds.current));
  const pairingPort = await freePort();
  const server = await fixture.startAuthServer(fixture.home("server"), [
    "--pairing-port",
    String(pairingPort),
  ]);
  serverNode = await startServeNode(builds, tailnet, join(root, "serve"));
  await serverNode.login();
  await serverNode.serve(
    new Map([
      [portOf(server), () => portOf(server)],
      [pairingPort, () => pairingPort],
    ]),
  );
  // Explicit fixture installation at the same stable path Desktop uses in ordinary operation.
  // The app itself does not install, replace or stop this helper.
  const bin = join(home, "install/current/bin");
  await mkdir(bin, { recursive: true });
  await installFixtureHelper(builds.current, bin, tailnet.controlURL);
  const login = () =>
    fixture.coveInput(["remote", "tsnet", "login"], `${tailnet.authKey}\n`, { home });
  assert.equal((await login()).code, 0);
  const cliInvitation = withTsnetEntry(
    (await fixture.invite(server.home)).invitation,
    serverNode.self,
  );
  fixture.remember(cliInvitation);
  const cliRecord = await fixture.pairOk(home, "cli-box", cliInvitation, ["--via", "tsnet"]);
  const desktopInvitation = withTsnetEntry(
    (await fixture.invite(server.home)).invitation,
    serverNode.self,
  );
  fixture.remember(desktopInvitation);
  const environment = {
    ...fixture.env,
    HOME: process.env.HOME,
    COVE_HOME: home,
    COVE_DESKTOP_PROFILE: profile,
    COVE_DESKTOP_DATA_DIR: join(root, "desktop"),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  await mkdir(environment.COVE_DESKTOP_DATA_DIR);
  electron = await _electron.launch({
    executablePath: require("electron"),
    args: [join(desktop, "dist/main/index.js")],
    env: environment,
    timeout: 30_000,
  });
  electron.process().stderr.on("data", (chunk) => logs.push(String(chunk)));
  runtime = await electron.evaluate(() => process.versions);
  page = await electron.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(async () => (await window.cove.snapshot()).ready);
  const snapshot = () => page.evaluate(() => window.cove.snapshot());
  const serverId = server.record.serverId;
  const current = () =>
    page.waitForFunction(
      async (id) => (await window.cove.snapshot()).sessions[id]?.status === "current",
      serverId,
    );
  const stale = () =>
    page.waitForFunction(
      async (id) => (await window.cove.snapshot()).sessions[id]?.status !== "current",
      serverId,
    );

  await step(
    "Desktop and CLI pair independent devices over the same actual dial node",
    async () => {
      await page.getByRole("button", { name: "Pair server", exact: false }).first().click();
      const dialog = page.getByRole("dialog", { name: "Pair a server", exact: true });
      await dialog.getByLabel("Server alias").fill("tailnet-box");
      await dialog.getByLabel("Device name").fill("Desktop shared node");
      await dialog.getByLabel("Invitation", { exact: true }).fill(desktopInvitation);
      await dialog.getByLabel("Pairing entry").selectOption("tsnet");
      await dialog.getByRole("button", { name: "Pair device", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      const saved = (await snapshot()).servers[0];
      assert.equal(saved.serverId, cliRecord.serverId);
      assert.notEqual(saved.deviceId, cliRecord.deviceId);
      assert.equal(Object.hasOwn(saved, "token"), false);
      await page
        .getByRole("navigation", { name: "Servers", exact: true })
        .getByRole("button", { name: /tailnet-box/ })
        .click();
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await current();
      const before = await daemonHello(home);
      assert.ok(before.streams.length);
      const cli = await fixture.coveJson(["remote", "tsnet", "status"], { home });
      const desktopStatus = await page.evaluate(() => window.cove.networkStatus());
      assert.equal(desktopStatus.ok, true);
      assert.equal(desktopStatus.value.self.stableNodeID, cli.self.stableNodeID);
      assert.equal(cli.daemon.pid, before.pid);
      await page.screenshot({ path: join(output, "01-shared-node.png") });
    },
  );
  await step("explicit CLI logout retires Desktop facts without claiming server exit", async () => {
    const logout = await fixture.cove(["remote", "tsnet", "logout", "--yes"], { home });
    assert.equal(logout.code, 0);
    await stale();
    await page.locator(".stale-banner").waitFor();
    const status = await fixture.coveJson(["status"], { home: server.home });
    assert.equal(status.serverId, serverId);
    assert.equal((await login()).code, 0);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await current();
  });
  await step(
    "explicit CLI stop disconnects Desktop; only explicit reconnect reopens it",
    async () => {
      const daemon = await daemonHello(home);
      assert.ok(daemon.streams.length);
      const stopped = await fixture.cove(["remote", "tsnet", "stop", "--yes"], { home });
      assert.equal(stopped.code, 0);
      await stale();
      await waitFor("owned daemon stopped", async () => (await daemonHello(home)) === null, 10_000);
      const observed = await page.evaluate(() => window.cove.networkStatus());
      assert.equal(observed.ok, true);
      assert.equal(observed.value.state, "not-started");
      const status = await fixture.coveJson(["status"], { home: server.home });
      assert.equal(status.serverId, serverId);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await current();
    },
  );
  await step(
    "Desktop quit leaves the same CLI-shared node and independent server alive",
    async () => {
      const before = await fixture.coveJson(["remote", "tsnet", "status"], { home });
      await closeApp();
      const after = await fixture.coveJson(["remote", "tsnet", "status"], { home });
      assert.equal(after.daemon.pid, before.daemon.pid);
      assert.equal(after.self.stableNodeID, before.self.stableNodeID);
      const serverStatus = await fixture.coveJson(["status"], { home: server.home });
      assert.equal(serverStatus.serverId, serverId);
    },
  );
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        source,
        runtime,
        platform: process.platform,
        arch: process.arch,
        steps,
        scope:
          "Actual cove-tsnet peers on isolated loopback testcontrol/DERP/STUN; no production tailnet",
      },
      null,
      2,
    ),
  );
} catch (error) {
  failed = true;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        status: "FAIL",
        source,
        steps,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  const cleanup = {};
  const failures = [];
  for (const [name, action] of [
    ["app", closeApp],
    ["daemon", () => endDaemon(home)],
    ["serve", () => serverNode?.stop()],
    ["fixture", () => fixture?.cleanup()],
    ["tailnet", () => tailnet?.stop()],
    ["keychain", () => cleanKeychain(profile)],
  ]) {
    try {
      cleanup[name] = (await action()) ?? "cleaned";
    } catch (error) {
      cleanup[name] = String(error);
      failures.push(error);
    }
  }
  if (!failures.length) await removeRoot(root);
  await writeFile(join(output, "electron-stderr.log"), logs.join(""));
  await writeFile(
    join(output, "cleanup.json"),
    JSON.stringify({ source, profile, cleanup }, null, 2),
  );
  process.stdout.write(`Own network fixture cleanup: ${JSON.stringify(cleanup)}\n`);
  if (failures.length && !failed) {
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          status: "FAIL",
          source,
          steps,
          error: "Own network acceptance cleanup failed",
          cleanup,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
