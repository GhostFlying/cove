import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  expect(record.browserRevision).toBe("1243");
  expect(record.browserVersion).toBe("153.0.8010.12");
  expect(record.browserExecutable).toContain(`chromium-${record.browserRevision}`);
  expect(record.renderedWidth).toBeGreaterThan(0);
  expect(record.renderedHeight).toBeGreaterThan(0);
  await expect(fetch(`http://127.0.0.1:${record.listenerPort}/`)).rejects.toThrow(/fetch failed/);
  const evidence = resolve(import.meta.dirname, "../../../.cache/ci/smoke");
  await mkdir(evidence, { recursive: true });
  await writeFile(resolve(evidence, "web.json"), `${JSON.stringify(record, null, 2)}\n`);
});

test("browser work deadline closes Chromium and its fixture listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-browser-deadline-"));
  const evidence = join(directory, "cleanup.json");
  try {
    const result = spawnSync(process.execPath, [entry], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 40_000,
      env: {
        ...process.env,
        COVE_PROBE_WORK_BUDGET_MS: "8000",
        COVE_PROBE_STAGE_DELAY_MS: "2000",
        COVE_PROBE_CLEANUP_EVIDENCE: evidence,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/deadline|timed out/);
    const record = JSON.parse(await readFile(evidence, "utf8"));
    expect(record.browserPid).toBeGreaterThan(0);
    expect(record.completedInjectedDelays).toBeGreaterThanOrEqual(1);
    expect(record.browserExited).toBe(true);
    expect(record.listenerClosed).toBe(true);
    expect(record.elapsedMs).toBeLessThan(16_000);
    await expect(fetch(`http://127.0.0.1:${record.listenerPort}/`)).rejects.toThrow(/fetch failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser export preserves work and cleanup failures after closing Chromium", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-browser-errors-"));
  const evidence = join(directory, "cleanup.json");
  try {
    const script = `import { runEnvironmentProbe } from ${JSON.stringify(import.meta.resolve("@cove/terminal-web/probes/environment"))};
try { await runEnvironmentProbe(); process.exitCode = 2; }
catch (error) { console.log(JSON.stringify({ name: error.name, messages: error.errors?.map((item) => item.message), cause: error.cause?.message })); }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 40_000,
      env: {
        ...process.env,
        COVE_PROBE_INJECT_WORK_FAILURE: "1",
        COVE_PROBE_INJECT_CLEANUP_FAILURE: "1",
        COVE_PROBE_CLEANUP_EVIDENCE: evidence,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      name: "AggregateError",
      messages: ["Injected browser work failure", "Injected browser cleanup failure"],
      cause: "Injected browser work failure",
    });
    const cleanup = JSON.parse(await readFile(evidence, "utf8"));
    expect(cleanup.browserPid).toBeGreaterThan(0);
    expect(cleanup.browserExited).toBe(true);
    expect(cleanup.listenerClosed).toBe(true);
    await expect(fetch(`http://127.0.0.1:${cleanup.listenerPort}/`)).rejects.toThrow(
      /fetch failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser rejects an executable outside the pinned managed revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-browser-selection-"));
  const unrelated = join(directory, "unrelated-browser");
  try {
    await writeFile(unrelated, "not a browser");
    const result = spawnSync(process.execPath, [entry], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 40_000,
      env: { ...process.env, COVE_PROBE_TEST_EXECUTABLE: unrelated },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/outside managed revision 1243/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser rejects a wrong reported version and closes its owned resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cove-browser-version-"));
  const evidence = join(directory, "cleanup.json");
  try {
    const result = spawnSync(process.execPath, [entry], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 40_000,
      env: {
        ...process.env,
        COVE_PROBE_TEST_REPORTED_VERSION: "0.0.0.0",
        COVE_PROBE_CLEANUP_EVIDENCE: evidence,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /Chromium version 0\.0\.0\.0 does not match pinned 153\.0\.8010\.12/,
    );
    const cleanup = JSON.parse(await readFile(evidence, "utf8"));
    expect(cleanup.browserPid).toBeGreaterThan(0);
    expect(cleanup.browserExited).toBe(true);
    expect(cleanup.listenerClosed).toBe(true);
    await expect(fetch(`http://127.0.0.1:${cleanup.listenerPort}/`)).rejects.toThrow(
      /fetch failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
