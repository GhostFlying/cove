import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, writeSync } from "node:fs";
import filesystem from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupDir = join(root, ".cache/ci/setup");

const minute = 60_000;

// One budget for every CI time bound. Each bound must contain the configured allowances of
// everything inside it, not just their observed durations. While work without its own bound
// stays within its stated reserve, these allowances leave room to record ordinary failures.
// Only the async setup stages below bound their wait after termination; synchronous check/gate
// children can ignore TERM. Workflow cancellation is the final containment, not cleanup proof.
// tests/tooling/ci-environment-setup.test.mjs checks the composition and the workflow value.
export const ciTimeBudget = Object.freeze({
  // Each of the install, native and browser setup steps (observed: at most 25 s on macOS).
  setupStageMs: 10 * minute,
  // The workflow browser step also contains route preparation and bounded termination/finalization.
  browserStepMs: 12 * minute,
  setupFinalizeReserveMs: minute,
  // Each auxiliary gate command: the toolchain probe, discovery and the source revision.
  gateCommandMs: 2 * minute,
  // The vitest run. #111 raised it from 12 to 20 minutes when green macOS runs took 11.1-11.8.
  // #151 raised it to 40: by 2026-10-21 green macOS runs took 15.5-17 minutes on main-based PRs
  // and 19.95 minutes (3 s under the old bound) on the M2 T1 branch, while Ubuntu took 14.5. The
  // run is effectively serial: every project but the small pure ones sets maxWorkers: 1, Vitest
  // runs those projects one after another, and the per-file times add up to the wall time. So
  // each new scenario suite adds its full duration, and the M2 slices keep adding them. 40
  // minutes is twice the slowest green run. By #163 the unsharded macOS run took 27.8 minutes, so
  // check.yml now runs the gate as ciShardCount shard jobs per OS (scripts/ci-test-gate.mjs), and
  // this bound and those derived from it apply to each shard; a shard plans about 9 minutes of
  // that run. Add a shard rather than raising this when a shard's green runs approach 20 minutes.
  vitestMs: 40 * minute,
  // Native preparation, format, lint, build and the gate's file preparation inside
  // `pnpm check`. They have no bound of their own; this reserve is well above the observed 30 s.
  checkPreludeReserveMs: 5 * minute,
  // Parsing reports and writing evidence after the last gate command.
  checkFinalizeReserveMs: 1 * minute,
  // Runner actions (checkout, setup-node, pnpm, upload-artifact) have no bound we configure;
  // observed at most about 40 s together.
  jobActionsReserveMs: 5 * minute,
  // The aggregation of one OS's shard reports (`ci-test-gate.mjs --aggregate`), the step bound
  // in check.yml. It only reads and validates JSON and scans the checkout's test files.
  aggregateStepMs: 5 * minute,
});

// `pnpm check`: prelude, toolchain probe and discovery, vitest, source revision, finalization.
export const checkStageMs =
  ciTimeBudget.checkPreludeReserveMs +
  2 * ciTimeBudget.gateCommandMs +
  ciTimeBudget.vitestMs +
  ciTimeBudget.gateCommandMs +
  ciTimeBudget.checkFinalizeReserveMs;

// Each `check-shard` job: three setup steps, the `--environment` toolchain probe, the check stage
// and the runner actions. `.github/workflows/check.yml` must allow at least this long.
export const checkJobMinimumMs =
  2 * (ciTimeBudget.setupStageMs + ciTimeBudget.setupFinalizeReserveMs) +
  ciTimeBudget.browserStepMs +
  ciTimeBudget.gateCommandMs +
  checkStageMs +
  ciTimeBudget.jobActionsReserveMs;

// Each aggregating `check` job: the aggregation step and the runner actions (checkout,
// setup-node, artifact download and upload).
export const aggregateJobMinimumMs =
  ciTimeBudget.aggregateStepMs + ciTimeBudget.jobActionsReserveMs;

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
  timeoutMs = ciTimeBudget.setupStageMs,
  outputs = {},
) {
  if (stage === "check")
    return fileRecordedCheck(stage, binary, args, directory, cwd, timeoutMs, outputs);
  await mkdir(directory, { recursive: true });
  const startedAt = new Date();
  const attempt = {
    stage,
    argv: [binary, ...args],
    sourceSha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    status: "in-progress",
    startedAt: startedAt.toISOString(),
    deadline: new Date(startedAt.getTime() + timeoutMs).toISOString(),
    timeoutMs,
    exitCode: null,
    signal: null,
    errorCode: null,
    timedOut: false,
    // Raw streams are copied into files while the child runs, with no output-size cap.
    stdoutPath: `${stage}.stdout.bin`,
    stderrPath: `${stage}.stderr.bin`,
  };
  const metadata = join(directory, `${stage}.json`);
  // Publish the attempt before even opening output files or launching a subprocess. A workflow
  // cancellation can leave this record in-progress; it must never be interpreted as success.
  await writeFile(metadata, `${JSON.stringify(attempt, null, 2)}\n`, { flag: "wx" });
  const handles = [];
  let primary;
  let child;
  const custodyErrors = [];
  try {
    for (const path of [attempt.stdoutPath, attempt.stderrPath]) {
      handles.push(await filesystem.open(join(directory, path), "wx"));
    }
    const outcome = await new Promise((settle) => {
      let deadlineTimer;
      let killTimer;
      let finalTimer;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(deadlineTimer);
        clearTimeout(killTimer);
        clearTimeout(finalTimer);
        settle(result);
      };
      const signalGroup = (signal) => {
        (attempt.terminationSignals ??= []).push(signal);
        try {
          // A new group contains only this setup command and its descendants. Privileged apt
          // descendants can refuse these signals; record that uncertainty, do not wait forever.
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") {
            custodyErrors.push({
              phase: "termination",
              signal,
              code: error.code,
              message: error.message,
            });
          }
        }
      };
      try {
        child = spawn(binary, args, {
          cwd,
          detached: process.platform !== "win32",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish({ error });
        return;
      }
      attempt.childPid = child.pid ?? null;
      let outputFailure;
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.on("data", (chunk) => {
          if (outputFailure) return;
          try {
            let offset = 0;
            while (offset < chunk.length) {
              const written = writeSync(handles[index].fd, chunk, offset, chunk.length - offset);
              if (!written) throw new Error("Setup raw output write made no progress");
              offset += written;
            }
          } catch (error) {
            outputFailure = error;
            signalGroup("SIGKILL");
          }
        });
        stream.on("error", (error) => {
          outputFailure ??= error;
        });
      }
      child.once("error", (error) => finish({ error }));
      child.once("close", () => {
        if (!attempt.timedOut) finish({ error: outputFailure });
      });
      child.once("exit", (code, signal) => {
        attempt.exitCode = code;
        attempt.signal = signal;
        // On timeout allow the scheduled KILL to reach remaining group members even if the
        // immediate child has already exited. The final deadline closes descendant-held pipes.
      });
      deadlineTimer = setTimeout(() => {
        attempt.timedOut = true;
        signalGroup("SIGTERM");
        killTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          finalTimer = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish({
              error:
                outputFailure ??
                Object.assign(new Error(`${stage} timed out`), { code: "ETIMEDOUT" }),
            });
          }, 250);
        }, 250);
      }, timeoutMs);
    });
    primary = outcome.error;
    if (!primary && attempt.exitCode !== 0)
      primary = new Error(`${stage} exited ${attempt.exitCode}`);
  } catch (error) {
    primary = error;
  } finally {
    for (const handle of handles) {
      try {
        await handle.close();
      } catch (error) {
        custodyErrors.push({ phase: "close", code: error.code, message: error.message });
      }
    }
  }
  Object.assign(attempt, {
    status: primary || custodyErrors.length ? "failed" : "succeeded",
    finishedAt: new Date().toISOString(),
    errorCode: primary?.code ?? null,
    error: primary ? { name: primary.name, message: primary.message } : null,
    // Parent exit and closed output pipes do not prove privileged/detached descendants exited.
    // Runner teardown, not this controller, ultimately contains those processes.
    cleanup: attempt.terminationSignals?.length
      ? "unconfirmed-after-group-signals"
      : "not-inspected",
    custodyErrors,
  });
  try {
    await writeFile(metadata, `${JSON.stringify(attempt, null, 2)}\n`);
  } catch (error) {
    custodyErrors.push({ phase: "metadata", code: error.code, message: error.message });
    attempt.status = "failed";
  }
  // Do not replay output after completion; the raw files retain partial output on cancellation.
  // The raw files are the authoritative output and the workflow always uploads their directory.
  if (primary || custodyErrors.length) {
    const error = primary ?? new Error(`${stage} evidence could not be finalized`);
    error.ciOutputAttempt = attempt;
    throw error;
  }
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
    "--browser": ["browser", process.execPath, [join(root, "scripts/ci-ubuntu-archive.mjs")]],
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
    command === "--check" ? checkStageMs : ciTimeBudget.setupStageMs,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
