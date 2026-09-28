import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { until } from "./pipe-harness.mjs";

const rowPattern =
  /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

export function parseFifoReaderRow(raw, owner) {
  if (typeof raw !== "string" || raw.includes("\n"))
    return { kind: "unverifiable", raw, reason: "missing-or-multiple-rows" };
  const match = rowPattern.exec(raw.trim());
  if (!match || Number(match[1]) !== owner.child.pid)
    return { kind: "unverifiable", raw, reason: "malformed-or-wrong-pid" };
  const [, , started, commandLine] = match;
  const argv = [owner.entry, ...owner.args].join(" ");
  const commands = [process.execPath, realpathSync(process.execPath), "node"].map(
    (executable) => `${executable} ${argv}`,
  );
  if (!commands.includes(commandLine))
    return { kind: "unverifiable", raw, reason: "unrelated-argv" };
  return { kind: "owned", pid: owner.child.pid, started, commandLine, raw };
}

export function observeFifoReader(owner) {
  try {
    const raw = execFileSync(
      "/bin/ps",
      ["-p", String(owner.child.pid), "-o", "pid=", "-o", "lstart=", "-o", "command="],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 2000 },
    ).trim();
    return parseFifoReaderRow(raw, owner);
  } catch (error) {
    if (error.status === 1) return { kind: "absent", pid: owner.child.pid };
    return {
      kind: "unverifiable",
      pid: owner.child.pid,
      reason: `ps-error:${error.code ?? error.status ?? "unknown"}`,
    };
  }
}

const sameReader = (owner, fresh) =>
  owner.initialObservation?.kind === "owned" &&
  fresh.kind === "owned" &&
  fresh.pid === owner.initialObservation.pid &&
  fresh.started === owner.initialObservation.started &&
  fresh.commandLine === owner.initialObservation.commandLine;

const sampleReader = (owner) => {
  try {
    return owner.observe(owner);
  } catch (error) {
    return {
      kind: "unverifiable",
      pid: owner.child.pid,
      reason: `observer-error:${error.code ?? error.name ?? "unknown"}`,
    };
  }
};

const beforeDeadline = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

function acquireFifoReader(entry, args, nonce, observe) {
  if (!args.includes(nonce)) throw Error("FIFO reader nonce missing from argv");
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const owner = {
    child,
    entry,
    args,
    nonce,
    messages: [],
    errors: [],
    stderr: [],
    stage: "spawned",
  };
  owner.exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  child.on("error", (error) => owner.errors.push({ name: error.name, message: error.message }));
  child.on("message", (message) => owner.messages.push(message));
  child.stderr?.on("data", (bytes) => owner.stderr.push(Buffer.from(bytes)));
  owner.observe = observe ?? observeFifoReader;
  owner.firstObservation = sampleReader(owner);
  return owner;
}

export async function waitFifoReaderHandshake(owner, ms = 8000) {
  return until(
    () => {
      if (owner.errors.length) throw Error(`FIFO reader error: ${JSON.stringify(owner.errors)}`);
      return owner.messages.find(
        (message) =>
          message?.nonce === owner.nonce &&
          message?.pid === owner.child.pid &&
          message?.state === "fifo-open-unread",
      );
    },
    ms,
    "FIFO reader open timeout",
  );
}

async function closeFifoReader(owner) {
  if (!owner) return { kind: "not-spawned" };
  const fresh = sampleReader(owner);
  owner.cleanupObservation = fresh;
  if (fresh.kind === "absent")
    return {
      kind:
        owner.child.exitCode !== null || owner.child.signalCode !== null
          ? "exited"
          : "unverifiable",
      fresh,
      signalSent: false,
    };
  if (!sameReader(owner, fresh)) {
    if (owner.child.connected) owner.child.disconnect();
    return { kind: "unverifiable", fresh, signalSent: false };
  }
  if (!owner.child.kill("SIGTERM")) return { kind: "unverifiable", fresh, signalSent: false };
  try {
    await beforeDeadline(owner.exit, 5000, "FIFO reader SIGTERM deadline");
  } catch {
    const retry = sampleReader(owner);
    if (!sameReader(owner, retry)) return { kind: "unverifiable", fresh: retry, signalSent: true };
    if (!owner.child.kill("SIGKILL"))
      return { kind: "unverifiable", fresh: retry, signalSent: true };
    await beforeDeadline(owner.exit, 5000, "FIFO reader SIGKILL deadline");
  }
  return { kind: "exited", fresh: sampleReader(owner), signalSent: true };
}

export async function withOwnedFifoReader({
  entry,
  args,
  nonce,
  observe,
  setup,
  cleanupResources,
  preserve,
}) {
  let owner;
  let result;
  let primary;
  const cleanupErrors = [];
  const record = (stage) => {
    try {
      preserve?.(stage, { owner, primary, cleanupErrors });
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    owner = acquireFifoReader(entry, args, nonce, observe);
    owner.initialObservation = await until(
      () => {
        const current = sampleReader(owner);
        if (current.kind === "owned") return current;
        if (owner.errors.length || owner.child.exitCode !== null || owner.child.signalCode !== null)
          throw Error(`FIFO reader identity unavailable: ${JSON.stringify(current)}`);
        return null;
      },
      2000,
      "FIFO reader initial identity",
    );
    owner.stage = "identified";
    result = await setup(owner);
  } catch (error) {
    primary = error;
  } finally {
    record("before-cleanup");
    try {
      await cleanupResources?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (owner) {
        owner.cleanupVerdict = await closeFifoReader(owner);
        if (owner.cleanupVerdict.kind === "unverifiable")
          cleanupErrors.push(Error("FIFO reader cleanup identity uncertain"));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    record("after-cleanup");
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "FIFO reader setup and/or cleanup failed",
    );
  if (primary) throw primary;
  return result;
}
