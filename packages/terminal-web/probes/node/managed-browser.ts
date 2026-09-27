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
  isConnected(): boolean;
  on(event: "disconnected", listener: () => void): void;
  off(event: "disconnected", listener: () => void): void;
}
interface BrowserServer {
  wsEndpoint(): string;
  process(): BrowserProcess;
  close(): Promise<void>;
  kill(): Promise<void>;
  on(event: "close", listener: () => void): void;
  off(event: "close", listener: () => void): void;
}
interface BrowserProcess {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  off(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
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

interface PageCleanupRecord {
  page: number;
  shareMs: number | null;
  dispose: { budgetMs: number; elapsedMs: number; outcome: string };
  close: {
    attempts: number;
    budgetMs: number;
    elapsedMs: number;
    outcome: string;
    lateOutcome?: "completed" | "rejected";
  };
}

interface BrowserCleanupPhase {
  attempts: number;
  startedMs: number | null;
  phaseDeadlineMs: number;
  phaseRemainingMs: number | null;
  budgetMs: number;
  elapsedMs: number;
  outcome: "not-started" | "completed" | "timed-out" | "rejected";
  lateOutcome?: "completed" | "rejected";
}

interface ManagedBrowserEvidenceOptions {
  path: string;
  caseId: string;
  testName: string | null;
  invocationId: string;
  runId: string;
  sourceCommit: string;
  sourceDirty: boolean;
}

type TimelineOutcome = "not-called" | "pending" | "fulfilled" | "rejected" | "threw";

interface TimelineCall {
  calledMs: number | null;
  settledMs: number | null;
  outcome: TimelineOutcome;
}

interface TimelineEvent {
  firstMs: number | null;
  count: number;
}

// Public lifecycle events locate an observed wait stage, not a private close RPC acknowledgement.
export class BrowserCloseTimeline {
  readonly record: {
    cleanupStartedMs: number | null;
    finalMs: number | null;
    connectedBeforeClose: boolean | null;
    connectedAtFinal: boolean | null;
    disconnected: TimelineEvent;
    serverClose: TimelineEvent;
    processExit: TimelineEvent;
    rawClose: TimelineCall;
    closeWrapper: TimelineCall & { timeoutObservedMs: number | null };
    rawKill: TimelineCall;
  };
  private finalized = false;
  private readonly origin: number;
  private browser?: ProbeBrowser;
  private server?: BrowserServer;
  private process?: BrowserProcess;
  private readonly onDisconnected = () => this.mark(this.record.disconnected);
  private readonly onServerClose = () => this.mark(this.record.serverClose);
  private readonly onProcessExit = () => this.mark(this.record.processExit);

  constructor(origin = performance.now()) {
    this.origin = origin;
    const event = (): TimelineEvent => ({ firstMs: null, count: 0 });
    const call = (): TimelineCall => ({ calledMs: null, settledMs: null, outcome: "not-called" });
    this.record = {
      cleanupStartedMs: null,
      finalMs: null,
      connectedBeforeClose: null,
      connectedAtFinal: null,
      disconnected: event(),
      serverClose: event(),
      processExit: event(),
      rawClose: call(),
      closeWrapper: { ...call(), timeoutObservedMs: null },
      rawKill: call(),
    };
  }

  private now(): number {
    return Math.max(0, Math.round(performance.now() - this.origin));
  }

  private mark(event: TimelineEvent): void {
    if (this.finalized) return;
    if (event.firstMs === null) event.firstMs = this.now();
    event.count = Math.min(2, event.count + 1);
  }

  attachServer(server: BrowserServer, process: BrowserProcess): void {
    this.server = server;
    this.process = process;
    server.on("close", this.onServerClose);
    process.on("exit", this.onProcessExit);
  }

  attachBrowser(browser: ProbeBrowser): void {
    this.browser = browser;
    browser.on("disconnected", this.onDisconnected);
  }

  beginCleanup(): void {
    this.record.cleanupStartedMs = this.now();
  }

  beforeClose(): void {
    this.record.connectedBeforeClose = this.connectionState();
  }

  private connectionState(): boolean | null {
    try {
      return this.browser?.isConnected() ?? null;
    } catch {
      return null;
    }
  }

  invoke(kind: "rawClose" | "rawKill", operation: () => Promise<void>): Promise<void> {
    const call = this.record[kind];
    call.calledMs = this.now();
    call.outcome = "pending";
    let result: Promise<void>;
    try {
      result = operation();
    } catch (error) {
      call.settledMs = this.now();
      call.outcome = "threw";
      throw error;
    }
    void result.then(
      () => this.settle(call, "fulfilled"),
      () => this.settle(call, "rejected"),
    );
    return result;
  }

  observeWrapper(operation: Promise<void>): void {
    const wrapper = this.record.closeWrapper;
    wrapper.calledMs = this.now();
    wrapper.outcome = "pending";
    void operation.then(
      () => this.settle(wrapper, "fulfilled"),
      () => this.settle(wrapper, "rejected"),
    );
  }

  markWrapperTimeout(): void {
    if (this.finalized) return;
    this.record.closeWrapper.timeoutObservedMs = this.now();
  }

  private settle(call: TimelineCall, outcome: "fulfilled" | "rejected"): void {
    if (this.finalized) return;
    call.settledMs = this.now();
    call.outcome = outcome;
  }

  finalize(): void {
    if (this.finalized) return;
    this.record.connectedAtFinal = this.connectionState();
    this.record.finalMs = this.now();
    this.finalized = true;
    this.browser?.off("disconnected", this.onDisconnected);
    this.server?.off("close", this.onServerClose);
    this.process?.off("exit", this.onProcessExit);
  }
}

export function observeLateBrowserClose(
  operation: Promise<void>,
  phase: BrowserCleanupPhase,
  isFinalized: () => boolean,
): void {
  void operation.then(
    () => {
      if (phase.outcome === "timed-out" && !isFinalized()) phase.lateOutcome = "completed";
    },
    () => {
      if (phase.outcome === "timed-out" && !isFinalized()) phase.lateOutcome = "rejected";
    },
  );
}

const defaultBuiltRoot = fileURLToPath(new URL("../../browser/", import.meta.url));
const browsersPath = fileURLToPath(new URL("../../../.cache/playwright/", import.meta.url));

export async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out`));
        }, milliseconds);
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
  requestedBuiltRoot?: string,
  evidenceOptions?: ManagedBrowserEvidenceOptions,
): Promise<{
  value: T;
  context: Omit<
    ManagedBrowserContext,
    "browser" | "remaining" | "stage" | "trackPage" | "reportPageError" | "assertPageErrors"
  >;
}> {
  // Q1 retains its environment override for isolated version tests. V1 passes a dedicated root
  // explicitly so both fixtures share this one bounded browser and listener lifecycle.
  const builtRoot = resolve(
    requestedBuiltRoot ?? process.env.COVE_QUERY_BROWSER_ROOT ?? defaultBuiltRoot,
  );
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
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
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
  let browserProcess: BrowserProcess | undefined;
  const closeTimeline = new BrowserCloseTimeline(workStarted);
  let exitEvent: { code: number | null; signal: string | null; at: number } | undefined;
  const onBrowserExit = (code: number | null, signal: string | null) => {
    exitEvent = { code, signal, at: performance.now() };
  };
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
    browserProcess = browserServer.process();
    browserProcess.on("exit", onBrowserExit);
    closeTimeline.attachServer(browserServer, browserProcess);
    if (profile === "environment" && process.env.COVE_PROBE_INJECT_WORK_FAILURE === "1")
      throw new Error("Injected browser work failure");
    if (profile === "query" && process.env.COVE_QUERY_INJECT_WORK_FAILURE === "1")
      throw new Error("Injected query work failure");
    await stage("launched Chromium delay");
    browser = await chromium.connect(browserServer.wsEndpoint(), {
      timeout: remaining(5_000, "Chromium connect"),
    });
    closeTimeline.attachBrowser(browser);
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
  const pageCleanup: PageCleanupRecord[] = [];
  let cleanupEvidenceFinalized = false;
  const cleanupStarted = performance.now();
  closeTimeline.beginCleanup();
  const cleanupDeadline = cleanupStarted + 7_000;
  const phase = (deadline: number): BrowserCleanupPhase => ({
    attempts: 0,
    startedMs: null,
    phaseDeadlineMs: Math.round(deadline - cleanupStarted),
    phaseRemainingMs: null,
    budgetMs: 0,
    elapsedMs: 0,
    outcome: "not-started",
  });
  // Q1 reserves a forced-kill interval after graceful close and a final listener interval.
  const pageDeadline = cleanupDeadline - 3_500;
  const gracefulCloseDeadline = cleanupDeadline - 2_500;
  const browserDeadline = profile === "query" ? cleanupDeadline - 1_000 : cleanupDeadline;
  const graceful = phase(profile === "query" ? gracefulCloseDeadline : browserDeadline);
  const kill = phase(browserDeadline);
  const listener = phase(cleanupDeadline);
  const cleanupRemaining = (limit: number, phaseDeadline = cleanupDeadline) =>
    Math.max(1, Math.min(limit, Math.floor(phaseDeadline - performance.now())));
  const pageRemaining = (phaseDeadline: number, label: string) => {
    const left = Math.floor(Math.min(phaseDeadline, cleanupDeadline) - performance.now());
    if (left <= 0) throw new Error(`${label} phase expired`);
    return left;
  };
  const disposeDelay = Number(process.env.COVE_QUERY_TEST_DISPOSE_DELAY_MS ?? 0);
  if (
    profile === "query" &&
    (!Number.isInteger(disposeDelay) || disposeDelay < 0 || disposeDelay > 1_500)
  )
    cleanupErrors.push(new Error("Invalid query disposal delay injection"));
  let disposedPages = 0;
  const pages = ownedPages.reverse();
  for (const [index, page] of pages.entries()) {
    // Q1 shares its reserved page phase; B0 keeps its 500 ms page-operation limits.
    const pageShare =
      profile === "query"
        ? Math.floor((pageDeadline - performance.now()) / (pages.length - index))
        : null;
    const pageEnd =
      pageShare === null
        ? cleanupDeadline
        : Math.min(pageDeadline, performance.now() + Math.max(0, pageShare));
    const record: PageCleanupRecord = {
      page: index + 1,
      shareMs: pageShare,
      dispose: { budgetMs: 0, elapsedMs: 0, outcome: "not-started" },
      close: { attempts: 0, budgetMs: 0, elapsedMs: 0, outcome: "not-started" },
    };
    pageCleanup.push(record);
    const injectedHang =
      profile === "query" && process.env.COVE_QUERY_TEST_DISPOSE_HANG === "1" && index === 0;
    const disposalExpression = injectedHang
      ? "new Promise(() => {})"
      : profile === "query" && disposeDelay > 0 && disposeDelay <= 1_500
        ? `new Promise((resolve) => setTimeout(() => { window.coveQuery?.dispose(); resolve(); }, ${disposeDelay}))`
        : "window.coveQuery?.dispose()";
    const disposeStarted = performance.now();
    try {
      const disposalBudget =
        pageShare === null
          ? cleanupRemaining(500)
          : Math.min(
              1_500,
              pageRemaining(pageEnd, `Query fixture disposal page ${index + 1}`) - 500,
            );
      if (disposalBudget <= 0)
        throw new Error(`Query fixture disposal page ${index + 1} has no reserved budget`);
      record.dispose.budgetMs = disposalBudget;
      await within(
        page.evaluate<void>(disposalExpression),
        disposalBudget,
        `Query fixture disposal page ${index + 1}/${pages.length} (${disposalBudget} ms)`,
      );
      record.dispose.outcome = "completed";
    } catch (error) {
      record.dispose.outcome =
        error instanceof Error && error.message.includes("phase expired")
          ? "phase-expired"
          : error instanceof Error && error.message.includes("timed out")
            ? "timed-out"
            : "error";
      cleanupErrors.push(error);
    }
    record.dispose.elapsedMs = Math.round(performance.now() - disposeStarted);
    const afterDisposeDelay = Number(process.env.COVE_QUERY_TEST_AFTER_DISPOSE_DELAY_MS ?? 0);
    if (profile === "query" && index === 0 && afterDisposeDelay !== 0) {
      if (
        !Number.isSafeInteger(afterDisposeDelay) ||
        afterDisposeDelay < 0 ||
        afterDisposeDelay > 2_000
      )
        cleanupErrors.push(new Error("Invalid post-disposal delay injection"));
      else await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, afterDisposeDelay));
    }
    const closeStarted = performance.now();
    try {
      const closeBudget =
        pageShare === null
          ? cleanupRemaining(500, pageEnd)
          : pageRemaining(pageEnd, `Browser page close ${index + 1}`);
      record.close.budgetMs = closeBudget;
      const mode = profile === "query" ? process.env.COVE_QUERY_TEST_CLOSE_MODE : undefined;
      const target = process.env.COVE_QUERY_TEST_CLOSE_PAGE ?? "1";
      const inject = target === "all" || target === String(index + 1);
      const delay = Number(process.env.COVE_QUERY_TEST_CLOSE_DELAY_MS ?? 0);
      if (mode && !["delay", "hang", "reject"].includes(mode))
        throw new Error("Invalid query close mode injection");
      if (mode === "delay" && (!Number.isSafeInteger(delay) || delay < 0 || delay > 5_000))
        throw new Error("Invalid query close delay injection");
      record.close.attempts = 1;
      const actualClose = page.close();
      const closeOperation =
        !inject || !mode
          ? actualClose
          : mode === "delay"
            ? actualClose.then(
                () => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay)),
              )
            : mode === "hang"
              ? actualClose.then(() => new Promise<void>(() => {}))
              : actualClose.then(() => {
                  throw new Error("Injected query page close rejection");
                });
      void closeOperation.then(
        () => {
          if (record.close.outcome === "timed-out" && !cleanupEvidenceFinalized)
            record.close.lateOutcome = "completed";
        },
        () => {
          if (record.close.outcome === "timed-out" && !cleanupEvidenceFinalized)
            record.close.lateOutcome = "rejected";
        },
      );
      await within(
        closeOperation,
        closeBudget,
        `Browser page close ${index + 1}/${pages.length} (${closeBudget} ms)`,
      );
      disposedPages++;
      record.close.outcome = "completed";
    } catch (error) {
      record.close.outcome =
        error instanceof Error && error.message.includes("phase expired")
          ? "phase-expired"
          : error instanceof Error && error.message.includes("timed out")
            ? "timed-out"
            : "error";
      cleanupErrors.push(error);
    }
    record.close.elapsedMs = Math.round(performance.now() - closeStarted);
  }
  if (browserServer) {
    const injectedCloseHang =
      profile === "query" && process.env.COVE_QUERY_TEST_BROWSER_CLOSE_HANG === "1";
    const closeDelay =
      profile === "query" ? Number(process.env.COVE_QUERY_TEST_BROWSER_CLOSE_DELAY_MS ?? 0) : 0;
    const killMode =
      profile === "query" ? process.env.COVE_QUERY_TEST_BROWSER_KILL_MODE : undefined;
    const killDelay =
      profile === "query" ? Number(process.env.COVE_QUERY_TEST_BROWSER_KILL_DELAY_MS ?? 0) : 0;
    const gracefulStarted = performance.now();
    graceful.startedMs = Math.round(gracefulStarted - cleanupStarted);
    graceful.phaseRemainingMs = Math.floor(
      (profile === "query" ? gracefulCloseDeadline : browserDeadline) - gracefulStarted,
    );
    try {
      if (!Number.isSafeInteger(closeDelay) || closeDelay < 0 || closeDelay > 2_500)
        throw new Error("Invalid browser close delay injection");
      if (killMode && !["hang", "reject"].includes(killMode))
        throw new Error("Invalid browser kill mode injection");
      if (!Number.isSafeInteger(killDelay) || killDelay < 0 || killDelay > 1_000)
        throw new Error("Invalid browser kill delay injection");
      graceful.budgetMs = cleanupRemaining(
        profile === "query" ? 2_000 : 3_000,
        profile === "query" ? gracefulCloseDeadline : browserDeadline,
      );
      graceful.attempts = 1;
      closeTimeline.beforeClose();
      const actualClose = injectedCloseHang
        ? new Promise<void>(() => {})
        : closeTimeline.invoke("rawClose", () => browserServer.close());
      const closeOperation = closeDelay
        ? actualClose.then(
            () => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, closeDelay)),
          )
        : actualClose;
      closeTimeline.observeWrapper(closeOperation);
      observeLateBrowserClose(closeOperation, graceful, () => cleanupEvidenceFinalized);
      await within(closeOperation, graceful.budgetMs, "Browser close", () =>
        closeTimeline.markWrapperTimeout(),
      );
      graceful.outcome = "completed";
    } catch (error) {
      graceful.outcome =
        error instanceof Error && error.message.includes("timed out") ? "timed-out" : "rejected";
      cleanupErrors.push(error);
      const killStarted = performance.now();
      kill.startedMs = Math.round(killStarted - cleanupStarted);
      kill.phaseRemainingMs = Math.floor(browserDeadline - killStarted);
      try {
        kill.budgetMs = cleanupRemaining(profile === "query" ? 1_500 : 2_000, browserDeadline);
        kill.attempts = 1;
        const actualKill = closeTimeline.invoke("rawKill", () => browserServer.kill());
        const killOperation = actualKill.then(async () => {
          if (killDelay)
            await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, killDelay));
          if (killMode === "hang") await new Promise<void>(() => {});
          if (killMode === "reject") throw new Error("Injected browser kill rejection");
        });
        await within(killOperation, kill.budgetMs, "Browser kill");
        kill.outcome = "completed";
      } catch (killError) {
        kill.outcome =
          killError instanceof Error && killError.message.includes("timed out")
            ? "timed-out"
            : "rejected";
        cleanupErrors.push(killError);
      }
      kill.elapsedMs = Math.round(performance.now() - killStarted);
    }
    graceful.elapsedMs = Math.round(performance.now() - gracefulStarted);
    const state = browserServer.process();
    if (state.exitCode === null && state.signalCode === null)
      cleanupErrors.push(new Error("Browser process exit was not observed"));
  }
  if (server.listening) {
    const listenerStarted = performance.now();
    listener.startedMs = Math.round(listenerStarted - cleanupStarted);
    listener.phaseRemainingMs = Math.floor(cleanupDeadline - listenerStarted);
    server.closeAllConnections();
    try {
      listener.budgetMs = cleanupRemaining(profile === "query" ? 750 : 2_000);
      listener.attempts = 1;
      await within(
        new Promise<void>((resolveClose, reject) =>
          server.close((error) => (error ? reject(error) : resolveClose())),
        ),
        listener.budgetMs,
        "Fixture listener close",
      );
      listener.outcome = "completed";
    } catch (error) {
      listener.outcome =
        error instanceof Error && error.message.includes("timed out") ? "timed-out" : "rejected";
      cleanupErrors.push(error);
    }
    listener.elapsedMs = Math.round(performance.now() - listenerStarted);
  }
  cleanupEvidenceFinalized = true;
  closeTimeline.finalize();
  browserProcess?.off("exit", onBrowserExit);
  const browserState = browserProcess ?? browserServer?.process();
  const cleanupEvidence = {
    schemaVersion: 1,
    final: true,
    caseId: evidenceOptions?.caseId ?? null,
    testName: evidenceOptions?.testName ?? null,
    invocationId: evidenceOptions?.invocationId ?? null,
    runId: evidenceOptions?.runId ?? null,
    sourceCommit: evidenceOptions?.sourceCommit ?? null,
    sourceDirty: evidenceOptions?.sourceDirty ?? null,
    profile,
    primaryOutcome: primaryError ? "rejected" : "completed",
    primaryErrorName:
      primaryError instanceof Error ? primaryError.name : primaryError ? "unknown" : null,
    browserPid: browserState?.pid ?? null,
    browserExited: browserState
      ? browserState.exitCode !== null || browserState.signalCode !== null
      : true,
    browserExit: browserState
      ? {
          code: browserState.exitCode,
          signal: browserState.signalCode,
          observedMs: exitEvent ? Math.round(exitEvent.at - cleanupStarted) : null,
        }
      : null,
    listenerPort,
    listenerClosed: !server.listening,
    graceful: { ...graceful },
    kill: { ...kill },
    listener: { ...listener },
    closeTimeline: {
      ...closeTimeline.record,
      finalized: true,
      invocationId: evidenceOptions?.invocationId ?? null,
      runId: evidenceOptions?.runId ?? null,
      sourceCommit: evidenceOptions?.sourceCommit ?? null,
    },
    disposedPages,
    pages: pageCleanup.map((record) => ({
      ...record,
      dispose: { ...record.dispose },
      close: { ...record.close },
    })),
    workBudgetMs,
    completedInjectedDelays,
    cleanupElapsedMs: Math.round(performance.now() - cleanupStarted),
    elapsedMs: Math.round(performance.now() - workStarted),
  };
  const legacyEvidencePath =
    profile === "environment"
      ? process.env.COVE_PROBE_CLEANUP_EVIDENCE
      : process.env.COVE_QUERY_CLEANUP_EVIDENCE;
  const evidencePaths = [...new Set([evidenceOptions?.path, legacyEvidencePath].filter(Boolean))];
  if (evidencePaths.length) {
    try {
      await within(
        Promise.all(
          evidencePaths.map((path) => writeFile(path!, `${JSON.stringify(cleanupEvidence)}\n`)),
        ),
        cleanupRemaining(profile === "query" ? 250 : 1_000),
        "Browser cleanup evidence",
      );
    } catch (error) {
      cleanupErrors.push(error);
      console.error(
        `Browser cleanup evidence write failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
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
  const cleanupDiagnostic = JSON.stringify(cleanupEvidence);
  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `Browser work and cleanup failed: ${cleanupDiagnostic}`,
      {
        cause: primaryError,
      },
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, `Browser cleanup failed: ${cleanupDiagnostic}`);
  if (result === undefined || !contextRecord) throw new Error("Browser probe produced no result");
  return { value: result, context: contextRecord };
}

export async function openManagedPage(
  context: ManagedBrowserContext,
  path = "/",
): Promise<ProbePage> {
  const page = await within(
    context.browser.newPage(),
    context.remaining(5_000, "page creation"),
    "page creation",
  );
  context.trackPage(page);
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
  const url = new URL(path, context.url);
  if (url.origin !== new URL(context.url).origin) throw new Error("Managed page escaped fixture");
  const response = await page.goto(url.href, {
    waitUntil: "networkidle",
    timeout: context.remaining(10_000, "navigation"),
  });
  if (!response?.ok()) throw new Error(`Fixture navigation failed: ${response?.status()}`);
  context.assertPageErrors();
  return page;
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
