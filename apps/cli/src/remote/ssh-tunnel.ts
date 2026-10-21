import { spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { SshTargetSchema } from "@cove/protocol/auth";
import { RemoteError } from "./entry-types.js";

// The SSH entry's channel (m2 D11, S6): one system `ssh -N -L` per command, forwarding a local
// loopback port to the server's loopback port on the target host.
//
// Peer check. ssh verifies the target's host key against the user's own known_hosts before it
// opens any forward (StrictHostKeyChecking=yes, BatchMode=yes: an unknown or changed key is a
// failure, never a prompt or a silent addition). A tunnel that reports ready has passed that
// check; the serverId over it is checked next (entries.ts), and only then is a token or an
// invitation secret released. Cove never writes the user's known_hosts or ssh config.
//
// Options on the command line take precedence over the user's ssh config (ssh uses the first value
// it obtains for an option), so the user's config cannot widen the forward:
// - `-L 127.0.0.1:<local>:127.0.0.1:<remote>` binds the local end on 127.0.0.1 only, and
//   GatewayPorts=no keeps it there even when the config says `GatewayPorts yes`; the remote end
//   is the target host's own 127.0.0.1;
// - ExitOnForwardFailure=yes: a forward that cannot be set up (the local port was taken) ends ssh
//   instead of leaving a tunnel without it;
// - ControlMaster=no and ControlPath=none: a forward requested through a user's multiplexing master
//   would be set up, and outlive this command, in that master (with the master's GatewayPorts);
// - ConnectTimeout bounds the connection; ServerAlive ends a tunnel whose peer stopped answering;
// - UpdateHostKeys=no: ssh does not add keys the server offers to the user's known_hosts (with
//   StrictHostKeyChecking=yes it never adds an unknown host either), so a command never writes it.
// The argv holds only the target and the ports: no token or secret ever goes to ssh.
//
// Lifetime. The tunnel lives as long as the command. ssh runs under a small POSIX sh supervisor
// in a session and process group of its own (spawn `detached`), whose stdin is a pipe from this
// process: the supervisor waits for that pipe's end-of-file and then ends ssh. The pipe's write end
// is held only by this process, so its end-of-file comes when the command closes the tunnel and
// also when the command dies in any way, SIGKILL included; no ssh process outlives the command.
// close() ends the pipe and waits, then signals the group (TERM, then KILL), bounded.
//
// Readiness. ssh opens the local listener only after authentication and the host-key check; the
// tunnel is ready when that port accepts a connection while ssh still runs, within readyTimeoutMs.
// The local port is one the OS just reported free on 127.0.0.1; a process taking it before ssh
// binds makes ssh exit (ExitOnForwardFailure), which is retried on a new port a bounded number of
// times. Another OS user's process that grabs the port is a documented residual limitation, as
// for the loopback entry (relay-protocol §11.8); the serverId check still applies.

export type SshTunnelOptions = {
  // An SshTargetSchema target: `[user@]host` or an ssh_config alias.
  readonly target: string;
  // The port on the target host's 127.0.0.1 to forward to.
  readonly remotePort: number;
  readonly readyTimeoutMs?: number;
};

export type SshTunnel = {
  // The local end, on 127.0.0.1.
  readonly localPort: number;
  // The ssh supervisor's PID, the leader of the tunnel's process group.
  readonly pid: number;
  // Settles when ssh has exited (the tunnel is gone), for whatever reason.
  readonly ended: Promise<void>;
  // Ends the tunnel and waits for its processes, bounded. Never throws.
  close(): Promise<void>;
};

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_S = 15;
const PROBE_INTERVAL_MS = 50;
const BIND_ATTEMPTS = 3;
const CLOSE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;
// The tail of ssh's stderr kept for an error message: third-party text, bounded and reduced to
// printable ASCII before it is shown.
const STDERR_TAIL_BYTES = 4096;
const DETAIL_CHARS = 200;

// The supervisor: `sh -c SUPERVISOR cove-ssh ssh ARGS...`. fd 3 keeps the pipe from this process
// and fd 4 the stderr pipe, which only ssh writes to: the shell's own stderr goes to /dev/null, so
// its job messages (bash reports the reader it kills as "Terminated") never become the error line
// shown for ssh. ssh runs in the background with stdin from /dev/null; a reader waits for the
// pipe's EOF and then ends ssh; the supervisor exits with ssh's status. Arguments reach ssh as
// "$@", never through the shell's parser.
const SUPERVISOR = [
  "exec 3<&0 4>&2 </dev/null 2>/dev/null",
  '"$@" 2>&4 &',
  "ssh_pid=$!",
  '{ read -r _ <&3; kill -TERM "$ssh_pid" 2>/dev/null; } &',
  "reader_pid=$!",
  'wait "$ssh_pid"',
  "status=$?",
  'kill "$reader_pid" 2>/dev/null',
  'exit "$status"',
].join("\n");

export function sshArguments(target: string, localPort: number, remotePort: number): string[] {
  return [
    "-N",
    "-T",
    ...["-o", "BatchMode=yes"],
    ...["-o", "StrictHostKeyChecking=yes"],
    ...["-o", "ExitOnForwardFailure=yes"],
    ...["-o", "GatewayPorts=no"],
    ...["-o", "ControlMaster=no"],
    ...["-o", "ControlPath=none"],
    ...["-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`],
    ...["-o", "ServerAliveInterval=15"],
    ...["-o", "ServerAliveCountMax=3"],
    ...["-o", "UpdateHostKeys=no"],
    ...["-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`],
    // Everything after `--` is the destination: a target can never be read as an option.
    "--",
    target,
  ];
}

// A port the OS reports free on 127.0.0.1 right now.
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(PROBE_INTERVAL_MS * 4);
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

// ssh's last stderr line, printable ASCII only and bounded, for an error message.
function lastLine(stderr: string): string {
  const line =
    stderr
      .split(/\r?\n/)
      .map((text) => text.replace(/[^\x20-\x7e]/g, "").trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS)}...` : line;
}

type Started = { child: ChildProcess; ended: Promise<number | null>; stderr: () => string };

function startSupervised(args: string[]): Started {
  const child = spawn("/bin/sh", ["-c", SUPERVISOR, "cove-ssh", "ssh", ...args], {
    detached: true,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("latin1");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });
  child.stdin!.on("error", () => undefined);
  const ended = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return { child, ended, stderr: () => stderr };
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

// Ends a supervised ssh: end-of-file on the supervisor's pipe, then TERM and KILL to its group
// while the supervisor (the group's leader, so the group is still this tunnel's) has not exited.
async function stop({ child, ended }: Started): Promise<void> {
  const running = () => child.exitCode === null && child.signalCode === null;
  child.stdin?.end();
  if ((await Promise.race([ended, delay(CLOSE_GRACE_MS)])) !== "timeout" || !running()) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (running() && child.pid !== undefined) process.kill(-child.pid, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  if ((await Promise.race([ended, delay(KILL_GRACE_MS)])) !== "timeout") return;
  signal("SIGKILL");
  await Promise.race([ended, delay(KILL_GRACE_MS)]);
}

// Opens a tunnel to `remotePort` on the target host. A failure is a RemoteError
// (ENTRY_UNAVAILABLE) raised before anything was sent through the tunnel.
export async function openSshTunnel(options: SshTunnelOptions): Promise<SshTunnel> {
  if (!SshTargetSchema.safeParse(options.target).success)
    throw new RemoteError(
      "ENTRY_UNAVAILABLE",
      "the recorded SSH target is invalid; nothing was sent",
    );
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  let failure = "";
  for (let attempt = 1; attempt <= BIND_ATTEMPTS; attempt++) {
    const localPort = await freeLoopbackPort();
    const started = startSupervised(sshArguments(options.target, localPort, options.remotePort));
    let exited = false;
    void started.ended.then(() => (exited = true));
    for (;;) {
      if (exited) break;
      if (await accepts(localPort)) {
        // Ready only while ssh still runs: a listener that outlived ssh is not this tunnel.
        if (!exited && started.child.exitCode === null)
          return {
            localPort,
            pid: started.child.pid!,
            ended: started.ended.then(() => undefined),
            close: () => stop(started),
          };
      }
      if (Date.now() > deadline) {
        await stop(started);
        throw new RemoteError(
          "ENTRY_UNAVAILABLE",
          `ssh did not open the tunnel within ${Math.round(
            (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000,
          )} s; nothing was sent`,
        );
      }
      await delay(PROBE_INTERVAL_MS);
    }
    const code = await started.ended;
    const line = lastLine(started.stderr());
    failure = `ssh exited${code === null ? "" : ` with status ${code}`}${line ? `: ${line}` : ""}`;
    // Only a lost race for the local port is retried; nothing was sent through any attempt.
    if (!/cannot listen to port|Address already in use/i.test(started.stderr())) break;
  }
  throw new RemoteError("ENTRY_UNAVAILABLE", `${failure}; nothing was sent`);
}
