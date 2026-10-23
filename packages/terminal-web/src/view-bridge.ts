import { DomainErrorSchema, domainError, type DomainError } from "@cove/protocol/errors";
import { GeometrySchema, type Geometry, type Appearance } from "@cove/protocol/profile";
import type { BaselineDescriptor, TerminalEvent } from "@cove/protocol/terminal";
import type {
  FocusIntent,
  InputIntent,
  TerminalView,
  ViewInitialization,
} from "@cove/protocol/view";
import {
  VIEW_BRIDGE_MAX_FRAME_CHARS,
  decodeBridgeBytes,
  encodeBridgeBytes,
  frameCharge,
  positiveCounter,
  readBridgeFrame,
  type ViewBridgeFrame,
} from "./view-bridge-wire.js";

type Listener<T> = (value: T) => void;
type PostMessage = (message: string) => void;

export interface ViewBridgeOptions {
  /** A new positive counter for each physical WebView/renderer incarnation. */
  bridgeGeneration: number;
  postMessage: PostMessage;
  /** Includes queued and in-flight command reservations. Default: 8 MiB / 64 commands. */
  maxPendingBytes?: number;
  maxPendingCommands?: number;
  /** Bounds readiness and each actual view application, not merely postMessage. */
  timeoutMs?: number;
}

export interface TerminalViewBridgeHost extends TerminalView {
  /** Await before controller attach: measureGrid never fabricates an unconfirmed grid. */
  readonly ready: Promise<Geometry>;
  receiveMessage(message: string): void;
  invalidate(error?: DomainError): void;
  snapshot(): { pendingCommands: number; chargedBytes: number; closed: boolean };
}

export interface ViewBridgeEndpointOptions {
  bridgeGeneration: number;
  view: TerminalView;
  initialGeometry: Geometry;
  postMessage: PostMessage;
  /** Bounds input/focus/layout awaiting host receipt, independently of VT parsing. */
  maxPendingBytes?: number;
  maxPendingNotices?: number;
  timeoutMs?: number;
}

export interface TerminalViewBridgeEndpoint {
  receiveMessage(message: string): void;
  /** Called after an actual layout measurement, never from a guessed host viewport. */
  publishGeometry(geometry: Geometry): void;
  snapshot(): { pendingNotices: number; chargedBytes: number; closed: boolean };
  dispose(): void;
}

function emit<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // Observer exceptions do not corrupt bridge credit or prevent disposal.
    }
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>) {
  listeners.add(listener);
  return { dispose: () => void listeners.delete(listener) };
}

function errorValue(value: unknown): DomainError {
  return DomainErrorSchema.safeParse(value).data ?? domainError("RESYNC_REQUIRED");
}

function validViewGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function serialize(frame: ViewBridgeFrame): string {
  const text = JSON.stringify(frame);
  if (text.length > VIEW_BRIDGE_MAX_FRAME_CHARS) throw domainError("RESYNC_REQUIRED");
  return text;
}

interface PendingCommand {
  id: number;
  text: string;
  charge: number;
  resolve(): void;
  reject(error: DomainError): void;
}

export function createTerminalViewBridgeHost(options: ViewBridgeOptions): TerminalViewBridgeHost {
  if (!positiveCounter(options.bridgeGeneration)) throw new RangeError("Invalid bridge generation");
  const maxBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
  const maxCommands = options.maxPendingCommands ?? 64;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 2 * 1024 * 1024 ||
    maxBytes > 32 * 1024 * 1024 ||
    !positiveCounter(maxCommands) ||
    maxCommands > 256 ||
    !positiveCounter(timeoutMs) ||
    timeoutMs > 30_000
  )
    throw new RangeError("Invalid bridge bounds");
  const inputs = new Set<Listener<InputIntent>>();
  const focuses = new Set<Listener<FocusIntent>>();
  const failures = new Set<Listener<DomainError>>();
  const queue: PendingCommand[] = [];
  let current: PendingCommand | undefined;
  let chargedBytes = 0;
  let nextId = 1;
  let lastNoticeId = 0;
  let closed = false;
  let geometry: Geometry | undefined;
  let measurementRevision = 0;
  let readySettled = false;
  let resolveReady!: (geometry: Geometry) => void;
  let rejectReady!: (error: DomainError) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<Geometry>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Creation may precede the component mounting; a premature failure remains
  // observable to its later ready consumer without an unhandled rejection.
  void ready.catch(() => {});

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const close = (error: DomainError, notify: boolean, notifyEndpoint = true) => {
    if (closed) return;
    closed = true;
    cancelTimer();
    geometry = undefined;
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    const abandoned = current ? [current, ...queue] : [...queue];
    current = undefined;
    queue.length = 0;
    chargedBytes = 0;
    for (const command of abandoned) command.reject(error);
    if (notifyEndpoint) {
      try {
        options.postMessage(
          serialize({ version: 1, bridgeGeneration: options.bridgeGeneration, kind: "dispose" }),
        );
      } catch {
        // A failed/departed renderer cannot acknowledge cleanup. Local promises
        // are still settled; its owner must release the physical content process.
      }
    }
    if (notify) emit(failures, error);
    inputs.clear();
    focuses.clear();
    failures.clear();
  };
  const fail = (error = domainError("RESYNC_REQUIRED")) => close(error, true);
  const armTimer = () => {
    cancelTimer();
    timer = setTimeout(() => fail(), timeoutMs);
  };
  const pump = () => {
    if (closed || !geometry || current || queue.length === 0) return;
    current = queue.shift()!;
    // Set current and arm timeout before post: a local transport may acknowledge synchronously.
    armTimer();
    try {
      options.postMessage(current.text);
    } catch {
      fail();
    }
  };
  const enqueue = (operation: string, value?: unknown, bytes?: Uint8Array): Promise<void> => {
    if (closed) return Promise.reject(domainError("RESYNC_REQUIRED"));
    let text: string;
    let charge: number;
    const id = nextId++;
    try {
      if (!positiveCounter(id)) throw domainError("COUNTER_EXHAUSTED");
      text = serialize({
        version: 1,
        bridgeGeneration: options.bridgeGeneration,
        kind: "command",
        commandId: id,
        operation,
        ...(value === undefined ? {} : { value }),
        ...(bytes === undefined ? {} : { bytes: encodeBridgeBytes(bytes) }),
      });
      charge = frameCharge(text, bytes?.byteLength ?? 0);
    } catch {
      fail();
      return Promise.reject(domainError("RESYNC_REQUIRED"));
    }
    if (queue.length + Number(!!current) >= maxCommands || chargedBytes + charge > maxBytes) {
      fail(domainError("BUSY"));
      return Promise.reject(domainError("BUSY"));
    }
    chargedBytes += charge;
    const pending = new Promise<void>((resolve, reject) => {
      queue.push({ id, text, charge, resolve, reject });
    });
    pump();
    return pending;
  };
  const enqueueVoid = (operation: string, value: unknown) => {
    void enqueue(operation, value).catch(() => {});
  };
  const adoptGeometry = (value: unknown, revision: unknown): boolean => {
    const checked = GeometrySchema.safeParse(value);
    if (!checked.success || !positiveCounter(revision)) return false;
    // ACKs bypass the receipt-controlled notice lane. Their measurements and
    // queued layout notices therefore share one endpoint-issued order.
    if (revision <= measurementRevision) return true;
    measurementRevision = revision;
    geometry = checked.data;
    if (!readySettled) {
      readySettled = true;
      resolveReady({ ...geometry });
    }
    return true;
  };
  const acknowledgeNotice = (noticeId: number) => {
    if (closed) return;
    try {
      options.postMessage(
        serialize({
          version: 1,
          bridgeGeneration: options.bridgeGeneration,
          kind: "notice-ack",
          noticeId,
        }),
      );
    } catch {
      fail();
    }
  };
  armTimer();

  return {
    ready,
    initialize: (input: ViewInitialization) => enqueue("initialize", input),
    beginBaseline: (descriptor: BaselineDescriptor) => enqueue("beginBaseline", descriptor),
    writeBaselineChunk: (bytes: Uint8Array) => enqueue("writeBaselineChunk", undefined, bytes),
    finishBaseline: () => enqueue("finishBaseline"),
    applyEvent: (event: TerminalEvent, payload?: Uint8Array) =>
      enqueue("applyEvent", event, payload),
    measureGrid() {
      if (closed || !geometry) throw domainError("RESYNC_REQUIRED");
      return { ...geometry };
    },
    setAppearance: (appearance: Appearance) => enqueueVoid("setAppearance", appearance),
    setVisibility: (visible: boolean) => enqueueVoid("setVisibility", visible),
    onInputIntent: (listener) => subscribe(inputs, listener),
    onFocusIntent: (listener) => subscribe(focuses, listener),
    onFailure: (listener) => subscribe(failures, listener),
    invalidate: fail,
    snapshot: () => ({ pendingCommands: queue.length + Number(!!current), chargedBytes, closed }),
    receiveMessage(message: string) {
      if (closed) return;
      const frame = readBridgeFrame(message);
      if (!frame) return fail();
      if (frame.bridgeGeneration !== options.bridgeGeneration) return;
      if (frame.kind === "closed") return close(domainError("RESYNC_REQUIRED"), true, false);
      if (frame.kind === "failure") return fail(errorValue(frame.value));
      if (frame.kind === "ready") {
        if (!adoptGeometry(frame.value, frame.measurementRevision)) return fail();
        if (!current) cancelTimer();
        pump();
        return;
      }
      if (frame.kind === "ack") {
        if (!current || frame.commandId !== current.id) return;
        if (!adoptGeometry(frame.value, frame.measurementRevision)) return fail();
        const applied = current;
        current = undefined;
        chargedBytes -= applied.charge;
        cancelTimer();
        applied.resolve();
        pump();
        return;
      }
      if (!positiveCounter(frame.noticeId)) return fail();
      if (frame.noticeId <= lastNoticeId) return;
      if (frame.noticeId !== lastNoticeId + 1) return fail();
      lastNoticeId = frame.noticeId;
      if (frame.kind === "geometry") {
        if (!adoptGeometry(frame.value, frame.measurementRevision)) return fail();
        acknowledgeNotice(frame.noticeId);
        return;
      }
      if (frame.kind === "input-rejected") {
        const error = errorValue(frame.value);
        if (error.kind !== "INPUT_REJECTED") return fail();
        emit(failures, error);
        acknowledgeNotice(frame.noticeId);
        return;
      }
      if (frame.kind === "input") {
        const bytes = decodeBridgeBytes(frame.bytes);
        const value = frame.value as Partial<InputIntent> | undefined;
        if (!value || !validViewGeneration(value.viewGeneration)) return fail();
        if (!bytes || !["keyboard", "paste", "mouse"].includes(value.source ?? "")) return fail();
        // The controller accepts the preceding logical generation while recovery
        // initializes its replacement, and visibly rejects truly obsolete input.
        // Admission to this bridge's initialize queue is not that transition.
        emit(inputs, { viewGeneration: value.viewGeneration, source: value.source!, bytes });
        // Receipt proves synchronous delivery to the controller's listener only.
        // Its own input receipt still decides PTY acceptance/written/unknown.
        acknowledgeNotice(frame.noticeId);
        return;
      }
      if (frame.kind === "focus") {
        const value = frame.value as Partial<FocusIntent> | undefined;
        const grid = GeometrySchema.safeParse(value?.geometry);
        if (!value || !validViewGeneration(value.viewGeneration)) return fail();
        if (!positiveCounter(value.focusSeq) || typeof value.focused !== "boolean" || !grid.success)
          return fail();
        // Focus carries the server's logical grid, not a local viewport measurement.
        emit(focuses, value as FocusIntent);
        acknowledgeNotice(frame.noticeId);
        return;
      }
      fail();
    },
    dispose() {
      if (closed) return;
      close(domainError("RESYNC_REQUIRED"), false);
    },
  };
}

export function createTerminalViewBridgeEndpoint(
  options: ViewBridgeEndpointOptions,
): TerminalViewBridgeEndpoint {
  if (
    !positiveCounter(options.bridgeGeneration) ||
    !GeometrySchema.safeParse(options.initialGeometry).success
  )
    throw new RangeError("Invalid bridge endpoint initialization");
  const { view } = options;
  const maxBytes = options.maxPendingBytes ?? 2 * 1024 * 1024;
  const maxNotices = options.maxPendingNotices ?? 64;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 2 * 1024 * 1024 ||
    maxBytes > 32 * 1024 * 1024 ||
    !positiveCounter(maxNotices) ||
    maxNotices > 256 ||
    !positiveCounter(timeoutMs) ||
    timeoutMs > 30_000
  )
    throw new RangeError("Invalid bridge notification bounds");
  let closed = false;
  let closing = false;
  let active = false;
  let lastId = 0;
  const subscriptions: Array<{ dispose(): void }> = [];
  const notices: Array<{ id: number; text: string; charge: number }> = [];
  let currentNotice: { id: number; text: string; charge: number } | undefined;
  let noticeBytes = 0;
  let nextNoticeId = 1;
  let measurementRevision = 1;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const post = (kind: string, rest: Partial<ViewBridgeFrame> = {}) => {
    if (!closed)
      options.postMessage(
        serialize({ version: 1, bridgeGeneration: options.bridgeGeneration, kind, ...rest }),
      );
  };
  const disposeLocal = () => {
    if (closed) return;
    closed = true;
    if (noticeTimer !== undefined) clearTimeout(noticeTimer);
    noticeTimer = undefined;
    currentNotice = undefined;
    notices.length = 0;
    noticeBytes = 0;
    let cleanupError: unknown;
    for (const subscription of subscriptions) {
      try {
        subscription.dispose();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    subscriptions.length = 0;
    try {
      view.dispose();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) throw cleanupError;
  };
  const dispose = () => {
    if (closed || closing) return;
    closing = true;
    try {
      // Endpoint unmount invalidates even an idle host immediately. The host
      // does not echo this closure back, and received host disposal stays local.
      post("closed");
    } finally {
      disposeLocal();
    }
  };
  const fail = (error: unknown) => {
    try {
      post("failure", { value: errorValue(error) });
    } catch {
      // Transport failure is already fatal; still attempt every local cleanup.
    } finally {
      try {
        disposeLocal();
      } catch {
        // The failure notification never promises successful resource cleanup.
        // Public dispose preserves a cleanup exception for the physical owner.
      }
    }
  };
  const pumpNotices = () => {
    if (closed || currentNotice || notices.length === 0) return;
    currentNotice = notices.shift()!;
    noticeTimer = setTimeout(() => fail(domainError("RESYNC_REQUIRED")), timeoutMs);
    try {
      options.postMessage(currentNotice.text);
    } catch (error) {
      fail(error);
    }
  };
  const forward = (kind: string, value: unknown, bytes?: Uint8Array, measuredRevision?: number) => {
    if (closed) return;
    try {
      const id = nextNoticeId++;
      if (!positiveCounter(id)) throw domainError("COUNTER_EXHAUSTED");
      const text = serialize({
        version: 1,
        bridgeGeneration: options.bridgeGeneration,
        kind,
        noticeId: id,
        value,
        ...(measuredRevision === undefined ? {} : { measurementRevision: measuredRevision }),
        ...(bytes === undefined ? {} : { bytes: encodeBridgeBytes(bytes) }),
      });
      const charge = frameCharge(text, bytes?.byteLength ?? 0);
      if (notices.length + Number(!!currentNotice) >= maxNotices || noticeBytes + charge > maxBytes)
        throw domainError("BUSY");
      notices.push({ id, text, charge });
      noticeBytes += charge;
      pumpNotices();
    } catch (error) {
      fail(error);
    }
  };
  const apply = async (frame: ViewBridgeFrame) => {
    const bytes = frame.bytes === undefined ? undefined : decodeBridgeBytes(frame.bytes);
    if (bytes === null) throw domainError("RESYNC_REQUIRED");
    switch (frame.operation) {
      case "initialize":
        await view.initialize(frame.value as ViewInitialization);
        break;
      case "beginBaseline":
        await view.beginBaseline(frame.value as BaselineDescriptor);
        break;
      case "writeBaselineChunk":
        if (!bytes) throw domainError("RESYNC_REQUIRED");
        await view.writeBaselineChunk(bytes);
        break;
      case "finishBaseline":
        await view.finishBaseline();
        break;
      case "applyEvent":
        await view.applyEvent(frame.value as TerminalEvent, bytes);
        break;
      case "setAppearance":
        view.setAppearance(frame.value as Appearance);
        break;
      case "setVisibility":
        if (typeof frame.value !== "boolean") throw domainError("RESYNC_REQUIRED");
        view.setVisibility(frame.value);
        break;
      default:
        throw domainError("RESYNC_REQUIRED");
    }
  };
  try {
    subscriptions.push(view.onInputIntent(({ bytes, ...value }) => forward("input", value, bytes)));
    subscriptions.push(view.onFocusIntent((value) => forward("focus", value)));
    subscriptions.push(
      view.onFailure((error) => {
        if (error.kind === "INPUT_REJECTED") forward("input-rejected", error);
        else fail(error);
      }),
    );
    post("ready", { value: options.initialGeometry, measurementRevision });
  } catch (error) {
    try {
      disposeLocal();
    } catch {
      // Preserve the initialization failure after attempting every cleanup.
    }
    throw error;
  }
  return {
    receiveMessage(message: string) {
      if (closed) return;
      const frame = readBridgeFrame(message);
      if (!frame) return fail(domainError("RESYNC_REQUIRED"));
      if (frame.bridgeGeneration !== options.bridgeGeneration) return;
      if (frame.kind === "dispose") return disposeLocal();
      if (frame.kind === "notice-ack") {
        if (!currentNotice || frame.noticeId !== currentNotice.id) return;
        if (noticeTimer !== undefined) clearTimeout(noticeTimer);
        noticeTimer = undefined;
        noticeBytes -= currentNotice.charge;
        currentNotice = undefined;
        pumpNotices();
        return;
      }
      if (
        frame.kind !== "command" ||
        !positiveCounter(frame.commandId) ||
        frame.commandId <= lastId ||
        active
      )
        return fail(domainError("RESYNC_REQUIRED"));
      lastId = frame.commandId;
      active = true;
      void apply(frame).then(() => {
        if (closed) return;
        active = false;
        try {
          // For baseline/event writes, apply resolves only after xterm's parse
          // callback. Posting to this document was never an acknowledgement.
          const measured = view.measureGrid();
          if (!positiveCounter(++measurementRevision)) throw domainError("COUNTER_EXHAUSTED");
          post("ack", {
            commandId: frame.commandId!,
            value: measured,
            measurementRevision,
          });
        } catch (error) {
          fail(error);
        }
      }, fail);
    },
    publishGeometry(geometry: Geometry) {
      if (!GeometrySchema.safeParse(geometry).success) return fail(domainError("RESYNC_REQUIRED"));
      if (!positiveCounter(++measurementRevision)) return fail(domainError("COUNTER_EXHAUSTED"));
      forward("geometry", geometry, undefined, measurementRevision);
    },
    snapshot: () => ({
      pendingNotices: notices.length + Number(!!currentNotice),
      chargedBytes: noticeBytes,
      closed,
    }),
    dispose,
  };
}
