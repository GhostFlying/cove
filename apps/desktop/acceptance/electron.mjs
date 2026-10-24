import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { _electron } from "playwright";
import { createM1Fixture } from "../../cli/tests/m1/fixtures.mjs";
import { waitFor } from "../../cli/tests/recording-view.mjs";

// Run after pnpm build, on macOS with a GUI/Keychain session. This is actual Electron,
// not a browser substitute. All server/Git/PTY/file resources are fresh task-owned fixtures.
assert.equal(process.platform, "darwin");
const desktop = resolve(import.meta.dirname, "..");
const require = createRequire(new URL("../package.json", import.meta.url));
const executablePath = require("electron");
const output =
  process.env.COVE_DESKTOP_ACCEPTANCE_DIR ||
  (await mkdtemp(join(tmpdir(), "cove-desktop-electron-")));
await mkdir(output, { recursive: true });
const fixture = await createM1Fixture();
const profile = `m3-${randomUUID()}`;
const data = join(fixture.root, "desktop-data");
await mkdir(data);
const environment = {
  ...fixture.env,
  // Keep the logged-in macOS Keychain context; server/files remain isolated below.
  HOME: process.env.HOME,
  COVE_DESKTOP_PROFILE: profile,
  COVE_DESKTOP_DATA_DIR: data,
  COVE_HOME: fixture.home("network-home"),
};
delete environment.ELECTRON_RUN_AS_NODE;
let electron;
let page;
let server;
let serverId;
const errors = [];
const steps = [];
let run;
const logs = [];
async function step(name, action) {
  process.stdout.write(`Starting: ${name}\n`);
  await action();
  steps.push({ name, status: "PASS" });
  process.stdout.write(`PASS: ${name}\n`);
}
async function launch() {
  electron = await _electron.launch({
    executablePath,
    args: [join(desktop, "dist/main/index.js")],
    env: environment,
    timeout: 30_000,
  });
  electron.process().stderr.on("data", (chunk) => logs.push(String(chunk)));
  page = await electron.firstWindow();
  // CDP clicks alone do not establish macOS foreground. Activate only this test window.
  await electron.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(async () => (await window.cove.snapshot()).ready);
  assert.equal(await page.title(), "Cove");
  assert.match(page.url(), /^file:/);
}
async function dialog(name, action) {
  const modal = page.getByRole("dialog", { name, exact: true });
  await modal.waitFor();
  await action(modal);
  await modal.waitFor({ state: "detached" });
}
async function snapshot() {
  return page.evaluate(() => window.cove.snapshot());
}
async function current() {
  await page.waitForFunction(
    async (id) => (await window.cove.snapshot()).sessions[id]?.status === "current",
    serverId,
  );
}
async function chooseServer() {
  await page
    .getByRole("navigation", { name: "Servers", exact: true })
    .getByRole("button", { name: /electron-box/ })
    .click();
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  server = await fixture.startServer(fixture.home("server"));
  serverId = server.record.serverId;
  const repo = await fixture.gitRepo("clone");
  await launch();
  await step("real Electron window and first meaningful screen", async () => {
    await page.getByRole("heading", { name: "A place for work in progress." }).waitFor();
    await page.screenshot({ path: join(output, "01-first-use.png") });
  });
  await step(
    "explicit same-host independent device pairing with actual Keychain storage",
    async () => {
      await page.getByRole("button", { name: "Pair this Mac", exact: true }).click();
      await dialog("Pair this Mac's server", async (modal) => {
        await modal.getByLabel("Server alias").fill("electron-box");
        await modal.getByLabel("Device name").fill("Electron acceptance");
        await modal.getByLabel("Local Cove home (absolute path)").fill(server.home);
        await modal.getByRole("button", { name: "Pair device", exact: true }).click();
      });
      const state = await snapshot();
      assert.equal(state.servers.length, 1);
      assert.equal(state.servers[0].serverId, serverId);
      assert.equal(Object.hasOwn(state.servers[0], "token"), false);
      const sealed = await readFile(join(data, "credentials.sealed"));
      assert.equal(sealed[0] === 0x5b || sealed[0] === 0x7b, false);
      const devices = await fixture.coveJson(["auth", "device", "list"], { home: server.home });
      assert.equal(devices.devices[0].name, "Electron acceptance");
    },
  );
  await chooseServer();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await current();
  await step(
    "visible repository/task/workspace operations against actual compiled server",
    async () => {
      await page.getByRole("button", { name: "Repositories", exact: true }).click();
      await page.getByRole("button", { name: "Register repository", exact: true }).click();
      await dialog("Register repository", async (modal) => {
        await modal.getByLabel("Absolute repository path on this server").fill(repo.path);
        await modal.getByLabel("Display name").fill("Acceptance repository");
        await modal.getByRole("button", { name: "Register", exact: true }).click();
      });
      await page.getByRole("heading", { name: "Acceptance repository", exact: true }).waitFor();
      await page.getByRole("button", { name: "Tasks", exact: true }).click();
      await page.getByRole("button", { name: "＋ New", exact: true }).click();
      await dialog("Create task", async (modal) => {
        await modal.getByLabel("Task title").fill("Electron trial");
        await modal.getByRole("button", { name: "Add repository mount", exact: true }).click();
        await modal.getByRole("button", { name: "Create task", exact: true }).click();
      });
      await page.getByRole("button", { name: /Electron trial/ }).click();
      await page.getByRole("button", { name: "Check paths", exact: true }).click();
      await page.getByText("Last path check: entry ready", { exact: false }).waitFor();
    },
  );
  await step("real terminal attachment and deliberate keyboard input once", async () => {
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await dialog("Create terminal tab", async (modal) => {
      await modal.getByLabel("Tab name").fill("Trial shell");
      await modal.getByRole("button", { name: "Create tab and run", exact: true }).click();
    });
    await page
      .getByRole("navigation", { name: "Terminal tabs", exact: true })
      .getByRole("button", { name: "Trial shell", exact: true })
      .click();
    await page.locator(".terminal-surface .xterm-screen").waitFor();
    await page.locator(".terminal-surface").click({ position: { x: 45, y: 35 } });
    await page.getByText("Input ready", { exact: false }).waitFor();
    const marker = join(fixture.root, "typed-once");
    await page.keyboard.type(`printf 'typed-once\\n' >> ${quote(marker)}`, { delay: 1 });
    await page.keyboard.press("Enter");
    await waitFor(
      "typed marker",
      async () => (await readFile(marker, "utf8").catch(() => "")) === "typed-once\n",
      10_000,
    );
    const state = await snapshot();
    run = state.sessions[serverId].mirror.records.find(
      (row) => row.kind === "tab" && row.record.name === "Trial shell",
    ).record.latestRun;
    assert.ok(run);
    await page.screenshot({ path: join(output, "02-terminal.png") });
  });
  await step("renderer reload obtains new real baseline without replaying input", async () => {
    await page.reload();
    await page.waitForFunction(async () => (await window.cove.snapshot()).ready);
    await chooseServer();
    await page.getByRole("button", { name: /Electron trial/ }).click();
    await page
      .getByRole("navigation", { name: "Terminal tabs", exact: true })
      .getByRole("button", { name: "Trial shell", exact: true })
      .click();
    await page.getByText("Run live", { exact: false }).waitFor();
    assert.equal(await readFile(join(fixture.root, "typed-once"), "utf8"), "typed-once\n");
    await page.screenshot({ path: join(output, "03-recovered.png") });
  });
  await step("app quit preserves independent server and same PTY run", async () => {
    await electron.close();
    electron = undefined;
    assert.equal(await fixture.serverRuns(server), true);
    const observed = await fixture.coveJson(["terminal", "get", run.runId], { home: server.home });
    assert.equal(JSON.stringify(observed).includes(run.runId), true);
    assert.equal(JSON.stringify(observed).includes("running"), true);
  });
  await step(
    "actual Keychain credential cold restore and read-only original operation queries",
    async () => {
      await launch();
      const restored = await snapshot();
      assert.equal(restored.servers[0].serverId, serverId);
      await chooseServer();
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await current();
      const operations = (await snapshot()).operations;
      const created = operations.find((operation) => operation.method === "task.create");
      assert.ok(created);
      const reply = await page.evaluate(
        async ({ id, operationId }) => window.cove.queryOperation(id, operationId),
        { id: serverId, operationId: created.operationId },
      );
      assert.equal(reply.ok, true);
      assert.equal(reply.value.ok, true);
      const tasks = await fixture.coveJson(["task", "list"], { home: server.home });
      assert.equal(tasks.tasks.filter((task) => task.title === "Electron trial").length, 1);
    },
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        environment: {
          platform: process.platform,
          arch: process.arch,
          electron: "45.0.0",
          playwright: "1.63.0",
          profile,
        },
        steps,
        unexecuted: [
          "macOS14 physical target",
          "physical IME/native clipboard",
          "shared tsnet real logout/stop",
          "production Tailnet/SSH GUI entry",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Electron acceptance PASS; evidence ${output}\n`);
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      { status: "FAIL", steps, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (electron) await electron.close();
  await fixture.cleanup();
  await writeFile(join(output, "electron-stderr.log"), logs.join(""));
  // The unique profile's exact Keychain item must be identified before any deletion; this
  // script never guesses a service name and never deletes another application's key.
  process.stdout.write(
    `Task Keychain profile: Cove-${profile}; cleanup requires exact matching item verification.\n`,
  );
}
