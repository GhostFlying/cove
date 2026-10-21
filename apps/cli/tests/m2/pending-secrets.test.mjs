import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { acceptWrite, readPending } from "../../dist/commands/_pending.js";

// m2 T0 ("秘密与操作记录的分界" item 5): a CLI pending record never holds a secret, and a
// request whose secrets were left out of it cannot be resent.

const authKey = "tskey-auth-k1234567890SECRET";
let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cove-pending-secrets-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

// The command arguments and session acceptWrite uses, with a client that records what it sends.
function command() {
  const sent = [];
  const args = { words: [], flags: new Map([["--home", [home]]]) };
  const session = {
    record: { serverId: "server-1" },
    client: {
      call: async (method, params) => {
        sent.push({ method, params });
        return {
          ok: true,
          value: { operation: { operationId: params.operationId, method, state: "accepted" } },
        };
      },
    },
  };
  return { args, session, sent };
}

async function pendingFiles() {
  const directory = join(home, "cli", "operations");
  return Promise.all(
    (await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")),
  );
}

test("a write with an input secret sends it but saves only the field name", async () => {
  const { args, session, sent } = command();
  const params = { operationId: "login-1", secrets: { authKey } };
  await acceptWrite(args, session, "server.tsnet.login", params);
  expect(sent).toEqual([{ method: "server.tsnet.login", params }]);
  const files = await pendingFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain(authKey);
  expect(JSON.parse(files[0])).toMatchObject({
    method: "server.tsnet.login",
    params: { operationId: "login-1" },
    omittedSecrets: ["authKey"],
  });

  // Resending is refused locally, naming the field and never the value.
  const refusal = await readPending(home, "login-1").catch((error) => error);
  expect(refusal.message).toMatch(
    /carried secrets \(authKey\).*cannot be resent; nothing was sent/,
  );
  expect(refusal.message).not.toContain(authKey);

  // Running the original command again with the same operation ID still works: the saved
  // request has the same intent, and this command's own secret goes with it.
  const again = command();
  const other = "tskey-auth-OTHERKEY1234567890";
  await acceptWrite(again.args, again.session, "server.tsnet.login", {
    operationId: "login-1",
    secrets: { authKey: other },
  });
  expect(again.sent[0].params).toEqual({ operationId: "login-1", secrets: { authKey: other } });
  expect((await pendingFiles()).join()).not.toMatch(/tskey-auth/);
});

test("a write whose secrets are only in its response stays resendable", async () => {
  const { args, session } = command();
  await acceptWrite(args, session, "auth.invite.create", { operationId: "invite-1" });
  const saved = await readPending(home, "invite-1");
  expect(saved).toMatchObject({
    method: "auth.invite.create",
    params: { operationId: "invite-1" },
  });
  expect(saved).not.toHaveProperty("omittedSecrets");
});

test("a saved record that holds secrets or undeclared omissions is invalid", async () => {
  const directory = join(home, "cli", "operations");
  const { args, session } = command();
  await acceptWrite(args, session, "auth.invite.create", { operationId: "seed" });
  const write = (operationId, record) =>
    writeFile(join(directory, `${operationId}.json`), JSON.stringify(record));
  const base = { version: 1, serverId: "server-1", savedAtMs: 1 };
  await write("held", {
    ...base,
    method: "server.tsnet.login",
    params: { operationId: "held", secrets: { authKey } },
  });
  await write("undeclared", {
    ...base,
    method: "auth.invite.create",
    params: { operationId: "undeclared" },
    omittedSecrets: ["invitation"],
  });
  for (const operationId of ["held", "undeclared"])
    await expect(readPending(home, operationId)).rejects.toThrow(/is invalid/);
});
