import { createServer } from "node:http";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProbePage {
  goto(
    url: string,
    options: { waitUntil: "networkidle"; timeout: number },
  ): Promise<{ ok(): boolean; status(): number } | null>;
  evaluate<T>(expression: string, argument?: unknown): Promise<T>;
  waitForFunction(
    expression: string,
    argument: null,
    options: { timeout: number },
  ): Promise<unknown>;
  keyboard: { type(value: string): Promise<void>; press(value: string): Promise<void> };
  mouse: {
    click(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(x: number, y: number): Promise<void>;
  };
  locator(selector: string): {
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
    focus(): Promise<void>;
  };
  on(event: string, listener: (value: unknown) => void): void;
  setDefaultTimeout(milliseconds: number): void;
}

interface ProbeBrowser {
  newPage(): Promise<ProbePage>;
  version(): string;
  close(): Promise<void>;
}
interface BrowserServer {
  wsEndpoint(): string;
  process(): { pid?: number; exitCode: number | null; signalCode: string | null };
  close(): Promise<void>;
  kill(): Promise<void>;
}
interface BrowserLauncher {
  executablePath(): string;
  launchServer(options: {
    headless: boolean;
    executablePath: string;
    timeout: number;
  }): Promise<BrowserServer>;
  connect(endpoint: string, options: { timeout: number }): Promise<ProbeBrowser>;
}

const builtRoot = resolve(fileURLToPath(new URL("../../browser/", import.meta.url)));
const browsersPath = fileURLToPath(new URL("../../../.cache/playwright/", import.meta.url));

export async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ManagedBrowserContext {
  browser: ProbeBrowser;
  url: string;
  remaining(limit: number, label: string): number;
  browserVersion: string;
  browserRevision: string;
  browserPid: number;
  listenerPort: number;
}

export async function withManagedBrowser<T>(
  work: (context: ManagedBrowserContext) => Promise<T>,
): Promise<{ value: T; context: Omit<ManagedBrowserContext, "browser" | "remaining"> }> {
  if (!(await stat(join(builtRoot, "index.html")).catch(() => null)))
    throw new Error("Built browser fixture is absent");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const require = createRequire(import.meta.url);
  const manifest = require("playwright/package.json") as {
    version?: string;
    dependencies?: { "playwright-core"?: string };
  };
  if (manifest.version !== "1.63.0" || manifest.dependencies?.["playwright-core"] !== "1.63.0")
    throw new Error("Unexpected Playwright package version");
  const coreRequire = createRequire(require.resolve("playwright/package.json"));
  const coreManifestPath = coreRequire.resolve("playwright-core/package.json");
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8")) as { version?: string };
  if (coreManifest.version !== "1.63.0") throw new Error("Unexpected Playwright core version");
  const browsersManifest = JSON.parse(
    await readFile(join(dirname(coreManifestPath), "browsers.json"), "utf8"),
  ) as { browsers?: { name?: string; revision?: string; browserVersion?: string }[] };
  const chromiumEntries = browsersManifest.browsers?.filter((entry) => entry.name === "chromium");
  const chromiumEntry = chromiumEntries?.[0];
  if (
    chromiumEntries?.length !== 1 ||
    !chromiumEntry?.revision ||
    !/^\d+$/.test(chromiumEntry.revision) ||
    !chromiumEntry.browserVersion
  )
    throw new Error("Pinned Chromium manifest entry is invalid");
  const imported: unknown = require("playwright");
  if (typeof imported !== "object" || imported === null || !("chromium" in imported))
    throw new Error("Playwright Chromium launcher is absent");
  const chromium = imported.chromium as BrowserLauncher;
  const executable = chromium.executablePath();
  if (!(await stat(executable).catch(() => null))) throw new Error("Managed Chromium is absent");
  const resolvedExecutable = await realpath(executable);
  const managedRevision = join(await realpath(browsersPath), `chromium-${chromiumEntry.revision}`);
  if (!resolvedExecutable.startsWith(`${managedRevision}${sep}`))
    throw new Error("Chromium executable is outside managed revision");

  const budget = Number(process.env.COVE_QUERY_WORK_BUDGET_MS);
  const workDeadline =
    performance.now() +
    (Number.isFinite(budget) && budget >= 500 ? Math.min(budget, 32_000) : 32_000);
  const remaining = (limit: number, label: string) => {
    const left = Math.floor(workDeadline - performance.now());
    if (left <= 0) throw new Error(`Browser work deadline exceeded before ${label}`);
    return Math.min(limit, left);
  };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
      const candidate = normalize(join(builtRoot, relative));
      if (!candidate.startsWith(`${builtRoot}${sep}`))
        throw new Error("Asset path escaped fixture");
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
  let browserServer: BrowserServer | undefined;
  let browser: ProbeBrowser | undefined;
  let listenerPort: number | null = null;
  let result: T | undefined;
  let contextRecord: Omit<ManagedBrowserContext, "browser" | "remaining"> | undefined;
  let primaryError: unknown;
  try {
    const listenAbort = new AbortController();
    try {
      await within(
        new Promise<void>((resolveListen, reject) => {
          server.once("error", reject);
          server.listen({ port: 0, host: "127.0.0.1", signal: listenAbort.signal }, resolveListen);
        }),
        remaining(2_000, "fixture listener"),
        "fixture listener",
      );
    } catch (error) {
      listenAbort.abort();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected listener address");
    listenerPort = address.port;
    browserServer = await chromium.launchServer({
      headless: true,
      executablePath: resolvedExecutable,
      timeout: remaining(8_000, "Chromium launch"),
    });
    if (process.env.COVE_QUERY_INJECT_WORK_FAILURE === "1")
      throw new Error("Injected query work failure");
    browser = await chromium.connect(browserServer.wsEndpoint(), {
      timeout: remaining(5_000, "Chromium connect"),
    });
    const browserVersion = browser.version();
    if (browserVersion !== chromiumEntry.browserVersion)
      throw new Error(
        `Chromium version ${browserVersion} does not match pinned ${chromiumEntry.browserVersion}`,
      );
    const browserPid = browserServer.process().pid;
    if (!browserPid) throw new Error("Browser process identity is unavailable");
    contextRecord = {
      url: `http://127.0.0.1:${address.port}/`,
      browserVersion,
      browserRevision: chromiumEntry.revision,
      browserPid,
      listenerPort: address.port,
    };
    result = await work({ ...contextRecord, browser, remaining });
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  const cleanupDeadline = performance.now() + 7_000;
  const cleanupRemaining = (limit: number) =>
    Math.max(1, Math.min(limit, Math.floor(cleanupDeadline - performance.now())));
  if (browserServer) {
    try {
      await within(browserServer.close(), cleanupRemaining(3_000), "Browser close");
    } catch (error) {
      cleanupErrors.push(error);
      try {
        await within(browserServer.kill(), cleanupRemaining(2_000), "Browser kill");
      } catch (killError) {
        cleanupErrors.push(killError);
      }
    }
    const state = browserServer.process();
    if (state.exitCode === null && state.signalCode === null)
      cleanupErrors.push(new Error("Browser process exit was not observed"));
  }
  if (server.listening) {
    server.closeAllConnections();
    try {
      await within(
        new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        ),
        cleanupRemaining(2_000),
        "Fixture listener close",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (process.env.COVE_QUERY_CLEANUP_EVIDENCE) {
    try {
      await writeFile(
        process.env.COVE_QUERY_CLEANUP_EVIDENCE,
        `${JSON.stringify({ browserPid: browserServer?.process().pid ?? null, browserExited: browserServer ? browserServer.process().exitCode !== null || browserServer.process().signalCode !== null : true, listenerPort, listenerClosed: !server.listening })}\n`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length)
    throw new AggregateError([primaryError, ...cleanupErrors], "Browser work and cleanup failed", {
      cause: primaryError,
    });
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Browser cleanup failed");
  if (result === undefined || !contextRecord) throw new Error("Browser probe produced no result");
  return { value: result, context: contextRecord };
}

export async function openQueryPage(
  context: ManagedBrowserContext,
  adapter: "private" | "reference" | "public",
  cols = 40,
): Promise<ProbePage> {
  const page = await within(
    context.browser.newPage(),
    context.remaining(5_000, "page creation"),
    "page creation",
  );
  page.setDefaultTimeout(context.remaining(5_000, "browser action"));
  const errors: string[] = [];
  for (const event of ["console", "pageerror", "requestfailed"])
    page.on(event, (value) => {
      if (typeof value !== "object" || value === null) return;
      const item = value as {
        type?: () => string;
        text?: () => string;
        message?: string;
        url?: () => string;
      };
      if (event === "console" && item.type?.() === "error")
        errors.push(item.text?.() ?? "console error");
      if (event === "pageerror") errors.push(item.message ?? "page error");
      if (event === "requestfailed") errors.push(`Failed request: ${item.url?.()}`);
    });
  page.on("request", (request) => {
    const url = (request as { url(): string }).url();
    if (!url.startsWith(context.url)) errors.push(`External request: ${url}`);
  });
  const response = await page.goto(
    `${context.url}?fixture=query-input&adapter=${adapter}&cols=${cols}`,
    { waitUntil: "networkidle", timeout: context.remaining(10_000, "navigation") },
  );
  if (!response?.ok()) throw new Error(`Fixture navigation failed: ${response?.status()}`);
  await page.waitForFunction("window.coveQuery?.ready === true", null, {
    timeout: context.remaining(5_000, "xterm ready"),
  });
  if (errors.length) throw new Error(`Browser page errors: ${JSON.stringify(errors)}`);
  return page;
}
