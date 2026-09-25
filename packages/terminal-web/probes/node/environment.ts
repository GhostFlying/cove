import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withManagedBrowser, within } from "./managed-browser.js";

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
  const { value, context: browser } = await withManagedBrowser(async (context) => {
    const page = await within(
      context.browser.newPage(),
      context.remaining(5_000, "Browser page creation"),
      "Browser page creation",
    );
    await context.stage("created browser page delay");
    page.setDefaultTimeout(context.remaining(5_000, "Browser actions"));
    const errors: string[] = [];
    for (const event of ["console", "pageerror", "requestfailed"])
      page.on(event, (value) => {
        const error = browserError(event, value);
        if (error) errors.push(error);
      });
    page.on("request", (request) => {
      const url = (request as { url(): string }).url();
      if (!url.startsWith(context.url)) errors.push(`External request: ${url}`);
    });
    const response = await page.goto(context.url, {
      waitUntil: "networkidle",
      timeout: context.remaining(10_000, "fixture navigation"),
    });
    if (!response?.ok()) throw new Error(`Fixture navigation failed: ${response?.status()}`);
    await context.stage("loaded browser fixture delay");
    await page.waitForFunction("window.coveProbe?.ready === true", null, {
      timeout: context.remaining(5_000, "xterm ready"),
    });
    const rendered = await within(
      page.evaluate<{ line?: string; cursorX: number; width: number; height: number }>(`(() => {
      const probe = window.coveProbe;
      if (!probe) throw new Error("Browser probe unavailable");
      const line = probe.terminal.buffer.active.getLine(0)?.translateToString(true);
      const dimensions = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      probe.terminal.focus();
      return { line, cursorX: probe.terminal.buffer.active.cursorX, width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 };
    })()`),
      context.remaining(5_000, "xterm inspection"),
      "xterm inspection",
    );
    if (
      rendered.line !== "COVE_BROWSER_READY" ||
      rendered.cursorX !== 18 ||
      rendered.width <= 0 ||
      rendered.height <= 0
    )
      throw new Error(`Browser buffer or geometry mismatch: ${JSON.stringify(rendered)}`);
    await within(
      page.keyboard.type("ok"),
      context.remaining(5_000, "Browser keyboard input"),
      "Browser keyboard input",
    );
    const input = await within(
      page.evaluate<string>("window.coveProbe?.input"),
      context.remaining(5_000, "Browser input inspection"),
      "Browser input inspection",
    );
    if (input !== "ok" || errors.length)
      throw new Error(`Browser input/errors: ${JSON.stringify({ input, errors })}`);
    return { rendered, input };
  }, "environment");
  return {
    browserVersion: browser.browserVersion,
    browserRevision: browser.browserRevision,
    browserExecutable: browser.browserExecutable,
    renderedWidth: value.rendered.width,
    renderedHeight: value.rendered.height,
    input: value.input,
    listenerPort: browser.listenerPort,
    browserPid: browser.browserPid,
  };
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
