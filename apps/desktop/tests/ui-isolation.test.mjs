import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, test } from "vitest";

// CI's existing browser setup installs the pinned Playwright browser in this worktree.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(
  import.meta.dirname,
  "../../../packages/terminal-web/.cache/playwright",
);
const { chromium } = createRequire(import.meta.url)("playwright");

// Render the delivered renderer with deferred IPC replies. This checks React response
// isolation, not Electron, Keychain, real terminal input or server authentication.
let browser;
let server;
let page;
const failures = [];
beforeEach(async () => {
  failures.length = 0;
  const root = resolve(import.meta.dirname, "../dist/renderer");
  server = createServer((request, response) => {
    const path = join(root, new URL(request.url, "http://localhost").pathname);
    void readFile(path.endsWith("/") ? join(path, "index.html") : path)
      .then((bytes) => {
        response.setHeader(
          "Content-Type",
          { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(path)] ||
            "text/html",
        );
        response.end(bytes);
      })
      .catch(() => {
        response.statusCode = 404;
        response.end();
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  await page.addInitScript(() => {
    const snapshot = {
      localHome: "/synthetic",
      ready: true,
      operations: [],
      error: null,
      servers: ["alpha", "beta"].map((id) => ({
        serverId: id,
        alias: id,
        defaultEntry: "loopback",
        entries: { loopback: "http://127.0.0.1" },
      })),
      sessions: Object.fromEntries(
        ["alpha", "beta"].map((id) => [
          id,
          {
            status: "current",
            generation: 1,
            operations: [],
            mirror: {
              records: [
                {
                  kind: "task",
                  record: {
                    taskId: "task",
                    title: "Test task",
                    revision: 1,
                    archived: false,
                    workspace: { revision: 1, entryPath: "/synthetic/task", mounts: [] },
                  },
                },
                ...["tab-a", "tab-b"].map((tabId) => ({
                  kind: "tab",
                  record: { taskId: "task", tabId, name: tabId },
                })),
              ],
            },
          },
        ]),
      ),
    };
    window.reads = [];
    window.writes = [];
    window.cove = {
      snapshot: async () => snapshot,
      onState: () => () => {},
      call: async (serverId, method, params) => {
        if (method === "auth.device.list" || method === "tab.runs")
          return await new Promise((resolve) =>
            window.reads.push({ serverId, method, params, resolve }),
          );
        window.writes.push({ serverId, method, params });
        return { ok: true, value: { ok: true, value: {} } };
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.getByRole("button", { name: "alpha", exact: false }).click();
});
afterEach(async () => {
  try {
    await browser?.close();
  } finally {
    browser = undefined;
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    server = undefined;
  }
  assert.deepEqual(failures, []);
});
async function waitReads(count) {
  await page.waitForFunction((count) => window.reads.length === count, count);
}
async function reply(index, value) {
  await page.evaluate(
    ({ index, value }) => window.reads[index].resolve({ ok: true, value: { ok: true, value } }),
    { index, value },
  );
}
const device = (name) => ({
  deviceId: `${name}-id`,
  name,
  neverConnected: false,
  revokedAtMs: null,
});

test("device reads clear on server selection and late replies cannot replace the selected server's devices", async () => {
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await waitReads(1);
  await reply(0, { devices: [device("A device")] });
  await page.getByRole("heading", { name: "A device", exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh devices", exact: true }).click();
  await waitReads(2);
  await page.getByRole("button", { name: "beta", exact: false }).click();
  await waitReads(3);
  expect(await page.getByRole("heading", { name: "A device", exact: true }).count()).toBe(0);
  await reply(2, { devices: [device("B device")] });
  await page.getByRole("heading", { name: "B device", exact: true }).waitFor();
  await reply(1, { devices: [device("Late A device")] });
  await page.getByRole("button", { name: "Revoke device", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke device", exact: true }).click();
  await page.waitForFunction(() => window.writes.length === 1);
  expect(await page.evaluate(() => window.writes[0])).toEqual({
    serverId: "beta",
    method: "auth.device.revoke",
    params: { deviceId: "B device-id" },
  });
  expect(await page.getByRole("heading", { name: "Late A device", exact: true }).count()).toBe(0);
});

test("history responses are invalidated across tab changes including returning to the original tab", async () => {
  await page.getByRole("button", { name: "Test task", exact: false }).click();
  await page.getByRole("button", { name: "tab-a", exact: true }).click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await waitReads(1);
  await page.getByRole("button", { name: "tab-b", exact: true }).click();
  await page.getByRole("button", { name: "tab-a", exact: true }).click();
  await reply(0, {
    runs: [
      {
        run: { runId: "stale-run" },
        lifecycle: "exited",
        verification: "verified",
        exitCode: 0,
        cwd: "/synthetic/old",
      },
    ],
  });
  await page
    .getByRole("button", { name: "Run history", exact: true })
    .waitFor({ state: "visible" });
  // Await the finally block rather than relying on a sleep to release global write busy state.
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Run history",
      ).disabled,
  );
  expect(
    await page.getByRole("heading", { name: "Retained run history", exact: true }).count(),
  ).toBe(0);
  await page.getByRole("button", { name: "tab-b", exact: true }).click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await waitReads(2);
  await reply(1, {
    runs: [
      {
        run: { runId: "current-run" },
        lifecycle: "exited",
        verification: "verified",
        exitCode: 0,
        cwd: "/synthetic/current",
      },
    ],
  });
  await page.getByRole("heading", { name: "Retained run history", exact: true }).waitFor();
  expect(await page.locator(".history").textContent()).toContain("current-run");
  expect(await page.locator(".history").textContent()).not.toContain("stale-run");
});
