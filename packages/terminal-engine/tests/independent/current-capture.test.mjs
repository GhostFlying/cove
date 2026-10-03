import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "vitest";
import { TerminalModel } from "@cove/terminal-engine";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { record } from "../../../terminal-worker/tests/independent/current-recovery-ports.mjs";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const run = { serverId: "w2-server", relayInstanceId: "w2-relay", runId: "engine" };
const utf8 = (text) => new TextEncoder().encode(text);
const geometry = { cols: 12, rows: 4 };
function engineAccount(limit = 262144) {
  let used = 0;
  let serial = 0;
  const live = new Map();
  const events = [];
  const reserve = (bytes) => {
    events.push({ phase: "request", bytes, used });
    if (bytes > limit - used) return;
    const id = ++serial;
    used += bytes;
    live.set(id, bytes);
    events.push({ phase: "acquire", id, bytes, used });
    return {
      release() {
        assert(live.has(id));
        used -= live.get(id);
        live.delete(id);
        events.push({ phase: "release", id, bytes, used });
      },
    };
  };
  return { reserve, events, live, available: () => limit - used, used: () => used };
}
function model(account, reserve = account.reserve) {
  return new TerminalModel({
    run,
    geometry,
    appearance: DEFAULT_APPEARANCE,
    effectiveBudgets: { ...M0_LIMITS, historyLines: 10 },
    onAutomaticOutput() {},
    reserveRetainedBytes: reserve,
    availableRetainedBytes: account.available,
  });
}
const apply = (engine, seq, bytes) => engine.apply({ type: "output", run, seq }, bytes);
const write = (terminal, bytes) => new Promise((resolve) => terminal.write(bytes, resolve));
function visible(terminal) {
  const active = terminal.buffer.active;
  return {
    alternate: active === terminal.buffer.alternate,
    x: active.cursorX,
    y: active.cursorY,
    lines: Array.from({ length: active.length }, (_, index) =>
      active.getLine(index).translateToString(false),
    ),
  };
}

describe("W2 current engine capture", () => {
  it("W2C-E01 detached baseline reserve precedes copies and refusal preserves authority", async () => {
    const account = engineAccount();
    const engine = model(account);
    try {
      assert((await apply(engine, 1, utf8("BASE"))).ok);
      const before = engine.currentState();
      let reserved;
      const denied = await engine.captureBaseline((bytes) => {
        reserved = bytes;
        return false;
      });
      assert.equal(denied.status, "unavailable");
      assert(reserved > 4096);
      assert.deepEqual(engine.currentState(), before);
      const thrown = await engine.captureBaseline(() => {
        throw Error("controlled reserve refusal");
      });
      assert.equal(thrown.status, "unavailable");
      let lease;
      let observed;
      const captured = await engine.captureBaseline((bytes) => {
        lease = account.reserve(bytes);
        assert(lease);
        observed = engine.currentState();
        return true;
      });
      assert.equal(captured.status, "ready");
      assert.equal(observed.parsedSeq, 1);
      assert.equal(reserved, captured.baseline.vt.length + captured.baseline.tail.length + 4096);
      captured.baseline.vt.fill(88);
      const again = await engine.captureBaseline();
      assert.equal(again.status, "ready");
      assert.notDeepEqual(captured.baseline.vt, again.baseline.vt);
      lease.release();
      record("W2C-E01", { reserved, before, events: account.events });
    } finally {
      engine.dispose();
      assert.equal(account.used(), 0);
    }
  });
  it("W2C-E02 bounded preview scratch reserves before construction and releases on every exit", async () => {
    const account = engineAccount();
    let deny = false;
    const scratch = M0_LIMITS.previewBytesPerRun + 512 * 12 * 4 + 256;
    const engine = model(account, (bytes) =>
      deny && bytes === scratch ? undefined : account.reserve(bytes),
    );
    try {
      assert((await apply(engine, 1, utf8("PREVIEW"))).ok);
      const before = account.used();
      const start = account.events.length;
      const preview = await engine.capturePreview();
      assert.equal(preview.status, "ready");
      const trace = account.events.slice(start);
      const allocation = trace.find(
        (event) => event.phase === "acquire" && event.bytes === scratch,
      );
      assert(allocation);
      assert(trace.some((event) => event.phase === "release" && event.id === allocation.id));
      assert.equal(account.used(), before);
      deny = true;
      assert.equal((await engine.capturePreview()).status, "unavailable");
      assert.equal(account.used(), before);
      record("W2C-E02", { scratch, trace });
    } finally {
      engine.dispose();
      assert.equal(account.used(), 0);
    }
    assert.equal((await engine.capturePreview()).status, "disposed");
  });
  it("W2C-E03 real checkpoint scratch uses exact independently frozen arithmetic", async () => {
    const account = engineAccount();
    const availableAfterSetters = 262144 - 16512;
    const gridCap = Math.min(
      M0_LIMITS.baselineVtBytes,
      Math.floor((availableAfterSetters - 512) / 7),
    );
    const scratch = 6 * gridCap + 256;
    record("W2C-E03-pre-execution", {
      limit: 262144,
      settersBytes: 16512,
      settersLength: 0,
      availableAfterSetters,
      gridCap,
      scratch,
      geometry,
      appearance: DEFAULT_APPEARANCE,
    });
    const engine = model(account);
    try {
      const acquisitions = account.events.filter((event) => event.phase === "acquire");
      assert.equal(acquisitions[0].bytes, 16512);
      assert.equal(acquisitions[1].bytes, scratch);
      assert(
        account.events.some(
          (event) => event.phase === "release" && event.id === acquisitions[1].id,
        ),
      );
      const captured = await engine.captureBaseline();
      assert.equal(captured.status, "ready");
      assert(captured.baseline.vt.length <= gridCap);
      record("W2C-E03", account.events);
    } finally {
      engine.dispose();
      assert.equal(account.used(), 0);
    }
  });
  it("W2C-E04 finite normal alternate and partial-grammar captures continue exact suffix", async () => {
    const variants = [
      [
        "R3-both-buffers",
        "4e4f524d414c1b5b323b33481b5b33316d1b371b5b3f343768414c541b5b333b35481b5b33326d1b371b5b343b39481b5b33346d",
        "",
        "1b38581b5b3f34376c1b3859",
      ],
      ["utf8-3", "", "e4", "b8ad"],
      ["utf8-4", "", "f09f", "9880"],
      ["csi-parameters", "", "1b5b3132", "3b3348"],
      ["osc-bel", "", "1b5d323b54", "07"],
      ["dcs-status", "", "1b5024716d1b", "5c"],
    ];
    for (const [id, setup, tail, continuation] of variants) {
      const account = engineAccount();
      const engine = model(account);
      const original = new Terminal({ ...geometry, scrollback: 10, allowProposedApi: true });
      const restored = new Terminal({ ...geometry, scrollback: 10, allowProposedApi: true });
      try {
        let seq = 0;
        for (const hex of [setup, tail])
          if (hex) {
            const bytes = Buffer.from(hex, "hex");
            assert((await apply(engine, ++seq, bytes)).ok);
            await write(original, bytes);
          }
        const capture = await engine.captureBaseline();
        assert.equal(capture.status, "ready", id);
        assert.equal(capture.baseline.atSeq, seq);
        await write(restored, capture.baseline.vt);
        await write(restored, capture.baseline.tail);
        const suffix = Buffer.concat([Buffer.from(continuation, "hex"), utf8("|W2-E04|")]);
        assert((await apply(engine, ++seq, suffix)).ok);
        await write(original, suffix);
        await write(restored, suffix);
        assert.deepEqual(visible(restored), visible(original), id);
        record("W2C-E04", {
          semanticVariant: id,
          setup,
          tail,
          continuation,
          baselineVtHex: Buffer.from(capture.baseline.vt).toString("hex"),
          baselineTailHex: Buffer.from(capture.baseline.tail).toString("hex"),
          original: visible(original),
          restored: visible(restored),
        });
      } finally {
        engine.dispose();
        original.dispose();
        restored.dispose();
        assert.equal(account.used(), 0);
      }
    }
  });
});
