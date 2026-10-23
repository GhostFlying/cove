import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
  binaryIdentity,
  DIAL_PROTOCOL,
  TsnetBinaryError,
  type BinaryIdentity,
} from "./tsnet-binary.js";
import { readTsnetConfig } from "./tsnet-config.js";

// The CLI side of the per-user `cove-tsnet dial` daemon (m2 D14; the socket protocol is
// native/tailscale/PROTOCOL.md). The daemon owns the client's tailnet node in
// `<home>/tsnet-client/`; every tsnet command reaches it over `<home>/tsnet-client/run/dial.sock`
// (0600 in a 0700 directory: whoever can connect is the owner, D7) and asks for one thing per
// connection: `hello`, then at most one request (status, login, logout, stop, or dial, after which
// the connection is the raw stream).
//
// Start and readiness (D14 "崩溃恢复与启动竞争"). Ownership is decided by the daemon's kernel lock
// on `run/lock`, not by whether the socket file exists: a daemon can hold the lock with no socket
// (starting, or idle-exiting after it unlinked the socket and before the lock is released), and a
// socket file can exist with no daemon behind it (after SIGKILL). The CLI therefore never treats a
// lost start race as proof that a ready daemon is coming. Within one total deadline (10 s) it loops:
// connect to the socket and exchange `hello`; on any failure (no socket, refused, closed before the
// hello answer, which is how a daemon that just decided to exit idle answers) start a detached
// daemon unless one this command started is still running, back off briefly, and try again. A
// started daemon that exits with 75 lost the lock to another one and only means "someone else
// holds it right now"; one that exits 0 (stopped by a concurrent command, or idle before this one
// connected) or is killed by a signal is started again as well; one that exits 1 or 2 failed for a reason it wrote to its log (bad
// permissions, a socket path that is too long), which retrying cannot fix, so that ends the loop at
// once. When the deadline passes the command fails with ENTRY_UNAVAILABLE and the daemon's log
// tail, and nothing was requested of any daemon. This loop is the only retry: it runs before any
// request is sent. Once a request has been sent (a login, or a stream whose bytes reach the
// server) a broken connection is reported as such and never repeated.
//
// Versions (D14 "升级与版本不符"). "The current build" is the build of the executable this CLI
// would start (`cove-tsnet version`), since that is what replacing a daemon produces. After the
// hello:
// - same build: use it;
// - another build and no active streams: ask it to `stop` (frozen across versions, so any daemon
//   can be replaced) and go round the loop, which starts the current build. The daemon unlinks its
//   socket before it answers, so the reconnect never reaches the exiting daemon; while it still
//   holds the lock a new daemon exits 75 and the loop simply goes on;
// - another build with active streams: it is never replaced while it carries someone's work. With
//   the same local protocol the command uses it and warns on stderr; with another protocol the
//   command fails with the streams listed and the way out (wait, or `remote tsnet stop --yes`).
// A stream that appears between the hello and the stop makes the stop fail with ACTIVE_STREAMS and
// change nothing; the loop then sees the stream in the next hello.
//
// The daemon is started detached (its own session, stdin and stdout on /dev/null, stderr appended
// to `run/dial.log`), so it outlives the command and is not part of the terminal's job; it exits by
// itself after its idle timeout (D14; `remote tsnet config`). It writes only stream IDs, stable node
// IDs and ports to its log, never an auth key or login URL (it runs without --verbose).

const START_DEADLINE_MS = 10_000;
const BACKOFF_MIN_MS = 25;
const BACKOFF_MAX_MS = 400;
const CONNECT_TIMEOUT_MS = 2_000;
const HELLO_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;
const OWNED_MIN_TIMEOUT_MS = 500;
export const MAX_FRAME_BYTES = 64 * 1024;
// sockaddr_un.sun_path is 104 bytes on macOS (108 on Linux), including the terminator.
const MAX_SOCKET_PATH_BYTES = 103;
const LOG_ROTATE_BYTES = 1 << 20;
const DIAGNOSTIC_BYTES = 2_000;

export type StreamInfo = {
  readonly id: string;
  readonly stableNodeID: string;
  readonly port: number;
  readonly label?: string;
  readonly startedAt: string;
};

export type Hello = {
  readonly protocol: number;
  readonly build: string;
  readonly mode: string;
  readonly pid: number;
  readonly streams: readonly StreamInfo[];
};

// An error answer of the daemon to a request.
export class DialError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly streams: readonly StreamInfo[] = [],
  ) {
    super(`${detail} (${code})`);
  }
}

// No usable daemon could be reached; nothing was requested of any daemon.
export class DaemonUnavailable extends Error {}

// Text from the daemon (its messages may quote the control plane) reduced to bounded printable
// ASCII before it is shown.
export function printable(text: unknown, limit = 512): string {
  return String(text)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, limit);
}

export function describeStreams(streams: readonly StreamInfo[]): string {
  return streams
    .map(
      (stream) =>
        `${printable(stream.id, 64)} to ${printable(stream.stableNodeID, 64)}:${stream.port}` +
        (stream.label ? ` (${printable(stream.label, 64)})` : "") +
        ` since ${printable(stream.startedAt, 40)}`,
    )
    .join("; ");
}

export function tsnetHome(home: string): string {
  return join(home, "tsnet-client");
}

export function socketPath(home: string): string {
  return join(tsnetHome(home), "run", "dial.sock");
}

function logPath(home: string): string {
  return join(tsnetHome(home), "run", "dial.log");
}

// Creates `path` owner-only, or narrows this user's existing directory to 0700. A symlink or
// another user's directory is refused; the daemon makes the same checks.
function ownerOnlyDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new DaemonUnavailable(`${path} is not a directory owned by this user`);
  if ((info.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

// ---------------------------------------------------------------------------------------------
// One connection to the daemon: newline-delimited JSON frames, then possibly raw bytes.

export class Channel {
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | undefined;
  private closed = false;
  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.waiter?.();
  };
  private readonly onEnd = () => {
    this.closed = true;
    this.waiter?.();
  };

  constructor(readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onEnd);
  }

  write(frame: unknown): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  // The next frame, parsed. Rejects when the connection ends first, the frame is too long or
  // invalid, or `timeoutMs` passes; the connection is then destroyed.
  async read(timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end >= 0) {
        if (end > MAX_FRAME_BYTES) break;
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 1);
        try {
          return JSON.parse(line) as unknown;
        } catch {
          break;
        }
      }
      if (this.buffer.length > MAX_FRAME_BYTES || this.closed) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = undefined;
    }
    this.socket.destroy();
    throw new ChannelBroken();
  }

  // Sends `request` and reads its answer: the result, or a DialError.
  async request(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    this.write(request);
    return answerOf(await this.read(timeoutMs));
  }

  // Hands the connection over as a raw stream: frame parsing stops, and the bytes that arrived
  // after the last frame (the first stream bytes, if the peer already sent some) are returned to
  // be delivered first. The socket is paused until its new reader resumes it.
  detach(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onEnd);
    this.socket.pause();
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }

  close(): void {
    this.socket.destroy();
  }
}

// The connection ended, or answered with something that is not a frame, before an answer came.
export class ChannelBroken extends Error {
  constructor() {
    super("the connection to the dial daemon ended before it answered");
  }
}

function answerOf(frame: unknown): unknown {
  const answer = frame as {
    ok?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown; streams?: unknown };
  } | null;
  if (answer && answer.ok === true) return answer.result ?? {};
  if (answer && answer.ok === false && typeof answer.error?.code === "string")
    throw new DialError(
      printable(answer.error.code, 64),
      printable(answer.error.message ?? ""),
      Array.isArray(answer.error.streams) ? (answer.error.streams as StreamInfo[]) : [],
    );
  throw new ChannelBroken();
}

function connectSocket(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

function parseHello(value: unknown): Hello | null {
  const hello = value as Partial<Hello> | null;
  if (
    !hello ||
    typeof hello.protocol !== "number" ||
    typeof hello.build !== "string" ||
    typeof hello.pid !== "number" ||
    !Array.isArray(hello.streams)
  )
    return null;
  return { mode: String(hello.mode), ...hello } as Hello;
}

// Connects once and exchanges hello: the open channel and the daemon's hello, or null when no
// daemon answered (nothing listens, it closed the connection unanswered, or `deadline` passed).
// Every wait is bounded by what is left of the one absolute deadline when that wait starts, so a
// slow connect cannot leave the hello a stale budget, and a hello answered after the deadline
// does not yield a channel.
async function attempt(
  home: string,
  build: string,
  deadline: number,
): Promise<{ channel: Channel; hello: Hello } | null> {
  const left = () => deadline - Date.now();
  if (left() <= 0) return null;
  let socket: Socket;
  try {
    socket = await connectSocket(socketPath(home), Math.min(left(), CONNECT_TIMEOUT_MS));
  } catch {
    return null;
  }
  const channel = new Channel(socket);
  try {
    if (left() > 0) {
      const hello = parseHello(
        await channel.request(
          { op: "hello", protocol: DIAL_PROTOCOL, build },
          Math.min(left(), HELLO_TIMEOUT_MS),
        ),
      );
      if (hello && hello.mode === "dial" && left() > 0) return { channel, hello };
    }
  } catch {
    // Closed unanswered or answered with an error: no usable daemon on this connection.
  }
  channel.close();
  return null;
}

// `promise`, or DaemonUnavailable once `deadline` passes first (the promise is left to settle on
// its own; nothing was requested of a daemon).
async function beforeDeadline<T>(promise: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DaemonUnavailable(`${what} did not finish within the start deadline`)),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// The current build and daemon start.

export type OpenOptions = {
  // The absolute time (Date.now() milliseconds) by which a usable daemon must have answered;
  // default START_DEADLINE_MS (D14: 10 s) from the call. A caller that retries around openDaemon
  // passes its own deadline, so that all of its attempts share one budget.
  readonly deadline?: number;
};

export type Daemon = { readonly channel: Channel; readonly hello: Hello };

// Binary location and test-control-plane policy belong to the host. Desktop supplies a stable
// installed helper path, not an executable inside a temporary app build. Disposing a connection
// never invokes stop/logout on this shared per-user daemon.
export interface TsnetRuntime {
  binaryPath(): string | null;
  controlUrl?(): string | undefined;
  warn?(message: string): void;
}
export interface TsnetDaemon {
  currentBinary(): Promise<{ path: string; identity: BinaryIdentity }>;
  openDaemon(home: string, options?: OpenOptions): Promise<Daemon>;
  probeDaemon(home: string): Promise<Daemon | null>;
}

export function createTsnetDaemon(runtime: TsnetRuntime): TsnetDaemon {
  let current: Promise<{ path: string; identity: BinaryIdentity }> | undefined;

  // The executable this CLI starts and its build, read once per command.
  function currentBinary(): Promise<{ path: string; identity: BinaryIdentity }> {
    current ??= (async () => {
      try {
        const path = runtime.binaryPath();
        if (path === null)
          throw new DaemonUnavailable(
            "this Cove build has no cove-tsnet executable (an installed Cove ships bin/cove-tsnet; " +
              "a development checkout builds it with `pnpm tsnet:build`)",
          );
        const identity = await binaryIdentity(path);
        if (identity.protocol !== DIAL_PROTOCOL)
          throw new DaemonUnavailable(
            `${path} speaks local protocol ${identity.protocol}; this CLI speaks ${DIAL_PROTOCOL}`,
          );
        return { path, identity };
      } catch (error) {
        // A rejected override or an executable that does not identify itself: no daemon can be
        // used, and nothing was started.
        if (error instanceof TsnetBinaryError) throw new DaemonUnavailable(error.message);
        throw error;
      }
    })();
    return current;
  }

  type Started = { child: ChildProcess; exit?: { code: number | null; signal: string | null } };

  // The daemon's log: appended to by every daemon this user starts, rotated once it grows past
  // LOG_ROTATE_BYTES. Returns the descriptor and where this start's output begins.
  function openLog(home: string): { fd: number; offset: number } {
    const path = logPath(home);
    try {
      if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    const fd = openSync(path, "a", 0o600);
    const offset = fstatSync(fd).size;
    writeSync(
      fd,
      `cove: starting cove-tsnet dial for cove pid ${process.pid} at ${new Date().toISOString()}\n`,
    );
    return { fd, offset };
  }

  function readLogTail(home: string, from: number): string {
    try {
      const fd = openSync(logPath(home), "r");
      try {
        const size = fstatSync(fd).size;
        const start = Math.max(from, size - DIAGNOSTIC_BYTES);
        const buffer = Buffer.alloc(Math.max(0, size - start));
        readSync(fd, buffer, 0, buffer.length, start);
        return buffer
          .toString("utf8")
          .replace(/[^\x20-\x7e\n]/g, "?")
          .trim();
      } finally {
        closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  async function startDaemon(
    home: string,
    binary: string,
  ): Promise<{ started: Started; logFrom: number }> {
    const config = await readTsnetConfig(home);
    const args = [
      "dial",
      "--home",
      tsnetHome(home),
      "--idle-timeout",
      `${config.idleTimeoutSeconds}s`,
    ];
    // Development and test only (the CLI scenarios' test control plane, tsnet-binary.ts); unset in
    // real use, where the node talks to Tailscale's control plane.
    const controlUrl = runtime.controlUrl?.();
    if (controlUrl) args.push("--control-url", controlUrl);
    const log = openLog(home);
    try {
      const child = spawn(binary, args, {
        detached: true,
        stdio: ["ignore", "ignore", log.fd],
        cwd: "/",
      });
      const started: Started = { child };
      child.once("exit", (code, signal) => (started.exit = { code, signal }));
      child.once("error", () => (started.exit = { code: 1, signal: null }));
      child.unref();
      return { started, logFrom: log.offset };
    } finally {
      closeSync(log.fd);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Opening a daemon connection.

  const warned = new Set<string>();

  function warnOnce(key: string, text: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    runtime.warn?.(text);
  }

  // A connection to a ready daemon of an acceptable build, after its hello, on which the caller
  // sends exactly one request. Starts the daemon if needed and replaces an idle one of another
  // build (see the top of this file). Throws DaemonUnavailable when the deadline passes or the
  // running daemon cannot be used; nothing was requested of any daemon then.
  async function openDaemon(home: string, options: OpenOptions = {}): Promise<Daemon> {
    // One absolute deadline from the very start, identifying the executable included; every wait
    // below gets what is left of it when the wait starts.
    const deadline = options.deadline ?? Date.now() + START_DEADLINE_MS;
    const { path: binary, identity } = await beforeDeadline(
      currentBinary(),
      deadline,
      "identifying the cove-tsnet executable",
    );
    const sock = socketPath(home);
    if (Buffer.byteLength(sock) > MAX_SOCKET_PATH_BYTES)
      throw new DaemonUnavailable(
        `the dial socket path ${sock} is longer than ${MAX_SOCKET_PATH_BYTES} bytes; use a shorter --home`,
      );
    // home may be an arbitrary pre-existing user directory. Only our managed children are
    // checked/tightened; creation mode applies to newly created paths, never existing ancestors.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    ownerOnlyDirectory(tsnetHome(home));
    ownerOnlyDirectory(join(tsnetHome(home), "run"));

    let started: Started | undefined;
    let logFrom: number | undefined;
    let backoff = BACKOFF_MIN_MS;
    let replaced: string | undefined;
    for (;;) {
      if (deadline - Date.now() <= 0) break;
      const reached = await attempt(home, identity.build, deadline);
      if (reached) {
        const { channel, hello } = reached;
        if (hello.build === identity.build) return reached;
        if (hello.streams.length === 0) {
          // Idle and another build: replace it. The stop is refused (ACTIVE_STREAMS) if a stream
          // started since the hello, and then nothing changed; either way, go round again.
          const left = deadline - Date.now();
          try {
            if (left > 0) {
              await channel.request({ op: "stop" }, Math.min(STOP_TIMEOUT_MS, left));
              replaced = hello.build;
            }
          } catch {
            // Refused or cut short: the next hello tells what runs now.
          }
          channel.close();
          continue;
        }
        if (hello.protocol === DIAL_PROTOCOL) {
          warnOnce(
            `build:${hello.build}`,
            `the tsnet dial daemon (pid ${hello.pid}) runs build ${printable(hello.build, 128)}, ` +
              `not ${identity.build}; it is kept because it has ${hello.streams.length} active ` +
              "stream(s), and is replaced once it is idle",
          );
          return reached;
        }
        channel.close();
        throw new DaemonUnavailable(
          `the tsnet dial daemon (pid ${hello.pid}) runs build ${printable(hello.build, 128)} with ` +
            `local protocol ${hello.protocol}, which this CLI (protocol ${DIAL_PROTOCOL}) cannot use, ` +
            `and it has active streams, so it was not replaced: ${describeStreams(hello.streams)}. ` +
            "Wait for them to end, or end them with `cove remote tsnet stop --yes`",
        );
      }
      // No daemon answered. Start one unless the one this command started is still running (it may
      // be about to listen). A started daemon that exited 0 ended normally before this command
      // reached it (a concurrent `remote tsnet stop`, or a short idle timeout), 75 lost the lock and
      // a signal killed it: each is started again within the deadline. Any other status is a failure
      // the daemon wrote to its log (1 error, 2 usage), which a retry cannot fix.
      if (started?.exit && ![null, 0, 75].includes(started.exit.code))
        throw new DaemonUnavailable(
          `cove-tsnet dial exited with status ${started.exit.code}` + diagnostics(home, logFrom),
        );
      if (!started || started.exit) {
        const start = await startDaemon(home, binary);
        started = start.started;
        logFrom ??= start.logFrom;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(backoff, Math.max(1, deadline - Date.now()))),
      );
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    throw new DaemonUnavailable(
      `the tsnet dial daemon did not become ready within ${START_DEADLINE_MS / 1000} s` +
        (replaced
          ? ` (an idle daemon of build ${printable(replaced, 128)} was stopped to be replaced)`
          : "") +
        diagnostics(home, logFrom),
    );
  }

  function diagnostics(home: string, from: number | undefined): string {
    if (from === undefined) return "";
    const tail = readLogTail(home, from);
    return tail ? `; its output (${logPath(home)}):\n${tail}` : `; see ${logPath(home)}`;
  }

  // Whether a daemon holds the lock of `home` right now (`cove-tsnet dial-owned`, PROTOCOL.md
  // "Ownership probe"), asked of the executable this CLI would start. It creates nothing and starts
  // nothing. Throws DaemonUnavailable when it cannot tell.
  async function daemonOwned(binary: string, home: string, deadline: number): Promise<boolean> {
    const answer = await new Promise<string | Error>((resolve) => {
      execFile(
        binary,
        ["dial-owned", "--home", tsnetHome(home)],
        {
          // At least a short while even at the deadline: the last look at the lock decides between
          // "no daemon" and "unknown".
          timeout: Math.max(
            OWNED_MIN_TIMEOUT_MS,
            Math.min(deadline - Date.now(), CONNECT_TIMEOUT_MS),
          ),
          maxBuffer: 1024,
          encoding: "utf8",
        },
        (error, stdout) => resolve(error ?? stdout.trim()),
      );
    });
    if (answer === "owned") return true;
    if (answer === "free") return false;
    throw new DaemonUnavailable(
      "cannot tell whether a tsnet dial daemon runs: `cove-tsnet dial-owned` " +
        (answer instanceof Error
          ? `failed (${printable(answer.message.split("\n")[0])})`
          : `answered ${printable(answer, 64)}`),
    );
  }

  // The running daemon, without starting one, for `remote tsnet stop` (which must not start a
  // daemon only to stop it, and stops whatever build runs): its connection after hello, or null
  // when no daemon runs. Throws DaemonUnavailable when that cannot be established in time.
  //
  // A failed connect or an unanswered hello is not proof that no daemon runs: a daemon holds the
  // lock with no socket while it starts (before it listens) and while it exits (after it unlinked
  // the socket), and one that is busy or stopped can accept a connection and not answer. Only the
  // lock decides, so "no daemon" is reported only when no hello came and the lock is free. While
  // the lock is held the probe waits, within one deadline, for the owner's socket and hello; a
  // daemon that exits meanwhile frees the lock, and one that becomes ready is returned.
  async function probeDaemon(home: string): Promise<Daemon | null> {
    const deadline = Date.now() + START_DEADLINE_MS;
    // A daemon refuses a directory whose socket path is too long, so none can run there.
    if (Buffer.byteLength(socketPath(home)) > MAX_SOCKET_PATH_BYTES) return null;
    // Every daemon creates its lock file before anything else; without one, none ever ran here.
    if (!existsSync(join(tsnetHome(home), "run", "lock"))) return null;
    let current: { path: string; identity: BinaryIdentity } | undefined;
    try {
      current = await beforeDeadline(currentBinary(), deadline, "identifying cove-tsnet");
    } catch {
      // A daemon that answers can still be stopped; asking about the lock needs the executable.
    }
    let backoff = BACKOFF_MIN_MS;
    for (;;) {
      const reached = existsSync(socketPath(home))
        ? await attempt(home, current?.identity.build ?? "unknown", deadline)
        : null;
      if (reached) return reached;
      if (!current)
        throw new DaemonUnavailable(
          "no tsnet dial daemon answered, and without a usable cove-tsnet executable this CLI " +
            "cannot tell whether one runs",
        );
      if (!(await daemonOwned(current.path, home, deadline))) return null;
      if (deadline - Date.now() <= 0)
        throw new DaemonUnavailable(
          `a tsnet dial daemon owns ${tsnetHome(home)} but did not answer within ` +
            `${START_DEADLINE_MS / 1000} s; whether it is running or exiting is unknown, and ` +
            "nothing was requested of it",
        );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(backoff, Math.max(1, deadline - Date.now()))),
      );
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  return { currentBinary, openDaemon, probeDaemon };
}
