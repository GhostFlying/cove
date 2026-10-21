import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createRecordingView, waitFor } from "../recording-view.mjs";
import { registeredRemote } from "../m1/s3-worktree-remotes.mjs";
import { createAuthFixture, payloadOf } from "./auth-fixtures.mjs";

// m2 S4 (revocation with live connections, D8), against the compiled CLI and server. Device A
// holds terminal control of a run and has an accepted operation still executing (held by a Git
// wrapper on the server's PATH); device B is attached to the same run. Revoking A closes its
// terminal WebSocket with the policy code, releases control without a resize, refuses A from
// then on (its own past operations included), lets the accepted operation finish for B to read,
// leaves B alone, cancels A's open invitation, and answers only after A's connections closed.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

function realGit() {
  return new Promise((done, fail) =>
    execFile("/bin/sh", ["-c", "command -v git"], { env: fixture.env }, (error, stdout) =>
      error ? fail(error) : done(stdout.trim()),
    ),
  );
}

// A `git` that holds the worktree-branch step until <control>/release exists (as in m1 S8).
async function installWrapper() {
  const control = join(fixture.root, "git-control");
  const bin = join(fixture.root, "git-bin");
  await mkdir(control, { recursive: true });
  await mkdir(bin, { recursive: true });
  const script = `#!/bin/sh
case "$*" in
  *"update-ref --no-deref --create-reflog -m cove: create worktree branch"*)
    echo $$ > "${control}/blocked.pid"
    while [ ! -e "${control}/release" ]; do /bin/sleep 0.1; done ;;
esac
exec "${await realGit()}" "$@"
`;
  await writeFile(join(bin, "git"), script);
  await chmod(join(bin, "git"), 0o755);
  fixture.env.PATH = `${bin}:${fixture.env.PATH}`;
  return {
    release: () => writeFile(join(control, "release"), ""),
    blockedPid: () =>
      readFile(join(control, "blocked.pid"), "utf8").then(
        (text) => Number(text.trim()),
        () => null,
      ),
  };
}

async function attached(client, run, viewId) {
  expect((await client.connect()).ok).toBe(true);
  const recording = createRecordingView({ cols: 80, rows: 24 });
  const opened = client.openTerminal({
    run,
    viewId,
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  expect(opened.ok).toBe(true);
  const controller = opened.value;
  expect(await controller.attach()).toMatchObject({ ok: true });
  await waitFor(`${viewId} to show the run`, () => recording.text().includes("loop-ready"));
  return { controller, recording };
}

test("revoking a device with control and an executing operation closes it, keeps its work and leaves other devices alone", async () => {
  const wrapper = await installWrapper();
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const alpha = await registeredRemote(fixture, serverHome, "alpha");
  const run = await fixture.coveJson(
    [
      ...["terminal", "create", "--cwd", fixture.root, "--cols", "80", "--rows", "24"],
      ...["--", "/bin/sh", "-c", 'printf "loop-ready\\n"; while read line; do echo "$line"; done'],
    ],
    { home: serverHome },
  );

  const homeA = fixture.home("device-a");
  const homeB = fixture.home("device-b");
  const a = await fixture.pairOk(homeA, "box", (await fixture.invite(serverHome)).invitation);
  const b = await fixture.pairOk(homeB, "box", (await fixture.invite(serverHome)).invitation);
  const tokenA = (await fixture.credential(homeA, a.serverId)).token;
  const tokenB = (await fixture.credential(homeB, b.serverId)).token;

  // A: control of the run. B: attached to the same run.
  const clientA = await fixture.deviceClient(server, tokenA);
  const clientB = await fixture.deviceClient(server, tokenB);
  const viewA = await attached(clientA.client, run, "device-a-view");
  const viewB = await attached(clientB.client, run, "device-b-view");
  expect(viewA.controller.setInputTarget(true, true)).toMatchObject({ ok: true });
  const focus = await viewA.controller.requestFocus({ cols: 80, rows: 24 });
  expect(focus).toMatchObject({ ok: true });
  const held = await fixture.coveJson(["--server", "box", "terminal", "get", run.runId], {
    home: homeB,
  });
  expect(held.geometry).toEqual({ cols: 80, rows: 24 });
  // B sees A's subscription as the holder.
  const holder = () => viewB.controller.snapshot().appliedAuthority?.holder ?? null;
  await waitFor("B to see A holding control", () => holder()?.viewId === "device-a-view");

  // A: an open invitation and an accepted operation that is still executing.
  const invitationA = await fixture.coveJson(["--server", "box", "auth", "invite", "create"], {
    home: homeA,
  });
  const operationId = "s4-task-a";
  const pending = fixture.spawnCove(
    [
      ...["--server", "box", "task", "create", "Held", "--worktree", alpha.repoId],
      ...["--operation-id", operationId],
    ],
    { home: homeA },
  );
  let pid = null;
  await waitFor(
    "A's held Git step",
    async () => (pid = await wrapper.blockedPid()) !== null,
    30_000,
  );
  await fixture.trackPid(pid);

  // Revoke A from the owner. The answer comes only after A's connections closed.
  const revoked = await fixture.cove(["auth", "device", "revoke", a.deviceId], {
    home: serverHome,
  });
  expect(revoked.stderr).toBe("");
  expect(revoked.code).toBe(0);
  expect(JSON.parse(revoked.stdout)).toMatchObject({ state: "succeeded" });
  expect(JSON.parse(revoked.stdout).result).not.toHaveProperty("unclosedConnections");
  await waitFor("A's terminal socket to close", () => clientA.closes.length > 0, 5_000);
  expect(clientA.closes).toContain(1008);
  expect(clientB.closes).toEqual([]);

  // Control is released, without a resize.
  const released = await fixture.coveJson(["--server", "box", "terminal", "get", run.runId], {
    home: homeB,
  });
  await waitFor("B to see control released", () => holder() === null, 5_000);
  expect(released.geometry).toEqual({ cols: 80, rows: 24 });
  expect(viewB.controller.snapshot().appliedGeometry?.geometry).toEqual({ cols: 80, rows: 24 });

  // A is refused on every path from now on, its own operations included.
  for (const args of [["status"], ["operation", "get", operationId], ["auth", "device", "list"]]) {
    const result = await fixture.cove(["--server", "box", ...args], { home: homeA });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("DEVICE_REVOKED");
    expect(result.stdout).toBe("");
  }
  const again = await fixture.deviceClient(server, tokenA);
  const reconnect = await again.client.connect();
  expect(reconnect.ok).toBe(false);
  again.client.dispose();

  // The accepted operation still completes, and B reads its outcome.
  await wrapper.release();
  await waitFor(
    "A's task to finish",
    async () => {
      const operation = await fixture.coveJson(
        ["--server", "box", "operation", "get", operationId],
        {
          home: homeB,
        },
      );
      return operation.state === "succeeded";
    },
    30_000,
  );
  // A's own CLI polling it was refused rather than told an outcome.
  const ended = await pending.done;
  expect(ended.code).not.toBe(0);

  // B is unaffected: its terminal still works and its connection stayed.
  expect(viewB.controller.setInputTarget(true, true)).toMatchObject({ ok: true });
  const sent = await viewB.controller.requestFocus({ cols: 80, rows: 24 });
  expect(sent).toMatchObject({ ok: true });
  expect(
    await viewB.controller.sendInput({
      source: "keyboard",
      bytes: new TextEncoder().encode("after-revoke\r"),
    }),
  ).toMatchObject({ ok: true });
  await waitFor("B's echo", () => viewB.recording.text().includes("after-revoke"));
  expect(clientB.closes).toEqual([]);
  const live = await fixture.coveJson(["terminal", "get", run.runId], { home: serverHome });
  expect(live.status).toBe("live");

  // A's open invitation was cancelled with it; A is listed revoked.
  const { invitations } = await fixture.coveJson(["auth", "invite", "list"], { home: serverHome });
  expect(invitations).toContainEqual(
    expect.objectContaining({
      inviteId: payloadOf(invitationA.invitation).inviteId,
      state: "cancelled",
    }),
  );
  const devices = await fixture.coveJson(["auth", "device", "list", "--include-revoked"], {
    home: serverHome,
  });
  expect(devices.devices).toContainEqual(
    expect.objectContaining({ deviceId: a.deviceId, revokedAtMs: expect.any(Number) }),
  );
  expect(
    (await fixture.coveJson(["auth", "device", "list"], { home: serverHome })).devices.map(
      (device) => device.deviceId,
    ),
  ).toEqual([b.deviceId]);
  clientA.client.dispose();
  clientB.client.dispose();
}, 120_000);

// A device revoking itself from the CLI while another client of the same device holds control of
// a live run: the server closes that client and the CLI's own terminal channel before it answers,
// and the CLI still gets the answer (sent on a request of its own), which reports no unclosed
// connection; control is released without a resize, and the device is refused afterwards.
test("a device revoking itself while holding control gets the answer after its connections closed", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const run = await fixture.coveJson(
    [
      ...["terminal", "create", "--cwd", fixture.root, "--cols", "80", "--rows", "24"],
      ...["--", "/bin/sh", "-c", 'printf "loop-ready\\n"; while read line; do echo "$line"; done'],
    ],
    { home: serverHome },
  );
  const home = fixture.home("device");
  const device = await fixture.pairOk(home, "box", (await fixture.invite(serverHome)).invitation);
  const token = (await fixture.credential(home, device.serverId)).token;
  const holding = await fixture.deviceClient(server, token);
  const view = await attached(holding.client, run, "self-view");
  expect(view.controller.setInputTarget(true, true)).toMatchObject({ ok: true });
  expect(await view.controller.requestFocus({ cols: 80, rows: 24 })).toMatchObject({ ok: true });
  const owner = await fixture.deviceClient(server, null);
  const watcher = await attached(owner.client, run, "owner-view");
  const holder = () => watcher.controller.snapshot().appliedAuthority?.holder ?? null;
  await waitFor(
    "the owner to see the device holding control",
    () => holder()?.viewId === "self-view",
  );

  const revoked = await fixture.cove(
    ["--server", "box", "auth", "device", "revoke", device.deviceId],
    { home },
  );
  expect(revoked.stderr).toBe("");
  expect(revoked.code).toBe(0);
  const record = JSON.parse(revoked.stdout);
  expect(record).toMatchObject({ state: "succeeded", result: { deviceId: device.deviceId } });
  expect(record.result).not.toHaveProperty("unclosedConnections");
  // The holding client was closed before the answer, and control released without a resize.
  expect(holding.closes).toContain(1008);
  await waitFor("the owner to see control released", () => holder() === null, 5_000);
  expect(watcher.controller.snapshot().appliedGeometry?.geometry).toEqual({ cols: 80, rows: 24 });
  expect(owner.closes).toEqual([]);

  const after = await fixture.cove(["--server", "box", "status"], { home });
  expect(after.code).not.toBe(0);
  expect(after.stderr).toContain("DEVICE_REVOKED");
  holding.client.dispose();
  owner.client.dispose();
}, 60_000);

// The same with a connection of the device that does not close: the answer counts it, and the
// CLI reports the revocation as done but not confirmed (exit 1).
test("a device revoking itself is told about a connection that did not close", async () => {
  const serverHome = fixture.home("server");
  const server = await fixture.startAuthServer(serverHome);
  const home = fixture.home("device");
  const device = await fixture.pairOk(home, "box", (await fixture.invite(serverHome)).invitation);
  const token = (await fixture.credential(home, device.serverId)).token;
  const stubborn = await fixture.stubbornTerminal(server, token);

  const revoked = await fixture.cove(
    ["--server", "box", "auth", "device", "revoke", device.deviceId],
    { home },
  );
  expect(revoked.code).toBe(1);
  const record = JSON.parse(revoked.stdout);
  expect(record).toMatchObject({ state: "succeeded", result: { unclosedConnections: 1 } });
  expect(revoked.stderr).toContain("1 of its connections had not closed");
  expect(stubborn.closed()).toBe(false);
  const after = await fixture.cove(["--server", "box", "status"], { home });
  expect(after.stderr).toContain("DEVICE_REVOKED");
}, 60_000);
