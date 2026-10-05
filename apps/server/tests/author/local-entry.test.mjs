import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { rpcBody, boundRpcResponseBody } from "../../dist/transport/http-rpc.js";
import { createPipeDecoder, encodePipeFrame } from "@cove/protocol/pipe";
import { encodeTerminalFrame, MAX_FRAME_BYTES } from "@cove/protocol/terminal";
import { PROFILE, BASELINE_ENCODING } from "@cove/protocol/profile";
import { REQUIRED_CAPABILITIES } from "@cove/protocol/bootstrap";
import { composeRpcResponse } from "@cove/protocol/rpc";
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

function workerWriteControl(core, mode) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const failure = new Error("real lower Writable failure");
  const decoder = createPipeDecoder();
  const events = [];
  let completeWrite;
  let worker;
  let resolveCallback;
  const callbackDelivered = new Promise((resolve) => {
    resolveCallback = resolve;
  });
  child.stdin = new Writable({
    write(bytes, _encoding, completed) {
      const frames = decoder.read(bytes).frames;
      events.push({
        type: "lower-write",
        bytes: Buffer.from(bytes).toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        metadata: frames.map((frame) => JSON.parse(Buffer.from(frame.metadata).toString())),
      });
      if (mode === "late") {
        completeWrite = completed;
        return;
      }
      if (mode === "error") {
        completed(failure);
        return;
      }
      for (const frame of frames) {
        const hello = JSON.parse(Buffer.from(frame.metadata).toString());
        const readyBytes = encodePipeFrame(
          2,
          utf8({ ...hello, type: "ready" }),
          new Uint8Array(),
        ).value;
        events.push({
          type: "ready-frame",
          bytes: Buffer.from(readyBytes).toString("base64"),
          sha256: createHash("sha256").update(readyBytes).digest("hex"),
        });
        child.stdout.write(readyBytes);
      }
      completed();
    },
  });
  const originalWrite = child.stdin.write;
  child.stdin.write = function (bytes, callback) {
    const returned = Reflect.apply(originalWrite, this, [
      bytes,
      function (error) {
        events.push({
          type: "callback-before",
          category: error === null ? "NULL" : error === undefined ? "UNDEFINED" : "ERROR",
          sameError: error === failure,
          error: error instanceof Error ? { name: error.name, message: error.message } : null,
          session: worker.session.snapshot(),
        });
        try {
          return Reflect.apply(callback, this, [error]);
        } finally {
          events.push({
            type: "callback-after",
            snapshot: worker.snapshot(),
            session: worker.session.snapshot(),
          });
          resolveCallback(error);
        }
      },
    ]);
    events.push({ type: "write-return", returned });
    return returned;
  };
  child.stdin.on("finish", () => child.stdin.destroy());
  child.stdin.on("close", () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  worker = new WorkerProcess(
    core.runtime,
    {
      serverId: identity.serverId,
      relayInstanceId: identity.relayInstanceId,
      workerId: `write-${mode}`,
      workerIncarnationId: "birth",
    },
    () => 0,
    () => child,
  );
  return {
    child,
    worker,
    failure,
    events,
    callbackDelivered,
    finishLowerWrite: () => completeWrite(),
  };
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
  it("D-A24 registered HTTP bootstrap preserves four exact kind refusals and success/mismatch/malformed classes", async () => {
    const fixed = [
      {
        name: "DN08.http-bootstrap-unsupported",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 2,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: [
            "terminal-framing-v2",
            "logical-grid-recovery-v1",
            "worker-pipe-v2",
            "terminal-preview-v1",
            "operation-receipts-v1",
          ],
          profiles: ["pragmatic-logical-grid-v1"],
          encodings: ["vt-checkpoint-tail-v1"],
        },
        inputSha256: "0f13595b09415125e87a3433e4f5e1bc814185e8fe529cfeb5876d27fa1a2f9c",
        expected: {
          type: "cove-bootstrap-error",
          kind: "BOOTSTRAP_UNSUPPORTED",
          message: "BOOTSTRAP UNSUPPORTED",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
      {
        name: "DN08.http-missing-capability",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 1,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: ["terminal-framing-v2"],
          profiles: ["pragmatic-logical-grid-v1"],
          encodings: ["vt-checkpoint-tail-v1"],
        },
        inputSha256: "ddb277f478a994d03fbecddba0ce16788a65e7b5ebbbdf8d7ef214fa72cacef4",
        expected: {
          type: "cove-bootstrap-error",
          kind: "CAPABILITY_UNAVAILABLE",
          message: "CAPABILITY UNAVAILABLE",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
      {
        name: "DN08.http-profile-unsupported",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 1,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: [
            "terminal-framing-v2",
            "logical-grid-recovery-v1",
            "worker-pipe-v2",
            "terminal-preview-v1",
            "operation-receipts-v1",
          ],
          profiles: ["unsupported-profile"],
          encodings: ["vt-checkpoint-tail-v1"],
        },
        inputSha256: "276eaf1526a429f11cb380fb83aefc636486c43c1be838a49d2c8debb9e77a35",
        expected: {
          type: "cove-bootstrap-error",
          kind: "PROFILE_UNSUPPORTED",
          message: "PROFILE UNSUPPORTED",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
      {
        name: "DN08.http-encoding-unsupported",
        input: {
          type: "cove-bootstrap",
          bootstrapVersion: 1,
          expectedServerId: "dn-server",
          expectedRelayInstanceId: "dn-instance",
          protocolVersion: 2,
          buildVersion: "oracle-client-a",
          capabilities: [
            "terminal-framing-v2",
            "logical-grid-recovery-v1",
            "worker-pipe-v2",
            "terminal-preview-v1",
            "operation-receipts-v1",
          ],
          profiles: ["pragmatic-logical-grid-v1"],
          encodings: ["unsupported-encoding"],
        },
        inputSha256: "e2e8a6fa284c0b8f6654e8e8a80335aee90398d3441de2e88386548cb887c87f",
        expected: {
          type: "cove-bootstrap-error",
          kind: "PROFILE_UNSUPPORTED",
          message: "PROFILE UNSUPPORTED",
          supportedVersions: {
            bootstrap: [1],
            protocol: [2],
          },
        },
      },
    ];
    const valid = {
      type: "cove-bootstrap",
      bootstrapVersion: 1,
      expectedServerId: "dn-server",
      expectedRelayInstanceId: "dn-instance",
      protocolVersion: 2,
      buildVersion: "oracle-client-a",
      capabilities: [
        "terminal-framing-v2",
        "logical-grid-recovery-v1",
        "worker-pipe-v2",
        "terminal-preview-v1",
        "operation-receipts-v1",
      ],
      profiles: ["pragmatic-logical-grid-v1"],
      encodings: ["vt-checkpoint-tail-v1"],
    };
    const local = createLocalApplication(
      { ...options, port: 19041, allowedOrigins: ["http://127.0.0.1:19042"] },
      { identity: { ...identity, serverId: "dn-server", relayInstanceId: "dn-instance" } },
    );
    const headers = {
      host: "127.0.0.1:19041",
      origin: "http://127.0.0.1:19042",
      authorization: `Bearer ${identity.secret}`,
    };
    try {
      await local.app.ready();
      for (const row of fixed) {
        const bytes = utf8(row.input);
        const inputSha256 = createHash("sha256").update(bytes).digest("hex");
        const response = await local.app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload: bytes,
        });
        await recordAuthor(row.name, {
          input: row.input,
          inputSha256,
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
          quota: local.admission.snapshot(),
        });
        expect(inputSha256).toBe(row.inputSha256);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual(row.expected);
        expect(local.admission.snapshot().rpc).toBe(0);
        expect(local.core.runtime.registry.count).toBe(0);
      }
      for (const [name, payload, expectedStatus, kind, type, empty] of [
        ["success", utf8(valid), 200, undefined, "cove-bootstrap-result", false],
        [
          "protocol",
          utf8({ ...valid, protocolVersion: 3 }),
          409,
          "PROTOCOL_MISMATCH",
          "cove-bootstrap-error",
          false,
        ],
        [
          "instance",
          utf8({ ...valid, expectedRelayInstanceId: "other" }),
          409,
          "INSTANCE_MISMATCH",
          "cove-bootstrap-error",
          false,
        ],
        ["malformed", Buffer.from("{"), 400, undefined, undefined, true],
      ]) {
        const response = await local.app.inject({
          method: "POST",
          url: "/bootstrap",
          headers,
          payload,
        });
        await recordAuthor(`A24-${name}`, {
          status: response.statusCode,
          headers: response.headers,
          body: response.body,
          quota: local.admission.snapshot(),
        });
        expect(response.statusCode).toBe(expectedStatus);
        const parsedBody = response.body === "" ? undefined : response.json();
        expect(parsedBody?.kind).toBe(kind);
        expect(parsedBody?.type).toBe(type);
        expect(response.body === "").toBe(empty);
        expect(response.body).not.toContain(identity.secret);
      }
    } finally {
      await local.app.close();
      local.disposeCore();
    }
  });
  it("D-A25 actual factory forwards one timer to clock and first-message deadlines with genuine handle cleanup", async () => {
    const jobs = new Map();
    const events = [];
    let next = 0;
    let now = 0;
    const timer = {
      set: (callback, milliseconds) => {
        const handle = ++next;
        jobs.set(handle, { callback, milliseconds });
        events.push({ type: "set", handle, milliseconds });
        return handle;
      },
      clear: (handle) => {
        events.push({ type: "clear", handle, removed: jobs.delete(handle) });
      },
    };
    const local = createLocalApplication(options, { identity, timer, monotonic: () => now });
    const peers = [];
    const open = () => {
      const prepared = local.terminal.prepare(auth);
      const peer = new Socket();
      peers.push(peer);
      local.terminal.accept(peer, prepared.claim);
      return peer;
    };
    try {
      await local.app.ready();
      local.clock.start();
      const clockHandle = next;
      expect(jobs.get(clockHandle).milliseconds).toBe(25);
      local.clock.stop();
      local.clock.stop();
      const eligible = open();
      const bootstrapHandle = next;
      now = 5000;
      eligible.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      await recordAuthor("A25-equality", {
        events,
        sent: eligible.sent,
        codes: eligible.codes,
        quota: local.admission.snapshot(),
      });
      expect(JSON.parse(eligible.sent[0]).type).toBe("cove-bootstrap-result");
      expect(
        events.find((event) => event.type === "set" && event.handle === bootstrapHandle)
          .milliseconds,
      ).toBe(5000);
      expect(jobs.has(bootstrapHandle)).toBe(false);
      eligible.finish();
      eligible.finish();
      const late = open();
      now = 10001;
      late.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(late.codes).toEqual([1008]);
      late.finish();
      const expired = open();
      const deadline = next;
      jobs.get(deadline).callback();
      expired.emit("message", utf8({ ...bootstrap, secret: identity.secret }), false);
      expect(expired.sent).toEqual([]);
      expect(expired.codes).toEqual([1008]);
      expired.finish();
      await recordAuthor("A25-retired", {
        events,
        remainingHandles: [...jobs.keys()],
        quota: local.admission.snapshot(),
      });
      expect(
        events.filter((event) => event.type === "clear" && event.handle === clockHandle),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === "clear" && event.handle === bootstrapHandle && event.removed,
        ),
      ).toHaveLength(1);
      expect(jobs.size).toBe(0);
      expect(local.admission.snapshot().authenticated).toBe(0);
    } finally {
      local.terminal.close();
      for (const peer of peers) peer.finish();
      await local.app.close();
      local.disposeCore();
    }
  });
  it("D-A26 actual factory forwards WorkerSpawn through the original worker handshake and lower retirement", async () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const decoder = createPipeDecoder();
    const writes = [];
    const events = [];
    let worker;
    const originalWrite = child.stdin.write;
    child.stdin.write = function (bytes, callback) {
      const returned = Reflect.apply(originalWrite, this, [
        bytes,
        function (error) {
          events.push({
            type: "callback-before",
            error:
              error === null
                ? "NULL"
                : error === undefined
                  ? "UNDEFINED"
                  : { name: error.name, message: error.message },
            snapshot: worker.snapshot(),
            session: worker.session.snapshot(),
          });
          try {
            return Reflect.apply(callback, this, [error]);
          } finally {
            events.push({
              type: "callback-after",
              snapshot: worker.snapshot(),
              session: worker.session.snapshot(),
            });
          }
        },
      ]);
      events.push({
        type: "write-return",
        returned,
        bytes: Buffer.from(bytes).toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      return returned;
    };
    for (const streamName of ["stdin", "stdout", "stderr"]) {
      for (const event of ["error", "end", "finish", "close"]) {
        child[streamName].on(event, (error) =>
          events.push({
            streamName,
            type: event,
            error: error instanceof Error ? { name: error.name, message: error.message } : null,
          }),
        );
      }
    }
    for (const event of ["exit", "close"])
      child.on(event, (code, signal) => events.push({ type: `child-${event}`, code, signal }));
    let selectedBin;
    let spawns = 0;
    child.stdin.on("data", (bytes) => {
      for (const frame of decoder.read(bytes).frames) {
        const hello = JSON.parse(Buffer.from(frame.metadata).toString());
        writes.push({ hello, bytes: Buffer.from(bytes).toString("base64") });
        const readyBytes = encodePipeFrame(
          2,
          utf8({ ...hello, type: "ready" }),
          new Uint8Array(),
        ).value;
        events.push({
          type: "ready-frame",
          hello,
          bytes: Buffer.from(readyBytes).toString("base64"),
          sha256: createHash("sha256").update(readyBytes).digest("hex"),
        });
        child.stdout.write(readyBytes);
      }
    });
    child.stdin.on("finish", () => {
      child.stdin.destroy();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    const local = createLocalApplication(options, {
      identity,
      monotonic: () => 0,
      workerSpawn: (bin) => {
        selectedBin = bin;
        spawns++;
        return child;
      },
    });
    let primaryError;
    let errors;
    try {
      await local.app.ready();
      worker = local.createWorker();
      worker.start();
      await worker.ready;
      await recordAuthor("A26-ready", {
        selectedBin,
        spawns,
        writes,
        snapshot: worker.snapshot(),
        lowerPid123NotNativeBirth: true,
      });
      expect(worker).toBeInstanceOf(WorkerProcess);
      expect(selectedBin).toMatch(/node_modules[/\\]\.bin[/\\]cove-terminal-worker$/);
      expect(spawns).toBe(1);
      expect(writes[0].hello.type).toBe("hello");
      const sink = process.env.COVE_D_AUTHOR_OUTPUT;
      if (sink) {
        mkdirSync(sink, { recursive: true });
        writeFileSync(
          join(sink, "A26-live-guard.json"),
          JSON.stringify(
            {
              events,
              snapshot: worker.snapshot(),
              session: worker.session.snapshot(),
              lowerPid123NotNativeBirth: true,
            },
            null,
            2,
          ) + "\n",
        );
      }
      expect(worker.snapshot().ready).toBe(true);
      child.stdout.emit("error", new Error("fixed lower contact loss"));
      expect(worker.snapshot().contact).toBe("unverifiable");
      expect(worker.snapshot().directlyOwnedLeaderExited).toBe(false);
      const receipt = await worker.close();
      await recordAuthor("A26-closed", { receipt, snapshot: worker.snapshot(), spawns });
      expect(receipt.status).toBe("exited");
      expect(worker.snapshot().directlyOwnedLeaderExited).toBe(true);
    } catch (error) {
      primaryError = error;
    } finally {
      errors = primaryError === undefined ? [] : [primaryError];
      for (const [name, action] of [
        [
          "before-close-observation",
          () =>
            recordAuthor("A26-before-finally", {
              events,
              snapshot: worker?.snapshot(),
              session: worker?.session.snapshot(),
            }),
        ],
        ["worker.close", () => worker?.close()],
        ["stdin.destroy", () => child.stdin.destroy()],
        ["stdout.destroy", () => child.stdout.destroy()],
        ["stderr.destroy", () => child.stderr.destroy()],
        ["app.close", () => local.app.close()],
        ["disposeCore", () => local.disposeCore()],
      ]) {
        try {
          await action();
          events.push({ type: "finally-attempt", name, outcome: "returned" });
        } catch (error) {
          errors.push(error);
          events.push({
            type: "finally-attempt",
            name,
            outcome: "threw",
            error: { name: error.name, message: error.message },
          });
        }
      }
      try {
        await recordAuthor("A26-finally-after", {
          events,
          snapshot: worker?.snapshot(),
          session: worker?.session.snapshot(),
          destroyed: {
            stdin: child.stdin.destroyed,
            stdout: child.stdout.destroyed,
            stderr: child.stderr.destroyed,
          },
          errors: errors.map((error) => ({ name: error.name, message: error.message })),
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Worker fixture body and cleanup failures", {
        cause: errors[0],
      });
  });
  it("D-A28 real Node Writable null success retains live readiness and retires physical backing", async () => {
    await withApp(async ({ core }) => {
      const rig = workerWriteControl(core, "success");
      try {
        rig.worker.start();
        await rig.worker.ready;
        const error = await rig.callbackDelivered;
        await recordAuthor("A28-null-success", {
          events: rig.events,
          snapshot: rig.worker.snapshot(),
          session: rig.worker.session.snapshot(),
          lowerPid123NotNativeBirth: true,
        });
        expect(error).toBe(null);
        expect(rig.worker.snapshot().ready).toBe(true);
        expect(rig.worker.snapshot().contact).toBe("live");
        expect(rig.worker.session.snapshot().physicalBytes).toBe(0);
        expect(rig.events.filter((event) => event.type === "callback-after")).toHaveLength(1);
      } finally {
        try {
          await rig.worker.close();
        } finally {
          rig.child.stdin.destroy();
          rig.child.stdout.destroy();
          rig.child.stderr.destroy();
        }
      }
    });
  });
  it("D-A29 real Node Writable Error preserves identity and refuses ready resurrection", async () => {
    await withApp(async ({ core }) => {
      const rig = workerWriteControl(core, "error");
      try {
        rig.worker.start();
        const error = await rig.callbackDelivered;
        await recordAuthor("A29-real-error", {
          events: rig.events,
          snapshot: rig.worker.snapshot(),
          session: rig.worker.session.snapshot(),
          lowerPid123NotNativeBirth: true,
        });
        expect(error).toBe(rig.failure);
        await expect(rig.worker.ready).rejects.toThrow("Worker startup unavailable");
        expect(rig.worker.snapshot().ready).toBe(false);
        expect(rig.worker.snapshot().contact).toBe("unverifiable");
        expect(rig.worker.session.snapshot().physicalBytes).toBe(0);
        expect(rig.events.filter((event) => event.type === "callback-after")).toHaveLength(1);
      } finally {
        try {
          await rig.worker.close();
        } finally {
          rig.child.stdin.destroy();
          rig.child.stdout.destroy();
          rig.child.stderr.destroy();
        }
      }
    });
  });
  it("D-A30 actual stream close precedes late Writable completion without duplicate retirement", async () => {
    await withApp(async ({ core }) => {
      const rig = workerWriteControl(core, "late");
      try {
        rig.worker.start();
        const held = rig.worker.session.snapshot();
        await recordAuthor("A30-held", {
          events: rig.events,
          held,
          snapshot: rig.worker.snapshot(),
          lowerPid123NotNativeBirth: true,
        });
        expect(held.physicalBytes).toBeGreaterThan(0);
        const closed = new Promise((resolve) => rig.child.stdin.once("close", resolve));
        rig.child.stdin.destroy();
        await closed;
        const released = rig.worker.session.snapshot();
        await recordAuthor("A30-closed-before-late", {
          events: rig.events,
          released,
          snapshot: rig.worker.snapshot(),
        });
        expect(released.physicalBytes).toBe(0);
        rig.finishLowerWrite();
        await rig.callbackDelivered;
        await recordAuthor("A30-late-after-close", {
          events: rig.events,
          snapshot: rig.worker.snapshot(),
          session: rig.worker.session.snapshot(),
        });
        expect(rig.worker.session.snapshot()).toEqual(released);
        expect(rig.worker.snapshot().ready).toBe(false);
        expect(rig.events.filter((event) => event.type === "callback-after")).toHaveLength(1);
        expect((await rig.worker.close()).status).toBe("exited");
      } finally {
        try {
          await rig.worker.close();
        } finally {
          rig.child.stdin.destroy();
          rig.child.stdout.destroy();
          rig.child.stderr.destroy();
        }
      }
    });
  });
  it("D-A27 extracted aggregate response guard keeps exact UTF8 boundaries without closed-method bypass", async () => {
    const envelope = { jsonrpc: "2.0", id: "component", result: "" };
    const overhead = Buffer.byteLength(JSON.stringify(envelope));
    for (const [bytes, expectedStatus, accepted] of [
      [262144, 200, true],
      [262145, 413, false],
    ]) {
      const remaining = bytes - overhead;
      const result = "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2);
      const value = { ...envelope, result };
      const body = JSON.stringify(value);
      const composer = composeRpcResponse(value, (text) => Buffer.from(text));
      const guard = boundRpcResponseBody(body, 262144);
      await recordAuthor(`A27-${bytes}`, {
        body,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
        composer,
        guard,
        credit: "COMPONENT_ONLY",
      });
      expect(Buffer.byteLength(body)).toBe(bytes);
      expect(guard.status).toBe(expectedStatus);
      expect(composer).toEqual(accepted ? value : null);
      expect(guard.body).toBe(accepted ? body : undefined);
      const changed = body.replace("é", "è");
      const changedGuard = boundRpcResponseBody(changed, 262144);
      await recordAuthor(`A27-changed-${bytes}`, {
        body: changed,
        bytes: Buffer.byteLength(changed),
        guard: changedGuard,
      });
      expect(Buffer.byteLength(changed)).toBe(bytes);
      expect(changedGuard.status).toBe(guard.status);
      expect(changed).not.toBe(body);
    }
    expect(
      composeRpcResponse(
        { ...envelope, error: { code: -32603, message: "Internal error" } },
        (text) => Buffer.from(text),
      ),
    ).toBeNull();
  });
});
