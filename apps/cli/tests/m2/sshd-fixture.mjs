import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { waitFor } from "../recording-view.mjs";

// A task-owned, unprivileged sshd for the SSH entry scenarios (m2 S5–S7): its own config, host
// key and client key generated per scenario, a high port on 127.0.0.1, `UsePAM no`, and a client
// side that never reads the operator's ssh configuration. The client side is
// - an ssh_config naming the fixture host (TARGET) with the fixture's key, a known_hosts file of
//   its own (pinned to the fixture host key; the scenario can replace it) and no agent; it also
//   sets options the CLI must override on its command line (GatewayPorts yes, a multiplexing
//   master with ControlPersist), so a scenario can check that the user's config cannot widen the
//   forward or keep a tunnel alive after the command;
// - a directory with an `ssh` wrapper, put first on the CLI's PATH, that runs the system ssh with
//   `-F <that config>`, so the CLI's `ssh` uses the fixture config instead of ~/.ssh/config.
// The sshd authenticates the current user by the fixture key only. Everything is under `directory`,
// which the caller removes; stop() ends the sshd.
//
// `hostile: true` adds honest settings a user's config may have that would switch the host-key
// check off or detach ssh unless the CLI pins them (ssh-tunnel.ts): NoHostAuthenticationForLocalhost
// yes (TARGET resolves to 127.0.0.1), NoHostAuthenticationForProxyCommand yes (Apple's ssh; other
// builds ignore it through IgnoreUnknown) and ForkAfterAuthentication yes. It also adds
// PROXY_TARGET, the same host reached through a ProxyCommand (proxy.mjs under `directory`).
//
// Availability. sshd is looked up in the usual system locations. When it cannot run,
// sshdUnavailable() returns the reason and the scenario fails with it (ssh-scenario.mjs).

export const TARGET = "cove-test-sshd";
export const PROXY_TARGET = "cove-test-sshd-proxy";
const SSHD_PATHS = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"];

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 20_000, ...options }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

async function executable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function which(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, name);
    if (directory && (await executable(path))) return path;
  }
  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The reason an unprivileged sshd cannot be used here, or null when it can.
export async function sshdUnavailable() {
  const sshd = (await Promise.all(SSHD_PATHS.map(executable))).findIndex(Boolean);
  if (sshd < 0) return `no sshd in ${SSHD_PATHS.join(", ")}`;
  for (const tool of ["ssh", "ssh-keygen"]) if (!(await which(tool))) return `no ${tool} on PATH`;
  return null;
}

async function keyPair(path, comment) {
  const made = await run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    comment,
    "-f",
    path,
  ]);
  if (made.code !== 0) throw new Error(`ssh-keygen failed: ${made.stderr}`);
  return (await readFile(`${path}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ");
}

// Starts the sshd under `directory` (created 0700). Returns the fixture; see the top of the file.
export async function startSshd(directory, { hostile = false } = {}) {
  const sshd = SSHD_PATHS[(await Promise.all(SSHD_PATHS.map(executable))).findIndex(Boolean)];
  const ssh = await which("ssh");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const user = userInfo().username;
  const hostKey = await keyPair(join(directory, "host_ed25519"), "cove-test-host");
  const otherHostKey = await keyPair(join(directory, "other_host_ed25519"), "cove-test-other");
  const clientKey = await keyPair(join(directory, "client_ed25519"), "cove-test-client");
  await writeFile(join(directory, "authorized_keys"), `${clientKey}\n`, { mode: 0o600 });
  const knownHosts = join(directory, "known_hosts");
  const clientConfig = join(directory, "ssh_config");
  const wrapperDirectory = join(directory, "bin");
  await mkdir(wrapperDirectory, { mode: 0o700 });
  // exec keeps the PID: the CLI's supervisor sees ssh itself.
  await writeFile(
    join(wrapperDirectory, "ssh"),
    `#!/bin/sh\nexec ${JSON.stringify(ssh)} -F ${JSON.stringify(clientConfig)} "$@"\n`,
    { mode: 0o700 },
  );

  let port;
  let child;
  let log = "";
  for (let attempt = 0; attempt < 3 && !child; attempt++) {
    port = await freePort();
    const config = join(directory, "sshd_config");
    await writeFile(
      config,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(directory, "host_ed25519")}`,
        `PidFile ${join(directory, "sshd.pid")}`,
        `AuthorizedKeysFile ${join(directory, "authorized_keys")}`,
        `AllowUsers ${user}`,
        "UsePAM no",
        // The fixture files live in a temporary tree whose ancestors sshd does not own.
        "StrictModes no",
        "PubkeyAuthentication yes",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "AllowTcpForwarding local",
        "AllowAgentForwarding no",
        "X11Forwarding no",
        "PermitTTY no",
        // DEBUG1 logs each forwarded channel's target (server_request_direct_tcpip).
        "LogLevel DEBUG1",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    log = "";
    const started = spawn(sshd, ["-D", "-e", "-f", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    started.stderr.on("data", (chunk) => (log += chunk));
    const exited = new Promise((done) => started.once("exit", (code) => done(code)));
    await waitFor(
      "the sshd to listen",
      () => started.exitCode !== null || log.includes(`Server listening on 127.0.0.1 port ${port}`),
      15_000,
    );
    if (started.exitCode === null) child = { process: started, exited };
    else if (!/Address already in use/.test(log))
      throw new Error(`sshd exited ${started.exitCode}: ${log}`);
  }
  if (!child) throw new Error(`sshd could not bind a port: ${log}`);

  const knownHostsLine = (key) => `[127.0.0.1]:${port} ${key}\n`;
  await writeFile(knownHosts, knownHostsLine(hostKey), { mode: 0o600 });
  const proxyScript = join(directory, "proxy.mjs");
  await writeFile(
    proxyScript,
    [
      'import { connect } from "node:net";',
      "const socket = connect({ host: process.argv[2], port: Number(process.argv[3]) });",
      "process.stdin.pipe(socket);",
      "socket.pipe(process.stdout);",
      "socket.on('error', () => process.exit(1));",
      "socket.on('close', () => process.exit(0));",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const hostileOptions = hostile
    ? [
        "  NoHostAuthenticationForLocalhost yes",
        "  NoHostAuthenticationForProxyCommand yes",
        "  ForkAfterAuthentication yes",
      ]
    : [];
  const hostBlock = (alias, extra) => [
    `Host ${alias}`,
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${join(directory, "client_ed25519")}`,
    "  IdentitiesOnly yes",
    "  IdentityAgent none",
    `  UserKnownHostsFile ${knownHosts}`,
    "  GlobalKnownHostsFile /dev/null",
    "  CheckHostIP no",
    // Options the CLI's command line must override (ssh-tunnel.ts).
    "  GatewayPorts yes",
    "  ControlMaster auto",
    `  ControlPath ${join(directory, "cm-%C")}`,
    "  ControlPersist 60",
    ...hostileOptions,
    ...extra,
  ];
  await writeFile(
    clientConfig,
    [
      // Global, before every Host block: ssh rejects an unknown keyword even in a block that does
      // not apply to the target, unless IgnoreUnknown already names it.
      ...(hostile
        ? ["IgnoreUnknown NoHostAuthenticationForProxyCommand,ForkAfterAuthentication"]
        : []),
      ...hostBlock(TARGET, []),
      ...(hostile
        ? hostBlock(PROXY_TARGET, [
            `  ProxyCommand ${JSON.stringify(process.execPath)} ${JSON.stringify(proxyScript)} %h %p`,
          ])
        : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  return {
    directory,
    port,
    target: TARGET,
    proxyTarget: PROXY_TARGET,
    proxyScript,
    knownHosts,
    clientConfig,
    // `env` with the fixture's ssh first on PATH.
    env(env) {
      return { ...env, PATH: `${wrapperDirectory}${delimiter}${env.PATH ?? process.env.PATH}` };
    },
    // known_hosts pinned to the fixture host key ("correct"), to another key for the same host
    // ("wrong", a changed host key) or empty ("unknown").
    async pin(kind) {
      const content =
        kind === "correct"
          ? knownHostsLine(hostKey)
          : kind === "wrong"
            ? knownHostsLine(otherHostKey)
            : "";
      await writeFile(knownHosts, content, { mode: 0o600 });
    },
    log: () => log,
    async stop() {
      if (child.process.exitCode === null) child.process.kill("SIGTERM");
      const timer = setTimeout(() => child.process.kill("SIGKILL"), 5_000);
      await child.exited;
      clearTimeout(timer);
    },
  };
}

// The PIDs and argv of every running process whose arguments mention `marker` (a ProxyCommand
// helper: its script path).
export async function processesWith(marker) {
  const listed = await run("ps", ["-A", "-o", "pid=,args="]);
  if (listed.code !== 0) throw new Error(`ps failed: ${listed.stderr}`);
  return listed.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match && match[2].includes(marker) && !match[2].startsWith("ps "))
    .map((match) => ({ pid: Number(match[1]), args: match[2] }));
}

// The PIDs and argv of every running ssh client whose arguments mention `marker`.
export async function sshClients(marker) {
  const listed = await run("ps", ["-A", "-o", "pid=,args="]);
  if (listed.code !== 0) throw new Error(`ps failed: ${listed.stderr}`);
  return listed.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match && /(^|\/)ssh /.test(match[2]) && match[2].includes(marker))
    .map((match) => ({ pid: Number(match[1]), args: match[2] }));
}
