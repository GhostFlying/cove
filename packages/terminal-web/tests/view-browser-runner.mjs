import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";

const builtRoot = resolve(import.meta.dirname, "../dist/view-browser");
const browsersPath = resolve(import.meta.dirname, "../.cache/playwright");

function within(operation, milliseconds, label) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function withViewPage(work) {
  if (!(await stat(join(builtRoot, "index.html")).catch(() => null)))
    throw new Error("Built V1 browser fixture is absent");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const require = createRequire(import.meta.url);
  const playwrightManifest = require("playwright/package.json");
  if (playwrightManifest.version !== "1.63.0") throw new Error("Unexpected Playwright version");
  const coreRequire = createRequire(require.resolve("playwright/package.json"));
  const coreManifestPath = coreRequire.resolve("playwright-core/package.json");
  const browsers = JSON.parse(
    await readFile(join(dirname(coreManifestPath), "browsers.json"), "utf8"),
  );
  const entries = browsers.browsers.filter((entry) => entry.name === "chromium");
  if (entries.length !== 1) throw new Error("Pinned Chromium manifest is ambiguous");
  const chromiumEntry = entries[0];
  const { chromium } = require("playwright");
  const executable = await realpath(chromium.executablePath());
  const managedRoot = join(await realpath(browsersPath), `chromium-${chromiumEntry.revision}`);
  if (!executable.startsWith(`${managedRoot}${sep}`)) throw new Error("Chromium is unmanaged");

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
      const candidate = normalize(join(builtRoot, relative));
      if (!candidate.startsWith(`${builtRoot}${sep}`)) throw new Error("escaped root");
      const body = await readFile(candidate);
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
        extname(candidate)
      ];
      response.writeHead(200, { "content-type": mime ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  let browserServer;
  let browser;
  let page;
  let primaryError;
  let result;
  const errors = [];
  try {
    await within(
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
      }),
      2_000,
      "listener",
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected listener address");
    browserServer = await chromium.launchServer({
      headless: true,
      executablePath: executable,
      timeout: 8_000,
    });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
    if (browser.version() !== chromiumEntry.browserVersion)
      throw new Error("Unexpected Chromium version");
    page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle",
      timeout: 10_000,
    });
    if (!response?.ok()) throw new Error("V1 fixture navigation failed");
    await page.waitForFunction("window.coveQuery?.ready === true", null, { timeout: 5_000 });
    result = await within(work(page), 30_000, "V1 browser scenario");
    if (errors.length) throw new Error(`Browser page errors: ${JSON.stringify(errors)}`);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    if (page)
      await within(
        page.evaluate(() => window.coveQuery?.dispose()),
        1_500,
        "fixture disposal",
      );
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (page) await within(page.close(), 500, "page close");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (browserServer) {
    try {
      await within(browserServer.close(), 3_000, "browser close");
    } catch (error) {
      cleanupErrors.push(error);
      try {
        await within(browserServer.kill(), 1_500, "browser kill");
      } catch (killError) {
        cleanupErrors.push(killError);
      }
    }
  }
  if (server.listening) {
    server.closeAllConnections();
    try {
      await within(
        new Promise((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        ),
        750,
        "listener close",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError([primaryError, ...cleanupErrors], "V1 work and cleanup failed", {
      cause: primaryError,
    });
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "V1 cleanup failed");
  return result;
}
