import { afterEach, expect, test, vi } from "vitest";
import { attachNativeCommittedInput } from "../../dist/src/xterm-native-input.js";
import { attachInputOrigin } from "../../dist/src/xterm-input-origin.js";

afterEach(() => vi.useRealTimers());

function rig() {
  vi.useFakeTimers();
  const emitted = [];
  const rejected = [];
  const signals = new Set();
  const textarea = { value: "" };
  const helper = {
    _isComposing: false,
    _isSendingComposition: false,
    _dataAlreadySent: "",
    _handleAnyTextareaChanges() {},
  };
  const core = {
    textarea,
    _compositionHelper: helper,
    _keyPressHandled: false,
    _keyDownSeen: false,
    _unprocessedDeadKey: false,
    coreService: {
      triggerDataEvent(_data, user) {
        if (user) for (const signal of signals) signal();
      },
      triggerBinaryEvent() {},
      onUserInput(listener) {
        signals.add(listener);
        return { dispose: () => signals.delete(listener) };
      },
    },
    cancel() {},
    _inputEvent(event) {
      if (event.data && (!event.composed || !this._keyDownSeen) && !this._keyPressHandled) {
        this.coreService.triggerDataEvent(event.data, true);
        return true;
      }
      return false;
    },
  };
  const terminal = { _core: core };
  const origin = attachInputOrigin(
    terminal,
    (source) => source,
    (bytes) => emitted.push(...bytes),
    (error) => rejected.push(error.kind),
  );
  const original = core._inputEvent;
  const changes = helper._handleAnyTextareaChanges;
  const native = attachNativeCommittedInput(terminal);
  const input = (data, extra = {}) =>
    core._inputEvent({
      data,
      inputType: "insertText",
      isTrusted: true,
      isComposing: false,
      composed: true,
      ...extra,
    });
  return { core, helper, textarea, native, origin, emitted, rejected, input, original, changes };
}

test.each(["before-insertion", "after-insertion", "after-input"])(
  "native committed ASCII is emitted once with legacy timer %s",
  (order) => {
    const r = rig();
    // Exact ordering observed on WKWebView: 229, trusted insertText, keyup;
    // no keypress or composition. Exercise both sides of the old diff race.
    for (const char of "cove-t5-diag") {
      r.core._keyDownSeen = true;
      r.helper._handleAnyTextareaChanges();
      if (order === "before-insertion") vi.runAllTimers();
      r.textarea.value += char;
      if (order === "after-insertion") vi.runAllTimers();
      r.input(char);
      vi.runAllTimers();
      r.core._keyDownSeen = false;
    }
    expect(r.emitted).toEqual([...new TextEncoder().encode("cove-t5-diag")]);
    expect(r.rejected).toEqual([]);
  },
);

test("legacy deletion/replacement survive and disposal cancels deferred work", () => {
  const r = rig();
  r.textarea.value = "abc";
  r.helper._handleAnyTextareaChanges();
  r.textarea.value = "ab";
  vi.runAllTimers();
  r.helper._handleAnyTextareaChanges();
  r.textarea.value = "xy";
  vi.runAllTimers();
  expect(r.emitted).toEqual([127, 120, 121]);
  r.helper._handleAnyTextareaChanges();
  r.textarea.value = "xyz";
  r.native.dispose();
  vi.runAllTimers();
  expect(r.emitted).toEqual([127, 120, 121]);
  expect(r.core._inputEvent).toBe(r.original);
  expect(r.helper._handleAnyTextareaChanges).toBe(r.changes);
  expect(r.native.ownsSurface()).toBe(false);
});

test("composition and handled keypress stay on their original paths; replies stay filtered", () => {
  const r = rig();
  r.core._keyDownSeen = true;
  r.helper._handleAnyTextareaChanges();
  r.helper._isComposing = true;
  r.textarea.value = "色";
  r.input("色", { isComposing: true });
  vi.runAllTimers();
  expect(r.emitted).toEqual([]);
  // CompositionHelper's finalization remains its own producer.
  r.core.coreService.triggerDataEvent("色", true);
  r.helper._isComposing = false;
  r.core.coreService.triggerDataEvent("a", true);
  r.core._keyPressHandled = true;
  r.helper._handleAnyTextareaChanges();
  r.textarea.value += "a";
  r.input("a");
  vi.runAllTimers();
  r.core.coreService.triggerDataEvent("\x1b[0n", false);
  expect(r.emitted).toEqual([...new TextEncoder().encode("色a")]);
});

test("unsupported private shape fails explicitly and replaced surfaces lose ownership", () => {
  expect(() => attachNativeCommittedInput({ _core: {} })).toThrow(
    expect.objectContaining({ kind: "PROFILE_UNSUPPORTED" }),
  );
  const r = rig();
  r.core._inputEvent = () => false;
  expect(r.native.ownsSurface()).toBe(false);
  r.native.dispose();
  expect(r.core._inputEvent).not.toBe(r.original);
});
