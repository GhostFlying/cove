import { afterEach, expect, it, vi } from "vitest";
import { encodeInvitation } from "@cove/protocol/auth";
import { BOOTSTRAP_VERSION, PROTOCOL_VERSION } from "@cove/protocol/bootstrap";
import { utf8, encodeBase64, decodeBase64 } from "../dist/codec.js";
import { NativePorts } from "../dist/native-ports.js";
import { pairServer } from "../dist/pairing.js";
import { probeSecureStore } from "../dist/credentials.js";
import {
  observeConnectedClient,
  observeTerminal,
  inputOutcomePresentation,
} from "../dist/observation.js";

const owned = [];
afterEach(() => {
  for (const runtime of owned.splice(0)) runtime.dispose();
});

class Driver {
  queue = [];
  waiter;
  activePulls = 0;
  peakPulls = 0;
  posted = [];
  sent = [];
  released = [];
  stopped = false;
  admit = true;
  throwAfterAdmission = false;
  cancelDisposition = "unknown";
  openEntry() {
    return 1;
  }
  closeEntry() {}
  post(...args) {
    this.posted.push(args);
    if (this.throwAfterAdmission) throw new Error("fixture native return lost");
    return this.admit;
  }
  openSocket(...args) {
    this.posted.push(args);
    return this.admit;
  }
  send(id, binary, body) {
    this.sent.push({ id, binary, body });
    return "handed-off";
  }
  cancel() {
    return this.cancelDisposition;
  }
  release(id) {
    this.released.push(id);
  }
  async nextEvent() {
    this.activePulls++;
    this.peakPulls = Math.max(this.peakPulls, this.activePulls);
    try {
      if (this.queue.length) return this.queue.shift();
      return await new Promise((resolve, reject) => {
        this.waiter = { resolve, reject };
      });
    } finally {
      this.activePulls--;
    }
  }
  emit(value) {
    const text = JSON.stringify(value);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(text);
    } else this.queue.push(text);
  }
  stop() {
    this.stopped = true;
    this.waiter?.reject(new Error("closed"));
    this.waiter = undefined;
  }
}

function runtime() {
  const driver = new Driver();
  const ports = new NativePorts(driver);
  owned.push(ports);
  return { driver, ports, entry: ports.entry("serverNode", 8123) };
}

it("retires a lost exact Client once and ignores already retired callbacks", () => {
  let snapshot = { status: "connected" };
  let listener;
  const disposed = vi.fn();
  const lost = vi.fn();
  const stop = observeConnectedClient(
    {
      snapshot: () => snapshot,
      onState: (callback) => {
        listener = callback;
        return { dispose: disposed };
      },
    },
    () => true,
    lost,
  );
  expect(lost).not.toHaveBeenCalled();
  snapshot = { status: "unverifiable" };
  listener(snapshot);
  listener({ status: "connected" });
  listener({ status: "disposed" });
  expect(lost).toHaveBeenCalledOnce();
  expect(disposed).toHaveBeenCalledOnce();
  stop();
  expect(disposed).toHaveBeenCalledOnce();

  let current = true;
  const staleLost = vi.fn();
  const staleStop = observeConnectedClient(
    {
      snapshot: () => ({ status: "connected" }),
      onState: (callback) => {
        listener = callback;
        return { dispose() {} };
      },
    },
    () => current,
    staleLost,
  );
  current = false;
  listener({ status: "unverifiable" });
  staleStop();
  current = true;
  listener({ status: "unverifiable" });
  expect(staleLost).not.toHaveBeenCalled();
});

it("observes controller loss and fences state/input listeners across retirement", () => {
  let stateListener;
  let inputListener;
  const disposeState = vi.fn();
  const disposeInput = vi.fn();
  const states = vi.fn();
  const inputs = vi.fn();
  let current = true;
  const stop = observeTerminal(
    {
      snapshot: () => ({ phase: "ready", execution: { status: "live" }, inputReady: true }),
      onState: (callback) => {
        stateListener = callback;
        return { dispose: disposeState };
      },
      onInputOutcome: (callback) => {
        inputListener = callback;
        return { dispose: disposeInput };
      },
    },
    () => current,
    states,
    inputs,
  );
  expect(states).toHaveBeenLastCalledWith({ status: "已取得控制", canControl: true });
  stateListener({ phase: "ready", execution: { status: "unverifiable" }, inputReady: false });
  expect(states).toHaveBeenLastCalledWith({
    status: expect.stringContaining("终端已连接；执行状态未核实"),
    canControl: true,
  });
  stateListener({ phase: "ready", execution: { status: "exited" }, inputReady: false });
  expect(states).toHaveBeenLastCalledWith({
    status: "服务端已确认所选 run 退出",
    canControl: false,
  });
  stateListener({ phase: "unavailable", execution: { status: "unverifiable" } });
  expect(states).toHaveBeenLastCalledWith({
    status: expect.stringContaining("未知"),
    canControl: false,
  });
  expect(states.mock.calls.at(-1)[0].status).not.toContain("退出");
  inputListener({ kind: "input-rejections", count: 2, groups: [] });
  expect(inputs).toHaveBeenLastCalledWith(expect.stringContaining("拒绝 2 次"));
  const before = [states.mock.calls.length, inputs.mock.calls.length];
  current = false;
  stateListener({ phase: "ready", execution: { status: "live" }, inputReady: true });
  inputListener({ kind: "input-rejections", count: 3, groups: [] });
  stop();
  current = true;
  stateListener({ phase: "ready", execution: { status: "live" }, inputReady: true });
  inputListener({ kind: "input-rejections", count: 4, groups: [] });
  expect([states.mock.calls.length, inputs.mock.calls.length]).toEqual(before);
  expect(disposeState).toHaveBeenCalledOnce();
  expect(disposeInput).toHaveBeenCalledOnce();
});

it("displays bounded partial/uncertain input counts without reflecting input or errors", () => {
  const privateText = "fixture-private-terminal-data";
  const message = inputOutcomePresentation({
    kind: "input",
    outcome: {
      ok: false,
      value: { writtenBytes: 3, unknownBytes: 4, notSentBytes: 5, source: privateText },
      error: { message: privateText },
    },
  });
  expect(message).toContain("写入 3 B；未知 4 B；未发送 5 B");
  expect(message).toMatch(/^输入未完成/);
  expect(message).toContain("不会自动重试");
  for (const notice of [
    { kind: "input-rejections", count: Number.MAX_SAFE_INTEGER, groups: [{ error: privateText }] },
    { kind: "renderer-rejection", error: { message: privateText } },
    {
      kind: "input",
      outcome: { ok: true, value: { writtenBytes: Infinity, unknownBytes: -1, notSentBytes: NaN } },
    },
  ]) {
    const text = inputOutcomePresentation(notice);
    expect(text.length).toBeLessThanOrEqual(192);
    expect(text).not.toContain(privateText);
  }
  expect(message).not.toContain(privateText);
});

const request = {
  path: "/rpc",
  headers: {},
  body: utf8.encode("{}"),
  maxResponseBytes: 256 * 1024,
};

it("roundtrips legal maximum native bytes and Unicode without browser codecs", () => {
  const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i & 255);
  const text = encodeBase64(bytes);
  expect(decodeBase64(text, bytes.length)).toEqual(bytes);
  expect(text).toBe(Buffer.from(bytes).toString("base64"));
  const unicode = "plain 中文 😀\u0000\uD800";
  expect(utf8.encode(unicode)).toEqual(new TextEncoder().encode(unicode));
  expect(utf8.decodeFatal(utf8.encode(unicode))).toBe("plain 中文 😀\u0000\uFFFD");
});

it("rejects malformed UTF-8, noncanonical base64 and oversized native data", () => {
  for (const bytes of [
    [0xc0, 0x80],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xe2, 0x82],
  ])
    expect(() => utf8.decodeFatal(new Uint8Array(bytes))).toThrow("Invalid native UTF-8");
  for (const value of ["A===", "AA=A", "AB==", "AAB=", "!!!!"])
    expect(() => decodeBase64(value, 256)).toThrow(/native binary data/);
  expect(() => decodeBase64("AAAA", 1)).toThrow("bound");
});

it("delivers a native HTTP result and releases the exact terminal handle", async () => {
  const { driver, entry } = runtime();
  const done = vi.fn();
  entry.http.post(request, { onDisposition: vi.fn(), onResponse: done, onFailure: vi.fn() });
  driver.emit({
    id: 1,
    type: "http-response",
    disposition: "handed-off",
    status: 200,
    body: encodeBase64(utf8.encode("{}")),
  });
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(done.mock.calls[0][0].body).toEqual(utf8.encode("{}"));
  expect(driver.released).toEqual([1]);
  expect(driver.peakPulls).toBe(1);
});

it("reports explicit native admission refusal as not-sent", () => {
  const { driver, entry } = runtime();
  driver.admit = false;
  const failed = vi.fn();
  const handle = entry.http.post(request, {
    onDisposition: vi.fn(),
    onResponse: vi.fn(),
    onFailure: failed,
  });
  expect(failed).toHaveBeenCalledWith({ disposition: "not-sent", reason: "transport" });
  expect(handle.cancel()).toBe("not-sent");
});

it("keeps a bridge exception after HTTP invocation unknown", () => {
  const { driver, entry } = runtime();
  driver.throwAfterAdmission = true;
  const failed = vi.fn();
  const handle = entry.http.post(request, {
    onDisposition: vi.fn(),
    onResponse: vi.fn(),
    onFailure: failed,
  });
  expect(driver.posted).toHaveLength(1);
  expect(failed).toHaveBeenCalledWith({ disposition: "unknown", reason: "transport" });
  expect(handle.cancel()).toBe("unknown");
});

it("preserves cancellation disposition and drains a late response without delivering it", async () => {
  const { driver, entry } = runtime();
  const done = vi.fn();
  const handle = entry.http.post(request, {
    onDisposition: vi.fn(),
    onResponse: done,
    onFailure: vi.fn(),
  });
  expect(handle.cancel()).toBe("unknown");
  driver.emit({ id: 1, type: "http-response", disposition: "handed-off", status: 200 });
  await vi.waitFor(() => expect(driver.released).toEqual([1]));
  expect(done).not.toHaveBeenCalled();
  expect(handle.cancel()).toBe("unknown");
});

it("keeps binary and text traffic ordered on each fixed WebSocket route", async () => {
  const { driver, entry } = runtime();
  const opened = vi.fn();
  const binary = vi.fn();
  const text = vi.fn();
  const closed = vi.fn();
  const handle = entry
    .socket("/events")
    .open({ onOpen: opened, onBinary: binary, onText: text, onClose: closed });
  expect(driver.posted[0]).toEqual([1, 1, "/events"]);
  driver.emit({ id: 1, type: "socket-open" });
  await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
  const connection = opened.mock.calls[0][0];
  expect(connection.send(new Uint8Array([0, 255]))).toBe("handed-off");
  expect(connection.send("中文")).toBe("handed-off");
  expect(driver.sent.map((value) => [value.binary, decodeBase64(value.body, 256)])).toEqual([
    [true, new Uint8Array([0, 255])],
    [false, utf8.encode("中文")],
  ]);
  driver.emit({ id: 1, type: "socket-binary", body: encodeBase64(new Uint8Array([255, 0])) });
  driver.emit({ id: 1, type: "socket-text", body: encodeBase64(utf8.encode("reply")) });
  await vi.waitFor(() => expect(text).toHaveBeenCalledOnce());
  expect(binary.mock.invocationCallOrder[0]).toBeLessThan(text.mock.invocationCallOrder[0]);
  handle.cancel();
  expect(closed).toHaveBeenCalledOnce();
  driver.emit({ id: 1, type: "socket-close", disposition: "handed-off" });
  await vi.waitFor(() => expect(driver.released).toContain(1));
  expect(connection.send("late")).toBe("not-sent");
  expect(closed).toHaveBeenCalledOnce();
  const pending = entry.terminal.open({
    onOpen: vi.fn(),
    onBinary: vi.fn(),
    onText: vi.fn(),
    onClose: closed,
  });
  driver.emit({ id: 2, type: "socket-close", disposition: "unknown" });
  await vi.waitFor(() => expect(driver.released).toContain(2));
  expect(pending.cancel()).toBe("unknown");
  expect(closed).toHaveBeenCalledTimes(2);
});

it("settles pending HTTP and sockets when the native stream fails", async () => {
  const { driver, entry } = runtime();
  const failed = vi.fn();
  const closed = vi.fn();
  entry.http.post(request, { onDisposition: vi.fn(), onResponse: vi.fn(), onFailure: failed });
  const pending = entry.terminal.open({
    onOpen: vi.fn(),
    onText: vi.fn(),
    onBinary: vi.fn(),
    onClose: closed,
  });
  driver.stop = () => {
    driver.stopped = true;
    throw new Error("Expo bridge destroyed");
  };
  driver.emit({ id: 1, type: "invalid-native-event" });
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
  expect(failed).toHaveBeenCalledWith({ disposition: "unknown", reason: "transport" });
  expect(closed).toHaveBeenCalledOnce();
  expect(pending.cancel()).toBe("unknown");
  expect(driver.stopped).toBe(true);
});

const invitation = encodeInvitation({
  serverId: "server",
  inviteId: "invite",
  secret: "a".repeat(43),
  expiresAtMs: Date.now() + 60_000,
  pairingPort: 8124,
  entries: { tsnet: { nodeId: "serverNode", name: "server.test" } },
});
const token = `cove_d1_device.${"b".repeat(43)}`;

function pairingFixture({ mismatch = false, failStore = false, loseReply = false } = {}) {
  const calls = [];
  const writes = [];
  let entryClosed = false;
  const http = {
    post(req, cb) {
      calls.push(req.path);
      if (req.path === "/pair" && loseReply)
        cb.onFailure({ disposition: "unknown", reason: "transport" });
      else
        cb.onResponse({
          status: 200,
          headers: {},
          body: utf8.encode(
            JSON.stringify(
              req.path === "/bootstrap"
                ? {
                    type: "cove-bootstrap-identity",
                    bootstrapVersion: BOOTSTRAP_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    buildVersion: "0.0.0+fixture",
                    serverId: mismatch ? "wrong-server" : "server",
                    relayInstanceId: "instance",
                  }
                : {
                    type: "cove-pairing-result",
                    serverId: "server",
                    deviceId: "device",
                    token,
                    businessPort: 8123,
                  },
            ),
          ),
        });
      return { cancel: () => "unknown" };
    },
  };
  return {
    calls,
    writes,
    closed: () => entryClosed,
    ports: {
      entry: () => ({
        http,
        close: () => {
          entryClosed = true;
        },
      }),
    },
    store: {
      read: async () => null,
      remove: async () => {},
      write: async (raw) => {
        if (failStore) throw new Error("SecureStore write failed: " + token);
        writes.push(JSON.parse(raw));
      },
    },
  };
}

it("verifies serverId before sending the invitation secret", async () => {
  const fixture = pairingFixture({ mismatch: true });
  await expect(pairServer(fixture.ports, invitation, "fixture", fixture.store)).rejects.toThrow(
    "identity",
  );
  expect(fixture.calls).toEqual(["/bootstrap"]);
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.closed()).toBe(true);
  await expect(
    pairServer(fixture.ports, "invalid", "fixture", fixture.store),
  ).rejects.toMatchObject({
    code: "COVE_NATIVE_PAIRING_INVITATION",
    stage: "invitation",
    disposition: "not-sent",
    redemptionDisposition: "not-sent",
  });
  const closedEntry = {
    entry: () => {
      throw new Error("bridge failure: " + token);
    },
  };
  await expect(pairServer(closedEntry, invitation, "fixture", fixture.store)).rejects.toMatchObject(
    {
      stage: "entry",
      redemptionDisposition: "not-sent",
    },
  );
  expect(fixture.calls).toEqual(["/bootstrap"]);
});

it("reports pairing success only after secure token persistence", async () => {
  const fixture = pairingFixture();
  const saved = await pairServer(fixture.ports, invitation, "fixture", fixture.store);
  expect(fixture.calls).toEqual(["/bootstrap", "/pair"]);
  expect(fixture.writes).toEqual([saved]);
  expect(saved.token).toBe(token);
  expect(fixture.closed()).toBe(true);
  let value = null;
  const probeCalls = [];
  await probeSecureStore({
    write: async (raw) => {
      probeCalls.push("write");
      value = raw;
    },
    read: async () => {
      probeCalls.push("read");
      return value;
    },
    remove: async () => {
      probeCalls.push("delete");
      value = null;
    },
  });
  expect(probeCalls).toEqual(["write", "read", "delete"]);
  expect(value).toBeNull();
});

it("does not convert a secure-store failure into pairing success or retry", async () => {
  const fixture = pairingFixture({ failStore: true });
  const failed = pairServer(fixture.ports, invitation, "fixture", fixture.store);
  await expect(failed).rejects.toMatchObject({
    code: "COVE_NATIVE_PAIRING_PERSIST",
    stage: "persist",
    disposition: "handed-off",
    redemptionDisposition: "handed-off",
  });
  await expect(failed).rejects.not.toThrow(token);
  expect(fixture.calls.filter((path) => path === "/pair")).toHaveLength(1);
  expect(fixture.writes).toHaveLength(0);
  let deleted = false;
  const denied = probeSecureStore({
    write: async () => {
      throw new Error("A required entitlement isn't present. " + token);
    },
    read: async () => {
      throw new Error("Must not read after failed write");
    },
    remove: async () => {
      deleted = true;
    },
  });
  await expect(denied).rejects.toMatchObject({ code: "COVE_NATIVE_STORE_MISSING_ENTITLEMENT" });
  await expect(denied).rejects.toThrow("cleanup confirmed");
  await expect(denied).rejects.not.toThrow(token);
  expect(deleted).toBe(true);
  const removalFailed = probeSecureStore({
    write: async () => {},
    read: async () => "cove-native-secure-store-probe-v1",
    remove: async () => {
      throw new Error("User interaction is not allowed.");
    },
  });
  await expect(removalFailed).rejects.toMatchObject({
    code: "COVE_NATIVE_STORE_INTERACTION_DISALLOWED",
  });
  await expect(removalFailed).rejects.toThrow("cleanup unverified");
});

it("does not repeat a redemption whose response was lost", async () => {
  const fixture = pairingFixture({ loseReply: true });
  await expect(
    pairServer(fixture.ports, invitation, "fixture", fixture.store),
  ).rejects.toMatchObject({
    stage: "redeem",
    disposition: "unknown",
    redemptionDisposition: "unknown",
  });
  expect(fixture.calls.filter((path) => path === "/pair")).toHaveLength(1);
  expect(fixture.writes).toHaveLength(0);
});
