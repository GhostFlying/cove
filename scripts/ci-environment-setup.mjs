import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import filesystem from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupDir = join(root, ".cache/ci/setup");

function custodyError(phase, error, stream) {
  return { phase, stream, error };
}

export function ordinaryCIOutputMetadata(capture) {
  return {
    stdout: capture.stdout,
    stderr: capture.stderr,
    custodyErrors: capture.errors.map(({ phase, stream, error }) => ({
      phase,
      stream,
      name: error.name,
      message: error.message,
      code: error.code ?? null,
      stack: error.stack,
      secondaryErrors: error.secondaryErrors?.map((secondary) => ({
        name: secondary.name,
        message: secondary.message,
        code: secondary.code ?? null,
      })),
    })),
  };
}

async function binaryOutputEvidence(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

// Ordinary CI output can exceed pipe capture limits; its custody stays binary and file-backed.
export async function captureOrdinaryCIOutput(
  stage,
  binary,
  args,
  directory,
  cwd,
  timeoutMs,
  maxBuffer,
) {
  const capture = {
    directory,
    errors: [],
    stdout: { path: `${stage}.stdout.bin`, fd: null, closed: false, complete: false },
    stderr: { path: `${stage}.stderr.bin`, fd: null, closed: false, complete: false },
  };
  const handles = {};
  let result;
  let failure;
  try {
    await mkdir(directory, { recursive: true });
    for (const stream of ["stdout", "stderr"]) {
      handles[stream] = await filesystem.open(join(directory, capture[stream].path), "wx");
      capture[stream].fd = handles[stream].fd;
    }
    try {
      result = spawnSync(binary, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env: process.env,
        stdio: ["ignore", handles.stdout.fd, handles.stderr.fd],
      });
      failure = result.error;
    } catch (error) {
      failure = error;
    }
  } catch (error) {
    capture.errors.push(custodyError("prepare", error));
  } finally {
    for (const stream of ["stdout", "stderr"]) {
      if (!handles[stream]) continue;
      try {
        await handles[stream].close();
        capture[stream].closed = true;
      } catch (error) {
        capture.errors.push(custodyError("close", error, stream));
      }
    }
  }
  for (const stream of ["stdout", "stderr"]) {
    if (!handles[stream]) continue;
    try {
      Object.assign(
        capture[stream],
        await binaryOutputEvidence(join(directory, capture[stream].path)),
      );
      capture[stream].complete = true;
    } catch (error) {
      capture.errors.push(custodyError("hash", error, stream));
    }
  }
  return { result, failure, capture };
}

export async function replayOrdinaryCIOutput(
  capture,
  stdout = process.stdout,
  stderr = process.stderr,
) {
  for (const [stream, destination] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    if (capture[stream].fd === null) continue;
    try {
      await pipeline(
        createReadStream(join(capture.directory, capture[stream].path), {
          highWaterMark: 64 * 1024,
        }),
        destination,
        { end: false },
      );
    } catch (error) {
      capture.errors.push(custodyError("replay", error, stream));
    }
  }
}

export function throwOrdinaryCIOutputFailure(primary, capture, attempt) {
  const failure = primary ?? capture.errors[0]?.error;
  if (!failure) return;
  failure.ciOutputAttempt = attempt;
  failure.custodyErrors = ordinaryCIOutputMetadata(capture).custodyErrors;
  throw failure;
}

async function checkOutputLog(capture, path) {
  let handle;
  let failure;
  try {
    handle = await filesystem.open(path, "wx");
    for (const stream of ["stdout", "stderr"]) {
      for await (const chunk of createReadStream(join(capture.directory, capture[stream].path), {
        highWaterMark: 64 * 1024,
      })) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error("CI check log write made no progress");
          offset += bytesWritten;
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      if (failure) failure.secondaryErrors = [error];
      else failure = error;
    }
  }
  if (failure) throw failure;
  return binaryOutputEvidence(path);
}

async function fileRecordedCheck(stage, binary, args, directory, cwd, timeoutMs, outputs) {
  const { result, failure, capture } = await captureOrdinaryCIOutput(
    stage,
    binary,
    args,
    directory,
    cwd,
    timeoutMs,
    2 * 1024 * 1024,
  );
  const attempt = {
    stage,
    argv: [binary, ...args],
    timeoutMs,
    childPid: result?.pid ?? null,
    exitCode: result?.status ?? null,
    signal: result?.signal ?? null,
    errorCode: failure?.code ?? null,
    timedOut: failure?.code === "ETIMEDOUT",
    outputCapture: ordinaryCIOutputMetadata(capture),
  };
  const primary =
    failure ??
    (result && result.status !== 0 ? new Error(`${stage} exited ${result.status}`) : undefined);
  let recorded = false;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${stage}.json`), `${JSON.stringify(attempt, null, 2)}\n`);
    recorded = true;
  } catch (error) {
    capture.errors.push(custodyError("metadata", error));
  }
  if (capture.stdout.complete && capture.stderr.complete) {
    try {
      attempt.log = {
        path: `${stage}.log`,
        ...(await checkOutputLog(capture, join(directory, `${stage}.log`))),
      };
    } catch (error) {
      capture.errors.push(custodyError("check-log", error));
    }
  }
  await replayOrdinaryCIOutput(capture, outputs.stdout, outputs.stderr);
  attempt.outputCapture = ordinaryCIOutputMetadata(capture);
  if (recorded) {
    try {
      await writeFile(join(directory, `${stage}.json`), `${JSON.stringify(attempt, null, 2)}\n`);
    } catch (error) {
      capture.errors.push(custodyError("metadata", error));
      attempt.outputCapture = ordinaryCIOutputMetadata(capture);
    }
  }
  throwOrdinaryCIOutputFailure(primary, capture, attempt);
  return attempt;
}

export async function runRecordedSetup(
  stage,
  binary,
  args,
  directory,
  cwd,
  timeoutMs = 600_000,
  outputs = {},
) {
  if (stage === "check")
    return fileRecordedCheck(stage, binary, args, directory, cwd, timeoutMs, outputs);
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
