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
  const event = (value) =>
    events.push({ ...value, account: backing.snapshot(), owners: [...live] });
  const reserve = (bytes) => {
    event({ phase: "request", bytes, used });
    const actual = backing.reserve("engine", bytes);
    if (!actual) return;
    const id = ++serial;
    used += bytes;
    live.set(id, bytes);
    event({ phase: "acquire", id, bytes, used });
    return {
      release() {
        assert(live.has(id));
        used -= live.get(id);
        live.delete(id);
        actual.release();
        assert.equal(backing.snapshot().engineBytes, used);
        event({ phase: "release", id, bytes, used });
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
    snapshot: () => backing.snapshot(),
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
    const callerOwners = [];
    const terminals = [];
    const fixedInput = {
      run,
      seq: 1,
      rawHex: "42415345",
      bytes: 4,
      sha256: "cbf36a964ba8c0894fcc9ec491b4d1dd94d221a7dc88308e9c6b892445a8574b",
    };
    const authority = {
      receivedSeq: 1,
      parsedSeq: 1,
      geometry,
      appearance: DEFAULT_APPEARANCE,
      appearanceEpoch: 1,
      supportedQueryIds: [
        "dsr-status",
        "cpr",
        "dec-cpr",
        "da-primary",
        "da-secondary",
        "mode-report",
        "color-fg",
        "color-bg",
        "color-palette",
      ],
      knownPaletteIndices: [1],
      activeBuffer: "normal",
      focusReportMode: false,
      recovery: { state: "ready" },
    };
    const resources = {
      queuedBytes: 0,
      pendingOperations: 0,
      checkpointBytes: 322,
      tailBytes: 0,
      tailAllocatedBytes: 0,
      peakAccountedBytes: 67045,
    };
    const staticVT = Buffer.from(
      "1b5d31303b7267623a666666662f666666662f666666661b5c1b5d31313b7267623a303030302f303030302f303030301b5c1b5d343b313b7267623a636363632f303030302f303030301b5c1b5b306d4241534520202020202020200d0a0d0a0d0a1b5b3f366c1b5b313b34721b5b33671b5b313b31481b481b5b313b39481b481b5b313b31481b5b306d1b28420f1b371b28421b29420f1b5b313b35481b5b306d1b5b3f3437681b5b481b5b3f366c1b5b313b34721b5b33671b5b313b31481b481b5b313b39481b481b5b313b31481b5b306d1b28420f1b371b28421b29420f1b5b313b31481b5b306d1b5b3f34376c1b5b3f366c1b5b313b34721b5b33671b5b313b31481b481b5b313b39481b481b5b313b31481b5b306d1b28420f1b371b28421b29420f1b5b313b35481b5b306d1b5b313b34481b5b31581b5b313b344845",
      "hex",
    );
    let disposed = false;
    let before;
    let lastLiveState;
    let receiptOrdinal = 0;
    const capture = (phase, value = {}, eventStart = 0) => {
      if (!disposed) lastLiveState = engine.currentState();
      const receipt = structuredClone({
        ordinal: ++receiptOrdinal,
        phase,
        fixedInput,
        ...value,
        disposedObserved: disposed,
        lastLiveState,
        currentState: !disposed ? engine.currentState() : undefined,
        account: account.snapshot(),
        ordinaryAvailable: account.available(),
        owners: [...account.live],
        callerOwners: callerOwners.map((owner) => ({
          id: owner.id,
          bytes: owner.bytes,
          released: owner.released,
        })),
        eventStart,
        eventEnd: account.events.length,
        events: account.events.slice(eventStart),
      });
      record("W2C-E01-complete-boundary", receipt);
      return receipt;
    };
    const assertAuthority = (state) => {
      assert.deepEqual(Object.keys(state).sort(), [...Object.keys(authority), "resources"].sort());
      for (const [key, expected] of Object.entries(authority)) {
        assert.deepEqual(state[key], expected, key);
        assert.deepEqual(state[key], before[key], key);
      }
    };
    const assertAccount = (used, peak = 236853) => {
      assert.deepEqual(account.snapshot(), {
        accountedBytes: used,
        peakAccountedBytes: peak,
        reservedControlBytes: 0,
        workerBytes: 0,
        engineBytes: used,
        nativeInputBytes: 0,
        nativeOutputBytes: 0,
      });
      assert.equal(account.available(), 262144 - used);
      assert.equal(
        [...account.live.values()].reduce((sum, bytes) => sum + bytes, 0),
        used,
      );
      for (const event of account.events) {
        assert.equal(event.account.engineBytes, event.used);
        assert.equal(event.account.accountedBytes, event.used);
        assert.equal(
          event.owners.reduce((sum, [, bytes]) => sum + bytes, 0),
          event.used,
        );
      }
    };
    const callerReserve = (bytes) => {
      const lease = account.reserve(bytes);
      const acquired = account.events.at(-1);
      const owner = {
        id: acquired?.phase === "acquire" ? acquired.id : undefined,
        bytes,
        lease,
        released: false,
      };
      if (lease) callerOwners.push(owner);
      return owner;
    };
    const releaseCaller = (owner) => {
      capture("caller-release-before", { id: owner.id });
      owner.lease.release();
      owner.released = true;
      capture("caller-release-after", { id: owner.id });
    };
    const terminalContent = (terminal) => {
      const buffer = (kind) => {
        const actual = terminal.buffer[kind];
        return {
          x: actual.cursorX,
          y: actual.cursorY,
          lines: Array.from({ length: actual.length }, (_, row) => {
            const line = actual.getLine(row);
            return {
              text: line.translateToString(false),
              cells: Array.from({ length: 12 }, (_, column) => {
                const cell = line.getCell(column);
                return {
                  chars: cell.getChars() || " ",
                  width: cell.getWidth(),
                  fgMode: cell.getFgColorMode(),
                  bgMode: cell.getBgColorMode(),
                  fg: cell.getFgColor(),
                  bg: cell.getBgColor(),
                  default: cell.isAttributeDefault(),
                  styles: [
                    cell.isBold(),
                    cell.isItalic(),
                    cell.isDim(),
                    cell.isUnderline(),
                    cell.isBlink(),
                    cell.isInverse(),
                    cell.isInvisible(),
                    cell.isStrikethrough(),
                    cell.isOverline(),
                  ],
                };
              }),
            };
          }),
        };
      };
      return {
        active: terminal.buffer.active === terminal.buffer.normal ? "normal" : "alternate",
        normal: buffer("normal"),
        alternate: buffer("alternate"),
        modes: { ...terminal.modes },
      };
    };
    const assertContent = async (baseline, label) => {
      const reference = new Terminal({ ...geometry, scrollback: 10, allowProposedApi: true });
      terminals.push(reference);
      const restored = new Terminal({ ...geometry, scrollback: 10, allowProposedApi: true });
      terminals.push(restored);
      await write(reference, utf8("BASE"));
      await write(restored, baseline.vt);
      if (baseline.tail.length) await write(restored, baseline.tail);
      const expected = terminalContent(reference);
      const actual = terminalContent(restored);
      capture("independent-content-before-assertions", { label, actual, reference: expected });
      const rows = ["BASE        ", "            ", "            ", "            "];
      const modes = {
        applicationCursorKeysMode: false,
        applicationKeypadMode: false,
        bracketedPasteMode: false,
        insertMode: false,
        mouseTrackingMode: "none",
        originMode: false,
        reverseWraparoundMode: false,
        sendFocusMode: false,
        synchronizedOutputMode: false,
        wraparoundMode: true,
      };
      for (const content of [expected, actual]) {
        assert.equal(content.active, "normal");
        assert.equal(content.normal.x, 4);
        assert.equal(content.normal.y, 0);
        assert.deepEqual(
          content.normal.lines.map((line) => line.text),
          rows,
        );
        assert.deepEqual(content.modes, modes);
        for (const line of [...content.normal.lines, ...content.alternate.lines]) {
          for (const cell of line.cells) {
            assert.equal(cell.width, 1);
            assert.equal(cell.default, true);
            assert.deepEqual([cell.fgMode, cell.bgMode, cell.fg, cell.bg], [0, 0, -1, -1]);
            assert.deepEqual(cell.styles, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
          }
        }
        assert([0, 4].includes(content.alternate.lines.length));
        assert(content.alternate.lines.every((line) => line.text === "            "));
      }
      assert.deepEqual(actual.normal, expected.normal);
      // An unused alternate buffer may be absent or four default empty rows.
      if (actual.alternate.lines.length && expected.alternate.lines.length)
        assert.deepEqual(actual.alternate.lines, expected.alternate.lines);
      assert.deepEqual(actual.modes, expected.modes);
      assert.deepEqual(baseline, {
        profile: "pragmatic-logical-grid-v1",
        encoding: "vt-checkpoint-tail-v1",
        checkpointSeq: 1,
        atSeq: 1,
        captureGeometry: geometry,
        currentGeometry: geometry,
        coverage: {
          normal: {
            historyLines: 0,
            includedHistoryLines: 0,
            trimmedBefore: false,
            resizeContext: "requires-baseline",
          },
          alternate: { included: true, resizeContext: "requires-baseline" },
        },
        appearance: DEFAULT_APPEARANCE,
        vt: baseline.vt,
        tail: baseline.tail,
      });
      assert.equal(baseline.tail.length, 0);
      assert.equal(baseline.vt.length, 322);
      assert.equal(
        createHash("sha256").update(baseline.vt).digest("hex"),
        "d2231cc0852784da9542da0e7ad9176ba6488cfe5ef3d87c75fb9dc30d2c1d92",
      );
      assert.deepEqual(Buffer.from(baseline.vt), staticVT);
    };
    let primaryError;
    try {
      capture("before-original-apply");
      const applied = await apply(engine, 1, utf8("BASE"));
      const completed = capture("completed-apply-before-refusal", { applied });
      assert(applied.ok);
      before = completed.currentState;
      assertAuthority(before);
      assert.deepEqual(before.resources, {
        queuedBytes: 0,
        pendingOperations: 0,
        checkpointBytes: 289,
        tailBytes: 4,
        tailAllocatedBytes: 65536,
        peakAccountedBytes: 1080,
      });
      assertAccount(66081, 227369);
      assert.deepEqual(
        [...account.live.values()].sort((a, b) => a - b),
        [545, 65536],
      );
      const oldCheckpoint = [...account.live].find(([, bytes]) => bytes === 545)[0];
      const oldTail = [...account.live].find(([, bytes]) => bytes === 65536)[0];
      const refusalStart = account.events.length;
      let refusalCalls = 0;
      let refusalCallback;
      const denied = await engine.captureBaseline((bytes) => {
        refusalCalls++;
        refusalCallback = capture(
          "inside-refusal-callback-before-return",
          { bytes, returned: false },
          refusalStart,
        );
        return false;
      });
      capture(
        "resolved-refusal-before-assertions",
        { denied, refusalCalls, refusalCallback },
        refusalStart,
      );
      assert.deepEqual(denied, {
        status: "unavailable",
        reason: "Detached baseline exceeds worker retention capacity",
      });
      assert.equal(refusalCalls, 1);
      assert.equal(refusalCallback.bytes, 4418);
      assert.equal(refusalCallback.account.engineBytes, 642);
      assert.equal(refusalCallback.owners.length, 2);
      assert.deepEqual(
        refusalCallback.owners.map(([, bytes]) => bytes).sort((a, b) => a - b),
        [64, 578],
      );
      assertAuthority(engine.currentState());
      assert.deepEqual(engine.currentState().resources, resources);
      assertAccount(578);
      const trace = account.events.slice(refusalStart);
      const acquired = trace.filter((event) => event.phase === "acquire");
      assert.deepEqual(
        acquired.map((event) => event.bytes),
        [64, 16512, 153618, 578],
      );
      const [operation, setters, scratch, candidate] = acquired;
      const index = (phase, id) =>
        trace.findIndex((event) => event.phase === phase && event.id === id);
      assert(index("acquire", candidate.id) < index("release", oldCheckpoint));
      assert(index("release", scratch.id) < index("release", oldCheckpoint));
      assert(index("release", oldCheckpoint) < index("release", oldTail));
      assert(index("release", oldTail) < index("release", setters.id));
      assert(index("release", setters.id) < index("release", operation.id));
      assert.deepEqual([...account.live], [[candidate.id, 578]]);
      const throwStart = account.events.length;
      const controlledError = Error("controlled reserve refusal");
      let throwCalls = 0;
      const thrown = await engine.captureBaseline((bytes) => {
        throwCalls++;
        capture(
          "inside-throwing-callback",
          { bytes, throwing: controlledError.message },
          throwStart,
        );
        throw controlledError;
      });
      capture("throw-result-before-assertions", { thrown, throwCalls }, throwStart);
      assert.deepEqual(thrown, {
        status: "unavailable",
        reason: "Detached baseline reservation failed",
      });
      assert.equal(throwCalls, 1);
      assertAuthority(engine.currentState());
      assert.deepEqual(engine.currentState().resources, resources);
      assertAccount(578);
      assert.deepEqual(
        account.events
          .slice(throwStart)
          .filter((event) => event.phase === "acquire")
          .map((event) => event.bytes),
        [64],
      );
      const validStart = account.events.length;
      let firstOwner;
      let firstInside;
      const captured = await engine.captureBaseline((bytes) => {
        firstOwner = callerReserve(bytes);
        firstInside = capture(
          "first-real-caller-reserve-before-return",
          { bytes, returned: Boolean(firstOwner.lease) },
          validStart,
        );
        return Boolean(firstOwner.lease);
      });
      capture("first-ready-before-assertions", { captured, firstInside }, validStart);
      assert.equal(captured.status, "ready");
      assert.equal(firstInside.bytes, 4418);
      assert.equal(firstInside.account.engineBytes, 5060);
      assert.equal(firstInside.currentState.parsedSeq, 1);
      assertAccount(4996);
      await assertContent(captured.baseline, "first-copy");
      capture("before-detached-first-copy-mutation", { baseline: captured.baseline });
      captured.baseline.vt.fill(88);
      capture("after-detached-first-copy-mutation", { baseline: captured.baseline });
      const secondStart = account.events.length;
      let secondOwner;
      let secondInside;
      const again = await engine.captureBaseline((bytes) => {
        secondOwner = callerReserve(bytes);
        secondInside = capture(
          "second-real-caller-reserve-before-return",
          { bytes, returned: Boolean(secondOwner.lease) },
          secondStart,
        );
        return Boolean(secondOwner.lease);
      });
      capture(
        "second-ready-before-assertions",
        { again, secondInside, mutatedFirst: captured.baseline },
        secondStart,
      );
      assert.equal(again.status, "ready");
      assert.equal(secondInside.bytes, 4418);
      assert.equal(secondInside.account.engineBytes, 9478);
      assertAccount(9414);
      await assertContent(again.baseline, "second-copy-after-detached-mutation");
      assert.notDeepEqual(captured.baseline.vt, again.baseline.vt);
      assert.notEqual(captured.baseline.vt, again.baseline.vt);
      assert.notEqual(captured.baseline.appearance, again.baseline.appearance);
      assertAuthority(engine.currentState());
      assert.deepEqual(engine.currentState().resources, resources);
      releaseCaller(firstOwner);
      releaseCaller(secondOwner);
      capture("after-both-caller-releases-before-assertions");
      assertAccount(578);
      const disposeStart = account.events.length;
      let disposeOwner;
      let disposeCalls = 0;
      const disposedResult = await engine.captureBaseline((bytes) => {
        disposeCalls++;
        disposeOwner = callerReserve(bytes);
        capture(
          "dispose-in-reserve-before-model-dispose",
          { bytes, returned: Boolean(disposeOwner.lease) },
          disposeStart,
        );
        engine.dispose();
        disposed = true;
        capture(
          "dispose-in-reserve-after-model-dispose",
          { bytes, returned: Boolean(disposeOwner.lease) },
          disposeStart,
        );
        return Boolean(disposeOwner.lease);
      });
      capture(
        "dispose-in-reserve-result-before-assertions",
        { disposedResult, disposeCalls },
        disposeStart,
      );
      assert.deepEqual(disposedResult, { status: "disposed", reason: "Terminal model disposed" });
      assert.equal(disposeCalls, 1);
      assert.equal(disposeOwner.bytes, 4418);
      assertAccount(4418);
      assert.deepEqual([...account.live], [[disposeOwner.id, 4418]]);
      releaseCaller(disposeOwner);
      capture("after-dispose-caller-release-before-assertions");
      assertAccount(0);
      const repeatStart = account.events.length;
      engine.dispose();
      capture("idempotent-dispose-before-assertions", {}, repeatStart);
      assert.equal(account.events.length, repeatStart);
    } catch (error) {
      primaryError = error;
      capture("first-body-failure", { error: String(error), stack: error.stack });
      throw error;
    } finally {
      capture("finally-before-actual-model-dispose", {
        primaryError: primaryError && String(primaryError),
      });
      engine.dispose();
      disposed = true;
      const cleanupErrors = [];
      for (const owner of callerOwners)
        if (!owner.released) {
          try {
            releaseCaller(owner);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      for (const terminal of terminals) {
        try {
          terminal.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      capture("finally-after-actual-dispose-before-ownership-assertions", {
        cleanupErrors: cleanupErrors.map(String),
      });
      assert.equal(cleanupErrors.length, 0, "E01 actual cleanup failed; see complete receipt");
      assert.equal(account.used(), 0);
      assert.equal(account.live.size, 0);
      assert.equal(account.snapshot().engineBytes, 0);
      for (const acquired of account.events.filter((event) => event.phase === "acquire")) {
        assert.equal(
          account.events.filter((event) => event.phase === "release" && event.id === acquired.id)
            .length,
          1,
        );
      }
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
    const rawReceipt = (bytes) => ({
      type: bytes.constructor.name,
      isBuffer: Buffer.isBuffer(bytes),
      length: bytes.length,
      rawHex: Buffer.from(bytes).toString("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    let receiptOrdinal = 0;
    const capture = (phase, owned, subject, disposed, value = {}) => {
      const result = value.result;
      const baseline = result?.status === "ready" ? result.baseline : undefined;
      const receipt = structuredClone({
        ordinal: ++receiptOrdinal,
        phase,
        run,
        geometry,
        appearance: DEFAULT_APPEARANCE,
        effectiveBudgets: { ...M0_LIMITS, historyLines: 10 },
        ...value,
        currentState: subject && !disposed ? subject.currentState() : undefined,
        disposedObservation: disposed,
        baselineBytes: baseline && {
          vt: rawReceipt(baseline.vt),
          tail: rawReceipt(baseline.tail),
          prefix: rawReceipt(baseline.vt.subarray(0, 76)),
        },
        account: owned.snapshot(),
        owners: [...owned.live],
        used: owned.used(),
        available: owned.available(),
        peak: owned.peak(),
        eventStart: 0,
        eventEnd: owned.events.length,
        events: owned.events.slice(),
      });
      record("W2C-E03-complete-boundary", receipt);
      return receipt;
    };
    let engine;
    try {
      capture("before-original-constructor", account);
      engine = model(account);
      capture("after-original-constructor-before-assertions", account, engine, false);
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
      capture("actual-capture-before-status-and-prefix-assertions", account, engine, false, {
        result: captured,
      });
      assert.equal(captured.status, "ready");
      const prefix = captured.baseline.vt.subarray(0, 76);
      assert.deepEqual(prefix, Uint8Array.from(setters));
      assert.equal(prefix.length, 76);
      assert.equal(
        createHash("sha256").update(prefix).digest("hex"),
        "729ee81f4b053d9a5f3185866583665bd9f65703565d1888d942da5ab000022c",
      );
      assert(captured.baseline.vt.length - 76 <= gridCap);
      assert(captured.baseline.vt.length <= 35060);
      assert.equal(acquisitions[2].bytes, captured.baseline.vt.length + 256);
      assert(acquisitions[2].bytes <= 35316);
      assert(account.peak() <= 262140);
      record("W2C-E03", account.events);
    } finally {
      capture("primary-finally-before-actual-dispose", account, engine, false);
      try {
        engine?.dispose();
      } finally {
        capture(
          "primary-finally-after-actual-dispose-before-zero-assertion",
          account,
          undefined,
          true,
        );
      }
      assert.equal(account.used(), 0);
    }
    for (const variant of ["scratch-denial", "construction-throw", "detached-dispose"]) {
      const owned = engineAccount();
      const bufferGetter = Object.getOwnPropertyDescriptor(Terminal.prototype, "buffer");
      let subject;
      let detached;
      let variantDisposed = false;
      try {
        capture("variant-before-original-setup", owned, undefined, false, {
          semanticVariant: variant,
        });
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
          assert.throws(() => {
            capture("variant-before-original-constructor", owned, undefined, false, {
              semanticVariant: variant,
            });
            try {
              const result = model(owned, (bytes) =>
                variant === "scratch-denial" && bytes === scratch
                  ? undefined
                  : owned.reserve(bytes),
              );
              subject = result;
              capture("variant-constructor-return-before-assertions", owned, undefined, false, {
                semanticVariant: variant,
                constructed: true,
              });
              return result;
            } catch (error) {
              capture("variant-constructor-throw-before-assertions", owned, undefined, false, {
                semanticVariant: variant,
                actualThrow: { name: error.name, message: error.message, stack: error.stack },
              });
              throw error;
            }
          });
          assert.equal(owned.used(), 0);
        } else {
          capture("variant-before-original-constructor", owned, undefined, false, {
            semanticVariant: variant,
          });
          subject = model(owned);
          capture("variant-after-original-constructor", owned, subject, false, {
            semanticVariant: variant,
          });
          const captured = await subject.captureBaseline((bytes) => {
            detached = owned.reserve(bytes);
            capture("variant-real-caller-reserve-before-assertion", owned, subject, false, {
              semanticVariant: variant,
              bytes,
              acquired: Boolean(detached),
            });
            assert(detached);
            subject.dispose();
            variantDisposed = true;
            capture("variant-actual-dispose-in-reserve", owned, undefined, true, {
              semanticVariant: variant,
              bytes,
              returned: true,
            });
            return true;
          });
          capture("variant-disposed-result-before-assertions", owned, subject, variantDisposed, {
            semanticVariant: variant,
            result: captured,
          });
          assert.equal(captured.status, "disposed");
          assert.equal(owned.live.size, 1);
          capture("variant-caller-release-before", owned, subject, variantDisposed, {
            semanticVariant: variant,
          });
          detached.release();
          detached = undefined;
          capture(
            "variant-caller-release-after-before-zero-assertion",
            owned,
            subject,
            variantDisposed,
            { semanticVariant: variant },
          );
          assert.equal(owned.used(), 0);
        }
        capture(
          "variant-before-original-scratch-owner-assertions",
          owned,
          subject,
          variantDisposed,
          { semanticVariant: variant },
        );
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
        capture(
          "variant-finally-after-original-getter-restoration",
          owned,
          subject,
          variantDisposed,
          {
            semanticVariant: variant,
            restoredBufferGetter:
              Object.getOwnPropertyDescriptor(Terminal.prototype, "buffer")?.get ===
              bufferGetter?.get,
          },
        );
        try {
          subject?.dispose();
        } finally {
          try {
            detached?.release();
          } finally {
            capture(
              "variant-finally-after-actual-dispose-and-caller-release-before-zero-assertion",
              owned,
              undefined,
              true,
              { semanticVariant: variant },
            );
          }
        }
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
