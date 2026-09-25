import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = fileURLToPath(import.meta.resolve("@cove/terminal-web/probes/environment"));

test("compiled web export serves built xterm in managed Chromium and receives keyboard input", async () => {
  const result = spawnSync(process.execPath, [entry], {
    cwd: resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 40_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(result.stderr || `Web probe exited ${result.status}`);
  expect(result.status).toBe(0);
  const record = JSON.parse(result.stdout.trim());
  expect(record.input).toBe("ok");
  expect(record.renderedWidth).toBeGreaterThan(0);
  expect(record.renderedHeight).toBeGreaterThan(0);
  await expect(fetch(`http://127.0.0.1:${record.listenerPort}/`)).rejects.toThrow(/fetch failed/);
  const evidence = resolve(import.meta.dirname, "../../../.cache/ci/smoke");
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, "web.json"), `${JSON.stringify(record, null, 2)}\n`);
});
