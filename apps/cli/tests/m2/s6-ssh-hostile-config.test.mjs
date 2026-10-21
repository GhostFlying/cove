import { execFile, spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { openSshTunnel } from "../../dist/remote/ssh-tunnel.js";
import { payloadOf, portOf } from "./auth-fixtures.mjs";
import { createSshFixture } from "./ssh-scenario.mjs";
import { processesWith, sshClients } from "./sshd-fixture.mjs";

// m2 S6 under a user ssh config with honest settings that would switch the host-key check off or
// detach ssh unless the CLI pins them on its command line (sshd-fixture.mjs `hostile`):
// NoHostAuthenticationForLocalhost yes (the target resolves to 127.0.0.1),
// NoHostAuthenticationForProxyCommand yes (Apple's ssh; a second target goes through a
// ProxyCommand) and ForkAfterAuthentication yes. Against the compiled CLI and server:
// - an unknown or changed host key still fails before any token or invitation secret is sent,
//   over both targets, and the pinned key still works;
// - closing a tunnel, or SIGKILL of the command holding it, leaves no ssh, no ProxyCommand helper
//   and no listener behind: ssh never forked away from its supervisor.

let ssh;

beforeEach(async () => {
  ssh = await createSshFixture({ hostile: true });
});

afterEach(async () => {
  await ssh?.cleanup();
  ssh = undefined;
});

function connects(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
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

// Whether this host's ssh knows Apple's NoHostAuthenticationForProxyCommand. (-G with the fixture
// config needs ForkAfterAuthentication=no too: forking without a command is an error.)
function knowsProxyOption(env) {
  return new Promise((done) => {
    execFile(
      "ssh",
      [
        "-G",
        ...["-o", "ForkAfterAuthentication=no"],
        ...["-o", "NoHostAuthenticationForProxyCommand=no"],
        ...["--", ssh.sshd.target],
      ],
      { env },
      (error) => done(!error),
    );
  });
}

// No ssh client, ProxyCommand helper or forward of the scenario is left.
async function nothingLeft(localPorts) {
  const { sshd } = ssh;
  await waitFor(
    "every ssh client and ProxyCommand helper to exit",
    async () =>
      (await sshClients(sshd.clientConfig)).length === 0 &&
      (await processesWith(sshd.proxyScript)).length === 0,
    10_000,
  );
  for (const port of localPorts) expect(await connects(port)).toBe(false);
}

test("a config that would skip host authentication cannot: unknown and changed keys fail before any secret", async () => {
  const { fixture, sshd } = ssh;
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome, [], { sshTarget: sshd.target });
  const { invitation } = await fixture.invite(serverHome);
  expect(payloadOf(invitation).entries.ssh.target).toBe(sshd.target);
  const client = fixture.home("laptop");
  const devices = async () =>
    (await fixture.coveJson(["auth", "device", "list"], { home: serverHome })).devices;

  // Pairing over SSH with the host unknown, then with a changed key: refused before any forward,
  // so the invitation was never sent and stays usable.
  for (const kind of ["unknown", "wrong"]) {
    await sshd.pin(kind);
    const refused = await fixture.pair(client, "box", invitation, ["--via", "ssh"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("ENTRY_UNAVAILABLE");
    expect(refused.stderr).toMatch(/Host key verification failed|REMOTE HOST IDENTIFICATION/);
    expect(refused.stderr).toContain("nothing was sent");
    expect(await devices()).toEqual([]);
  }
  const listed = await fixture.coveJson(["auth", "invite", "list"], { home: serverHome });
  expect(listed.invitations.map((entry) => entry.state)).toEqual(["open"]);

  // The same through the ProxyCommand target, at the tunnel itself: no tunnel opens.
  for (const kind of ["unknown", "wrong"]) {
    await sshd.pin(kind);
    await expect(
      openSshTunnel({ target: sshd.proxyTarget, remotePort: portOf(server) }),
    ).rejects.toThrow(/Host key verification failed|REMOTE HOST IDENTIFICATION/);
  }

  // The pinned key: pairing over SSH succeeds, and the command line carries the pins.
  await sshd.pin("correct");
  const paired = await fixture.pairOk(client, "box", invitation, ["--via", "ssh"]);
  expect((await devices())[0]).toMatchObject({ deviceId: paired.deviceId, neverConnected: true });
  const tunnel = await openSshTunnel({ target: sshd.proxyTarget, remotePort: portOf(server) });
  try {
    const [running] = await sshClients(sshd.clientConfig);
    expect(running.args).toContain("NoHostAuthenticationForLocalhost=no");
    expect(running.args).toContain("ForkAfterAuthentication=no");
    expect(running.args.includes("NoHostAuthenticationForProxyCommand=no")).toBe(
      await knowsProxyOption(fixture.env),
    );
  } finally {
    await tunnel.close();
  }
  const status = await fixture.coveJson(["--server", "box", "status"], { home: client });
  expect(status.serverId).toBe(paired.serverId);
  expect((await devices())[0].neverConnected).toBe(false);
  expect(await ssh.untouched()).toBe(true);
  await nothingLeft([tunnel.localPort]);
}, 120_000);

test("with ForkAfterAuthentication yes, a closed tunnel and a SIGKILLed command leave no ssh, helper or listener", async () => {
  const { fixture, sshd } = ssh;
  const server = await fixture.startAuthServer(fixture.home("server"), [], {
    sshTarget: sshd.target,
  });
  const remotePort = portOf(server);

  // Closed normally, over both targets: ssh stayed the supervisor's child, so closing ends it.
  const ports = [];
  for (const target of [sshd.target, sshd.proxyTarget]) {
    const tunnel = await openSshTunnel({ target, remotePort });
    ports.push(tunnel.localPort);
    expect(await connects(tunnel.localPort)).toBe(true);
    expect(await sshClients(sshd.clientConfig)).toHaveLength(1);
    await tunnel.close();
    await nothingLeft([tunnel.localPort]);
  }

  // A command holding a tunnel through the ProxyCommand target, killed with SIGKILL.
  const holder = spawn(
    process.execPath,
    [resolve(import.meta.dirname, "tunnel-holder.mjs"), sshd.proxyTarget, String(remotePort)],
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
    expect(await connects(Number(stdout.trim()))).toBe(true);
  } finally {
    holder.kill("SIGKILL");
  }
  expect(await exited).toBe("SIGKILL");
  await nothingLeft([...ports, Number(stdout.trim())]);
}, 120_000);
