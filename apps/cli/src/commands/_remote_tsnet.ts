import { createInterface } from "node:readline";
import { TsnetAuthKeySchema } from "@cove/protocol/auth";
import { parseIdleTimeout, readTsnetConfig, writeTsnetConfig } from "../remote/tsnet-config.js";
import {
  DaemonUnavailable,
  DialError,
  describeStreams,
  openDaemon,
  printable,
  probeDaemon,
  type Hello,
  type StreamInfo,
} from "../remote/tsnet-daemon.js";
import {
  flag,
  homeDirectory,
  print,
  sleep,
  takeFlags,
  UsageError,
  type Arguments,
} from "./_common.js";

// `cove remote tsnet ...` (m2 D9, D14): this client's own tailnet node, which the per-user
// `cove-tsnet dial` daemon runs (remote/tsnet-daemon.ts). Every command is one request to the
// daemon, started if needed (except `stop`, which never starts one); the daemon serializes login,
// logout, stop and stream setup, so concurrent commands cannot interleave inside them.
//
// Secrets. The auth key is read from a hidden prompt or from stdin, never from an argument or the
// environment, and goes to the daemon only inside the login request on its 0700 socket; it is not
// printed, logged or stored by the CLI. An interactive login's URL lets whoever opens it attach
// this node to their tailnet: it is shown to the user on stderr only, never in the JSON output.
//
// Results are reported as the daemon gives them: an identity hold (IDENTITY_CHANGED,
// LOGIN_UNCERTAIN), a logout the control plane did not confirm (remoteLogoutConfirmed false) and
// the streams a refused logout or stop would have closed.

export const usage = `  remote tsnet login                 (auth key from a hidden prompt or stdin; empty: login URL)
  remote tsnet status
  remote tsnet logout [--yes]
  remote tsnet stop [--yes]
  remote tsnet config [--idle-timeout DURATION]   (90s, 10m, 2h; default 10m)`;

const LOGIN_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 40_000;
const STOP_TIMEOUT_MS = 15_000;
// An interactive login waits this long for the URL to be visited.
const INTERACTIVE_WAIT_MS = 5 * 60_000;
const POLL_MS = 1_000;
const KEY_INPUT_BYTES = 4096;

type NodeInfo = {
  stableNodeID?: string;
  name?: string;
  hostName?: string;
  loginName?: string;
  tailscaleIPs?: string[];
};

type DaemonStatus = {
  state?: string;
  authURL?: string;
  self?: NodeInfo;
  streams?: StreamInfo[];
  hold?: string;
  warnings?: string[];
  remoteLogoutConfirmed?: boolean;
};

// What the JSON output shows of a status: never the login URL.
function shown(status: DaemonStatus, hello: Hello): Record<string, unknown> {
  return {
    state: status.state ?? "unknown",
    self: status.self ?? null,
    ...(status.hold ? { hold: status.hold } : {}),
    ...(status.remoteLogoutConfirmed !== undefined
      ? { remoteLogoutConfirmed: status.remoteLogoutConfirmed }
      : {}),
    streams: status.streams ?? [],
    warnings: (status.warnings ?? []).map((warning) => printable(warning)),
    daemon: { pid: hello.pid, build: hello.build, protocol: hello.protocol },
  };
}

function warnAbout(status: DaemonStatus): void {
  if (status.hold)
    process.stderr.write(
      `cove: this client's tsnet node is held (${printable(status.hold, 32)}); streams are refused ` +
        "until it is resolved" +
        (status.warnings?.[0] ? `: ${printable(status.warnings[0])}` : "") +
        "\n",
    );
  if (status.authURL)
    process.stderr.write(
      `cove: to log this client's tsnet node in, open: ${printable(status.authURL, 2048)}\n`,
    );
}

// One request to the daemon, started if needed. A DaemonUnavailable or DialError is reported with
// what it means for the command; nothing in this module repeats a request that was sent.
async function call(
  home: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ result: DaemonStatus; hello: Hello }> {
  const { channel, hello } = await openDaemon(home).catch((error: unknown) => {
    if (error instanceof DaemonUnavailable)
      throw new Error(`${error.message} (ENTRY_UNAVAILABLE); nothing was done`);
    throw error;
  });
  try {
    return { result: (await channel.request(request, timeoutMs)) as DaemonStatus, hello };
  } finally {
    channel.close();
  }
}

function failure(error: unknown, op: string): Error {
  if (!(error instanceof DialError)) {
    if (error instanceof Error && error.message.startsWith("the connection to the dial daemon"))
      return new Error(
        `the tsnet dial daemon closed the connection before it answered the ${op}; its outcome ` +
          "is unknown, see `cove remote tsnet status`",
      );
    return error instanceof Error ? error : new Error(String(error));
  }
  const streams = error.streams.length ? ` Active streams: ${describeStreams(error.streams)}.` : "";
  switch (error.code) {
    case "ACTIVE_STREAMS":
      return new Error(
        `the tsnet dial daemon has active streams, so nothing was done (ACTIVE_STREAMS).${streams} ` +
          `Run \`cove remote tsnet ${op} --yes\` to close them first`,
      );
    case "IDENTITY_CHANGED":
      return new Error(
        `the login ended as another node (IDENTITY_CHANGED): ${error.detail}. This client's node ` +
          "refuses streams until `cove remote tsnet logout`; then log in with the intended key",
      );
    case "LOGIN_UNCERTAIN":
      return new Error(
        `the login did not finish and may still have completed (LOGIN_UNCERTAIN): ` +
          `${error.detail}. Check \`cove remote tsnet status\` before anything else`,
      );
    case "ALREADY_LOGGED_IN":
      return new Error(
        "this client's tsnet node is already logged in (ALREADY_LOGGED_IN); log out first to use " +
          "another key",
      );
    case "SHUTTING_DOWN":
      return new Error(
        `the tsnet dial daemon was shutting down and did not carry out the ${op} (SHUTTING_DOWN); ` +
          "run the command again",
      );
    default:
      return new Error(`the ${op} failed (${error.code}): ${error.detail}`);
  }
}

// The auth key, or "" for an interactive login: a hidden prompt when stdin is a terminal,
// otherwise stdin itself, bounded. Never echoed, never kept beyond the request.
async function readAuthKey(): Promise<string> {
  if (process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    process.stderr.write("Tailscale auth key (input is hidden; leave empty for a login URL): ");
    // readline echoes typed input through _writeToOutput; silencing it hides the key.
    (prompt as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    try {
      return (
        await new Promise<string>((resolve, reject) => {
          prompt.once("line", resolve);
          prompt.once("close", () => reject(new Error("no auth key was entered")));
        })
      ).trim();
    } finally {
      prompt.close();
      process.stderr.write("\n");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > KEY_INPUT_BYTES) throw new Error("the input is too long for an auth key");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function login(home: string): Promise<number> {
  const key = await readAuthKey();
  if (key && !TsnetAuthKeySchema.safeParse(key).success)
    throw new Error(
      "the input is not a Tailscale auth key (16-512 printable characters without spaces); " +
        "nothing was sent",
    );
  let answer;
  try {
    answer = await call(
      home,
      { op: "login", ...(key ? { authKey: key } : {}), timeoutMs: LOGIN_TIMEOUT_MS },
      LOGIN_TIMEOUT_MS + 15_000,
    );
  } catch (error) {
    throw failure(error, "login");
  }
  let { result: status } = answer;
  const { hello } = answer;
  if (!key) {
    // Interactive: show the URL, then follow the daemon's status until the node runs as the
    // enrolled identity, the hold turns into IDENTITY_CHANGED, or the wait ends.
    warnAbout(status);
    const deadline = Date.now() + INTERACTIVE_WAIT_MS;
    while ((status.state !== "Running" || status.hold) && status.hold !== "IDENTITY_CHANGED") {
      if (Date.now() > deadline)
        throw new Error(
          "the interactive login did not finish in time; it may still complete when the URL is " +
            "opened. Check `cove remote tsnet status`",
        );
      await sleep(POLL_MS);
      try {
        status = (await call(home, { op: "status" }, STATUS_TIMEOUT_MS)).result;
      } catch (error) {
        throw failure(error, "status");
      }
    }
  }
  print(shown(status, hello));
  if (status.hold) {
    const { authURL: _url, ...held } = status;
    warnAbout(held);
    return 1;
  }
  return 0;
}

async function status(home: string): Promise<number> {
  let answer;
  try {
    answer = await call(home, { op: "status" }, STATUS_TIMEOUT_MS);
  } catch (error) {
    throw failure(error, "status");
  }
  warnAbout(answer.result);
  print(shown(answer.result, answer.hello));
  return 0;
}

async function logout(home: string, force: boolean): Promise<number> {
  let answer;
  try {
    answer = await call(
      home,
      { op: "logout", ...(force ? { force: true } : {}) },
      LOGOUT_TIMEOUT_MS,
    );
  } catch (error) {
    throw failure(error, "logout");
  }
  const { result, hello } = answer;
  if (result.remoteLogoutConfirmed === false)
    process.stderr.write(
      "cove: warning: this client's tsnet node state was deleted, but the control plane did not " +
        "confirm the logout; remove the node in the tailnet's admin console" +
        (result.warnings?.[0] ? ` (${printable(result.warnings[0])})` : "") +
        "\n",
    );
  print(shown(result, hello));
  return 0;
}

// Stops the running daemon of whatever build; never starts one. `running: false` without
// `stopped` is reported only when the daemon lock was free (probeDaemon); a daemon that holds it
// but does not answer in time makes the command fail with its state unknown.
async function stop(home: string, force: boolean): Promise<number> {
  const daemon = await probeDaemon(home).catch((error: unknown) => {
    if (error instanceof DaemonUnavailable)
      throw new Error(`${error.message} (ENTRY_UNAVAILABLE); nothing was stopped`);
    throw error;
  });
  if (!daemon) {
    print({ running: false });
    return 0;
  }
  const { channel, hello } = daemon;
  try {
    await channel.request({ op: "stop", ...(force ? { force: true } : {}) }, STOP_TIMEOUT_MS);
  } catch (error) {
    throw failure(error, "stop");
  } finally {
    channel.close();
  }
  print({
    running: false,
    stopped: { pid: hello.pid, build: hello.build, closedStreams: force ? hello.streams : [] },
  });
  return 0;
}

async function config(home: string, args: Arguments): Promise<number> {
  const value = flag(args, "--idle-timeout");
  if (value !== undefined) {
    const seconds = parseIdleTimeout(value);
    if (seconds === null)
      throw new UsageError(
        "--idle-timeout is a whole number of seconds, minutes or hours (90s, 10m, 2h), at most 24h",
      );
    await writeTsnetConfig(home, { idleTimeoutSeconds: seconds });
  }
  // A running daemon keeps the timeout it started with.
  print({ ...(await readTsnetConfig(home)), appliesFrom: "the next start of the dial daemon" });
  return 0;
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[2];
  if (args.words.length !== 3 || args.command)
    throw new UsageError("remote tsnet takes one of login, status, logout, stop, config");
  if (flag(args, "--via") !== undefined) throw new UsageError("--via applies to remote add only");
  const home = homeDirectory(args);
  switch (sub) {
    case "login":
      takeFlags(args, []);
      return login(home);
    case "status":
      takeFlags(args, []);
      return status(home);
    case "logout":
      takeFlags(args, ["--yes"]);
      return logout(home, args.flags.has("--yes"));
    case "stop":
      takeFlags(args, ["--yes"]);
      return stop(home, args.flags.has("--yes"));
    case "config":
      takeFlags(args, ["--idle-timeout"]);
      return config(home, args);
    default:
      throw new UsageError("remote tsnet takes one of login, status, logout, stop, config");
  }
}
