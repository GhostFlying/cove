import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAuthFixture, portOf } from "./auth-fixtures.mjs";
import { endDaemon, withTsnetEntry } from "./tsnet-fixtures.mjs";

// m2 S8 (D14): a tsnet entry's streams for later connections are checked like its first one, and
// when one is refused (the node was held after a login, or the server node's address now answers
// as another node) the command's error names the reason, not only the closed connection the
// client sees. The daemon is the scripted fake (tsnet-fake-dial.mjs): it forwards a command's
// first stream (the bootstrap identity check) to a real Cove server and refuses the later ones.

const fake = resolve(import.meta.dirname, "tsnet-fake-dial.mjs");

let fixture;
let client;
let configPath;
let eventsPath;
let businessPort;

beforeEach(async () => {
  fixture = await createAuthFixture();
  const serverHome = fixture.home("server");
  businessPort = portOf(await fixture.startAuthServer(serverHome));
  const wrapper = join(fixture.root, "cove-tsnet");
  await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`);
  await chmod(wrapper, 0o755);
  configPath = join(fixture.root, "fake.json");
  eventsPath = join(fixture.root, "events.jsonl");
  Object.assign(fixture.env, { COVE_TSNET_BINARY: wrapper, COVE_TEST_FAKE_DIAL: configPath });
  client = fixture.home("c");
  // Paired over loopback with an invitation that also names a tsnet node, so the record has a
  // tsnet entry at the business port.
  const { invitation } = await fixture.invite(serverHome);
  const advertised = withTsnetEntry(invitation, {
    stableNodeID: "nSERVER1",
    name: "cove-srv.tail-scale.ts.net",
  });
  fixture.remember(advertised);
  await fixture.pairOk(client, "box", advertised);
});

afterEach(async () => {
  await endDaemon(client);
  await fixture.cleanup();
});

const dials = async () =>
  (await readFile(eventsPath, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.op === "dial");

test("a hold or a mismatch that starts after the bootstrap stream is named in the command's error", async () => {
  const cases = [
    {
      error: {
        code: "IDENTITY_CHANGED",
        message: "enrolled as nOLD, logged in as nNEW; paired clients must pair again",
      },
      expected: [
        "held after a login (IDENTITY_CHANGED: enrolled as nOLD, logged in as nNEW",
        "see `cove remote tsnet status`",
      ],
    },
    {
      error: { code: "PEER_MISMATCH", message: "100.64.0.9 answered WhoIs as nOTHER" },
      expected: ["answered as another node (PEER_MISMATCH: 100.64.0.9 answered WhoIs as nOTHER)"],
    },
  ];
  for (const { error, expected } of cases) {
    await writeFile(
      configPath,
      JSON.stringify({
        build: "b1",
        protocol: 1,
        events: eventsPath,
        dialForward: businessPort,
        dialPeer: "nSERVER1",
        laterDials: { ok: false, error },
      }),
    );
    const before = (await dials()).length;
    const result = await fixture.cove(["--server", "box", "--via", "tsnet", "status"], {
      home: client,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the tsnet entry refused a later connection");
    for (const text of expected) expect(result.stderr).toContain(text);
    expect(result.stderr).toContain("the request on that connection was not sent");
    // The bootstrap stream passed; a later one was refused.
    expect((await dials()).length - before).toBeGreaterThanOrEqual(2);
  }
}, 120_000);
