import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
const processStamp = (identity) => identity?.split(/\s{2,}/)[0];
const sameOwnedWorker = (initial, current) => {
  const tempTag = initial?.match(/cove-qual-(?:bin|consumer)-[^/]+/)?.[0];
  return (
    !!tempTag &&
    !!processStamp(initial) &&
    processStamp(initial) === processStamp(current) &&
    current.includes(tempTag) &&
    (current.includes("/.bin/cove-terminal-worker") ||
      current.includes("/packages/terminal-worker/dist/src/main.js"))
  );
};

export function workerExecIdentity(harness) {
  const current = psIdentity(harness.child.pid);
  if (
    !sameOwnedWorker(harness.identity, current) ||
    !current.includes("/packages/terminal-worker/dist/src/main.js")
  )
    throw Error(`worker exec identity uncertain: initial=${harness.identity}, current=${current}`);
  return current;
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

export function childPipe(bin, nonce) {
  const child = spawn(bin, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, COVE_QUALIFICATION_NONCE: nonce },
  });
  if (!child.pid) throw Error("compiled child did not start");
  const identity = psIdentity(child.pid);
  if (!identity || !identity.includes("cove-terminal-worker"))
    throw Error(`unverified worker identity: ${identity}`);
  const decoder = createPipeDecoder();
  const frames = [];
  const stderr = [];
  const rawSizes = [];
  child.stdout.on("data", (chunk) => {
    rawSizes.push(chunk.length);
    let offset = 0;
    while (offset < chunk.length) {
      const result = decoder.read(chunk.subarray(offset));
      if (result.status === "error" || result.consumedBytes <= 0)
        throw Error(`invalid child frame: ${JSON.stringify(result.error)}`);
      offset += result.consumedBytes;
      for (const frame of result.frames) {
        const metadata = JSON.parse(Buffer.from(frame.metadata).toString("utf8"));
        const valid = validatePipeFrame(frame, metadata);
        if (!valid.ok) throw Error(`invalid child metadata: ${valid.error.code}`);
        frames.push({ metadata, payload: Buffer.from(frame.payload), kind: frame.kind });
      }
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const send = (metadata, payload) => child.stdin.write(encode(metadata, payload));
  const wait = (predicate, label) =>
    until(() => frames.find((frame) => predicate(frame.metadata, frame)), 8000, label);
  return { child, identity, frames, rawSizes, stderr, exit, send, wait };
}

export async function stopVerified(harness) {
  const { child, identity } = harness;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const current = psIdentity(child.pid);
  if (sameOwnedWorker(identity, current)) {
    child.kill("SIGTERM");
    try {
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        5000,
        "worker exit after SIGTERM",
      );
    } catch {
      if (sameOwnedWorker(identity, psIdentity(child.pid))) child.kill("SIGKILL");
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        5000,
        "worker exit after SIGKILL",
      );
    }
  } else if (current) {
    throw Error(`cleanup identity uncertain: initial=${identity}, current=${current}`);
  }
}
