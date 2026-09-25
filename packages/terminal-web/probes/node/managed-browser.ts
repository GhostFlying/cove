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
  close(): Promise<void>;
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

const builtRoot = resolve(
  process.env.COVE_QUERY_BROWSER_ROOT ?? fileURLToPath(new URL("../../browser/", import.meta.url)),
);
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
  stage(label: string): Promise<void>;
  trackPage(page: ProbePage): void;
  reportPageError(error: string): void;
  assertPageErrors(): void;
  browserVersion: string;
  browserRevision: string;
  browserExecutable: string;
  browserPid: number;
  listenerPort: number;
}

export async function withManagedBrowser<T>(
  work: (context: ManagedBrowserContext) => Promise<T>,
  profile: "query" | "environment" = "query",
): Promise<{
  value: T;
  context: Omit<
    ManagedBrowserContext,
    "browser" | "remaining" | "stage" | "trackPage" | "reportPageError" | "assertPageErrors"
  >;
}> {
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
  const executable =
    (profile === "environment" ? process.env.COVE_PROBE_TEST_EXECUTABLE : undefined) ??
    chromium.executablePath();
  if (!(await stat(executable).catch(() => null))) throw new Error("Managed Chromium is absent");
  const resolvedExecutable = await realpath(executable);
  const managedRevision = join(await realpath(browsersPath), `chromium-${chromiumEntry.revision}`);
  if (!resolvedExecutable.startsWith(`${managedRevision}${sep}`))
    throw new Error(`Chromium executable is outside managed revision ${chromiumEntry.revision}`);

  const maxBudget = profile === "environment" ? 24_000 : 32_000;
  const budget = Number(
    profile === "environment"
      ? process.env.COVE_PROBE_WORK_BUDGET_MS
      : process.env.COVE_QUERY_WORK_BUDGET_MS,
  );
  const workBudgetMs =
    Number.isFinite(budget) && budget >= 500 ? Math.min(budget, maxBudget) : maxBudget;
  const workStarted = performance.now();
  const workDeadline = workStarted + workBudgetMs;
  const remaining = (limit: number, label: string) => {
    const left = Math.floor(workDeadline - performance.now());
    if (left <= 0) throw new Error(`Browser work deadline exceeded before ${label}`);
    return Math.min(limit, left);
  };
  let completedInjectedDelays = 0;
  const stage = async (label: string) => {
    if (profile !== "environment") return;
    const requested = Number(process.env.COVE_PROBE_STAGE_DELAY_MS);
    if (!Number.isFinite(requested) || requested <= 0) return;
    const delay = Math.min(requested, 2_000);
    await within(
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay)),
      remaining(delay + 1, label),
      label,
    );
    completedInjectedDelays++;
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
  let contextRecord:
    | Omit<
        ManagedBrowserContext,
        "browser" | "remaining" | "stage" | "trackPage" | "reportPageError" | "assertPageErrors"
      >
    | undefined;
  const ownedPages: ProbePage[] = [];
  const pageErrors: string[] = [];
  const assertPageErrors = () => {
    if (pageErrors.length) throw new Error(`Browser page errors: ${JSON.stringify(pageErrors)}`);
  };
  let checkedPageErrors = 0;
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
    if (profile === "environment" && process.env.COVE_PROBE_INJECT_WORK_FAILURE === "1")
      throw new Error("Injected browser work failure");
    if (profile === "query" && process.env.COVE_QUERY_INJECT_WORK_FAILURE === "1")
      throw new Error("Injected query work failure");
    await stage("launched Chromium delay");
    browser = await chromium.connect(browserServer.wsEndpoint(), {
      timeout: remaining(5_000, "Chromium connect"),
    });
    const browserVersion = browser.version();
    const reportedVersion =
      profile === "environment"
        ? (process.env.COVE_PROBE_TEST_REPORTED_VERSION ?? browserVersion)
        : browserVersion;
    if (
      browserVersion !== chromiumEntry.browserVersion ||
      reportedVersion !== chromiumEntry.browserVersion
    )
      throw new Error(
        `Chromium version ${browserVersion !== chromiumEntry.browserVersion ? browserVersion : reportedVersion} does not match pinned ${chromiumEntry.browserVersion}`,
      );
    await stage("connected Chromium delay");
    const browserPid = browserServer.process().pid;
    if (!browserPid) throw new Error("Browser process identity is unavailable");
    contextRecord = {
      url: `http://127.0.0.1:${address.port}/`,
      browserVersion,
      browserRevision: chromiumEntry.revision,
      browserExecutable: resolvedExecutable,
      browserPid,
      listenerPort: address.port,
    };
    result = await within(
      work({
        ...contextRecord,
        browser,
        remaining,
        stage,
        trackPage: (page) => ownedPages.push(page),
        reportPageError: (error) => pageErrors.push(error),
        assertPageErrors,
      }),
      remaining(workBudgetMs, "Browser work"),
      "Browser work",
    );
    checkedPageErrors = pageErrors.length;
    assertPageErrors();
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  const cleanupStarted = performance.now();
  const cleanupDeadline = cleanupStarted + 7_000;
  // Q1 reserves a forced-kill interval after graceful close and a final listener interval.
  const pageDeadline = cleanupDeadline - 3_500;
  const gracefulCloseDeadline = cleanupDeadline - 2_500;
  const browserDeadline = profile === "query" ? cleanupDeadline - 1_000 : cleanupDeadline;
  const cleanupRemaining = (limit: number, phaseDeadline = cleanupDeadline) =>
    Math.max(1, Math.min(limit, Math.floor(phaseDeadline - performance.now())));
  const disposeDelay = Number(process.env.COVE_QUERY_TEST_DISPOSE_DELAY_MS ?? 0);
  if (
    profile === "query" &&
    (!Number.isInteger(disposeDelay) || disposeDelay < 0 || disposeDelay > 1_500)
  )
    cleanupErrors.push(new Error("Invalid query disposal delay injection"));
  let disposedPages = 0;
  const pages = ownedPages.reverse();
  for (const [index, page] of pages.entries()) {
    // Q1 shares page time; B0 retains its original 500 ms page-operation limits.
    const pageShare =
      profile === "query"
        ? Math.max(1, Math.floor((pageDeadline - performance.now()) / (pages.length - index)))
        : undefined;
    const pageEnd =
      pageShare === undefined
        ? cleanupDeadline
        : Math.min(pageDeadline, performance.now() + pageShare);
    const disposalBudget =
      pageShare === undefined
        ? cleanupRemaining(500)
        : cleanupRemaining(Math.min(1_500, Math.max(1, pageShare - 500)), pageEnd);
    const injectedHang =
      profile === "query" && process.env.COVE_QUERY_TEST_DISPOSE_HANG === "1" && index === 0;
    const disposalExpression = injectedHang
      ? "new Promise(() => {})"
      : profile === "query" && disposeDelay > 0 && disposeDelay <= 1_500
        ? `new Promise((resolve) => setTimeout(() => { window.coveQuery?.dispose(); resolve(); }, ${disposeDelay}))`
        : "window.coveQuery?.dispose()";
    try {
      await within(
        page.evaluate<void>(disposalExpression),
        disposalBudget,
        `Query fixture disposal page ${index + 1}/${pages.length} (${disposalBudget} ms)`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await within(page.close(), cleanupRemaining(500, pageEnd), "Browser page close");
      disposedPages++;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (browserServer) {
    const injectedCloseHang =
      profile === "query" && process.env.COVE_QUERY_TEST_BROWSER_CLOSE_HANG === "1";
    try {
      await within(
        injectedCloseHang ? new Promise<void>(() => {}) : browserServer.close(),
        cleanupRemaining(
          profile === "query" ? 2_000 : 3_000,
          profile === "query" ? gracefulCloseDeadline : browserDeadline,
        ),
        "Browser close",
      );
    } catch (error) {
      cleanupErrors.push(error);
      try {
        await within(
          browserServer.kill(),
          cleanupRemaining(profile === "query" ? 1_500 : 2_000, browserDeadline),
          "Browser kill",
        );
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
        cleanupRemaining(profile === "query" ? 750 : 2_000),
        "Fixture listener close",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const evidencePath =
    profile === "environment"
      ? process.env.COVE_PROBE_CLEANUP_EVIDENCE
      : process.env.COVE_QUERY_CLEANUP_EVIDENCE;
  if (evidencePath) {
    try {
      await within(
        writeFile(
          evidencePath,
          `${JSON.stringify({ browserPid: browserServer?.process().pid ?? null, browserExited: browserServer ? browserServer.process().exitCode !== null || browserServer.process().signalCode !== null : true, listenerPort, listenerClosed: !server.listening, disposedPages, workBudgetMs, completedInjectedDelays, cleanupElapsedMs: Math.round(performance.now() - cleanupStarted), elapsedMs: Math.round(performance.now() - workStarted) })}\n`,
        ),
        cleanupRemaining(profile === "query" ? 250 : 1_000),
        "Browser cleanup evidence",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (profile === "environment" && process.env.COVE_PROBE_INJECT_CLEANUP_FAILURE === "1")
    cleanupErrors.push(new Error("Injected browser cleanup failure"));
  if (profile === "query" && process.env.COVE_QUERY_INJECT_CLEANUP_FAILURE === "1")
    cleanupErrors.push(new Error("Injected query cleanup failure"));
  if (pageErrors.length > checkedPageErrors)
    cleanupErrors.push(
      new Error(`Browser page errors: ${JSON.stringify(pageErrors.slice(checkedPageErrors))}`),
    );
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
  context.trackPage(page);
  await context.stage("created browser page delay");
  page.setDefaultTimeout(context.remaining(5_000, "browser action"));
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
        context.reportPageError(item.text?.() ?? "console error");
      if (event === "pageerror") context.reportPageError(item.message ?? "page error");
      if (event === "requestfailed") context.reportPageError(`Failed request: ${item.url?.()}`);
    });
  page.on("request", (request) => {
    const url = (request as { url(): string }).url();
    if (!url.startsWith(context.url)) context.reportPageError(`External request: ${url}`);
  });
  const response = await page.goto(
    `${context.url}?fixture=query-input&adapter=${adapter}&cols=${cols}`,
    { waitUntil: "networkidle", timeout: context.remaining(10_000, "navigation") },
  );
  if (!response?.ok()) throw new Error(`Fixture navigation failed: ${response?.status()}`);
  await context.stage("loaded browser fixture delay");
  context.assertPageErrors();
  await page.waitForFunction("window.coveQuery?.ready === true", null, {
    timeout: context.remaining(5_000, "xterm ready"),
  });
  context.assertPageErrors();
  return page;
}
