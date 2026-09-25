import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { loadSerializeAddon } from "./serialize-loader.js";

export interface EngineProbeResult {
  readonly nativeBinary: string;
  readonly nativeSha256: string;
  readonly nodeAbi: string;
  readonly nodeApi: string;
  readonly platform: string;
  readonly arch: string;
  readonly childExitCode: number;
  readonly childPid: number;
  readonly temporaryCwd: string;
  readonly roundTrip: string;
}

function waitForOutput(
  getOutput: () => string,
  subscribe: (wake: () => void) => () => void,
  marker: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`PTY output timed out awaiting ${marker}`));
    }, 5_000);
    const check = () => {
      if (!getOutput().includes(marker)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    unsubscribe = subscribe(check);
    check();
  });
}

async function writeTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

async function within<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runEnvironmentProbe(): Promise<EngineProbeResult> {
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
  const pty = require(process.env.COVE_PROBE_PTY_MODULE ?? "node-pty") as typeof import("node-pty");
  const nativeBinary = Object.keys(require.cache).find((path) => path.endsWith(".node"));
  if (!nativeBinary) throw new Error("node-pty native binary did not load");
  const nativeSha256 = createHash("sha256")
    .update(await readFile(nativeBinary))
    .digest("hex");
  let cwd: string | undefined;
  let terminal: HeadlessTerminal | undefined;
  let replay: HeadlessTerminal | undefined;
  let addon: ReturnType<typeof loadSerializeAddon> | undefined;
  let child: import("node-pty").IPty | undefined;
  let exitPromise: Promise<{ exitCode: number }> | undefined;
  let output = "";
  const listeners = new Set<() => void>();
  let exited = false;
  let primaryError: unknown;
  let record: EngineProbeResult | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), "cove-engine-probe-"));
    terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    replay = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    addon = loadSerializeAddon();
    terminal.loadAddon(addon as never);
    const childPath =
      process.env.COVE_PROBE_CHILD_PATH ??
      fileURLToPath(new URL("./pty-child.js", import.meta.url));
    child = pty.spawn(process.execPath, [childPath], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, COVE_PROBE: "1" },
    });
    child.onData((data) => {
      output += data;
      if (output.length > 16_384) output = output.slice(-16_384);
      for (const listener of listeners) listener();
    });
    exitPromise = new Promise<{ exitCode: number }>((resolve) =>
      child?.onExit((event) => {
        exited = true;
        resolve(event);
      }),
    );
    const wait = (marker: string) =>
      waitForOutput(
        () => output,
        (wake) => {
          listeners.add(wake);
          return () => listeners.delete(wake);
        },
        marker,
      );
    await wait("READY");
    const nonce = randomBytes(16).toString("hex");
    const digest = createHash("sha256").update(nonce).digest("hex").slice(0, 16);
    child.write(`PING ${nonce}\n`);
    await wait(`ACK ${digest}`);
    child.resize(92, 31);
    child.write("SIZE\n");
    await wait("SIZE 92 31");
    child.write("EXIT\n");
    await wait("BYE");
    const result = await within(exitPromise, 5_000, "PTY exit");
    if (result.exitCode !== 23) throw new Error(`Unexpected PTY exit ${result.exitCode}`);
    await writeTerminal(terminal, "Cove probe\r\nREADY");
    const serialized = addon.serialize();
    await writeTerminal(replay, serialized);
    const line = replay.buffer.active.getLine(1)?.translateToString(true);
    if (
      line !== "READY" ||
      replay.buffer.active.cursorX !== terminal.buffer.active.cursorX ||
      replay.buffer.active.cursorY !== terminal.buffer.active.cursorY
    ) {
      throw new Error("Headless serialize round trip disagrees on line or cursor");
    }
    record = {
      nativeBinary: await realpath(nativeBinary),
      nativeSha256,
      nodeAbi: process.versions.modules,
      nodeApi: process.versions.napi ?? "unavailable",
      platform: process.platform,
      arch: process.arch,
      childExitCode: result.exitCode,
      childPid: child.pid,
      temporaryCwd: cwd,
      roundTrip: line,
    };
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (child && !exited) {
    try {
      child.kill();
      if (exitPromise) await within(exitPromise, 2_000, "PTY cleanup");
      if (!exited) throw new Error("PTY child exit was not observed during cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const resource of [addon, terminal, replay]) {
    try {
      resource?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cwd) {
    try {
      await rm(cwd, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length) console.error("Probe cleanup failed:", cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Probe cleanup failed");
  if (!record) throw new Error("Probe produced no result");
  return record;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runEnvironmentProbe()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
