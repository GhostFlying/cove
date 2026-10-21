import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { openSshTunnel } from "../../dist/remote/ssh-tunnel.js";
import { bootstrapRequest, payloadOf, portOf, post } from "./auth-fixtures.mjs";
import { ECHO_LOOP, attachedTerminal, createSshFixture, unavailable } from "./ssh-scenario.mjs";
import { sshClients } from "./sshd-fixture.mjs";

// m2 S6 (the SSH entry), against the compiled CLI and server and a task-owned sshd
// (sshd-fixture.mjs). The CLI runs the system ssh with the fixture's own config and known_hosts:
// - an unknown or changed host key fails the command before any token or invitation secret is
//   sent (pairing leaves the invitation unused, a paired device never authenticates), and the
//   correct key succeeds;
// - with `GatewayPorts yes` (and a multiplexing master) in the user's config, the forward still
//   listens on 127.0.0.1 only, and the remote end is the execution host's 127.0.0.1;
// - a request through the tunnel carries the tunnel's own local port in Host, which the server
//   accepts as a loopback literal (user decision 2026-10-22), while a domain Host is refused;
// - a tunnel that drops mid-command leaves the server and the PTY running, and a new connection
//   recovers the run from its baseline plus what followed;
// - the CLI never rewrites the user's known_hosts or ssh config, and no ssh outlives its command.

let ssh;

beforeEach(async () => {
  if (!unavailable) ssh = await createSshFixture();
});

afterEach(async () => {
  await ssh?.cleanup();
  ssh = undefined;
});

// The server, with an invitation advertising the fixture's SSH target.
async function sshServer() {
  const { fixture, sshd } = ssh;
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome, [], { sshTarget: sshd.target });
  return { serverHome, server };
}

async function devices(serverHome) {
  return (await ssh.fixture.coveJson(["auth", "device", "list"], { home: serverHome })).devices;
}

test.skipIf(unavailable)(
  "an unknown or changed host key fails before any secret is sent; the pinned key pairs and connects",
  async () => {
    const { fixture, sshd } = ssh;
    const { serverHome } = await sshServer();
    const { invitation } = await fixture.invite(serverHome);
    expect(payloadOf(invitation).entries.ssh.target).toBe(sshd.target);
    const client = fixture.home("laptop");

    // Pairing over SSH with the host unknown, then with a changed key: ssh refuses the host
    // before any forward, so the invitation was never sent and stays usable.
    for (const kind of ["unknown", "wrong"]) {
      await sshd.pin(kind);
      const refused = await fixture.pair(client, "box", invitation, ["--via", "ssh"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("ENTRY_UNAVAILABLE");
      expect(refused.stderr).toMatch(/Host key verification failed|REMOTE HOST IDENTIFICATION/);
      expect(refused.stderr).toContain("nothing was sent");
      expect(await devices(serverHome)).toEqual([]);
    }
    const listed = await fixture.coveJson(["auth", "invite", "list"], { home: serverHome });
    expect(listed.invitations.map((entry) => entry.state)).toEqual(["open"]);

    // The pinned key: the same invitation pairs over SSH, and the record holds the SSH entry only.
    await sshd.pin("correct");
    const paired = await fixture.pairOk(client, "box", invitation, ["--via", "ssh"]);
    expect(paired).toMatchObject({ alias: "box", defaultEntry: "ssh" });
    const record = await fixture.credential(client, paired.serverId);
    expect(record.entries).toEqual({ ssh: { target: sshd.target, port: expect.any(Number) } });
    const [device] = await devices(serverHome);
    expect(device).toMatchObject({ deviceId: paired.deviceId, neverConnected: true });

    // A changed key on the paired entry: the command fails before the token is released, so the
    // device has still never authenticated.
    await sshd.pin("wrong");
    const blocked = await fixture.cove(["--server", "box", "status"], { home: client });
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("ENTRY_UNAVAILABLE");
    expect(blocked.stderr).toContain("Entries of box: ssh");
    expect((await devices(serverHome))[0].neverConnected).toBe(true);

    await sshd.pin("correct");
    const status = await fixture.coveJson(["--server", "box", "status"], { home: client });
    expect(status.serverId).toBe(paired.serverId);
    expect((await devices(serverHome))[0].neverConnected).toBe(false);
    expect(await ssh.untouched()).toBe(true);
    expect(await sshClients(sshd.clientConfig)).toEqual([]);
  },
  120_000,
);

// A non-loopback address of this host, or null when it has none.
function externalAddress() {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return null;
}

function connects(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(3_000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });
}

test.skipIf(unavailable)(
  "with GatewayPorts yes in the user's config the forward listens on 127.0.0.1 only, to the host's 127.0.0.1",
  async () => {
    const { sshd } = ssh;
    const { server } = await sshServer();
    const remotePort = portOf(server);
    // The compiled tunnel the SSH entry opens, with the fixture config (GatewayPorts yes, a
    // ControlMaster with ControlPersist) in effect.
    const tunnel = await openSshTunnel({ target: sshd.target, remotePort });
    try {
      const [client] = await sshClients(sshd.clientConfig);
      expect(client.args).toContain(`-L 127.0.0.1:${tunnel.localPort}:127.0.0.1:${remotePort}`);
      expect(client.args).toContain("GatewayPorts=no");
      expect(await connects("127.0.0.1", tunnel.localPort)).toBe(true);
      // End to end through the tunnel, with the Host of its own local port, not the server's.
      expect(tunnel.localPort).not.toBe(remotePort);
      const identity = await post(tunnel.localPort, "/bootstrap", bootstrapRequest(server));
      expect(identity.status).toBe(200);
      expect(identity.json).toMatchObject({
        type: "cove-bootstrap-identity",
        serverId: server.record.serverId,
      });
      const rebound = await post(tunnel.localPort, "/bootstrap", bootstrapRequest(server), {
        host: `evil.example:${tunnel.localPort}`,
      });
      expect(rebound.status).toBe(403);
      expect(rebound.raw).not.toContain(server.record.serverId);
      // From this host's own non-loopback address the forward is not reachable.
      const external = externalAddress();
      expect(external).not.toBeNull();
      expect(await connects(external, tunnel.localPort)).toBe(false);
      // The forwarded connection reached the server's 127.0.0.1 port on the execution host.
      await waitFor(
        "the sshd to log the forwarded channel",
        () => sshd.log().includes(`target 127.0.0.1 port ${remotePort}`),
        10_000,
      );
    } finally {
      await tunnel.close();
    }
    // No master or tunnel outlives the close, although the config asks for a ControlPersist master.
    expect(await sshClients(sshd.clientConfig)).toEqual([]);
    expect((await readdir(sshd.directory)).filter((name) => name.startsWith("cm-"))).toEqual([]);
  },
  60_000,
);

test.skipIf(unavailable)(
  "a dropped tunnel leaves the server and PTY running, and reconnecting recovers from the baseline",
  async () => {
    const { fixture, sshd } = ssh;
    const { serverHome, server } = await sshServer();
    const client = fixture.home("laptop");
    await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation, [
      "--via",
      "ssh",
    ]);
    const run = await fixture.coveJson(
      ["--server", "box", "terminal", "create", "--cwd", fixture.root, "--"].concat([
        "/bin/sh",
        "-c",
        ECHO_LOOP,
      ]),
      { home: client },
    );
    expect(run.runId).toEqual(expect.any(String));

    const first = await ssh.session(client, "box", undefined);
    const terminal = await attachedTerminal(first.client, run, "first");
    await terminal.sees("loop-ready");
    await terminal.type("one\r");
    await terminal.sees("echo:one");

    // The tunnel drops: its ssh is killed.
    const [tunnel] = await sshClients(sshd.clientConfig);
    process.kill(tunnel.pid, "SIGKILL");
    await waitFor(
      "the session to notice the dropped tunnel",
      () => first.client.snapshot().status !== "connected",
      30_000,
    );
    await ssh.closeSession(first);

    // The server and the PTY are unaffected: the server is the same process, the run is running,
    // and it answers the owner's input while no SSH client is connected.
    expect(await fixture.serverRuns(server)).toBe(true);
    const record = await fixture.coveJson(["terminal", "get", run.runId], { home: serverHome });
    expect(record.status).toBe("live");
    const owner = await fixture.deviceClient(server, null);
    expect((await owner.client.connect()).ok).toBe(true);
    const local = await attachedTerminal(owner.client, run, "owner");
    await local.sees("echo:one");
    await local.type("mid\r");
    await local.sees("echo:mid");
    owner.client.dispose();

    // A new connection over SSH: the baseline holds everything the run printed before, including
    // what it printed while no SSH client was connected, and new input is answered after it.
    const second = await ssh.session(client, "box", undefined);
    const again = await attachedTerminal(second.client, run, "second");
    await again.sees("echo:mid");
    await again.type("two\r");
    await again.sees("echo:two");
    const text = again.text();
    expect(text.indexOf("echo:one")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("echo:one")).toBeLessThan(text.indexOf("echo:mid"));
    expect(text.indexOf("echo:mid")).toBeLessThan(text.indexOf("echo:two"));
    expect(await ssh.untouched()).toBe(true);
  },
  120_000,
);

test.skipIf(unavailable)(
  "a command killed with SIGKILL leaves no ssh behind",
  async () => {
    const { fixture, sshd } = ssh;
    const { server } = await sshServer();
    const holder = spawn(
      process.execPath,
      [resolve(import.meta.dirname, "tunnel-holder.mjs"), sshd.target, String(portOf(server))],
      { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    holder.stdout.on("data", (chunk) => (stdout += chunk));
    holder.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise((done) => holder.once("exit", (code, signal) => done(signal)));
    try {
      await waitFor(
        "the tunnel to open",
        () => /^\d+\n/.test(stdout) || holder.exitCode !== null,
        30_000,
      );
      if (holder.exitCode !== null) throw new Error(`tunnel-holder exited: ${stderr}`);
      expect(await sshClients(sshd.clientConfig)).toHaveLength(1);
      expect(await connects("127.0.0.1", Number(stdout.trim()))).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
    expect(await exited).toBe("SIGKILL");
    // The supervisor sees its pipe end and ends ssh; the forward's port closes with it.
    await waitFor(
      "the killed command's ssh to exit",
      async () => (await sshClients(sshd.clientConfig)).length === 0,
      10_000,
    );
    expect(await connects("127.0.0.1", Number(stdout.trim()))).toBe(false);
  },
  60_000,
);
