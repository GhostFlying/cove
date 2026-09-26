import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openManagedPage, withManagedBrowser } from "../dist/probes/node/managed-browser.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDirectory = join(root, ".cache/ci/browser-cleanup");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sourceDirty =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  }).trim() !== "";
const runId = /^[A-Za-z0-9-]{1,80}$/.test(process.env.COVE_BROWSER_CLEANUP_RUN_ID ?? "")
  ? process.env.COVE_BROWSER_CLEANUP_RUN_ID
  : `local-${process.pid}-${Date.now()}`;
let invocation = 0;
let lastEvidencePath;

export async function readLastViewBrowserEvidence() {
  if (!lastEvidencePath) throw new Error("No V1 browser invocation has started");
  return JSON.parse(await readFile(lastEvidencePath, "utf8"));
}

const builtRoot = resolve(
  process.env.COVE_VIEW_BROWSER_ROOT ?? resolve(import.meta.dirname, "../dist/view-browser"),
);

export async function withViewPage(work) {
  if (++invocation > 48) throw new Error("V1 browser cleanup evidence invocation limit exceeded");
  let testName = null;
  try {
    const { expect } = await import("vitest");
    testName = expect.getState().currentTestName || null;
  } catch {
    // The isolated version-mismatch CLI uses this runner without Vitest.
  }
  const caller = new Error().stack?.match(
    /(view-(?:input|recovery|lifecycle)\.test\.mjs):(\d+):\d+/,
  );
  const caseId = caller ? `${caller[1]}:${caller[2]}` : "standalone";
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, `${process.pid}-${invocation}.json`);
  lastEvidencePath = path;
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, final: false, caseId, testName, runId, sourceCommit, sourceDirty })}\n`,
  );
  const { value } = await withManagedBrowser(
    async (context) => {
      const page = await openManagedPage(context);
      await page.waitForFunction("window.coveQuery?.ready === true", null, {
        timeout: context.remaining(5_000, "V1 xterm ready"),
      });
      context.assertPageErrors();
      return work(page);
    },
    "query",
    builtRoot,
    {
      path,
      caseId,
      testName,
      runId,
      sourceCommit,
      sourceDirty,
    },
  );
  return value;
}
