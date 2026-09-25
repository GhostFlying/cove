import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface WebProbeResult {
  readonly browserVersion: string;
  readonly browserRevision: string;
  readonly browserExecutable: string;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly input: string;
  readonly listenerPort: number;
  readonly browserPid: number;
}

const builtRoot = resolve(fileURLToPath(new URL("../../browser/", import.meta.url)));
const browsersPath = fileURLToPath(new URL("../../../.cache/playwright/", import.meta.url));

interface BrowserPage {
  on(event: string, listener: (value: unknown) => void): void;
  goto(
    url: string,
    options: { waitUntil: "networkidle"; timeout: number },
  ): Promise<{ ok(): boolean; status(): number } | null>;
  waitForFunction(expression: string, arg: null, options: { timeout: number }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  keyboard: { type(value: string): Promise<void> };
  setDefaultTimeout(milliseconds: number): void;
}

interface BrowserHandle {
  newPage(): Promise<BrowserPage>;
  version(): string;
  close(): Promise<void>;
}

interface ChromiumLauncher {
  executablePath(): string;
  launchServer(options: {
    headless: boolean;
    executablePath: string;
    timeout: number;
  }): Promise<BrowserServerHandle>;
  connect(endpoint: string, options: { timeout: number }): Promise<BrowserHandle>;
}

interface BrowserServerHandle {
  wsEndpoint(): string;
  process(): { pid?: number; exitCode: number | null; signalCode: string | null };
  close(): Promise<void>;
  kill(): Promise<void>;
}

async function within<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
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

function probeWorkBudget(maximum: number): number {
  const requested = Number(process.env.COVE_PROBE_WORK_BUDGET_MS);
  return Number.isFinite(requested) && requested >= 500 ? Math.min(requested, maximum) : maximum;
}

async function injectedDelay(remaining: (limit: number, label: string) => number, label: string) {
  const requested = Number(process.env.COVE_PROBE_STAGE_DELAY_MS);
  if (!Number.isFinite(requested) || requested <= 0) return;
  const delay = Math.min(requested, 2_000);
  await new Promise<void>((resolve, reject) => {
    const delayTimer = setTimeout(() => {
      clearTimeout(deadlineTimer);
      resolve();
    }, delay);
    const deadlineTimer = setTimeout(
      () => {
        clearTimeout(delayTimer);
        reject(new Error(`${label} exceeded work deadline`));
      },
      remaining(delay + 1, label),
    );
  });
}

function browserError(event: string, value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return `${event}: invalid event`;
  const item = value as {
    type?: () => string;
    text?: () => string;
    message?: string;
    url?: () => string;
  };
  if (event === "console") return item.type?.() === "error" ? item.text?.() : undefined;
  if (event === "pageerror") return item.message;
  if (event === "requestfailed") return `Failed request: ${item.url?.()}`;
  return undefined;
}

export async function runEnvironmentProbe(): Promise<WebProbeResult> {
  if (!(await stat(join(builtRoot, "index.html")).catch(() => null))) {
    throw new Error("Built browser fixture is absent");
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const require = createRequire(import.meta.url);
  const playwrightManifest = require("playwright/package.json") as {
    version?: string;
    dependencies?: { "playwright-core"?: string };
  };
  if (
    playwrightManifest.version !== "1.63.0" ||
    playwrightManifest.dependencies?.["playwright-core"] !== "1.63.0"
  )
    throw new Error("Unexpected Playwright package version");
  const coreRequire = createRequire(require.resolve("playwright/package.json"));
  const coreManifestPath = coreRequire.resolve("playwright-core/package.json");
  const coreManifest = JSON.parse(await readFile(coreManifestPath, "utf8")) as { version?: string };
  if (coreManifest.version !== "1.63.0") throw new Error("Unexpected Playwright core version");
  const browsersManifest = JSON.parse(
    await readFile(join(dirname(coreManifestPath), "browsers.json"), "utf8"),
  ) as { browsers?: { name?: string; revision?: string; browserVersion?: string }[] };
  const chromiumEntries = browsersManifest.browsers?.filter((item) => item.name === "chromium");
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
  // Playwright's Node API declarations reference DOM types; this probe uses only its public runtime methods.
  const chromium = imported.chromium as ChromiumLauncher;
  const executable = process.env.COVE_PROBE_TEST_EXECUTABLE ?? chromium.executablePath();
  if (!(await stat(executable).catch(() => null))) throw new Error("Managed Chromium is absent");
  const resolvedExecutable = await realpath(executable);
  const managedRevision = join(await realpath(browsersPath), `chromium-${chromiumEntry.revision}`);
  if (!resolvedExecutable.startsWith(`${managedRevision}${sep}`))
    throw new Error(`Chromium executable is outside managed revision ${chromiumEntry.revision}`);
  const workBudgetMs = probeWorkBudget(24_000);
  const workStarted = performance.now();
  const workDeadline = workStarted + workBudgetMs;
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
  let browser: BrowserHandle | undefined;
  let browserServer: BrowserServerHandle | undefined;
  let primaryError: unknown;
  let record: WebProbeResult | undefined;
  let listenerPort: number | null = null;
  let completedInjectedDelays = 0;
  try {
    const listenController = new AbortController();
    try {
      await within(
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ port: 0, host: "127.0.0.1", signal: listenController.signal }, resolve);
        }),
        remaining(2_000, "fixture listener"),
        "fixture listener",
      );
    } catch (error) {
      listenController.abort();
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
    if (process.env.COVE_PROBE_INJECT_WORK_FAILURE === "1")
      throw new Error("Injected browser work failure");
    await injectedDelay(remaining, "launched Chromium delay");
    completedInjectedDelays++;
    browser = await chromium.connect(browserServer.wsEndpoint(), {
      timeout: remaining(5_000, "Chromium connect"),
    });
    const browserVersion = browser.version();
    const reportedVersion = process.env.COVE_PROBE_TEST_REPORTED_VERSION ?? browserVersion;
    if (
      browserVersion !== chromiumEntry.browserVersion ||
      reportedVersion !== chromiumEntry.browserVersion
    )
      throw new Error(
        `Chromium version ${browserVersion !== chromiumEntry.browserVersion ? browserVersion : reportedVersion} does not match pinned ${chromiumEntry.browserVersion}`,
      );
    await injectedDelay(remaining, "connected Chromium delay");
    completedInjectedDelays++;
    const pageBudget = remaining(5_000, "Browser page creation");
    const page = await within(browser.newPage(), pageBudget, "Browser page creation");
    await injectedDelay(remaining, "created browser page delay");
    completedInjectedDelays++;
    page.setDefaultTimeout(remaining(5_000, "Browser actions"));
    const errors: string[] = [];
    for (const event of ["console", "pageerror", "requestfailed"]) {
      page.on(event, (value) => {
        const error = browserError(event, value);
        if (error) errors.push(error);
      });
    }
    page.on("request", (request) => {
      const url = (request as { url(): string }).url();
      if (!url.startsWith(`http://127.0.0.1:${address.port}/`))
        errors.push(`External request: ${url}`);
    });
    const response = await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle",
      timeout: remaining(10_000, "fixture navigation"),
    });
    if (!response?.ok()) throw new Error(`Fixture navigation failed: ${response?.status()}`);
    await injectedDelay(remaining, "loaded browser fixture delay");
    completedInjectedDelays++;
    await page.waitForFunction("window.coveProbe?.ready === true", null, {
      timeout: remaining(5_000, "xterm ready"),
    });
    const rendered = await within(
      page.evaluate<{
        line?: string;
        cursorX: number;
        width: number;
        height: number;
      }>(`(() => {
      const probe = window.coveProbe;
      if (!probe) throw new Error("Browser probe unavailable");
      const line = probe.terminal.buffer.active.getLine(0)?.translateToString(true);
      const dimensions = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      probe.terminal.focus();
      return { line, cursorX: probe.terminal.buffer.active.cursorX, width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 };
    })()`),
      remaining(5_000, "xterm inspection"),
      "xterm inspection",
    );
    if (
      rendered.line !== "COVE_BROWSER_READY" ||
      rendered.cursorX !== 18 ||
      rendered.width <= 0 ||
      rendered.height <= 0
    ) {
      throw new Error(`Browser buffer or geometry mismatch: ${JSON.stringify(rendered)}`);
    }
    const keyboardBudget = remaining(5_000, "Browser keyboard input");
    await within(page.keyboard.type("ok"), keyboardBudget, "Browser keyboard input");
    const input = await within(
      page.evaluate<string>("window.coveProbe?.input"),
      remaining(5_000, "Browser input inspection"),
      "Browser input inspection",
    );
    if (input !== "ok" || errors.length)
      throw new Error(`Browser input/errors: ${JSON.stringify({ input, errors })}`);
    const browserPid = browserServer.process().pid;
    if (!browserPid) throw new Error("Browser process identity is unavailable");
    record = {
      browserVersion,
      browserRevision: chromiumEntry.revision,
      browserExecutable: resolvedExecutable,
      renderedWidth: rendered.width,
      renderedHeight: rendered.height,
      input,
      listenerPort: address.port,
      browserPid,
    };
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
    const process = browserServer.process();
    if (process.exitCode === null && process.signalCode === null)
      cleanupErrors.push(new Error("Browser process exit was not observed"));
  }
  if (server.listening) {
    server.closeAllConnections();
    try {
      await within(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        cleanupRemaining(2_000),
        "Fixture listener close",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (process.env.COVE_PROBE_CLEANUP_EVIDENCE) {
    try {
      const browserProcess = browserServer?.process();
      await within(
        writeFile(
          process.env.COVE_PROBE_CLEANUP_EVIDENCE,
          `${JSON.stringify({ browserPid: browserProcess?.pid ?? null, browserExited: browserProcess ? browserProcess.exitCode !== null || browserProcess.signalCode !== null : true, listenerPort, listenerClosed: !server.listening, workBudgetMs, completedInjectedDelays, elapsedMs: Math.round(performance.now() - workStarted) })}\n`,
        ),
        cleanupRemaining(1_000),
        "Browser cleanup evidence",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (process.env.COVE_PROBE_INJECT_CLEANUP_FAILURE === "1")
    cleanupErrors.push(new Error("Injected browser cleanup failure"));
  if (primaryError) {
    if (cleanupErrors.length)
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Browser probe work and cleanup failed",
        {
          cause: primaryError,
        },
      );
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Browser probe cleanup failed");
  if (!record) throw new Error("Browser probe produced no result");
  return record;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  runEnvironmentProbe()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
