import { afterEach, expect, test } from "vitest";
import { BusinessFrameSchema } from "@cove/protocol/business-events";
import { bootstrapFailure } from "@cove/protocol/bootstrap";
import { readBusinessEvents } from "../../dist/commands/_events.js";
import { createAuthFixture } from "../m2/auth-fixtures.mjs";
import { waitFor } from "../recording-view.mjs";

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const value = await createAuthFixture();
  cleanup.push(() => value.cleanup());
  return value;
}

function stream(f, home, args = []) {
  const running = f.spawnCove(["events", "--json", ...args], { home });
  let text = "";
  running.child.stdout.on("data", (bytes) => {
    text += bytes.toString("utf8");
  });
  return {
    ...running,
    frames: () =>
      text
        .split("\n")
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => {
          const frame = JSON.parse(line);
          expect(BusinessFrameSchema.safeParse(frame).success).toBe(true);
          return frame;
        }),
  };
}

test("events rejects usage and cursor/filter errors before opening a server session", async () => {
  const f = await fixture();
  const home = f.home("no-server");
  for (const args of [
    ["events"],
    ["events", "--json", "extra"],
    ["events", "--json", "--since", "{}"],
    ["events", "--json", "--kind", "unknown"],
    ["events", "--json", "--since", "not-json"],
  ]) {
    const result = await f.cove(args, { home });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("No local server");
  }
});

test("compiled events CLI snapshots, advances filtered empty cursors, resumes and reports reset with code3", async () => {
  const f = await fixture();
  const home = f.home("server");
  const server = await f.startAuthServer(home);
  const first = stream(f, home, ["--kind", "task", "--kind", "task"]);
  await waitFor(
    "CLI business snapshot ready",
    () => first.frames().some((frame) => frame.type === "ready"),
    10_000,
  );
  expect(first.frames().some((frame) => frame.type === "snapshot-end")).toBe(true);
  const initial = first.frames().findLast((frame) => frame.cursor).cursor;
  expect(initial.filter).toBe("task");
  await f.coveJson(
    ["config", "set", "workspaceRoot", f.home("workspaces"), "--operation-id", "events-config"],
    { home },
  );
  await waitFor(
    "filtered empty watermark",
    () => first.frames().some((frame) => frame.type === "changes" && frame.changes.length === 0),
    10_000,
  );
  const captured = first.frames().findLast((frame) => frame.cursor).cursor;
  first.child.kill("SIGTERM");
  expect((await first.done).code).toBe(143);
  const created = await f.coveJson(
    ["task", "create", "cli-events", "--operation-id", "events-create"],
    { home },
  );
  const taskId = created.task.taskId;
  const resumed = stream(f, home, ["--kind", "task", "--since", JSON.stringify(captured)]);
  await waitFor(
    "CLI replay ready",
    () => resumed.frames().some((frame) => frame.type === "ready"),
    10_000,
  );
  expect(resumed.frames().some((frame) => frame.type === "snapshot-begin")).toBe(false);
  expect(
    resumed
      .frames()
      .flatMap((frame) => frame.changes ?? [])
      .some((change) => change.value?.kind === "task" && change.value.id === taskId),
  ).toBe(true);
  resumed.child.kill("SIGINT");
  expect((await resumed.done).code).toBe(130);
  const reset = stream(f, home, ["--kind", "repo", "--since", JSON.stringify(captured)]);
  const resetResult = await reset.done;
  expect(resetResult.code).toBe(3);
  expect(reset.frames()).toEqual([{ type: "reset", reason: "filter" }]);
  expect(server.wrapper.exitCode).toBeNull();
}, 30_000);

test("paired CLI event stream uses its device credential and exits on actual revocation", async () => {
  const f = await fixture();
  const home = f.home("server");
  await f.startAuthServer(home);
  const invitation = await f.invite(home);
  const deviceHome = f.home("device");
  const paired = await f.pairOk(deviceHome, "box", invitation.invitation);
  const events = stream(f, deviceHome, ["--server", "box"]);
  await waitFor(
    "paired CLI events ready",
    () => events.frames().some((frame) => frame.type === "ready"),
    10_000,
  );
  await f.coveJson(
    ["auth", "device", "revoke", paired.deviceId, "--operation-id", "events-revoke"],
    { home },
  );
  const result = await events.done;
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/closed|DEVICE_REVOKED/);
}, 20_000);

test("credential cancellation settles without opening a late channel", async () => {
  const abort = new AbortController();
  let opened = 0;
  let release;
  const provider = new Promise((done) => {
    release = done;
  });
  const pending = readBusinessEvents({
    target: { serverId: "server", relayInstanceId: "instance" },
    buildVersion: "fixture",
    credentials: () => provider,
    port: {
      open() {
        opened++;
        throw new Error("must not open");
      },
    },
    request: { type: "subscribe", filter: {} },
    signal: abort.signal,
    frame: async () => {},
  });
  abort.abort();
  expect(await pending).toBe(130);
  release({ authorization: "Bearer fixture", terminalSecret: "s".repeat(43) });
  await Promise.resolve();
  expect(opened).toBe(0);
});

test("reader preserves explicit bootstrap refusal and does not log malformed private JSON", async () => {
  const attempts = [
    { text: JSON.stringify(bootstrapFailure("DEVICE_REVOKED")), expected: "DEVICE_REVOKED" },
    { text: '{"private":"synthetic-sensitive-value"', expected: "Invalid business event JSON" },
  ];
  for (const attempt of attempts) {
    const closed = [];
    const pending = readBusinessEvents({
      target: { serverId: "server", relayInstanceId: "instance" },
      buildVersion: "fixture",
      credentials: () => ({ authorization: "Bearer fixture", terminalSecret: "s".repeat(43) }),
      port: {
        open(callbacks) {
          const connection = {
            send() {
              queueMicrotask(() => callbacks.onText(new TextEncoder().encode(attempt.text)));
              return "handed-off";
            },
            close() {
              closed.push(true);
            },
            dispose() {},
          };
          callbacks.onOpen(connection);
          return { cancel: () => "handed-off" };
        },
      },
      request: { type: "subscribe", filter: {} },
      signal: new AbortController().signal,
      frame: async () => {},
    });
    await expect(pending).rejects.toThrow(attempt.expected);
    await expect(pending).rejects.not.toThrow("synthetic-sensitive-value");
    expect(closed.length).toBeGreaterThan(0);
  }
});
