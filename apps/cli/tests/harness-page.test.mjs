import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { waitFor } from "./recording-view.mjs";
import { stopServer, within } from "./server-process.mjs";

const cli = resolve(import.meta.dirname, "../dist/main.js");
// The repository's one managed Chromium, installed for the pinned Playwright by
// `pnpm --filter @cove/terminal-web browser:install` (CI: ci-environment-setup --browser).
const browsersPath =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  resolve(import.meta.dirname, "../../../packages/terminal-web/.cache/playwright");

const MARKER = "cove-harness-ok";

async function startServer(directory) {
  const env = {
    ...process.env,
    // The CLI keeps its start lock and default rendezvous under ~/.cove; the server must never
    // touch the user's real home.
    HOME: directory,
    SHELL: "/bin/sh",
  };
  delete env.COVE_RENDEZVOUS;
  const wrapper = spawn(process.execPath, [cli, "server", "start", "--harness"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  wrapper.stdout.on("data", (chunk) => (stdout += chunk));
  wrapper.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => wrapper.once("exit", (code) => done(code)));
  try {
    await waitFor(
      "the server start report",
      () => wrapper.exitCode !== null || stdout.trim().endsWith("}"),
      20_000,
    );
    if (wrapper.exitCode !== null) throw new Error("cove server start --harness exited");
    return { wrapper, exited, report: JSON.parse(stdout) };
  } catch (error) {
    await stopServer(wrapper, exited);
    throw new Error(`${error.message}: ${stderr}`, { cause: error });
  }
}

// Chromium is launched as a BrowserServer so this test can force it down: a client-side
// Browser from launch() offers no way to kill Chromium when close hangs.
async function closeChromium(chromiumServer, browser) {
  if (browser)
    await within(
      browser.close().catch(() => {}),
      5_000,
    );
  const closed = await within(
    chromiumServer.close().then(
      () => "closed",
      () => "failed",
    ),
    10_000,
  );
  if (closed === "closed") return;
  // Playwright starts Chromium in its own process group; kill() signals the whole group and
  // waits for cleanup, whereas signalling only the parent would leave descendants running.
  const killed = await within(
    chromiumServer.kill().then(
      () => "killed",
      (error) => error,
    ),
    10_000,
  );
  if (killed === "killed") return;
  throw new Error(`Chromium ${chromiumServer.process().pid} was not killed`, {
    cause: killed === "timeout" ? undefined : killed,
  });
}

test("the harness page creates a terminal, takes typed input and renders its output", async () => {
  // Realpath the temp root: on macOS /var is a symlink and the server refuses a rendezvous
  // reached through a symlinked ancestor.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cove-harness-")));
  let server;
  let chromiumServer;
  let browser;
  let stopped;
  let failure;
  try {
    server = await startServer(directory);
    const url = server.report.harness;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#/);
    const secret = new URLSearchParams(new URL(url).hash.slice(1)).get("secret");
    expect(secret).toBeTruthy();

    if (!(await stat(browsersPath).catch(() => null)))
      throw new Error(`Managed Chromium is not installed under ${browsersPath}`);
    // Playwright reads its browser location when it is first loaded.
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
    const { chromium } = await import("playwright");
    chromiumServer = await chromium.launchServer({ headless: true, timeout: 15_000 });
    browser = await chromium.connect(chromiumServer.wsEndpoint(), { timeout: 10_000 });
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    page.setDefaultTimeout(15_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(url);
    await page.waitForFunction(
      () => document.getElementById("connection")?.textContent === "connected",
    );
    // The fragment, and the secret in it, is gone from the address bar once read.
    expect(page.url()).not.toContain(secret);
    expect(await page.evaluate(() => location.href)).not.toContain(secret);
    expect(await page.evaluate(() => location.hash)).toBe("");

    await page.click("#new-terminal");
    await page.waitForFunction(
      () => document.getElementById("terminal-status")?.dataset.phase === "ready",
    );
    await page.waitForSelector("#terminal .xterm-rows");
    await page.click("#terminal");
    await page.keyboard.type(`echo ${MARKER}`);
    await page.keyboard.press("Enter");
    // The echoed output is its own row, distinct from the typed command line.
    try {
      await page.waitForFunction(
        (marker) =>
          [...document.querySelectorAll("#terminal .xterm-rows > div")].some(
            (row) => row.textContent.trim() === marker,
          ),
        MARKER,
      );
    } catch (error) {
      // Name the page's own account of the failure, such as an input rejection.
      const status = await page.textContent("#terminal-status").catch(() => null);
      const rows = await page
        .$$eval("#terminal .xterm-rows > div", (divs) =>
          divs.map((row) => row.textContent.trimEnd()).filter(Boolean),
        )
        .catch(() => []);
      throw new Error(`${error.message}\nterminal status: ${status}\nscreen:\n${rows.join("\n")}`, {
        cause: error,
      });
    }
    expect(await page.textContent("#error")).toBe("");
    expect(pageErrors).toEqual([]);
  } catch (error) {
    failure = error;
  }
  // Every cleanup step runs even when an earlier one fails, and the test's own failure is
  // reported in preference to any cleanup failure.
  const cleanupErrors = [];
  const attempt = async (step) => {
    try {
      await step();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (chromiumServer) await attempt(() => closeChromium(chromiumServer, browser));
  if (server)
    await attempt(async () => {
      stopped = await stopServer(server.wrapper, server.exited, server.report.pid);
    });
  await attempt(() => rm(directory, { recursive: true, force: true }));
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "harness test cleanup failed");
  expect(stopped).toBe(0);
});
