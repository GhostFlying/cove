import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
  unlink,
  readdir,
  realpath,
  mkdir,
  chmod,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalApplication } from "../../dist/entry/main.js";
import { validateLocalOptions, parseLocalOptions } from "../../dist/entry/m0-local-options.js";
import { LocalRendezvous, launchIdentity } from "../../dist/entry/local-rendezvous.js";
import { LocalRuntimeClock } from "../../dist/terminal/local-runtime-clock.js";
import { WorkerProcess } from "../../dist/terminal/worker-process.js";
import { actualHeaders } from "../../dist/transport/local-admission.js";
import { TerminalWebSocket } from "../../dist/transport/terminal-websocket.js";
import { rpcBody } from "../../dist/transport/http-rpc.js";
import { createPipeDecoder, encodePipeFrame } from "@cove/protocol/pipe";
import { encodeTerminalFrame, MAX_FRAME_BYTES } from "@cove/protocol/terminal";
import { PROFILE, BASELINE_ENCODING } from "@cove/protocol/profile";
import { REQUIRED_CAPABILITIES } from "@cove/protocol/bootstrap";
import { M0_LIMITS } from "@cove/protocol/budgets";

async function recordAuthor(name, data) {
  const sink = process.env.COVE_D_AUTHOR_OUTPUT;
  if (!sink) return;
  await mkdir(sink, { recursive: true });
  await writeFile(join(sink, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}
const identity = {
  serverId: "author-server",
  relayInstanceId: "author-instance",
  secret: "s".repeat(43),
};
const options = {
  mode: "m0-local",
  host: "127.0.0.1",
  port: 32123,
  rendezvousPath: join(tmpdir(), "cove-author-rendezvous"),
  allowedOrigins: ["http://127.0.0.1:32124"],
};
const bootstrap = {
  type: "cove-bootstrap",
  bootstrapVersion: 1,
  protocolVersion: 2,
  buildVersion: "different-build",
  capabilities: [...REQUIRED_CAPABILITIES],
  profiles: [PROFILE],
  encodings: [BASELINE_ENCODING],
};
const auth = { host: "127.0.0.1:32123", authorization: `Bearer ${identity.secret}` };
const business = {
  ...auth,
  "cove-protocol": "2",
  "cove-server-id": identity.serverId,
  "cove-instance-id": identity.relayInstanceId,
};
const statusCall = { jsonrpc: "2.0", id: "status", method: "server.status", params: {} };
const utf8 = (input) => Buffer.from(JSON.stringify(input));
async function withApp(body, budgets = { ...M0_LIMITS }) {
  const local = createLocalApplication(options, { identity, budgets });
  try {
    await local.app.ready();
    return await body(local);
  } finally {
    await local.app.close();
    local.disposeCore();
  }
}
class Socket extends EventEmitter {
  sent = [];
  codes = [];
  send(bytes, callback) {
    this.sent.push(typeof bytes === "string" ? bytes : Buffer.from(bytes));
    callback();
  }
  close(code) {
    this.codes.push(code);
  }
  finish() {
    this.emit("close");
    this.emit("close");
  }
}
function timerFixture() {
  const jobs = new Set();
  return {
    jobs,
    set: (callback) => {
      jobs.add(callback);
      return callback;
    },
    clear: (callback) => jobs.delete(callback),
    fire: () => {
      const first = jobs.values().next().value;
      if (first) {
        jobs.delete(first);
        first();
      }
    },
  };
}
async function withWs(body, budgets = { ...M0_LIMITS }) {
  await withApp(async (local) => {
    const timer = timerFixture();
    let now = 0;
    const terminal = new TerminalWebSocket(
      local.admission,
      local.core,
      local.arbiter,
      () => now,
      timer,
    );
    const peers = [];
    const open = () => {
      const prepared = terminal.prepare(auth);
      expect(prepared.kind).toBe("accepted");
      const socket = new Socket();
      peers.push(socket);
      terminal.accept(socket, prepared.claim);
      return socket;
    };
    try {
      await body({
        local,
        terminal,
        timer,
        open,
        time: (value) => {
          now = value;
        },
      });
    } finally {
      terminal.close();
      for (const peer of peers) peer.finish();
    }
  }, budgets);
}

describe("D passive production local entry", () => {
  it("D-A01 explicit numeric options refuse implicit modes and foreign bind authorities", () => {
    expect(validateLocalOptions(options).host).toBe("127.0.0.1");
    expect(validateLocalOptions({ ...options, host: "::1", port: 0 }).host).toBe("::1");
    for (const change of [
      { mode: "remote" },
      { host: "0.0.0.0" },
      { host: "localhost" },
      { port: 65536 },
      { rendezvousPath: "relative" },
      { allowedOrigins: ["null"] },
    ])
      expect(() => validateLocalOptions({ ...options, ...change })).toThrow(
        "Invalid explicit m0-local options",
      );
    expect(() => parseLocalOptions(["--port", "32123"])).toThrow(
      "Invalid explicit m0-local options",
    );
  });
  it("D-A02 the registered passive bootstrap authenticates and redacts the per-launch secret", async () => {
    await withApp(async ({ app, core }) => {
      expect(app.server.listening).toBe(false);
      const good = await app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: auth,
        payload: utf8(bootstrap),
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().type).toBe("cove-bootstrap-result");
      expect(good.body).not.toContain(identity.secret);
      for (const headers of [
        { ...auth, host: "localhost:32123" },
        { ...auth, origin: "null" },
        { ...auth, origin: "http://hostile" },
        { ...auth, authorization: "Bearer wrong" },
      ]) {
        const result = await app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload: utf8(bootstrap),
        });
        expect([401, 403]).toContain(result.statusCode);
        expect(result.body).not.toContain(identity.secret);
      }
      expect(core.runtime.pool.snapshot().workers).toBe(0);
    });
  });
  it("D-A03 actual fetch headers require browser Origin while CLI absence stays eligible", async () => {
    await withApp(async ({ app }) => {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/bootstrap",
            headers: { ...auth, "sec-fetch-mode": "cors" },
            payload: utf8(bootstrap),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/bootstrap",
            headers: { ...auth, "sec-fetch-mode": "cors", origin: options.allowedOrigins[0] },
            payload: utf8(bootstrap),
          })
        ).statusCode,
      ).toBe(200);
    });
  });
  it("D-A04 real registered OPTIONS and per-request metadata never bypass domain admission", async () => {
    await withApp(async ({ app, core }) => {
      const preflight = {
        host: auth.host,
        origin: options.allowedOrigins[0],
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type,Cove-Protocol",
      };
      expect(
        (await app.inject({ method: "OPTIONS", url: "/rpc", headers: preflight })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "OPTIONS",
            url: "/rpc",
            headers: { ...preflight, "access-control-request-headers": "X-Foreign" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: auth,
            payload: utf8(statusCall),
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: { ...business, "cove-instance-id": "foreign" },
            payload: utf8(statusCall),
          })
        ).statusCode,
      ).toBe(409);
      const result = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8(statusCall),
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().result.health).toBe("unverifiable");
      expect(core.runtime.registry.count).toBe(0);
    });
  });
  it("D-A05 framework byte readers admit exact encoded caps and refuse cap plus one", async () => {
    await withApp(async ({ app, admission }) => {
      for (const [url, value, cap, headers] of [
        ["/bootstrap", bootstrap, 8192, auth],
        ["/rpc", statusCall, 65536, business],
      ]) {
        const data = utf8(value);
        const payload = Buffer.concat([data, Buffer.alloc(cap - data.length, 32)]);
        expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(200);
        expect(
          (
            await app.inject({
              method: "POST",
              url,
              headers,
              payload: Buffer.concat([payload, Buffer.from(" ")]),
            })
          ).statusCode,
        ).toBe(413);
      }
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A06 classifier batch and notification behavior remain schema-bound without partial writes", async () => {
    await withApp(async ({ app, core, admission }) => {
      const batch = Array.from({ length: 16 }, (_, id) => ({ ...statusCall, id }));
      expect(
        (
          await app.inject({ method: "POST", url: "/rpc", headers: business, payload: utf8(batch) })
        ).json(),
      ).toHaveLength(16);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: business,
            payload: utf8([...batch, statusCall]),
          })
        ).json(),
      ).toMatchObject([{ error: { code: -32600 } }]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/rpc",
            headers: business,
            payload: utf8({ jsonrpc: "2.0", method: "terminal.create", params: {} }),
          })
        ).statusCode,
      ).toBe(204);
      expect(core.runtime.registry.count).toBe(0);
      const snapshot = core.runtime.pool.snapshot.bind(core.runtime.pool);
      let dispatched = 0;
      core.runtime.pool.snapshot = () => {
        dispatched++;
        return snapshot();
      };
      const notification = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8({ jsonrpc: "2.0", method: "server.status", params: {} }),
      });
      await recordAuthor("A06-notification", {
        status: notification.statusCode,
        body: notification.body,
        headers: notification.headers,
        dispatched,
        quota: admission.snapshot(),
      });
      expect(notification.statusCode).toBe(204);
      expect(notification.body).toBe("");
      expect(dispatched).toBe(1);
    });
  });
  it("D-A07 in-flight readers hold ownership until the correlated domain completion", async () => {
    await withApp(async ({ app, admission, core }) => {
      const held = [];
      core.operations.create = (_principal, params) =>
        new Promise((resolve) =>
          held.push(() =>
            resolve({
              operation: {
                operationId: params.operationId,
                method: "terminal.create",
                revision: 0,
                state: "accepted",
                run: {
                  serverId: identity.serverId,
                  relayInstanceId: identity.relayInstanceId,
                  runId: params.operationId,
                },
              },
            }),
          ),
        );
      const call = (id) => ({
        jsonrpc: "2.0",
        id,
        method: "terminal.create",
        params: {
          operationId: `operation-${id}`,
          expectedRelayInstanceId: identity.relayInstanceId,
          executable: "/bin/sh",
          argv: [],
          cwd: "/tmp",
          geometry: { cols: 80, rows: 24 },
        },
      });
      const pending = Array.from({ length: 32 }, (_, id) =>
        app.inject({ method: "POST", url: "/rpc", headers: business, payload: utf8(call(id)) }),
      );
      try {
        for (let turn = 0; turn < 100 && held.length !== 32; turn++)
          await new Promise(setImmediate);
        expect(held).toHaveLength(32);
        expect(admission.snapshot().rpc).toBe(32);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/rpc",
              headers: business,
              payload: utf8(call(33)),
            })
          ).statusCode,
        ).toBe(429);
        expect(held).toHaveLength(32);
      } finally {
        for (const finish of held) finish();
        await Promise.all(pending);
      }
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A08 unauthenticated upgrade slots reserve before carrier ownership and release once", async () => {
    await withApp(async ({ admission, terminal }) => {
      const claims = Array.from({ length: 8 }, () => terminal.prepare(auth));
      expect(claims.every((x) => x.kind === "accepted")).toBe(true);
      expect(terminal.prepare(auth).kind).toBe("busy");
      expect(terminal.prepare({ ...auth, host: "foreign" }).kind).toBe("forbidden");
      for (const x of claims) {
        x.claim.release();
        x.claim.release();
      }
      expect(admission.snapshot().unauthenticated).toBe(0);
    });
  });
  it("D-A09 pre-auth binary business is refused and close requests are not physical-close proof", async () => {
    await withWs(async ({ open, local }) => {
      const peer = open();
      peer.emit("message", Buffer.from([1, 2, 3]), true);
      expect(peer.codes).toEqual([1002]);
      expect(local.admission.snapshot().unauthenticated).toBe(1);
      expect(local.core.runtime.registry.count).toBe(0);
      peer.finish();
      expect(local.admission.snapshot().unauthenticated).toBe(0);
    });
  });
  it("D-A10 first-message monotonic equality and timeout ordering cannot resurrect authentication", async () => {
    await withWs(async ({ open, time, timer, local }) => {
      const eligible = open();
      time(5000);
      eligible.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(JSON.parse(eligible.sent[0]).type).toBe("cove-bootstrap-result");
      eligible.finish();
      const late = open();
      time(10001);
      late.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(late.codes).toEqual([1008]);
      late.finish();
      const expired = open();
      timer.fire();
      expired.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(expired.sent).toHaveLength(0);
      expired.finish();
      expect(local.admission.snapshot().authenticated).toBe(0);
    });
  });
  it("D-A11 authenticated maximum preserves healthy peers and refuses promotion plus one", async () => {
    for (const cap of [32, 2]) {
      await withWs(
        async ({ open, local }) => {
          const peers = Array.from({ length: cap }, () => {
            const peer = open();
            peer.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
            return peer;
          });
          expect(
            peers.every(
              (peer) =>
                peer.codes.length === 0 &&
                JSON.parse(peer.sent[0]).type === "cove-bootstrap-result",
            ),
          ).toBe(true);
          expect(local.admission.snapshot().authenticated).toBe(cap);
          const refused = open();
          refused.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
          expect(refused.codes).toEqual([1013]);
          refused.finish();
          expect(local.admission.snapshot().authenticated).toBe(cap);
          for (const peer of peers) peer.finish();
          expect(local.admission.snapshot().authenticated).toBe(0);
        },
        { ...M0_LIMITS, authenticatedSockets: cap },
      );
    }
  });
  it("D-A12 authenticated binary framing validates full connection identity before service dispatch", async () => {
    await withWs(async ({ open, local }) => {
      const peer = open();
      peer.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      const result = JSON.parse(peer.sent[0]);
      const attach = {
        type: "attach",
        requestId: "attach-one",
        run: {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          runId: "not-created",
        },
        connection: { ...result.connection, connectionId: "foreign" },
        viewId: "view",
        profile: PROFILE,
        encoding: BASELINE_ENCODING,
      };
      peer.emit("message", encodeTerminalFrame(1, utf8(attach), new Uint8Array()).value, true);
      expect(peer.codes).toEqual([1002]);
      expect(local.core.runtime.registry.count).toBe(0);
      peer.finish();
    });
  });
  it("D-A13 monotonic watchdog stops its own timer on regression and preserves one failure", () => {
    const timer = timerFixture();
    let value = 100;
    let ticks = 0;
    let failures = 0;
    const clock = new LocalRuntimeClock(
      () => ticks++,
      () => failures++,
      timer,
      () => value,
    );
    clock.start();
    clock.start();
    timer.fire();
    expect(ticks).toBe(1);
    value = 99;
    timer.fire();
    expect(failures).toBe(1);
    expect(timer.jobs.size).toBe(0);
    clock.start();
    expect(timer.jobs.size).toBe(0);
  });
  it("D-A14 actual process adapter orders public-bin hello/ready and keeps contact-loss separate", async () => {
    await withApp(async ({ core }) => {
      const child = new EventEmitter();
      child.pid = 123;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const decoder = createPipeDecoder();
      let selectedBin;
      child.stdin.on("data", (bytes) => {
        for (const frame of decoder.read(bytes).frames) {
          const hello = JSON.parse(Buffer.from(frame.metadata).toString());
          expect(hello.type).toBe("hello");
          child.stdout.write(
            encodePipeFrame(2, utf8({ ...hello, type: "ready" }), new Uint8Array()).value,
          );
        }
      });
      child.stdin.on("finish", () => {
        child.stdin.destroy();
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      const process = new WorkerProcess(
        core.runtime,
        {
          serverId: identity.serverId,
          relayInstanceId: identity.relayInstanceId,
          workerId: "worker",
          workerIncarnationId: "birth",
        },
        () => 0,
        (bin) => {
          selectedBin = bin;
          return child;
        },
      );
      process.start();
      await process.ready;
      expect(selectedBin).toMatch(/node_modules[/\\]\.bin[/\\]cove-terminal-worker$/);
      expect(process.snapshot().ready).toBe(true);
      child.stdout.emit("error", new Error("synthetic lower carrier"));
      expect(process.snapshot().contact).toBe("unverifiable");
      expect(process.snapshot().directlyOwnedLeaderExited).toBe(false);
      expect((await process.close()).status).toBe("exited");
      expect(process.snapshot().directlyOwnedLeaderExited).toBe(true);
    });
  });
  it("D-A15 rendezvous publishes complete restricted bytes and preserves a replaced foreign file", async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "cove-entry-author-"));
    const path = join(dir, "rendezvous");
    const file = new LocalRendezvous(path);
    try {
      await file.publish({
        bootstrapVersion: 1,
        ...launchIdentity(),
        endpoint: "http://127.0.0.1:32123",
      });
      expect(JSON.parse(await readFile(path, "utf8")).endpoint).toBe("http://127.0.0.1:32123");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(["rendezvous"]);
      await unlink(path);
      await writeFile(path, "owned-by-other-fixture");
      await file.close();
      await file.close();
      expect(await readFile(path, "utf8")).toBe("owned-by-other-fixture");
    } finally {
      await file.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("D-A16 failed publication never overwrites prior rendezvous or leaks owned temporary resources", async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), "cove-entry-failure-"));
    const path = join(dir, "rendezvous");
    const file = new LocalRendezvous(path);
    try {
      await writeFile(path, "prior");
      await expect(
        file.publish({
          bootstrapVersion: 1,
          ...launchIdentity(),
          endpoint: "http://127.0.0.1:32123",
        }),
      ).rejects.toThrow("publication failed");
      expect(await readFile(path, "utf8")).toBe("prior");
      expect(await readdir(dir)).toEqual(["rendezvous"]);
      await file.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("D-A17 response validation distinguishes invalid results from encoded whole-response overflow", async () => {
    await withApp(async ({ core }) => {
      core.runtime.pool.snapshot = () => ({ workers: -1, runs: 0, readyWorkers: 0 });
      expect(JSON.parse((await rpcBody(core, utf8(statusCall))).body).error.code).toBe(-32603);
      const records = Array.from({ length: 123 }, (_, i) => ({
        run: { serverId: "x".repeat(128), relayInstanceId: "y".repeat(128), runId: `run-${i}` },
        status: "live",
        geometry: { cols: 80, rows: 24 },
        controlEpoch: 0,
        controlHolder: null,
        preview: { version: 0, generatedAtMs: 0, checkedAtMs: 0, stale: false, byteLength: 0 },
      }));
      core.runtime.previews.cache.list = () => ({ runs: records });
      const list = { jsonrpc: "2.0", id: "list", method: "terminal.list", params: { limit: 128 } };
      expect((await rpcBody(core, utf8(Array.from({ length: 16 }, () => list)))).status).toBe(413);
    });
  });
  it("D-A18 secure missing leaf directory is created 0700 and removed only after owned file cleanup", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cove-secure-parent-"));
    const parent = join(root, "owned");
    const path = join(parent, "rendezvous");
    const file = new LocalRendezvous(path);
    try {
      await file.publish({
        bootstrapVersion: 1,
        ...launchIdentity(),
        endpoint: "http://127.0.0.1:32123",
      });
      const directory = await lstat(parent);
      const published = await lstat(path);
      await recordAuthor("A18-published", {
        directory: { uid: directory.uid, mode: directory.mode & 0o777 },
        file: { uid: published.uid, mode: published.mode & 0o777 },
        names: await readdir(parent),
      });
      expect(directory.mode & 0o777).toBe(0o700);
      expect(directory.uid).toBe(process.getuid());
      expect(published.mode & 0o777).toBe(0o600);
      await file.close();
      await file.close();
      const remaining = await readdir(root);
      await recordAuthor("A18-closed", { remaining });
      expect(remaining).toEqual([]);
    } finally {
      await file.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("D-A19 insecure and symlinked configured parents refuse publication and preserve foreign bytes", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cove-refused-parent-"));
    try {
      const insecure = join(root, "insecure");
      const target = join(root, "target");
      const alias = join(root, "alias");
      await mkdir(insecure, { mode: 0o700 });
      await chmod(insecure, 0o755);
      await mkdir(target, { mode: 0o700 });
      await symlink(target, alias);
      await writeFile(join(insecure, "prior"), "foreign-insecure");
      await writeFile(join(target, "prior"), "foreign-target");
      for (const [name, parent] of [
        ["insecure", insecure],
        ["symlink", alias],
      ]) {
        const file = new LocalRendezvous(join(parent, "rendezvous"));
        let error;
        try {
          await file.publish({
            bootstrapVersion: 1,
            ...launchIdentity(),
            endpoint: "http://127.0.0.1:32123",
          });
        } catch (caught) {
          error = caught;
        } finally {
          await file.close();
        }
        const info = await lstat(parent);
        const names = await readdir(parent);
        await recordAuthor(`A19-${name}`, {
          error: error?.message,
          mode: info.mode & 0o777,
          symlink: info.isSymbolicLink(),
          names,
          prior: await readFile(join(parent, "prior"), "utf8"),
        });
        expect(error?.message).toBe("Local rendezvous publication failed");
        expect(names).toEqual(["prior"]);
      }
      expect((await lstat(insecure)).mode & 0o777).toBe(0o755);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(target, "prior"), "utf8")).toBe("foreign-target");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("D-A20 valid notifications dispatch through the real map and invalid or unknown notifications do not", async () => {
    await withApp(async ({ app, core, admission }) => {
      const snapshot = core.runtime.pool.snapshot.bind(core.runtime.pool);
      let dispatches = 0;
      core.runtime.pool.snapshot = () => {
        dispatches++;
        return snapshot();
      };
      const payload = [
        { jsonrpc: "2.0", method: "server.status", params: {} },
        { jsonrpc: "2.0", method: "server.status", params: [] },
        { jsonrpc: "2.0", method: "unknown", params: {} },
        statusCall,
      ];
      const response = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8(payload),
      });
      await recordAuthor("A20-mixed", {
        status: response.statusCode,
        body: response.body,
        headers: response.headers,
        dispatches,
        quota: admission.snapshot(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
      expect(response.json()[0].id).toBe("status");
      expect(dispatches).toBe(2);
      expect(admission.snapshot().rpc).toBe(0);
      core.runtime.pool.snapshot = () => {
        throw new Error("fixed snapshot failure");
      };
      const failedNotification = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: business,
        payload: utf8({ jsonrpc: "2.0", method: "server.status", params: {} }),
      });
      await recordAuthor("A20-failed-notification", {
        status: failedNotification.statusCode,
        body: failedNotification.body,
        headers: failedNotification.headers,
        quota: admission.snapshot(),
      });
      expect(failedNotification.statusCode).toBe(204);
      expect(failedNotification.body).toBe("");
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A21 admitted RPC success, parse failure, no-reply and size refusal retain exact current identity headers", async () => {
    await withApp(async ({ app, admission }) => {
      for (const [name, payload, status] of [
        ["success", utf8(statusCall), 200],
        ["parse", Buffer.from("{"), 200],
        ["notification", utf8({ jsonrpc: "2.0", method: "server.status", params: {} }), 204],
        ["too-large", Buffer.alloc(65537, 32), 413],
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/rpc",
          headers: business,
          payload,
        });
        await recordAuthor(`A21-${name}`, {
          status: response.statusCode,
          body: response.body,
          headers: response.headers,
          quota: admission.snapshot(),
        });
        expect(response.statusCode).toBe(status);
        expect(response.headers["cove-protocol"]).toBe("2");
        expect(response.headers["cove-server-id"]).toBe(identity.serverId);
        expect(response.headers["cove-instance-id"]).toBe(identity.relayInstanceId);
        expect(response.headers.authorization).toBeUndefined();
        expect(response.body).not.toContain(identity.secret);
        expect(admission.snapshot().rpc).toBe(0);
      }
    });
  });
  it("D-A22 malformed and ambiguous real raw headers precede authority, credential and metadata mismatch", async () => {
    await withApp(async ({ admission, app }) => {
      const raw = Object.entries(business).flatMap(([key, value]) => [key, value]);
      const cases = [
        ["missing-host", { ...business, host: undefined }],
        ["bad-host", { ...business, host: "bad host" }],
        ["bad-protocol", { ...business, "cove-protocol": "NaN" }],
        ["bad-server", { ...business, "cove-server-id": "bad id" }],
        ["missing-instance", { ...business, "cove-instance-id": undefined }],
        ...["host", "origin", "authorization"].map((key) => [
          `duplicate-${key}`,
          actualHeaders(business, [...raw, key, "foreign", key, "second"]),
        ]),
      ];
      for (const [name, headers] of cases) {
        const result = admission.http("POST", "/rpc", headers, 0);
        await recordAuthor(`A22-${name}`, {
          result,
          headers: { ...headers, authorization: "[REDACTED]" },
          quota: admission.snapshot(),
        });
        expect(result).toBe("malformed");
      }
      for (const key of ["host", "origin", "authorization"]) {
        const headers = actualHeaders(auth, [
          "Host",
          auth.host,
          key,
          "one",
          key.toUpperCase(),
          "two",
        ]);
        expect(admission.http("POST", "/bootstrap", headers, 0)).toBe("malformed");
        expect(admission.http("OPTIONS", "/rpc", headers, 0)).toBe("malformed");
        expect(admission.upgrade("/terminal", headers)).toBe("malformed");
      }
      expect(admission.http("POST", "/rpc", { ...business, host: "example.com:32123" }, 0)).toBe(
        "forbidden",
      );
      expect(
        admission.http("POST", "/rpc", { ...business, authorization: "Bearer wrong" }, 0),
      ).toBe("unauthenticated");
      expect(admission.http("POST", "/rpc", { ...business, "cove-server-id": "foreign" }, 0)).toBe(
        "mismatch",
      );
      const response = await app.inject({
        method: "POST",
        url: "/rpc",
        headers: { ...business, "cove-protocol": "NaN" },
        payload: utf8(statusCall),
      });
      await recordAuthor("A22-real-route", {
        status: response.statusCode,
        body: response.body,
        headers: response.headers,
        quota: admission.snapshot(),
      });
      expect(response.statusCode).toBe(400);
      expect(admission.snapshot().rpc).toBe(0);
    });
  });
  it("D-A23 wrong message kinds use protocol close while true oversized messages retain size close", async () => {
    await withWs(async ({ open, local }) => {
      const oversized = open();
      oversized.emit("message", Buffer.alloc(8193), false);
      const text = open();
      text.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      text.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      const binary = open();
      binary.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      binary.emit("message", Buffer.alloc(MAX_FRAME_BYTES + 1), true);
      await recordAuthor("A23-before-close", {
        oversized: oversized.codes,
        secondText: text.codes,
        binary: binary.codes,
        quota: local.admission.snapshot(),
      });
      expect(oversized.codes).toEqual([1009]);
      expect(text.codes).toEqual([1002]);
      expect(binary.codes).toEqual([1009]);
      oversized.finish();
      text.finish();
      binary.finish();
      await recordAuthor("A23-physical-close", { quota: local.admission.snapshot() });
      expect(local.admission.snapshot().authenticated).toBe(0);
      expect(local.admission.snapshot().unauthenticated).toBe(0);
    });
  });
});
