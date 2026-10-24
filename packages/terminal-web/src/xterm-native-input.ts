import type { Terminal } from "@xterm/xterm";
import manifest from "@xterm/xterm/package.json" with { type: "json" };
import { domainError } from "@cove/protocol/errors";

interface CompositionSurface {
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _dataAlreadySent: string;
  _handleAnyTextareaChanges(): void;
}
interface NativeInputSurface {
  textarea: HTMLTextAreaElement;
  _compositionHelper: CompositionSurface;
  _inputEvent(event: InputEvent): boolean;
  _keyPressHandled: boolean;
  _unprocessedDeadKey: boolean;
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void };
  cancel(event: InputEvent): unknown;
}

export interface NativeInputAttachment {
  ownsSurface(): boolean;
  dispose(): void;
}

// xterm 6's composed insertText guard assumes keydown229's deferred textarea diff
// delivers the text. WKWebView can run that timer before native text insertion,
// leaving trusted input events unhandled (upstream #6045). Conversely, enabling
// input alone can duplicate a diff whose timer ran after insertion. Keep these two
// paths together, on this pinned private shape, and retain the existing origin
// wrapper: neither parser replies nor controller/PTY calls enter through here.
export function attachNativeCommittedInput(terminal: Terminal): NativeInputAttachment {
  const core = (terminal as unknown as { _core?: NativeInputSurface })._core;
  const helper = core?._compositionHelper;
  if (
    manifest.version !== "6.0.0" ||
    !core?.textarea ||
    !helper ||
    typeof core._inputEvent !== "function" ||
    typeof core.cancel !== "function" ||
    typeof core.coreService?.triggerDataEvent !== "function" ||
    typeof core._keyPressHandled !== "boolean" ||
    typeof core._unprocessedDeadKey !== "boolean" ||
    typeof helper._isComposing !== "boolean" ||
    typeof helper._isSendingComposition !== "boolean" ||
    typeof helper._dataAlreadySent !== "string" ||
    typeof helper._handleAnyTextareaChanges !== "function"
  )
    throw domainError("PROFILE_UNSUPPORTED");

  const originalInput = core._inputEvent;
  const originalChanges = helper._handleAnyTextareaChanges;
  type Change = {
    oldValue: string;
    timer: ReturnType<typeof setTimeout> | undefined;
    settled: boolean;
    sentValue?: string;
  };
  let pending: Change | undefined;
  let disposed = false;
  const cancel = () => {
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    pending = undefined;
  };
  const settle = (change: Change) => {
    if (disposed || change.settled) return;
    change.settled = true;
    if (helper._isComposing) return;
    // Preserve xterm6's legacy non-composition diff, including deletion and
    // replacement. Actual composition remains owned by CompositionHelper.
    const value = core.textarea.value;
    const diff = value.replace(change.oldValue, "");
    helper._dataAlreadySent = diff;
    const text =
      value.length > change.oldValue.length
        ? diff
        : value.length < change.oldValue.length
          ? "\x7f"
          : value !== change.oldValue
            ? value
            : undefined;
    if (text !== undefined) {
      change.sentValue = value;
      core.coreService.triggerDataEvent(text, true);
    }
  };
  const changes = function () {
    // A new 229 starts a new native edit. Finish the preceding edit before
    // replacing its timer, so rapid keys cannot drop unsent legacy changes.
    if (pending) settle(pending);
    cancel();
    const change: Change = { oldValue: core.textarea.value, timer: undefined, settled: false };
    pending = change;
    change.timer = setTimeout(() => settle(change), 0);
  };
  const input = function (this: NativeInputSurface, event: InputEvent): boolean {
    if (helper._isComposing || helper._isSendingComposition || event.isComposing) {
      cancel();
      return originalInput.call(this, event);
    }
    if (disposed || !pending || !event.isTrusted || event.inputType !== "insertText" || !event.data)
      return originalInput.call(this, event);

    const alreadySent = pending.sentValue === core.textarea.value;
    cancel();
    // Follow the stock input branch through coreService, whose method is still
    // owned by attachInputOrigin. A handled keypress or an already-emitted diff
    // must never generate a second copy of this committed edit.
    if (alreadySent || this._keyPressHandled) return false;
    this._unprocessedDeadKey = false;
    helper._dataAlreadySent = event.data;
    this.coreService.triggerDataEvent(event.data, true);
    this.cancel(event);
    return true;
  };
  helper._handleAnyTextareaChanges = changes;
  core._inputEvent = input;
  return {
    ownsSurface: () =>
      !disposed && core._inputEvent === input && helper._handleAnyTextareaChanges === changes,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      if (core._inputEvent === input) core._inputEvent = originalInput;
      if (helper._handleAnyTextareaChanges === changes)
        helper._handleAnyTextareaChanges = originalChanges;
    },
  };
}
