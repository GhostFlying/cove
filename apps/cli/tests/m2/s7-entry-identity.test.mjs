import { readFile, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildMismatch } from "../../dist/session.js";
import { portOf } from "./auth-fixtures.mjs";
import { ECHO_LOOP, attachedTerminal, createSshFixture } from "./ssh-scenario.mjs";
import { sshClients } from "./sshd-fixture.mjs";

// m2 S7 (switching entries keeps the identity), loopback and SSH parts, against the compiled CLI
// and server and a task-owned sshd (sshd-fixture.mjs). One client paired over loopback has both
// entries (the invitation's SSH target is recorded too):
// - over either entry it sees the same serverId, tasks and runs, and a terminal attached over
//   loopback and then over SSH (--via) recovers the same run, with no duplicate task or server;
// - when the selected entry is unreachable the command fails, names the entries and --via, and
//   never tries the other entry;
// - an entry address that now reaches another data directory's server is refused with
//   SERVER_ID_MISMATCH before the token is sent.
// The tsnet part is T4's.

let ssh;
let recorders;

beforeEach(async () => {
  recorders = [];
  ssh = await createSshFixture();
});

afterEach(async () => {
  for (const recorder of recorders) await recorder.close();
  await ssh?.cleanup();
  ssh = undefined;
});

// A TCP proxy on 127.0.0.1 in front of `targetPort` that records every byte its clients sent and
// how many connections it accepted. Like a server moved to this address, it is reached with its
// own port in Host, which the server behind it accepts as a loopback literal.
async function recorder(targetPort) {
  const sent = [];
  const sockets = new Set();
  let accepted = 0;
  const server = createServer((inbound) => {
    accepted += 1;
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(inbound).add(upstream);
    inbound.on("data", (chunk) => {
      sent.push(chunk);
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => inbound.write(chunk));
    for (const [a, b] of [
      [inbound, upstream],
      [upstream, inbound],
    ]) {
      a.on("close", () => b.destroy());
      a.on("error", () => b.destroy());
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const recorded = {
    port: server.address().port,
    accepted: () => accepted,
    bytes: () => Buffer.concat(sent).toString("latin1"),
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
  recorders.push(recorded);
  return recorded;
}

async function paired() {
  const { fixture, sshd } = ssh;
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome, [], { sshTarget: sshd.target });
  const client = fixture.home("laptop");
  const record = await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation);
  const recordPath = join(client, "client", "servers", `${record.serverId}.json`);
  return { serverHome, server, client, record, recordPath };
}

// Rewrites the credential record at `path` with `change` applied (the test standing in for an
// entry whose address now leads elsewhere).
async function rewrite(path, change) {
  const current = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify(change(current)), { mode: 0o600 });
}

const connections = (log) => log.split("Connection from ").length - 1;

test("loopback and SSH reach the same server, tasks and runs; --via switches the entry of the same run", async () => {
  const { fixture, sshd } = ssh;
  const { serverHome, server, client, record } = await paired();
  expect(record.defaultEntry).toBe("loopback");
  expect(record.entries).toEqual({
    loopback: { port: portOf(server) },
    ssh: { target: sshd.target, port: portOf(server) },
  });
  const over = (via, args) =>
    fixture.coveJson(["--server", "box", ...(via ? ["--via", via] : []), ...args], {
      home: client,
    });

  await over(undefined, ["task", "create", "Shared task"]);
  const run = await over("ssh", [
    "terminal",
    "create",
    "--cwd",
    fixture.root,
    "--",
    "/bin/sh",
    "-c",
    ECHO_LOOP,
  ]);
  const viaLoopback = {
    status: await over(undefined, ["status"]),
    tasks: await over(undefined, ["task", "list"]),
    runs: await over(undefined, ["terminal", "list"]),
  };
  const viaSsh = {
    status: await over("ssh", ["status"]),
    tasks: await over("ssh", ["task", "list"]),
    runs: await over("ssh", ["terminal", "list"]),
  };
  expect(viaSsh.status.serverId).toBe(record.serverId);
  expect(viaLoopback.status.serverId).toBe(record.serverId);
  expect(viaSsh.tasks).toEqual(viaLoopback.tasks);
  // The same runs (their previews' check times differ between the two reads).
  const refs = (listed) => listed.runs.map((entry) => entry.run);
  expect(refs(viaSsh.runs)).toEqual(refs(viaLoopback.runs));
  expect(refs(viaSsh.runs)).toEqual([run]);

  // A terminal over loopback, then the same run over SSH (--via ssh): the second attach
  // recovers the first's output and continues the same run.
  const local = await ssh.session(client, "box", undefined);
  const first = await attachedTerminal(local.client, run, "loopback");
  await first.type("over-loopback\r");
  await first.sees("echo:over-loopback");
  await ssh.closeSession(local);
  const remote = await ssh.session(client, "box", "ssh");
  expect(remote.record.endpoint).not.toBe(`http://127.0.0.1:${portOf(server)}`);
  const second = await attachedTerminal(remote.client, run, "ssh");
  await second.sees("echo:over-loopback");
  await second.type("over-ssh\r");
  await second.sees("echo:over-ssh");
  await ssh.closeSession(remote);

  // No duplicate task, run, paired server or server process.
  expect((await over(undefined, ["task", "list"])).tasks).toHaveLength(1);
  expect((await over("ssh", ["terminal", "list"])).runs).toHaveLength(1);
  expect(
    (await fixture.coveJson(["remote", "list"], { home: client })).servers.map((s) => s.alias),
  ).toEqual(["box"]);
  expect(await fixture.serverRuns(server)).toBe(true);
  expect((await fixture.coveJson(["status"], { home: serverHome })).serverId).toBe(record.serverId);
}, 120_000);

test("an unreachable selected entry fails with the entries and --via, and the other entry is never tried", async () => {
  const { fixture, sshd } = ssh;
  const { server, client, recordPath } = await paired();

  // Default ssh, whose forward reaches nothing (the recorded port is closed on the target host);
  // the loopback entry is a recorder in front of the working server.
  const front = await recorder(portOf(server));
  const closed = await recorder(1);
  await closed.close();
  await rewrite(recordPath, (record) => ({
    ...record,
    defaultEntry: "ssh",
    entries: {
      loopback: { port: front.port },
      ssh: { target: sshd.target, port: closed.port },
    },
  }));
  const failed = await fixture.cove(["--server", "box", "status"], { home: client });
  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toContain("ENTRY_UNAVAILABLE");
  expect(failed.stderr).toContain("ssh");
  expect(failed.stderr).toContain("Entries of box: loopback, ssh");
  expect(failed.stderr).toContain("--via");
  expect(front.accepted()).toBe(0);
  expect(await sshClients(sshd.clientConfig)).toEqual([]);

  // Default loopback, which reaches nothing; the SSH entry would work. No ssh is started.
  const before = connections(sshd.log());
  await rewrite(recordPath, (record) => ({
    ...record,
    defaultEntry: "loopback",
    entries: {
      loopback: { port: closed.port },
      ssh: { target: sshd.target, port: portOf(server) },
    },
  }));
  const refused = await fixture.cove(["--server", "box", "status"], { home: client });
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("ENTRY_UNAVAILABLE");
  expect(refused.stderr).toContain("Entries of box: loopback, ssh");
  expect(connections(sshd.log())).toBe(before);
  // The entry named with --via works.
  const viaSsh = await fixture.coveJson(["--server", "box", "--via", "ssh", "status"], {
    home: client,
  });
  expect(viaSsh.serverId).toBeTruthy();
  // This record has no tsnet entry (the invitation named none): unavailable, nothing sent,
  // nothing else tried. The tsnet entry itself is s7-tsnet-entry's.
  const tsnet = await fixture.cove(["--server", "box", "--via", "tsnet", "status"], {
    home: client,
  });
  expect(tsnet.code).not.toBe(0);
  expect(tsnet.stderr).toContain("box has no tsnet entry; nothing was sent");
  expect(tsnet.stderr).toContain("ENTRY_UNAVAILABLE");
}, 120_000);

test("an entry address that reaches another data directory's server is refused before the token is sent", async () => {
  const { fixture, sshd } = ssh;
  const { client, record, recordPath } = await paired();
  const token = (await fixture.credential(client, record.serverId)).token;
  const other = await fixture.startAuthServer(fixture.home("other-server"), [], {
    sshTarget: sshd.target,
  });
  expect(other.record.serverId).not.toBe(record.serverId);

  for (const kind of ["loopback", "ssh"]) {
    const front = await recorder(portOf(other));
    await rewrite(recordPath, (current) => ({
      ...current,
      entries: {
        ...current.entries,
        [kind]: { ...current.entries[kind], port: front.port },
      },
    }));
    const via = kind === "ssh" ? ["--via", "ssh"] : [];
    const refused = await fixture.cove(["--server", "box", ...via, "status"], { home: client });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("SERVER_ID_MISMATCH");
    expect(refused.stderr).toContain("no token was sent");
    // The other server was asked for its identity and nothing else: no token, no Authorization.
    expect(front.accepted()).toBeGreaterThan(0);
    expect(front.bytes()).toContain("POST /bootstrap");
    expect(front.bytes()).not.toContain(token.split(".")[1]);
    expect(front.bytes().toLowerCase()).not.toContain("authorization");
  }
  expect(await ssh.untouched()).toBe(true);
}, 120_000);

// D12 with #175: the source builds decide when both sides report one (they do not depend on the
// platform); otherwise the build IDs, as before. The warning names what was compared.
test("the build warning compares source builds when both sides know one, else build IDs", () => {
  const a = "0.0.0+aaaaaaaaaaaaaaaa";
  const b = "0.0.0+bbbbbbbbbbbbbbbb";
  const s = "0.0.0+5555555555555555";
  const t = "0.0.0+7777777777777777";
  // One commit installed on two platforms: other build IDs, one source build.
  expect(buildMismatch({ buildVersion: a, sourceBuild: s }, b, s)).toBeNull();
  expect(buildMismatch({ buildVersion: a, sourceBuild: s }, a, t)).toBe(
    `source build ${s}, this CLI is source build ${t}`,
  );
  // A side without a source build: the build IDs, as before.
  expect(buildMismatch({ buildVersion: a }, a, s)).toBeNull();
  expect(buildMismatch({ buildVersion: a }, b, s)).toBe(`build ${a}, this CLI is build ${b}`);
  expect(buildMismatch({ buildVersion: a, sourceBuild: s }, b, null)).toBe(
    `build ${a}, this CLI is build ${b}`,
  );
});
