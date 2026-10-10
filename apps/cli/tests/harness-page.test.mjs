import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { domainError } from "@cove/protocol/errors";
import {
  createTerminalDecoder,
  encodeTerminalFrame,
  TERMINAL_FRAME_CLASSES,
} from "@cove/protocol/terminal";
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
// The marker draws about 300 glyph pixels under SwiftShader at ratio 1 and a row of red cells
// without text none, so a third of that proves the text was drawn with margin for rasterizers.
const MARKER_GLYPH_PIXELS = 100;

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
  const reported = await page.textContent("#error").catch(() => null);
  const rows = await screenRows(page).catch(() => []);
  return new Error(
    `${error.message}\nterminal status: ${status}\npage error: ${reported}\nscreen:\n${rows.filter(Boolean).join("\n")}`,
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

// Counts, in a real screenshot of the terminal host (what the compositor shows rather than what
// a renderer claims to have drawn), pixels close to the harness palette red, rgb(204, 0, 0), and
// glyph pixels inside red cells: near-white foreground pixels with red within three pixels on the
// same row. Red background alone does not prove the marker's text was drawn; a renderer whose
// glyph atlas is broken still fills cell backgrounds. The typed command line, white on black,
// has no red beside its glyphs.
async function screenPixels(page) {
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
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    const at = (x, y) => (y * width + x) * 4;
    const isRed = (index) => data[index] > 150 && data[index + 1] < 60 && data[index + 2] < 60;
    const isWhite = (index) => data[index] > 200 && data[index + 1] > 200 && data[index + 2] > 200;
    let red = 0;
    let glyph = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = at(x, y);
        if (isRed(index)) red++;
        else if (isWhite(index)) {
          for (let dx = -3; dx <= 3; dx++) {
            const nx = x + dx;
            if (dx !== 0 && nx >= 0 && nx < width && isRed(at(nx, y))) {
              glyph++;
              break;
            }
          }
        }
      }
    return { red, glyph };
  }, png.toString("base64"));
}

const redPixels = async (page) => (await screenPixels(page)).red;

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

// Waits for the marker's own glyphs, drawn in its red cells, as screenPixels counts them.
async function waitForMarkerGlyphs(page, minimum) {
  let count = 0;
  await waitFor(
    "marker glyph pixels on screen",
    async () => (count = (await screenPixels(page)).glyph) >= minimum,
    15_000,
  ).catch((error) => {
    throw new Error(`${error.message} (last count ${count})`, { cause: error });
  });
  return count;
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

// Waits until the status has stayed attached and controlling for a while. Typing no longer
// needs it (input during a recovery is held); it lets a check read a settled status, and lets a
// probe that reads its tty size observe a resize before it is asked to print.
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
// scrollbar, which overlays the right edge of the terminal. Also the screen's size and the space
// available to it in both directions, and the grid the status bar reports.
const fitGeometry = (page) =>
  page.evaluate(() => {
    const host = document.getElementById("terminal");
    const style = getComputedStyle(host);
    const box = host.getBoundingClientRect();
    const contentRight =
      box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const scrollbar = host.querySelector(".xterm .scrollbar.vertical")?.getBoundingClientRect();
    const visibleRight = Math.min(contentRight, scrollbar?.width ? scrollbar.left : Infinity);
    const visibleBottom =
      box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const screen = host.querySelector(".xterm-screen").getBoundingClientRect();
    const screenRight = screen.right;
    const [cols, rows] = document
      .getElementById("terminal-status")
      .textContent.match(/(\d+)×(\d+)/)
      .slice(1)
      .map(Number);
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
    return {
      visibleRight,
      screenRight,
      glyphRights,
      grid: { cols, rows },
      screen: { width: screen.width, height: screen.height },
      available: { width: visibleRight - screen.left, height: visibleBottom - screen.top },
    };
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

const frameText = new TextDecoder();

function decodeFrames(frameDecoder, bytes) {
  const frames = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = frameDecoder.read(bytes.subarray(offset));
    if (read.status === "error" || read.consumedBytes === 0)
      throw new Error("terminal socket tap could not decode a frame");
    offset += read.consumedBytes;
    for (const frame of read.frames)
      frames.push({ metadata: JSON.parse(frameText.decode(frame.metadata)) });
  }
  return frames;
}

// A terminal error frame as the server would send it in reply to a command.
function errorFrame(fields) {
  const metadata = new TextEncoder().encode(JSON.stringify({ type: "error", ...fields }));
  const encoded = encodeTerminalFrame(TERMINAL_FRAME_CLASSES.error, metadata, new Uint8Array());
  if (!encoded.ok) throw new Error("could not encode an error frame");
  return Buffer.from(encoded.value);
}

const isResizeEvent = (frame) =>
  frame.metadata.type === "run-event" && frame.metadata.event?.type === "resize";

// Routes the page's terminal WebSocket through the test, which forwards every message in both
// directions and records the decoded frames' metadata (never their payloads, which carry
// terminal bytes). It can hold the server's messages from just after a chosen one, and the
// page's messages, so a test can keep the page's recovery incomplete for as long as it needs:
// the transport boundary, not the page's timing, decides when the recovery may finish. Install
// it before the page loads.
async function tapTerminalSocket(page) {
  const tap = {
    inbound: [],
    outbound: [],
    heldInbound: [],
    heldOutbound: [],
    holdingInbound: false,
    holdingOutbound: false,
    afterInbound: undefined,
    sockets: 0,
    // Run `action` once, just after the first server message with a frame matching `predicate`
    // is handed to the page and before the page can react to it.
    afterInboundFrame(predicate, action) {
      tap.afterInbound = { predicate, action };
    },
    // Forward the first server message with a frame matching `predicate`, then hold every
    // server message after it.
    holdInboundAfter(predicate) {
      tap.afterInboundFrame(predicate, () => (tap.holdingInbound = true));
    },
    holdOutbound() {
      tap.holdingOutbound = true;
    },
    // Forward the first page message with a frame matching `predicate`, then hold every server
    // message after it, so that command's reply (and everything else) stays away from the page.
    holdInboundAfterOutbound(predicate) {
      tap.afterOutbound = predicate;
    },
    afterOutbound: undefined,
    // Never forward the next page message with a frame matching `predicate` (a command) to the
    // server. Without `error` the command just gets no reply, so it ends as RESULT_UNKNOWN; with
    // it, the page gets that error for it at once, as a server refusal that changed nothing.
    interceptOutbound(predicate, error) {
      tap.intercept = { predicate, error };
    },
    intercept: undefined,
    intercepted: 0,
    // Release held messages in their original order, and stop holding.
    releaseInbound() {
      tap.holdingInbound = false;
      for (const { route, message } of tap.heldInbound.splice(0)) route.send(message);
    },
    releaseOutbound() {
      tap.holdingOutbound = false;
      for (const { server, message } of tap.heldOutbound.splice(0)) server.send(message);
    },
  };
  await page.routeWebSocket(/\/terminal$/, (route) => {
    tap.sockets++;
    const server = route.connectToServer();
    const inbound = createTerminalDecoder();
    const outbound = createTerminalDecoder();
    route.onMessage((message) => {
      const frames = typeof message === "string" ? [] : decodeFrames(outbound, message);
      tap.outbound.push(...frames);
      const intercept = tap.intercept;
      if (intercept && frames.length === 1 && intercept.predicate(frames[0])) {
        tap.intercept = undefined;
        tap.intercepted++;
        if (intercept.error) {
          const { requestId, run, type } = frames[0].metadata;
          route.send(errorFrame({ requestId, run, commandType: type, error: intercept.error }));
        }
        return;
      }
      if (tap.holdingOutbound) tap.heldOutbound.push({ server, message });
      else server.send(message);
      if (tap.afterOutbound && frames.some(tap.afterOutbound)) {
        tap.afterOutbound = undefined;
        tap.holdingInbound = true;
      }
    });
    server.onMessage((message) => {
      const frames = typeof message === "string" ? [] : decodeFrames(inbound, message);
      tap.inbound.push(...frames);
      if (tap.holdingInbound) {
        tap.heldInbound.push({ route, message });
        return;
      }
      route.send(message);
      const hook = tap.afterInbound;
      if (hook && frames.some(hook.predicate)) {
        tap.afterInbound = undefined;
        hook.action();
      }
    });
  });
  return tap;
}

const statusPhase = (page) =>
  page.evaluate(() => document.getElementById("terminal-status")?.dataset.phase);

// Lets the page run its pending tasks, so anything it would send now has reached the tap.
const pageTurn = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 100)));

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
      // Typed at once: input during the click's resize recovery is held, not refused.
      await printMarker(page, MARKER);
      await waitForRedPixels(page);
      if (webgl2) {
        // WebGL drew the marker's text, not only its red cells.
        await waitForMarkerGlyphs(page, MARKER_GLYPH_PIXELS);
        await recordRendererChanges(page);
        // xterm waits up to three seconds for the browser to restore a lost context before it
        // reports the loss; the view then drops to DOM and retries WebGL once after a delay.
        await loseWebglContexts(page, 1);
        await waitForRendererChanges(page, ["dom", "webgl"]);
        await waitForRedPixels(page);
        // The retried WebGL renderer rebuilt its glyph atlas and draws the text again.
        await waitForMarkerGlyphs(page, MARKER_GLYPH_PIXELS);
        await loseWebglContexts(page, 1);
        await waitForRendererChanges(page, ["dom", "webgl", "dom"]);
        // Well past the retry delay the view is still on DOM: the single retry was spent.
        await page.waitForTimeout(1_500);
        await waitForRendererChanges(page, ["dom", "webgl", "dom"]);
        await page.waitForFunction(() => !document.querySelector("#terminal canvas"));
        // DOM cells measure differently from WebGL cells, so the page resizes the PTY to the
        // DOM grid; input typed during that recovery is held and sent once it is over.
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
      // A click takes control at the page's grid. The run was created by the CLI at another grid,
      // so the size change is recovered with a fresh baseline; input typed meanwhile is held.
      await page.click("#terminal");
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

// A user's first click in a new terminal takes control and is followed at once by typing, with no
// wait for control to settle. The page created the terminal at its estimate of the grid the view
// measures, so taking control resizes nothing and nothing typed in between may be lost. A click
// that does change the grid is covered by the byte-probe test below.
test("a first click in a new terminal keeps the input typed right after it", async ({ task }) => {
  await withHarness(async ({ directory, server, page, pageErrors }) => {
    await openConnectedPage({ server, page });
    await offersWebgl2(page, task);
    await openNewTerminal(page);
    const statusGrid = () =>
      page.evaluate(
        () => document.getElementById("terminal-status")?.textContent.match(/\d+×\d+/)?.[0],
      );
    const created = await statusGrid();
    const target = join(directory, "first-click.txt");
    try {
      await page.click("#terminal");
      await page.keyboard.type(`echo first-click-ok > '${target}'`);
      await page.keyboard.press("Enter");
      await waitFor(
        "the command typed after the first click to run",
        async () => (await readFile(target, "utf8").catch(() => "")) === "first-click-ok\n",
        15_000,
      );
      await waitForSteadyControl(page);
    } catch (error) {
      throw await describePage(page, error);
    }
    expect(created).toMatch(/^\d+×\d+$/);
    expect(await statusGrid()).toBe(created);
    expect(await page.textContent("#error")).toBe("");
    expect(pageErrors).toEqual([]);
  });
});

// A process that switches its tty to raw mode and records every byte it reads until the typed
// line `done`, so each typed byte can be checked to arrive exactly once and in order.
const BYTE_PROBE = String.raw`import { writeFileSync } from "node:fs";
const out = process.argv[2];
process.stdin.setRawMode(true);
let received = "";
process.stdin.on("data", (chunk) => {
  received += chunk.toString("latin1");
  const end = received.indexOf("done\r");
  if (end >= 0) {
    writeFileSync(out, JSON.stringify(received.slice(0, end)));
    process.exit(0);
  }
});
process.stdout.write("byte-probe-ready\r\n");
`;

// The first click into a run created at another grid takes control at the page's grid, so the
// PTY is resized and this client recovers with a fresh baseline. Keys typed at once, with no
// wait for control to settle, are held during that recovery and sent once the grant is usable
// (relay-protocol 9.1): every byte reaches the PTY exactly once, in order. A fast local server
// could finish that recovery before the first key is typed, so the test holds the server's
// messages from the resize event on, and types only while the page is visibly still recovering.
test("a first click that changes the grid keeps every byte typed right after it", async () => {
  await withHarness(async ({ directory, server, page, pageErrors }) => {
    const socket = await tapTerminalSocket(page);
    const script = join(directory, "byte-probe.mjs");
    const out = join(directory, "byte-probe.json");
    await writeFile(script, BYTE_PROBE);
    // Created at a grid no page layout here measures (the default 80x24 can match the page's
    // own grid on some platforms' fonts), so the click is sure to resize the PTY.
    const run = await createRun(
      server.env,
      directory,
      [process.execPath, script, out],
      ["--cols", "61", "--rows", "17"],
    );
    // The DOM renderer's rows are the oracle for the probe's raw-mode readiness.
    await openConnectedPage({ server, page }, "dom");
    await page.click(`#runs button[data-run-id="${run.runId}"]`);
    await page.waitForFunction(
      () => document.getElementById("terminal-status")?.dataset.phase === "ready",
    );
    const statusGrid = () =>
      page.evaluate(
        () => document.getElementById("terminal-status")?.textContent.match(/\d+×\d+/)?.[0],
      );
    const typed = "first-click: every byte once";
    let before;
    let received;
    try {
      await waitForRow(page, "byte-probe-ready");
      before = await statusGrid();
      socket.holdInboundAfter(isResizeEvent);
      // Click on the first row: a 61x17 screen does not reach the middle of the host.
      await page.click("#terminal", { position: { x: 24, y: 8 } });
      await page.waitForFunction(
        () => document.getElementById("terminal-status")?.dataset.phase !== "ready",
      );
      await page.keyboard.type(typed);
      await page.keyboard.type("done");
      await page.keyboard.press("Enter");
      await pageTurn(page);
      // Every key was typed while the recovery could not finish, and none was sent yet.
      expect(socket.holdingInbound).toBe(true);
      expect(await statusPhase(page)).not.toBe("ready");
      expect(socket.outbound.filter((frame) => frame.metadata.type === "input")).toEqual([]);
      socket.releaseInbound();
      await waitFor(
        "the probe's report",
        async () => (received = JSON.parse(await readFile(out, "utf8").catch(() => "null"))),
        20_000,
      );
    } catch (error) {
      throw await describePage(page, error);
    }
    expect(received).toBe(typed);
    expect(socket.sockets).toBe(1);
    // The click did change the grid, so the input really crossed a resize recovery.
    expect(before).toMatch(/^\d+×\d+$/);
    expect(await statusGrid()).not.toBe(before);
    expect(await page.textContent("#error")).toBe("");
    expect(pageErrors).toEqual([]);
  });
});

// A focus the server accepted can still fail before its grant is usable: here the grid-changing
// first click's own recovery is overtaken by another page taking control. The page must report
// that accepted failure, although a recovery ran meanwhile, and must not take control back. The
// tap holds this page's messages from the resize event on, so its recovery request reaches the
// server only after the other page's focus.
test("a first click whose grant is lost during its own recovery reports the accepted focus", async () => {
  await withHarness(async ({ directory, server, browser, page, pageErrors }) => {
    const socket = await tapTerminalSocket(page);
    const run = await createRun(
      server.env,
      directory,
      ["/bin/cat"],
      ["--cols", "61", "--rows", "17"],
    );
    const openRunIn = async (target) => {
      await openConnectedPage({ server, page: target });
      await target.click(`#runs button[data-run-id="${run.runId}"]`);
      await target.waitForFunction(
        () => document.getElementById("terminal-status")?.dataset.phase === "ready",
      );
      await target.waitForSelector("#terminal .xterm-screen");
    };
    const statusText = (target) => target.textContent("#terminal-status");
    const other = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    other.setDefaultTimeout(15_000);
    try {
      await openRunIn(page);
      socket.afterInboundFrame(isResizeEvent, () => socket.holdOutbound());
      await page.click("#terminal", { position: { x: 24, y: 8 } });
      await waitFor(
        "the page's recovery request to be held",
        () =>
          socket.heldOutbound.length > 0 &&
          socket.outbound.some((f) => f.metadata.type === "recover"),
        15_000,
      );
      expect(await statusPhase(page)).not.toBe("ready");
      // The other page measures the same grid, so its focus takes control without a resize.
      await openRunIn(other);
      await other.click("#terminal");
      await other.waitForFunction(() =>
        document.getElementById("terminal-status")?.textContent.includes("controlling"),
      );
      socket.releaseOutbound();
      await page.waitForFunction(() =>
        /focus accepted at epoch \d+ but not usable/.test(
          document.getElementById("terminal-status")?.textContent ?? "",
        ),
      );
      await waitForSteadyControl(other);
    } catch (error) {
      throw await describePage(page, error);
    } finally {
      await other.close();
    }
    const status = await statusText(page);
    expect(status).toContain("viewing");
    expect(status).toContain("attached");
    expect(socket.outbound.filter((frame) => frame.metadata.type === "focus").length).toBe(1);
    expect(pageErrors).toEqual([]);
  });
});

const sentFrames = (socket, type) =>
  socket.outbound.filter((frame) => frame.metadata.type === type);

const waitForStatus = (page, pattern) =>
  page.waitForFunction(
    (source) =>
      new RegExp(source).test(document.getElementById("terminal-status")?.textContent ?? ""),
    pattern.source,
    { timeout: 15_000 },
  );

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A focus or resize whose reply never arrives ends as RESULT_UNKNOWN when its lane deadline
// passes: the server may have applied it. The page must say so rather than call it refused, and
// must hand no focus or resize off on its own until a server fact settles it (no silent retry).
// The tap holds every server message from the command on, so no fact arrives until the test
// releases them. Every focus and resize command on the wire is counted, whatever its grid.
test("a focus or resize with an unknown result is shown as unknown and never resent", async () => {
  await withHarness(async ({ page, server, pageErrors }) => {
    const socket = await tapTerminalSocket(page);
    await openConnectedPage({ server, page });
    await openNewTerminal(page);
    const status = () => page.textContent("#terminal-status");
    const sent = (type) => sentFrames(socket, type).length;
    try {
      socket.holdInboundAfterOutbound((frame) => frame.metadata.type === "focus");
      await page.click("#terminal");
      await waitForStatus(page, /focus result unknown/);
      expect(await status()).not.toContain("refused");
      expect([sent("focus"), sent("resize")]).toEqual([1, 0]);
      socket.releaseInbound();
      // The page did not adopt a grant it never saw accepted, so it stays a viewer until the user
      // clicks again: that is a new request, not a resend of the unknown one.
      await pause(500);
      expect([sent("focus"), sent("resize")]).toEqual([1, 0]);
      await page.click("#terminal");
      await waitForSteadyControl(page);
      expect([sent("focus"), sent("resize")]).toEqual([2, 0]);

      // Grid A: a resize this client asks for after the window grows, with its reply and facts
      // held until it ends as unknown.
      socket.holdInboundAfterOutbound((frame) => frame.metadata.type === "resize");
      await page.setViewportSize({ width: 1200, height: 760 });
      await waitForStatus(page, /resize result unknown/);
      expect(await status()).not.toContain("refused");
      expect([sent("focus"), sent("resize")]).toEqual([2, 1]);
      // The window changes to grid B and back to A while no fact has arrived: the page sends
      // neither B nor A again.
      await page.setViewportSize({ width: 1100, height: 700 });
      await pause(500);
      await page.setViewportSize({ width: 1200, height: 760 });
      await pause(500);
      expect([sent("focus"), sent("resize")]).toEqual([2, 1]);
      // The held facts show A applied: the page measures A, so it has nothing to send.
      socket.releaseInbound();
      await waitForSteadyControl(page);
      expect([sent("focus"), sent("resize")]).toEqual([2, 1]);
    } catch (error) {
      throw await describePage(page, error);
    }
    expect(socket.sockets).toBe(1);
    expect(pageErrors).toEqual([]);
  });
});

const gridOf = (target) =>
  target.evaluate(
    () => document.getElementById("terminal-status")?.textContent.match(/\d+×\d+/)?.[0],
  );

// A first click into a run created at another grid takes control and resizes the PTY. Its focus
// ends as unknown, and only then does the recovery from that resize reach ready: the page must not
// take control again by itself after it; a click does. A resize that never reaches the server is
// still unanswered when another client's resize brings this page to ready at a different grid;
// once it ends as unknown, that recovery is the fact that settles it, so the page later sends the
// grid it then needs, once. A resize the server refuses blocks nothing and is not retried.
test("a control command with an unknown result is not retried, and a fact unblocks resizing", async () => {
  await withHarness(async ({ directory, server, browser, page, pageErrors }) => {
    const socket = await tapTerminalSocket(page);
    let other;
    const run = await createRun(
      server.env,
      directory,
      ["/bin/cat"],
      ["--cols", "61", "--rows", "17"],
    );
    await openConnectedPage({ server, page });
    await page.click(`#runs button[data-run-id="${run.runId}"]`);
    await page.waitForFunction(
      () => document.getElementById("terminal-status")?.dataset.phase === "ready",
    );
    await page.waitForSelector("#terminal .xterm-screen");
    const sent = (type) => sentFrames(socket, type).length;
    const resizeEvents = () => socket.inbound.filter(isResizeEvent).length;
    try {
      // Everything after the focus is held until it ends as unknown; released, the resize it
      // caused starts a recovery that reaches ready after the unknown result.
      socket.holdInboundAfterOutbound((frame) => frame.metadata.type === "focus");
      // Click on the first row: a 61x17 screen does not reach the middle of the host.
      await page.click("#terminal", { position: { x: 24, y: 8 } });
      await waitForStatus(page, /focus result unknown/);
      const recoveries = sent("recover") + sent("attach");
      socket.releaseInbound();
      // The focus did resize the PTY, and the page recovered from it.
      await waitFor("the focus's resize event", () => resizeEvents() === 1, 15_000);
      await waitFor(
        "the recovery from it",
        () => sent("recover") + sent("attach") > recoveries,
        15_000,
      );
      await page.waitForFunction(
        () => document.getElementById("terminal-status")?.dataset.phase === "ready",
      );
      await pause(1_000);
      expect([sent("focus"), sent("resize")]).toEqual([1, 0]);
      await page.click("#terminal");
      await waitForSteadyControl(page);
      expect([sent("focus"), sent("resize")]).toEqual([2, 0]);

      // A second page, a viewer on a smaller window, is ready to take control at its own grid.
      other = await browser.newPage({ viewport: { width: 900, height: 560 } });
      other.setDefaultTimeout(15_000);
      await openConnectedPage({ server, page: other });
      await other.click(`#runs button[data-run-id="${run.runId}"]`);
      await other.waitForFunction(
        () => document.getElementById("terminal-status")?.dataset.phase === "ready",
      );
      await other.waitForSelector("#terminal .xterm-screen");

      // Grid A: the window grows and the page asks for A, which never reaches the server, so its
      // result can only end as unknown. Before it does, the other page takes control at its grid
      // X and this page recovers to ready at X, a grid other than A.
      socket.interceptOutbound((frame) => frame.metadata.type === "resize");
      await page.setViewportSize({ width: 1200, height: 760 });
      await waitFor("the resize to A", () => socket.intercepted === 1, 15_000);
      const requested = sentFrames(socket, "resize")[0].metadata.geometry;
      await other.click("#terminal");
      await waitForSteadyControl(other);
      const otherGrid = await gridOf(other);
      await page.waitForFunction((grid) => {
        const status = document.getElementById("terminal-status");
        return (
          status?.dataset.phase === "ready" &&
          status.textContent.includes(grid) &&
          status.textContent.includes("viewing")
        );
      }, otherGrid);
      expect(otherGrid).not.toBe(`${requested.cols}×${requested.rows}`);
      // The recovery reached ready while the resize to A was still unanswered.
      expect(await page.textContent("#terminal-status")).not.toMatch(/resize/);
      await waitForStatus(page, /resize result unknown/);
      await pause(500);
      expect([sent("focus"), sent("resize")]).toEqual([2, 1]);

      // A click takes control at A, by focus. A later window change then needs grid B: the
      // unknown resize to A blocks nothing any more, and B is sent exactly once.
      await page.click("#terminal");
      await waitForSteadyControl(page);
      expect([sent("focus"), sent("resize")]).toEqual([3, 1]);
      await page.setViewportSize({ width: 1100, height: 700 });
      await waitForSteadyControl(page);
      await pause(500);
      expect([sent("focus"), sent("resize")]).toEqual([3, 2]);
      expect(sentFrames(socket, "resize")[1].metadata.geometry).not.toEqual(requested);

      // A resize the server refuses (BUSY, not accepted) changed nothing: the page does not
      // retry it for the same grid, and the next window change is sent.
      socket.interceptOutbound((frame) => frame.metadata.type === "resize", domainError("BUSY"));
      await page.setViewportSize({ width: 1200, height: 760 });
      await waitForStatus(page, /resize refused/);
      await pause(500);
      expect([sent("focus"), sent("resize")]).toEqual([3, 3]);
      await page.setViewportSize({ width: 1000, height: 640 });
      await waitForSteadyControl(page);
      await pause(500);
      expect([sent("focus"), sent("resize")]).toEqual([3, 4]);
      expect(socket.intercepted).toBe(2);
    } catch (error) {
      throw await describePage(page, error);
    } finally {
      await other?.close();
    }
    expect(socket.sockets).toBe(1);
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
          // The key would be held through the click's resize recovery and still arrive, but the
          // probe reads its width from Node's cached tty size, which SIGWINCH refreshes only on a
          // later turn of its event loop: a key arriving right after the resize can be printed
          // at the old width. Wait for control to settle so the probe has seen the resize.
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
          // Measuring again at the applied grid must choose the same grid: the page re-measures
          // on a window resize event, and a different answer would resize the PTY.
          await page.evaluate(() => window.dispatchEvent(new Event("resize")));
          await page.waitForTimeout(300);
          // As above: a resize here must reach the probe before it prints, or the check would
          // compare against a stale width.
          await waitForSteadyControl(page);
          await page.keyboard.press("p");
          const reprinted = await probe.nextPrint();
          results.push({
            ...layout,
            active,
            cols: printed.cols,
            remeasuredCols: reprinted.cols,
            ...geometry,
          });
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
    // The grid is also the largest that fits, and measuring it again keeps it. xterm 6 renders
    // `count` cells as round(deviceCell * count / ratio) CSS px. The page does not expose the
    // device cell, but the screen's drawn size bounds it: round(deviceCell * count / ratio) equals
    // that size, so deviceCell < (size + 0.5) * ratio / count. A grid misses a column or row only
    // if one more would fit even with the largest device cell that bound allows; a valid maximal
    // grid is never rejected. V1-L11 checks maximality exactly against the renderer's own cell.
    const extent = (count, deviceCell, ratio) => Math.round((deviceCell * count) / ratio);
    const fitsOneMore = (count, size, available, ratio) =>
      extent(count + 1, ((size + 0.5) * ratio) / count, ratio) <= available;
    const short = results.filter(
      (result) =>
        result.grid.cols !== result.cols ||
        result.remeasuredCols !== result.cols ||
        result.screen.height > result.available.height + 0.5 / result.deviceScaleFactor ||
        fitsOneMore(
          result.grid.cols,
          result.screen.width,
          result.available.width,
          result.deviceScaleFactor,
        ) ||
        fitsOneMore(
          result.grid.rows,
          result.screen.height,
          result.available.height,
          result.deviceScaleFactor,
        ),
    );
    expect(short).toEqual([]);
  });
});

function createRun(env, directory, argv, flags = []) {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [cli, "terminal", "create", "--cwd", directory, ...flags, "--", ...argv],
      { env, timeout: 20_000 },
      (error, stdout, stderr) =>
        error
          ? fail(new Error(`cove terminal create failed: ${stderr}`))
          : done(JSON.parse(stdout)),
    );
  });
}
