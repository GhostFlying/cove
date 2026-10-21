import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAuthFixture } from "./auth-fixtures.mjs";

// The negative control of the secret scan for superseded tokens (#159, auth-fixtures.mjs). Neither
// pairing nor a CLI rotation prints the token, and after the rotation the credential file holds
// only the new one, so the scan knows the token pairing issued only if it remembered it when the
// pairing command saved it. Planting that superseded token in a scanned file must fail the scan.
// The test reads the credential file with readFile, not through the fixture, so that it adds
// nothing to what the scan remembers.

let fixture;

beforeEach(async () => {
  fixture = await createAuthFixture();
});

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

test("a token superseded by a CLI rotation before cleanup is still found by the scan", async () => {
  const serverHome = fixture.home("server");
  await fixture.startAuthServer(serverHome);
  const client = fixture.home("client");
  const paired = await fixture.pairOk(client, "box", (await fixture.invite(serverHome)).invitation);
  const recordPath = join(client, "client", "servers", `${paired.serverId}.json`);
  const issued = JSON.parse(await readFile(recordPath, "utf8")).token;

  const rotated = await fixture.cove(["--server", "box", "auth", "device", "rotate"], {
    home: client,
  });
  expect(rotated.code).toBe(0);
  expect(rotated.stdout).not.toContain(issued.split(".")[1]);
  const current = JSON.parse(await readFile(recordPath, "utf8")).token;
  expect(current).not.toBe(issued);
  // The first use promotes the new token; the superseded one is no longer in any credential file.
  expect((await fixture.cove(["--server", "box", "status"], { home: client })).code).toBe(0);
  fixture.expectToken(client, paired.serverId, current);

  // Each part of the superseded token, planted in a scanned file, fails the scan.
  const planted = join(fixture.root, "planted.log");
  for (const value of [issued, issued.split(".")[1]]) {
    await writeFile(planted, `log line ${value}\n`);
    await expect(fixture.scanSecrets()).rejects.toThrow(`a secret is in files: ${planted}`);
  }
  await rm(planted);
  // Without the plant the scan passes, so the failure above was the planted token's.
  await fixture.scanSecrets();
}, 60_000);
