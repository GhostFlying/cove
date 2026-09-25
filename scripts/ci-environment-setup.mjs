import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupDir = join(root, ".cache/ci/setup");

export async function runRecordedSetup(stage, binary, args, directory, cwd, timeoutMs = 600_000) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  const attempt = {
    stage,
    argv: [binary, ...args],
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${stage}.json`), `${JSON.stringify(attempt, null, 2)}\n`);
  await writeFile(
    join(directory, `${stage}.log`),
    `${result.stdout?.slice(-64_000) ?? ""}${result.stderr?.slice(-64_000) ?? ""}`,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${stage} exited ${result.status}`);
  return attempt;
}

async function initialize() {
  await rm(setupDir, { recursive: true, force: true });
  await mkdir(setupDir, { recursive: true });
  const hashes = {};
  for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    hashes[name] = createHash("sha256")
      .update(await readFile(join(root, name)))
      .digest("hex");
  }
  await writeFile(
    join(setupDir, "environment.json"),
    `${JSON.stringify(
      {
        node: process.version,
        nodeAbi: process.versions.modules,
        nodeApi: process.versions.napi,
        platform: process.platform,
        arch: process.arch,
        runnerOs: process.env.RUNNER_OS ?? null,
        hashes,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "--init") return initialize();
  const stages = {
    "--install": [
      "install",
      "pnpm",
      ["install", "--frozen-lockfile", "--config.side-effects-cache=false"],
    ],
    "--native": ["native", "pnpm", ["native:prepare"]],
    "--browser": [
      "browser",
      "pnpm",
      ["--filter", "@cove/terminal-web", "--fail-if-no-match", "browser:install"],
    ],
    "--check": ["check", "pnpm", ["check"]],
  };
  const selected = stages[command];
  if (!selected) throw new Error(`Unknown setup command ${command}`);
  await runRecordedSetup(
    selected[0],
    selected[1],
    selected[2],
    setupDir,
    root,
    command === "--check" ? 1_200_000 : 600_000,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
