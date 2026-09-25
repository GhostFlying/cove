import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("engine work deadline still reaps its owned PTY child and temporary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-engine-deadline-"));
  const evidence = join(directory, "cleanup.json");
  try {
    const result = spawnSync(process.execPath, [entry], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        COVE_PROBE_WORK_BUDGET_MS: "2200",
        COVE_PROBE_STAGE_DELAY_MS: "1200",
        COVE_PROBE_CLEANUP_EVIDENCE: evidence,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deadline|timed out/);
    const record = JSON.parse(await readFile(evidence, "utf8"));
    expect(record.childPid).toBeGreaterThan(0);
    expect(record.completedInjectedDelays).toBeGreaterThanOrEqual(1);
    expect(record.childExited).toBe(true);
    expect(record.temporaryCwdRemoved).toBe(true);
    expect(record.elapsedMs).toBeLessThan(7_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
