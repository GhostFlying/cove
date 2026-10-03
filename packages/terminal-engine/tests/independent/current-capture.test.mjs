import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "vitest";
import { TerminalModel } from "@cove/terminal-engine";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { record } from "../../../terminal-worker/tests/independent/current-recovery-ports.mjs";
import { WorkerRetainedBytes } from "../../../terminal-worker/dist/src/worker-retained-bytes.js";
import { createHash } from "node:crypto";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const run = { serverId: "w2-server", relayInstanceId: "w2-relay", runId: "engine" };
const utf8 = (text) => new TextEncoder().encode(text);
const geometry = { cols: 12, rows: 4 };
function engineAccount(limit = 262144) {
  const backing = new WorkerRetainedBytes(limit, 0);
  let used = 0;
  let serial = 0;
  const live = new Map();
  const events = [];
  const reserve = (bytes) => {
    events.push({ phase: "request", bytes, used });
    const actual = backing.reserve("engine", bytes);
    if (!actual) return;
    const id = ++serial;
    used += bytes;
    live.set(id, bytes);
    events.push({ phase: "acquire", id, bytes, used });
    return {
      release() {
        assert(live.has(id));
        used -= live.get(id);
        live.delete(id);
        actual.release();
        assert.equal(backing.snapshot().engineBytes, used);
        events.push({ phase: "release", id, bytes, used });
      },
    };
  };
  return {
    reserve,
    events,
    live,
    available: () => backing.availableOrdinaryBytes(),
    used: () => backing.snapshot().engineBytes,
    peak: () => backing.snapshot().peakAccountedBytes,
  };
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
const apply = (engine, seq, bytes) => {
  record("engine-input", { seq, rawHex: Buffer.from(bytes).toString("hex") });
  return engine.apply({ type: "output", run, seq }, bytes);
};
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
      record("E01-denied-capture", {
        before,
        after: engine.currentState(),
        denied,
        reserved,
        events: account.events,
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
    const scratch = 90368;
    const expected = utf8(
      "\x1b[0m\x1b[H\x1b[0mPREVIEW     \r\n\x1b[0m            \r\n\x1b[0m            \r\n\x1b[0m            \x1b[1;8H",
    );
    for (const variant of [
      "exact-bytes",
      "denial",
      "huge-cell-overflow",
      "construction-throw",
      "inflight-dispose",
    ]) {
      const account = engineAccount();
      let active = false;
      let engine;
      let detached;
      const original = Object.getOwnPropertyDescriptor(Terminal.prototype, "buffer");
      const reserve = (bytes) => {
        if (active && bytes === scratch && variant === "denial") return undefined;
        const lease = account.reserve(bytes);
        if (active && bytes === scratch && variant === "inflight-dispose") engine.dispose();
        return lease;
      };
      engine = model(account, reserve);
      try {
        assert((await apply(engine, 1, utf8("PREVIEW"))).ok);
        if (variant === "exact-bytes") {
          detached = account.reserve(65536);
          assert(detached);
        }
        const ownerIdsBefore = [...account.live.keys()];
        const usedBefore = account.used();
        const eventStart = account.events.length;
        if (variant === "construction-throw" || variant === "huge-cell-overflow") {
          assert(original?.get, "bounded public buffer getter injection required");
          Object.defineProperty(Terminal.prototype, "buffer", {
            ...original,
            get() {
              const buffers = original.get.call(this);
              return new Proxy(buffers, {
                get(target, key) {
                  if (key !== "active") return Reflect.get(target, key);
                  if (variant === "construction-throw")
                    throw Error("controlled preview construction throw");
                  const buffer = target.active;
                  return new Proxy(buffer, {
                    get(value, field) {
                      if (field !== "getLine") return Reflect.get(value, field);
                      return (lineIndex) => {
                        const line = value.getLine(lineIndex);
                        return new Proxy(line, {
                          get(row, rowField) {
                            if (rowField !== "getCell") {
                              const entry = Reflect.get(row, rowField);
                              return typeof entry === "function" ? entry.bind(row) : entry;
                            }
                            return (column) => {
                              const cell = row.getCell(column);
                              return new Proxy(cell, {
                                get(item, itemField) {
                                  if (itemField === "getChars")
                                    return () => "A" + "\u0301".repeat(40000);
                                  const entry = Reflect.get(item, itemField);
                                  return typeof entry === "function" ? entry.bind(item) : entry;
                                },
                              });
                            };
                          },
                        });
                      };
                    },
                  });
                },
              });
            },
          });
        }
        active = true;
        const result = await engine.capturePreview();
        await new Promise((resolve) => setImmediate(resolve));
        const trace = account.events.slice(eventStart);
        const owner = trace.find((event) => event.phase === "acquire" && event.bytes === scratch);
        if (variant === "denial") assert.equal(owner, undefined);
        else {
          assert(owner);
          assert(trace.some((event) => event.phase === "release" && event.id === owner.id));
        }
        if (variant === "exact-bytes") {
          assert.equal(result.status, "ready");
          assert.deepEqual(result.preview.vt, expected);
          assert.equal(account.used(), usedBefore);
          assert.deepEqual([...account.live.keys()], ownerIdsBefore);
          engine.dispose();
          assert.equal(account.used(), 65536);
          assert.deepEqual(result.preview.vt, expected);
          result.preview.vt.fill(0);
          detached.release();
          detached = undefined;
          assert.equal(account.used(), 0);
        } else if (variant === "inflight-dispose") {
          assert.equal(result.status, "disposed");
          assert.equal(account.used(), 0);
        } else {
          assert.equal(result.status, "unavailable");
          assert.equal(account.used(), usedBefore);
          assert.deepEqual([...account.live.keys()], ownerIdsBefore);
        }
        if (variant === "huge-cell-overflow") assert.match(result.reason, /exceeds byte cap/);
        if (variant === "construction-throw")
          assert.equal(result.reason, "controlled preview construction throw");
        record("W2C-E02", {
          semanticVariant: variant,
          scratch,
          expectedHex: Buffer.from(expected).toString("hex"),
          result: { status: result.status, reason: result.reason },
          ownerIdsBefore,
          ownerIdsAfter: [...account.live.keys()],
          trace,
          peak: account.peak(),
        });
      } finally {
        active = false;
        if (original) Object.defineProperty(Terminal.prototype, "buffer", original);
        engine.dispose();
        detached?.release();
        assert.equal(account.used(), 0);
      }
      assert.equal((await engine.capturePreview()).status, "disposed");
    }
  });
  it("W2C-E03 real checkpoint scratch uses exact independently frozen arithmetic", async () => {
    const account = engineAccount();
    const availableAfterSetters = 262144 - 16512;
    const gridCap = Math.min(
      M0_LIMITS.baselineVtBytes - 76,
      Math.floor((availableAfterSetters - 512 - 3 * 76) / 7),
    );
    const scratch = 6 * gridCap + 2 * 76 + 256;
    const setters = Buffer.from(
      "1b5d31303b7267623a666666662f666666662f666666661b5c1b5d31313b7267623a303030302f303030302f303030301b5c1b5d343b313b7267623a636363632f303030302f303030301b5c",
      "hex",
    );
    assert.equal(setters.length, 76);
    assert.equal(
      createHash("sha256").update(setters).digest("hex"),
      "729ee81f4b053d9a5f3185866583665bd9f65703565d1888d942da5ab000022c",
    );
    assert.equal(gridCap, 34984);
    assert.equal(scratch, 210312);
    record("W2C-E03-pre-execution", {
      limit: 262144,
      settersBytes: 16512,
      settersLength: 76,
      literalSettersHex: setters.toString("hex"),
      literalSettersSha256: "729ee81f4b053d9a5f3185866583665bd9f65703565d1888d942da5ab000022c",
      totalVtUpperBound: 35060,
      candidateOwnerUpperBound: 35316,
      peakUpperBound: 262140,
      headroom: 4,
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
      const scratchRequest = account.events.find(
        (event) => event.phase === "request" && event.bytes === scratch,
      );
      assert.equal(262144 - scratchRequest.used, 245632);
      assert(
        account.events.some(
          (event) => event.phase === "release" && event.id === acquisitions[1].id,
        ),
      );
      const captured = await engine.captureBaseline();
      assert.equal(captured.status, "ready");
      assert.deepEqual(captured.baseline.vt.subarray(0, 76), setters);
      assert(captured.baseline.vt.length - 76 <= gridCap);
      assert(captured.baseline.vt.length <= 35060);
      assert.equal(acquisitions[2].bytes, captured.baseline.vt.length + 256);
      assert(acquisitions[2].bytes <= 35316);
      assert(account.peak() <= 262140);
      record("W2C-E03", account.events);
    } finally {
      engine.dispose();
      assert.equal(account.used(), 0);
    }
    for (const variant of ["scratch-denial", "construction-throw", "detached-dispose"]) {
      const owned = engineAccount();
      const bufferGetter = Object.getOwnPropertyDescriptor(Terminal.prototype, "buffer");
      let subject;
      let detached;
      try {
        if (variant === "construction-throw") {
          assert(bufferGetter?.get);
          Object.defineProperty(Terminal.prototype, "buffer", {
            ...bufferGetter,
            get() {
              throw Error("controlled checkpoint construction throw");
            },
          });
        }
        if (variant === "scratch-denial" || variant === "construction-throw") {
          assert.throws(() =>
            model(owned, (bytes) =>
              variant === "scratch-denial" && bytes === scratch ? undefined : owned.reserve(bytes),
            ),
          );
          assert.equal(owned.used(), 0);
        } else {
          subject = model(owned);
          const captured = await subject.captureBaseline((bytes) => {
            detached = owned.reserve(bytes);
            assert(detached);
            subject.dispose();
            return true;
          });
          assert.equal(captured.status, "disposed");
          assert.equal(owned.live.size, 1);
          detached.release();
          detached = undefined;
          assert.equal(owned.used(), 0);
        }
        const scratchLease = owned.events.find(
          (event) => event.phase === "acquire" && event.bytes === scratch,
        );
        if (variant === "scratch-denial") assert.equal(scratchLease, undefined);
        else {
          assert(scratchLease);
          assert(
            owned.events.some((event) => event.phase === "release" && event.id === scratchLease.id),
          );
        }
        record("W2C-E03", {
          semanticVariant: variant,
          events: owned.events,
          peak: owned.peak(),
          finalOwners: [...owned.live.keys()],
        });
      } finally {
        if (bufferGetter) Object.defineProperty(Terminal.prototype, "buffer", bufferGetter);
        subject?.dispose();
        detached?.release();
        assert.equal(owned.used(), 0);
      }
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
