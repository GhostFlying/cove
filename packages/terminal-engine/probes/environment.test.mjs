import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = fileURLToPath(import.meta.resolve("@cove/terminal-engine/probes/environment"));

test("compiled engine export runs one native PTY and headless serializer round trip", async () => {
  const result = spawnSync(process.execPath, [entry], {
    cwd: resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(result.stderr || `Engine probe exited ${result.status}`);
  expect(result.status).toBe(0);
  const record = JSON.parse(result.stdout.trim());
  expect(record.childExitCode).toBe(23);
  expect(record.roundTrip).toBe("READY");
  expect(record.nativeSha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(access(record.temporaryCwd)).rejects.toMatchObject({ code: "ENOENT" });
  const evidence = resolve(import.meta.dirname, "../../../.cache/ci/smoke");
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, "engine.json"), `${JSON.stringify(record, null, 2)}\n`);
});
