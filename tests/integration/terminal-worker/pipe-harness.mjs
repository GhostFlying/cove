import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createPipeDecoder,
  encodePipeFrame,
  validatePipeFrame,
} from "../../../packages/protocol/dist/pipe.js";
import { M0_LIMITS } from "../../../packages/protocol/dist/budgets.js";
import { PROFILE, DEFAULT_APPEARANCE } from "../../../packages/protocol/dist/profile.js";

export const worker = {
  serverId: "qualification",
  relayInstanceId: "local",
  workerId: "worker",
  workerIncarnationId: "one",
};
export const geometry = { cols: 80, rows: 24 };
export const budgets = M0_LIMITS;
export const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const fixture = fileURLToPath(new URL("./fixtures/pty-child.mjs", import.meta.url));
export const run = (id) => ({
  serverId: worker.serverId,
  relayInstanceId: worker.relayInstanceId,
  runId: id,
});
export const subscription = (target) => ({
  run: target,
  connection: { connectionId: "connection", generation: 1 },
  subscriptionId: "subscription",
  viewId: "view",
});
export const command = (type, target, extra = {}) => ({
  type,
  worker,
  run: target,
  requestId: randomUUID(),
  ...extra,
});
export const hello = {
  type: "hello",
  worker,
  pipeVersion: 2,
  buildVersion: "qualification",
  effectiveBudgets: budgets,
};
export const encode = (metadata, payload = new Uint8Array()) => {
  const result = encodePipeFrame(1, Buffer.from(JSON.stringify(metadata)), payload);
  if (!result.ok) throw Error(result.error.code);
  return Buffer.from(result.value);
};
export const spawnCommand = (target, executable, argv, cwd) => {
  const payload = Buffer.from(JSON.stringify({ executable, argv, cwd }));
  return {
    metadata: command("spawn", target, {
      operationId: randomUUID(),
      geometry,
      profile: PROFILE,
      appearance: DEFAULT_APPEARANCE,
      effectiveBudgets: budgets,
      spawnPayloadBytes: payload.length,
    }),
    payload,
  };
};
export const until = async (predicate, ms = 8000, label = "condition") => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(`timeout: ${label}`);
};
export const psIdentity = (pid) => {
  try {
    const value = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="],
      { encoding: "utf8" },
    ).trim();
    return value || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
};
const workerEntry = join(repo, "packages/terminal-worker/dist/src/main.js");
const startPattern =
  /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

export function workerIdentityAnchors(bin, resolveEntry = realpathSync, entry = workerEntry) {
  try {
    return { installed: resolveEntry(bin), compiled: resolveEntry(entry) };
  } catch (error) {
    return { error: `${error.code ?? error.name ?? "unknown"}: ${error.message}` };
  }
}

export function parseWorkerProcessRow(
  raw,
  pid,
  bin,
  { resolveEntry = realpathSync, anchors = workerIdentityAnchors(bin, resolveEntry) } = {},
) {
  if (typeof raw !== "string" || raw.includes("\n"))
    return { kind: "unverifiable", raw, reason: "missing-or-multiple-rows" };
  const match = startPattern.exec(raw.trim());
  if (!match || Number(match[1]) !== pid)
    return { kind: "unverifiable", raw, reason: "malformed-or-wrong-pid" };
  const [, , started, commandLine] = match;
  const base = { pid, started, commandLine, raw };
  if (commandLine === "(sh)" || commandLine === "(bash)")
    return { kind: "unverifiable", ...base, reason: "pre-exec-shell" };
  if (anchors.error || !anchors.installed || !anchors.compiled)
    return {
      kind: "unverifiable",
      ...base,
      reason: "expected-anchor-unavailable",
      anchorError: anchors.error,
    };
  let form;
  let candidate;
  for (const prefix of ["/bin/sh ", "/usr/bin/env sh "]) {
    if (!commandLine.startsWith(prefix)) continue;
    form = "installed-shim";
    candidate = commandLine.slice(prefix.length);
    break;
  }
  if (!form)
    for (const prefix of [`${process.execPath} `, `${realpathSync(process.execPath)} `, "node "]) {
      if (!commandLine.startsWith(prefix)) continue;
      form = "compiled-entry";
      candidate = commandLine.slice(prefix.length);
      break;
    }
  if (!form && commandLine.startsWith("/")) {
    form = "installed-shim";
    candidate = commandLine;
  }
  if (!form || !candidate || candidate.includes(" "))
    return { kind: "unverifiable", ...base, reason: "unrelated-argv" };
  try {
    const canonical = resolveEntry(candidate);
    const expected = form === "installed-shim" ? anchors.installed : anchors.compiled;
    if (canonical === expected) return { kind: "owned", ...base, form, canonical, expected };
    return { kind: "unverifiable", ...base, reason: "unrelated-argv", canonical, expected };
  } catch (error) {
    return {
      kind: "unverifiable",
      ...base,
      reason: "candidate-resolution-failed",
      resolutionError: `${error.code ?? error.name ?? "unknown"}: ${error.message}`,
    };
  }
}

export function observeWorkerProcess(pid, bin, options = {}) {
  const requestedTimeout = options.timeoutMs ?? 2000;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout < 1)
    throw RangeError(`invalid worker observation timeout: ${requestedTimeout}`);
  const timeout = Math.min(2000, Math.floor(requestedTimeout));
  try {
    const raw = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        timeout,
      },
    ).trim();
    return parseWorkerProcessRow(raw, pid, bin, options);
  } catch (error) {
    if (error.status === 1) return { kind: "absent", pid, raw: error.stdout ?? "" };
    return {
      kind: "unverifiable",
      pid,
      raw: error.stdout ?? "",
      reason: `ps-error:${error.code ?? error.status ?? "unknown"}`,
    };
  }
}

export function sameOwnedWorker(initial, current) {
  return (
    initial?.kind === "owned" &&
    current?.kind === "owned" &&
    initial.pid === current.pid &&
    initial.started === current.started
  );
}

const sampleWorker = (observe, pid, bin, timeoutMs) => {
  try {
    return observe(pid, bin, timeoutMs);
  } catch (error) {
    return {
      kind: "unverifiable",
      pid,
      reason: `observer-error:${error.code ?? error.name ?? "unknown"}`,
    };
  }
};

const startupTick = (child, ms) =>
  new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      child.off("error", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    child.once("exit", done);
    child.once("error", done);
  });

export async function admitWorkerStartup(harness, { deadlineMs = 8000 } = {}) {
  const deadline = (harness.spawnAt ?? performance.now()) + Math.min(deadlineMs, 8000);
  harness.startupSamples = [];
  harness.startupState = "pending";
  harness.startupDeadlineMs = Math.min(deadlineMs, 8000);
  let observation = harness.firstObservation;
  let birth;
  try {
    if (harness.collectorError) throw Error("worker acquisition receipt failed");
    for (let sample = 0; sample < 128; sample++) {
      if (performance.now() > deadline) throw Error("worker startup admission deadline");
      if (
        harness.errors.length ||
        harness.exitObserved ||
        harness.child.exitCode !== null ||
        harness.child.signalCode !== null
      )
        throw Error("worker exited or errored during startup admission");
      harness.startupSamples.push(observation);
      if (Number.isInteger(observation?.pid) && typeof observation.started === "string") {
        if (!birth) birth = { pid: observation.pid, started: observation.started };
        else if (birth.pid !== observation.pid || birth.started !== observation.started)
          throw Error("worker birth changed during startup admission");
        harness.provisionalBirth = birth;
      }
      if (observation?.kind === "owned" && observation.form === "compiled-entry") {
        if (!birth) throw Error("worker compiled entry has no birth identity");
        harness.initialObservation = observation;
        harness.admittedObservation = observation;
        harness.identity = observation.raw;
        harness.startupState = "admitted";
        return observation;
      }
      const pending =
        (observation?.kind === "owned" && observation.form === "installed-shim") ||
        observation?.reason === "pre-exec-shell" ||
        observation?.kind === "absent" ||
        observation?.reason?.startsWith("ps-error:");
      if (!pending) throw Error(`worker startup identity rejected: ${JSON.stringify(observation)}`);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw Error("worker startup admission deadline");
      await startupTick(harness.child, Math.min(50, remaining));
      const beforeSample = deadline - performance.now();
      if (beforeSample <= 0) throw Error("worker startup admission deadline");
      const sampleBudget = Math.min(2000, Math.floor(beforeSample));
      if (sampleBudget < 1) throw Error("worker startup admission deadline");
      observation = sampleWorker(harness.observe, harness.child.pid, harness.bin, sampleBudget);
    }
    throw Error("worker startup observation budget exhausted");
  } catch (error) {
    harness.startupState = "failed";
    harness.startupFailure = { name: error.name, message: error.message };
    harness.startupFailureObservation = observation;
    throw error;
  }
}

export async function startWorkerPipe(harness, helloFrame = hello, options) {
  if (harness.helloWrite?.attempted) throw Error("worker hello already attempted");
  await admitWorkerStartup(harness, options);
  let complete;
  let reject;
  let settled = false;
  const completion = new Promise((resolve, fail) => {
    complete = resolve;
    reject = fail;
  });
  void completion.catch(() => {});
  const attempt = (harness.helloWrite = {
    status: "pending",
    attempted: false,
    returned: null,
    failure: null,
  });
  const fail = (error, phase) => {
    if (settled) return;
    settled = true;
    attempt.status = "failed";
    attempt.failure = {
      name: error.name,
      code: error.code ?? null,
      message: error.message,
      phase,
    };
    reject(error);
  };
  const succeed = () => {
    if (settled) return;
    settled = true;
    attempt.status = "completed";
    complete();
  };
  const childExited = () =>
    fail(Error("worker exited before hello write completion"), "child-exit");
  const stdinClosed = () =>
    fail(Error("worker stdin closed before hello write completion"), "stdin-close");
  harness.pendingHelloWrite = { fail };
  harness.child.once("exit", childExited);
  (harness.input ?? harness.child.stdin).once("close", stdinClosed);
  const waitMs = Math.min(8000, Math.max(1, options?.helloWriteMs ?? 8000));
  const timer = setTimeout(
    () =>
      fail(
        Object.assign(Error("worker hello write completion deadline"), { code: "ETIMEDOUT" }),
        "completion-timeout",
      ),
    waitMs,
  );
  try {
    workerExecIdentity(harness);
    attempt.attempted = true;
    attempt.returned = harness.send(helloFrame, undefined, (error) => {
      if (error) fail(error, "write-callback");
      else succeed();
    });
    await completion;
  } catch (error) {
    fail(error, attempt.attempted ? "write-call" : "pre-hello-proof");
    harness.startupState = "failed";
    harness.startupFailure = { ...attempt.failure };
    harness.startupFailureObservation = attempt.attempted
      ? null
      : (harness.lastObservation ?? null);
    throw error;
  } finally {
    clearTimeout(timer);
    harness.child.off("exit", childExited);
    (harness.input ?? harness.child.stdin).off("close", stdinClosed);
    harness.pendingHelloWrite = null;
  }
}

export function verifyWorkerIdentity(harness) {
  const current = sampleWorker(harness.observe, harness.child.pid, harness.bin);
  harness.lastObservation = current;
  if (harness.collectorError || !sameOwnedWorker(harness.initialObservation, current))
    throw Error(
      `worker identity uncertain: initial=${JSON.stringify(harness.initialObservation)}, current=${JSON.stringify(current)}`,
    );
  return current;
}

export function workerExecIdentity(harness) {
  const current = verifyWorkerIdentity(harness);
  if (
    current.form !== "compiled-entry" ||
    (harness.provisionalBirth &&
      (current.pid !== harness.provisionalBirth.pid ||
        current.started !== harness.provisionalBirth.started)) ||
    (harness.expectedAnchors && current.canonical !== harness.expectedAnchors.compiled)
  )
    throw Error(`worker exec identity uncertain: current=${JSON.stringify(current)}`);
  return current.raw;
}

export function signalVerifiedWorkerExec(harness, signal) {
  workerExecIdentity(harness);
  harness.signalObservation = harness.lastObservation;
  harness.child.kill(signal);
  return harness.signalObservation;
}

export function installedBin() {
  const temp = mkdtempSync(join(tmpdir(), "cove-qual-bin-"));
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      name: "cove-qualification-bin",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { "@cove/terminal-worker": `link:${join(repo, "packages/terminal-worker")}` },
    }),
  );
  try {
    execFileSync(
      "pnpm",
      ["install", "--offline", "--ignore-scripts", "--reporter", "append-only"],
      {
        cwd: temp,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return {
    bin: join(temp, "node_modules/.bin/cove-terminal-worker"),
    consumerRoot: temp,
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

export async function receipt(path, label = path) {
  const { readFileSync } = await import("node:fs");
  return until(
    () => {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    8000,
    label,
  );
}

export async function stopPtyIfOwned(start, nonce) {
  if (!start) return;
  if (start.nonce !== nonce || !Number.isInteger(start.pid))
    throw Error("PTY receipt identity invalid");
  const current = psIdentity(start.pid);
  if (!current) return;
  if (!current.includes(nonce) || !current.includes("pty-child.mjs"))
    throw Error(`PTY owner uncertain: ${current}`);
  process.kill(start.pid, "SIGHUP");
  try {
    await until(() => !psIdentity(start.pid), 5000, "PTY SIGHUP exit");
  } catch {
    const after = psIdentity(start.pid);
    if (after === current) process.kill(start.pid, "SIGKILL");
    await until(() => !psIdentity(start.pid), 5000, "PTY SIGKILL exit");
  }
}

export function childPipe(
  bin,
  nonce,
  { observe = observeWorkerProcess, evidencePath, expectedEntry = workerEntry, input } = {},
) {
  const expectedAnchors = workerIdentityAnchors(bin, realpathSync, expectedEntry);
  const boundObserve =
    observe === observeWorkerProcess
      ? (pid, path, timeoutMs) =>
          observeWorkerProcess(pid, path, { anchors: expectedAnchors, timeoutMs })
      : observe;
  const spawnAt = performance.now();
  const child = spawn(bin, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COVE_QUALIFICATION_NONCE: nonce },
  });
  const stdin = input ?? child.stdin;
  const decoder = createPipeDecoder();
  const frames = [];
  const stderr = [];
  const rawSizes = [];
  const errors = [];
  const stdinErrors = [];
  let harness;
  child.on("error", (error) => {
    errors.push({
      name: error.name,
      code: error.code ?? null,
      message: error.message,
      source: "child",
    });
    harness?.pendingHelloWrite?.fail(error, "child-error");
  });
  stdin.on("error", (error) => {
    const pendingHello =
      harness?.helloWrite?.status !== "completed" ? harness?.pendingHelloWrite : null;
    const row = {
      name: error.name,
      code: error.code ?? null,
      message: error.message,
      phase: pendingHello ? "hello-write" : "command-or-cleanup",
    };
    stdinErrors.push(row);
    errors.push({ ...row, source: "stdin" });
    pendingHello?.fail(error, "stdin-error");
  });
  child.stdout.on("data", (chunk) => {
    rawSizes.push(chunk.length);
    let offset = 0;
    while (offset < chunk.length) {
      const result = decoder.read(chunk.subarray(offset));
      if (result.status === "error" || result.consumedBytes <= 0) {
        errors.push({ name: "DecodeError", message: JSON.stringify(result.error) });
        return;
      }
      offset += result.consumedBytes;
      for (const frame of result.frames) {
        let metadata;
        try {
          metadata = JSON.parse(Buffer.from(frame.metadata).toString("utf8"));
        } catch (error) {
          errors.push({ name: error.name, message: error.message });
          return;
        }
        const valid = validatePipeFrame(frame, metadata);
        if (!valid.ok) {
          errors.push({ name: "MetadataError", message: valid.error.code });
          return;
        }
        frames.push({ metadata, payload: Buffer.from(frame.payload), kind: frame.kind });
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      if (harness) harness.exitObserved = true;
      resolve({ code, signal });
    }),
  );
  const send = (metadata, payload, onComplete) =>
    stdin.write(encode(metadata, payload), onComplete);
  const wait = (predicate, label) =>
    until(
      () => {
        if (errors.length) throw Error(`worker child error: ${JSON.stringify(errors)}`);
        return frames.find((frame) => predicate(frame.metadata, frame));
      },
      8000,
      label,
    );
  const initialObservation = child.pid
    ? sampleWorker(boundObserve, child.pid, bin)
    : { kind: "unverifiable", reason: "spawn-without-pid" };
  harness = {
    child,
    input: stdin,
    bin,
    nonce,
    observe: boundObserve,
    expectedAnchors,
    spawnAt,
    firstObservation: initialObservation,
    initialObservation,
    lastObservation: initialObservation,
    identity: initialObservation.raw ?? null,
    frames,
    rawSizes,
    stderr,
    errors,
    stdinErrors,
    exit,
    send,
    wait,
  };
  try {
    preserveWorkerHarness(harness, evidencePath, "acquired");
  } catch (error) {
    harness.collectorError = { name: error.name, message: error.message };
  }
  return harness;
}

export function workerHarnessSnapshot(harness, error) {
  const { child } = harness;
  return structuredClone({
    nonce: harness.nonce,
    pid: child.pid ?? null,
    initialObservation: harness.initialObservation,
    firstObservation: harness.firstObservation,
    provisionalBirth: harness.provisionalBirth ?? null,
    admittedObservation: harness.admittedObservation ?? null,
    startupState: harness.startupState ?? null,
    startupFailure: harness.startupFailure ?? null,
    startupFailureObservation: harness.startupFailureObservation ?? null,
    helloWrite: harness.helloWrite ?? null,
    stdinErrors: harness.stdinErrors ?? [],
    cleanupProofs: harness.cleanupProofs ?? [],
    cleanupSignals: harness.cleanupSignals ?? [],
    cleanupFailure: harness.cleanupFailure ?? null,
    startupDeadlineMs: harness.startupDeadlineMs ?? null,
    spawnAt: harness.spawnAt ?? null,
    startupSamples: harness.startupSamples ?? [],
    expectedAnchors: harness.expectedAnchors,
    currentObservation: child.pid ? sampleWorker(harness.observe, child.pid, harness.bin) : null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    exitObserved: harness.exitObserved ?? false,
    stderrHex: Buffer.concat(harness.stderr).toString("hex"),
    errors: harness.errors,
    failure: error && { name: error.name, message: error.message },
  });
}

export function composeWorkerReceipt(harness, details, error) {
  return { ...details, workerHarness: harness ? workerHarnessSnapshot(harness, error) : null };
}

export function preserveWorkerHarness(harness, evidencePath, stage, error) {
  if (!evidencePath) return;
  writeFileSync(
    join(evidencePath, `${stage}.json`),
    JSON.stringify(workerHarnessSnapshot(harness, error), null, 2) + "\n",
  );
}

export async function stopVerified(harness) {
  const { child } = harness;
  if (harness.exitObserved || child.exitCode !== null || child.signalCode !== null) return;
  const proof = (signal) => {
    const current = sampleWorker(harness.observe, child.pid, harness.bin);
    harness.lastObservation = current;
    const birth =
      harness.provisionalBirth ??
      harness.admittedObservation ??
      (harness.firstObservation?.kind === "owned" ? harness.firstObservation : null);
    const anchorsAgree = [
      harness.provisionalBirth,
      harness.admittedObservation,
      harness.firstObservation?.kind === "owned" ? harness.firstObservation : null,
    ]
      .filter(Boolean)
      .every((anchor) => anchor.pid === birth?.pid && anchor.started === birth?.started);
    const authorized =
      birth !== null &&
      anchorsAgree &&
      sameOwnedWorker({ ...birth, kind: "owned" }, current) &&
      current.form === "compiled-entry" &&
      (!harness.expectedAnchors || current.canonical === harness.expectedAnchors.compiled);
    (harness.cleanupProofs ??= []).push({ signal, observation: current, authorized });
    return authorized;
  };
  const eof = async () => {
    let descriptorError;
    try {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    } catch (error) {
      descriptorError = error;
    }
    try {
      await until(
        () => harness.exitObserved || child.exitCode !== null || child.signalCode !== null,
        2000,
        "worker EOF exit",
      );
    } catch (error) {
      const failure = Error(
        `cleanup identity uncertain: observation=${JSON.stringify(harness.lastObservation)}`,
        { cause: error },
      );
      if (descriptorError) failure.descriptorError = descriptorError;
      throw failure;
    }
    if (descriptorError) throw descriptorError;
  };
  try {
    if (!proof("SIGTERM")) {
      await eof();
      return;
    }
    child.kill("SIGTERM");
    (harness.cleanupSignals ??= []).push("SIGTERM");
    try {
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        5000,
        "worker exit after SIGTERM",
      );
    } catch {
      if (!proof("SIGKILL")) {
        await eof();
        return;
      }
      child.kill("SIGKILL");
      (harness.cleanupSignals ??= []).push("SIGKILL");
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        5000,
        "worker exit after SIGKILL",
      );
    }
  } catch (error) {
    harness.cleanupFailure = { name: error.name, message: error.message };
    throw error;
  }
}
