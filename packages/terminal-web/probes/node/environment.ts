import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface WebProbeResult {
  readonly browserVersion: string;
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
  const imported: unknown = createRequire(import.meta.url)("playwright");
  if (typeof imported !== "object" || imported === null || !("chromium" in imported))
    throw new Error("Playwright Chromium launcher is absent");
  // Playwright's Node API declarations reference DOM types; this probe uses only its public runtime methods.
  const chromium = imported.chromium as ChromiumLauncher;
  const executable = chromium.executablePath();
  if (!(await stat(executable).catch(() => null))) throw new Error("Managed Chromium is absent");
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected listener address");
    browserServer = await chromium.launchServer({
      headless: true,
      executablePath: executable,
      timeout: 8_000,
    });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
    const page = await within(browser.newPage(), 5_000, "Browser page creation");
    page.setDefaultTimeout(5_000);
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
      timeout: 10_000,
    });
    if (!response?.ok()) throw new Error(`Fixture navigation failed: ${response?.status()}`);
    await page.waitForFunction("window.coveProbe?.ready === true", null, { timeout: 5_000 });
    const rendered = await page.evaluate<{
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
    })()`);
    if (
      rendered.line !== "COVE_BROWSER_READY" ||
      rendered.cursorX !== 18 ||
      rendered.width <= 0 ||
      rendered.height <= 0
    ) {
      throw new Error(`Browser buffer or geometry mismatch: ${JSON.stringify(rendered)}`);
    }
    await within(page.keyboard.type("ok"), 5_000, "Browser keyboard input");
    const input = await page.evaluate<string>("window.coveProbe?.input");
    if (input !== "ok" || errors.length)
      throw new Error(`Browser input/errors: ${JSON.stringify({ input, errors })}`);
    const browserPid = browserServer.process().pid;
    if (!browserPid) throw new Error("Browser process identity is unavailable");
    record = {
      browserVersion: browser.version(),
      browserExecutable: executable,
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
  if (browserServer) {
    try {
      await within(browserServer.close(), 3_000, "Browser close");
    } catch (error) {
      cleanupErrors.push(error);
      try {
        await within(browserServer.kill(), 2_000, "Browser kill");
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
        2_000,
        "Fixture listener close",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length) console.error("Browser probe cleanup failed:", cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Browser probe cleanup failed");
  if (!record) throw new Error("Browser probe produced no result");
  return record;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runEnvironmentProbe()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
