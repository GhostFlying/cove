import { execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { writeFitProbe } from "./fit-probe.mjs";
import { QUERY_REPLIES_THEN, writeQueryProbe } from "./query-probe.mjs";
import { waitFor } from "./recording-view.mjs";
import { stopServer, within } from "./server-process.mjs";

const cli = resolve(import.meta.dirname, "../dist/main.js");
// The repository's one managed Chromium, installed for the pinned Playwright by
// `pnpm --filter @cove/terminal-web browser:install` (CI: ci-environment-setup --browser).
const browsersPath =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  resolve(import.meta.dirname, "../../../packages/terminal-web/.cache/playwright");

const MARKER = "cove-harness-ok";
const SECOND_MARKER = "cove-harness-dom";

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
    return { wrapper, exited, env, report: JSON.parse(stdout) };
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

// Run `body` against a harness server and a page in the managed Chromium, then tear both
// down. Every cleanup step runs even when an earlier one fails, and the body's own failure
// is reported in preference to any cleanup failure.
async function withHarness(body) {
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
    await body({ directory, server, browser, page, pageErrors });
  } catch (error) {
    failure = error;
  }
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
}

// Name the page's own account of a failure, such as an input rejection, and its screen.
async function describePage(page, error) {
  const status = await page.textContent("#terminal-status").catch(() => null);
  const rows = await screenRows(page).catch(() => []);
  return new Error(
    `${error.message}\nterminal status: ${status}\nscreen:\n${rows.filter(Boolean).join("\n")}`,
    { cause: error },
  );
}

const screenRows = (page) =>
  page.$$eval("#terminal .xterm-rows > div", (divs) =>
    divs.map((row) => row.textContent.trimEnd()),
  );

// Wait until the production view renders a row that is exactly `text`.
const waitForRow = (page, text) =>
  page.waitForFunction(
    (wanted) =>
      [...document.querySelectorAll("#terminal .xterm-rows > div")].some(
        (row) => row.textContent.trim() === wanted,
      ),
    text,
  );

// Whether this Chromium offers WebGL2 at all, and which WebGL implementation backs it. Headless
// CI Chromium may draw it in software (SwiftShader) or not offer it; without it the view must
// report the DOM fallback. The implementation is recorded in the test's metadata, which the JSON
// report keeps as CI evidence.
async function offersWebgl2(page, task) {
  const offered = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return { webgl2: false, implementation: null };
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const implementation = String(
      gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "",
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { webgl2: true, implementation };
  });
  task.meta.webgl = offered;
  return offered.webgl2;
}

const rendererOf = (page) =>
  page.evaluate(() => document.getElementById("terminal-status")?.dataset.renderer);

async function openNewTerminal(page) {
  await page.click("#new-terminal");
  await page.waitForFunction(
    () => document.getElementById("terminal-status")?.dataset.phase === "ready",
  );
  await page.waitForSelector("#terminal .xterm-screen");
}

// Prints `marker` on a red background (palette index 1). The typed command line itself has no
// red, so red pixels on screen prove that output was drawn, whichever renderer drew it.
async function printMarker(page, marker) {
  await page.keyboard.type(`printf '\\033[41m%s\\033[0m\\n' ${marker}`);
  await page.keyboard.press("Enter");
}

// Counts pixels of the terminal host close to the harness palette red, rgb(204, 0, 0), in a
// real screenshot: what the compositor shows rather than what a renderer claims to have drawn.
async function redPixels(page) {
  const png = await page.locator("#terminal").screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4)
      if (data[index] > 150 && data[index + 1] < 60 && data[index + 2] < 60) count++;
    return count;
  }, png.toString("base64"));
}

async function waitForRedPixels(page, minimum = 200) {
  let count = 0;
  await waitFor(
    "red marker pixels on screen",
    async () => (count = await redPixels(page)) >= minimum,
    15_000,
  ).catch((error) => {
    throw new Error(`${error.message} (last count ${count})`, { cause: error });
  });
}

// Loses every live WebGL context drawn in the terminal, as a GPU reset would, and checks that
// exactly `expected` contexts were live.
async function loseWebglContexts(page, expected) {
  const lost = await page.evaluate(() => {
    let count = 0;
    for (const canvas of document.querySelectorAll("#terminal canvas")) {
      const gl = canvas.getContext("webgl2");
      const extension = gl?.getExtension("WEBGL_lose_context");
      if (!gl || gl.isContextLost() || !extension) continue;
      extension.loseContext();
      count++;
    }
    return count;
  });
  if (lost !== expected) throw new Error(`lost ${lost} WebGL contexts, expected ${expected}`);
}

// Records each distinct renderer the status bar reports from now on, so a short DOM interval
// between a loss and its retry cannot be missed by polling.
const recordRendererChanges = (page) =>
  page.evaluate(() => {
    const status = document.getElementById("terminal-status");
    const changes = [];
    let last = status.dataset.renderer;
    new MutationObserver(() => {
      if (status.dataset.renderer === last) return;
      last = status.dataset.renderer;
      changes.push(last);
    }).observe(status, { attributes: true, attributeFilter: ["data-renderer"] });
    window.coveRendererChanges = changes;
  });

const waitForRendererChanges = (page, expected) =>
  page.waitForFunction(
    (wanted) => JSON.stringify(window.coveRendererChanges) === JSON.stringify(wanted),
    expected,
    { timeout: 15_000 },
  );

// A click takes control at the page's grid; a changed grid is recovered with a fresh baseline
// and control is retaken, and input typed in between is refused. Wait until the status has
// stayed attached and controlling for a while before typing.
async function waitForSteadyControl(page) {
  let last;
  let since = Date.now();
  await waitFor(
    "steady control of the terminal",
    async () => {
      const { text, phase } = await page.evaluate(() => {
        const status = document.getElementById("terminal-status");
        return { text: status?.textContent ?? "", phase: status?.dataset.phase };
      });
      if (text !== last) {
        last = text;
        since = Date.now();
      }
      return phase === "ready" && text.includes("controlling") && Date.now() - since > 750;
    },
    20_000,
  );
}

// Where the last cell of the grid and the last glyphs of the first two rows end, against the
// right edge of the area a user can see: the host's content box, short of xterm's vertical
// scrollbar, which overlays the right edge of the terminal.
const fitGeometry = (page) =>
  page.evaluate(() => {
    const host = document.getElementById("terminal");
    const style = getComputedStyle(host);
    const box = host.getBoundingClientRect();
    const contentRight =
      box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const scrollbar = host.querySelector(".xterm .scrollbar.vertical")?.getBoundingClientRect();
    const visibleRight = Math.min(contentRight, scrollbar?.width ? scrollbar.left : Infinity);
    const screenRight = host.querySelector(".xterm-screen").getBoundingClientRect().right;
    const glyphRights = [...host.querySelectorAll(".xterm-rows > div")].slice(0, 2).map((row) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let last;
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.data.trimEnd()) last = node;
      if (!last) return null;
      const range = document.createRange();
      const end = last.data.trimEnd().length;
      range.setStart(last, end - 1);
      range.setEnd(last, end);
      return range.getBoundingClientRect().right;
    });
    return { visibleRight, screenRight, glyphRights };
  });

// `renderer` adds the harness's renderer query parameter in front of the printed fragment;
// without it the printed URL is opened exactly as the CLI printed it.
async function openConnectedPage({ server, page }, renderer) {
  const url = server.report.harness;
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#/);
  const secret = new URLSearchParams(new URL(url).hash.slice(1)).get("secret");
  expect(secret).toBeTruthy();
  await page.goto(renderer ? url.replace("/#", `/?renderer=${renderer}#`) : url);
  await page.waitForFunction(
    () => document.getElementById("connection")?.textContent === "connected",
  );
  return secret;
}

// One harness serves both the printed-URL check and the context-loss policy: every harness
// start costs a server and a Chromium, and the macOS CI test budget is tight.
test("the printed harness URL renders typed output with the default renderer and survives WebGL context loss", async ({
  task,
}) => {
  await withHarness(async ({ server, page, pageErrors }) => {
    const secret = await openConnectedPage({ server, page });
    // The fragment, and the secret in it, is gone from the address bar once read.
    expect(page.url()).not.toContain(secret);
    expect(await page.evaluate(() => location.href)).not.toContain(secret);
    expect(await page.evaluate(() => location.hash)).toBe("");
    const webgl2 = await offersWebgl2(page, task);

    await openNewTerminal(page);
    // The printed URL names no renderer, so the view takes WebGL2 whenever the browser offers it
    // and otherwise reports the DOM fallback.
    expect(await rendererOf(page)).toBe(webgl2 ? "webgl" : "dom");
    await page.click("#terminal");
    try {
      await waitForSteadyControl(page);
      await printMarker(page, MARKER);
      await waitForRedPixels(page);
      if (webgl2) {
        await recordRendererChanges(page);
        // xterm waits up to three seconds for the browser to restore a lost context before it
        // reports the loss; the view then drops to DOM and retries WebGL once after a delay.
        await loseWebglContexts(page, 1);
        await waitForRendererChanges(page, ["dom", "webgl"]);
        await waitForRedPixels(page);
        await loseWebglContexts(page, 1);
        await waitForRendererChanges(page, ["dom", "webgl", "dom"]);
        // Well past the retry delay the view is still on DOM: the single retry was spent.
        await page.waitForTimeout(1_500);
        await waitForRendererChanges(page, ["dom", "webgl", "dom"]);
        await page.waitForFunction(() => !document.querySelector("#terminal canvas"));
        // DOM cells measure differently from WebGL cells, so the page resizes the PTY to the
        // DOM grid; wait for that recovery before typing.
        await waitForSteadyControl(page);
      }
      // The DOM renderer repainted the existing output and renders new output. The echoed
      // output is its own row, distinct from the typed command line.
      await waitForRow(page, MARKER);
      await printMarker(page, SECOND_MARKER);
      await waitForRow(page, SECOND_MARKER);
      await waitForRedPixels(page);
    } catch (error) {
      throw await describePage(page, error);
    }
    expect(await rendererOf(page)).toBe("dom");
    expect(await page.textContent("#error")).toBe("");
    expect(pageErrors).toEqual([]);
  });
});

test("S4 the production view answers no terminal query and passes real keys and paste through, on renderer=dom", async () => {
  await withHarness(async ({ directory, server, page, pageErrors }) => {
    // The probe sends DA and CPR once it reads the typed line `go`, and reports every byte it
    // reads until `done`. The page's xterm parses those queries and would answer them; only
    // the server's replies may reach the process.
    const probe = await writeQueryProbe(directory, "wait");
    const run = await createRun(server.env, directory, probe.argv);
    // The DOM renderer's rows are this test's text oracle for its synchronization points; the
    // WebGL renderer draws no text into the DOM. Query suppression is decided by the parser,
    // not the renderer, and the V1 view query suites run under the default renderer.
    await openConnectedPage({ server, page }, "dom");
    // The renderer parameter is not secret and stays in the address bar.
    expect(await page.evaluate(() => location.search)).toBe("?renderer=dom");
    await page.click(`#runs button[data-run-id="${run.runId}"]`);
    await page.waitForFunction(
      () => document.getElementById("terminal-status")?.dataset.phase === "ready",
    );
    expect(await rendererOf(page)).toBe("dom");
    await page.waitForSelector("#terminal .xterm-rows");
    try {
      // A click takes control at the page's grid; a size change is recovered and retaken.
      await page.click("#terminal");
      await page.waitForFunction(() => {
        const status = document.getElementById("terminal-status");
        return status?.dataset.phase === "ready" && status.textContent.includes("controlling");
      });
      // The probe prints this only after switching its tty to raw mode; typed earlier, the
      // tty's ICRNL would turn Enter into a newline and the probe would never ask.
      await waitForRow(page, "query-probe-ready");
      await page.keyboard.type("go");
      await page.keyboard.press("Enter");
      await waitFor("the probe to see both replies", probe.seen);
      // The view has parsed the queries, which precede this line in the output.
      await waitForRow(page, "replies-seen");
      await page.keyboard.type("kbd-1");
      // A real paste event on xterm's input element, as a browser delivers it.
      await page.locator("#terminal textarea").evaluate((textarea) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", "paste-2");
        textarea.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      });
      await page.keyboard.type("done");
      await page.keyboard.press("Enter");
      expect(await probe.received()).toMatch(QUERY_REPLIES_THEN("kbd-1paste-2"));
    } catch (error) {
      throw await describePage(page, error);
    }
    expect(await page.textContent("#error")).toBe("");
    expect(pageErrors).toEqual([]);
  });
});

test("the measured grid fits the visible terminal at several window sizes and pixel ratios", async () => {
  await withHarness(async ({ directory, server, browser }) => {
    const probe = await writeFitProbe(directory);
    const run = await createRun(server.env, directory, probe.argv);
    // The two renderers measure cells differently: WebGL snaps a cell to whole device pixels.
    const layouts = [
      { width: 1000, height: 640, deviceScaleFactor: 1, renderer: "dom" },
      { width: 1003, height: 611, deviceScaleFactor: 1.25, renderer: "dom" },
      { width: 1157, height: 700, deviceScaleFactor: 2, renderer: "dom" },
      { width: 1003, height: 611, deviceScaleFactor: 1.25, renderer: "webgl" },
      { width: 1157, height: 700, deviceScaleFactor: 2, renderer: "webgl" },
    ];
    const results = [];
    for (const [index, layout] of layouts.entries()) {
      const { width, height, deviceScaleFactor, renderer } = layout;
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor,
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await openConnectedPage({ server, page }, renderer);
        await page.click(`#runs button[data-run-id="${run.runId}"]`);
        await page.waitForFunction(
          () => document.getElementById("terminal-status")?.dataset.phase === "ready",
        );
        try {
          if (index === 0) await waitForRow(page, "fit-probe-ready");
          await page.click("#terminal");
          await waitForSteadyControl(page);
          await page.keyboard.press("p");
          const printed = await probe.nextPrint();
          await page.waitForFunction(
            (cols) => document.getElementById("terminal-status")?.textContent.includes(`${cols}×`),
            printed.cols,
          );
          // The probe printed at the grid the PTY had; the DOM renderer shows that same grid.
          // WebGL draws no DOM text, so only its cell geometry is checked.
          const active = await rendererOf(page);
          if (active === "dom") {
            await waitForRow(page, printed.ascii);
            await waitForRow(page, printed.mixed);
          }
          const geometry = await fitGeometry(page);
          results.push({ ...layout, active, cols: printed.cols, ...geometry });
        } catch (error) {
          throw await describePage(page, error);
        }
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    expect(results).toHaveLength(layouts.length);
    // Half a device pixel absorbs subpixel layout rounding, not a clipped cell.
    const clipped = results.filter((result) => {
      const limit = result.visibleRight + 0.5 / result.deviceScaleFactor;
      return result.screenRight > limit || result.glyphRights.some((right) => right > limit);
    });
    expect(clipped).toEqual([]);
  });
});

function createRun(env, directory, argv) {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [cli, "terminal", "create", "--cwd", directory, "--", ...argv],
      { env, timeout: 20_000 },
      (error, stdout, stderr) =>
        error
          ? fail(new Error(`cove terminal create failed: ${stderr}`))
          : done(JSON.parse(stdout)),
    );
  });
}
