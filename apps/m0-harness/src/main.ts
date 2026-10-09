// M0 test harness page: the minimal browser client the M0 scenarios drive (run list, create,
// attach, focus, input, resize, exit and error display). It is not the phase-2 Web App and not
// the Electron renderer; keep it a plain consumer of @cove/client and @cove/terminal-web.
import {
  createClient,
  type CallOutcome,
  type Client,
  type TerminalController,
  type TerminalSnapshot,
} from "@cove/client";
import { createDefaultScheduler, createUtf8Codec, createWebPorts } from "@cove/client/web-ports";
import { M0_LIMITS } from "@cove/protocol/budgets";
import type { RunRef } from "@cove/protocol/identity";
import { DEFAULT_APPEARANCE, type Geometry } from "@cove/protocol/profile";
import type { OperationRecord, RunRecord } from "@cove/protocol/rpc";
import {
  createXtermTerminalView,
  estimateXtermGrid,
  type XtermTerminalView,
  type XtermTerminalViewOptions,
} from "@cove/terminal-web/xterm-view";
import { readRendererChoice, takeConnectionInfo, type ConnectionInfo } from "./fragment.js";

const BUILD_VERSION = "m0-harness-0.0.0";
const OPERATION_WAIT_MS = 30_000;
const LIST_REFRESH_MS = 2_000;

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Page element #${id} is missing`);
  return found as T;
};
const connectionLabel = element<HTMLSpanElement>("connection");
const reconnectButton = element<HTMLButtonElement>("reconnect");
const newTerminalButton = element<HTMLButtonElement>("new-terminal");
const errorBox = element<HTMLDivElement>("error");
const runList = element<HTMLUListElement>("runs");
const terminalStatus = element<HTMLDivElement>("terminal-status");
const terminalHost = element<HTMLDivElement>("terminal");

function showError(message: string): void {
  errorBox.textContent = message;
}
function clearError(): void {
  errorBox.textContent = "";
}

// Errors are reported by kind only. Fixed client/protocol vocabularies never embed the
// secret, paths or terminal bytes, so they are safe to show on the page.
function describe(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const fields = error as Record<string, unknown>;
  if (typeof fields.category === "string")
    return `${fields.category} ${String(fields.reason)}${fields.field ? ` (${String(fields.field)})` : ""}`;
  if (typeof fields.kind === "string") return fields.kind;
  if (typeof fields.message === "string") return fields.message;
  return "unknown error";
}

function describeCall(outcome: Exclude<CallOutcome<unknown>, { ok: true }>): string {
  switch (outcome.kind) {
    case "local-error":
    case "rpc-error":
      return describe(outcome.error);
    case "operation-not-sent":
      return `operation ${outcome.operation.operationId} was not sent; nothing was executed`;
    case "operation-unknown":
      // The write may have taken effect; never resend it automatically.
      return `operation ${outcome.operation.operationId} outcome is unknown (${describe(outcome.error)})`;
  }
}

const sameGeometry = (left: Geometry, right: Geometry): boolean =>
  left.cols === right.cols && left.rows === right.rows;

// The grid for a new terminal. Before any view exists, a hidden xterm with the view's options and
// renderer measures the same cells the live view will, so taking focus later does not resize the
// PTY unless the space or the renderer really changed.
function estimateGrid(): Geometry {
  if (current) return current.view.measureGrid();
  return estimateXtermGrid(terminalHost, viewOptions) ?? { cols: 80, rows: 24 };
}

interface OpenTerminal {
  readonly run: RunRef;
  readonly controller: TerminalController;
  readonly view: XtermTerminalView;
  readonly disposables: { dispose(): void }[];
  // The last grid this client asked for, by focus or resize, so one size is requested once.
  requested?: Geometry;
  resizing: boolean;
  focusing: boolean;
  // The user is operating this terminal here: set by a click or key in it, cleared when the
  // page is hidden or another client takes control.
  operating: boolean;
  // This client changed the grid itself, so the recovery that follows must not cost it control.
  retakeAfterRecovery: boolean;
  lastPhase: TerminalSnapshot["phase"];
  // Counts departures from "ready", so a failed request can tell whether a recovery
  // superseded it or the server rejected it outright.
  recoveries: number;
  inputNotice: string;
}

let info: ConnectionInfo;
let viewOptions: XtermTerminalViewOptions = {};
let client: Client;
let current: OpenTerminal | undefined;
let runs: RunRecord[] = [];
let listing = false;

function renderRuns(): void {
  runList.replaceChildren(
    ...runs.map((record) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.runId = record.run.runId;
      button.setAttribute("aria-current", String(current?.run.runId === record.run.runId));
      const title = document.createElement("div");
      title.textContent = record.run.runId.slice(0, 12);
      const status = document.createElement("div");
      status.className = "status";
      status.textContent = `${record.status} · ${record.geometry.cols}×${record.geometry.rows}`;
      button.append(title, status);
      button.addEventListener("click", () => void openRun(record.run));
      item.append(button);
      return item;
    }),
  );
}

async function refreshRuns(): Promise<void> {
  if (listing || client.snapshot().status !== "connected") return;
  listing = true;
  try {
    const collected: RunRecord[] = [];
    let afterRunId: string | undefined;
    do {
      const page = await client.call("terminal.list", {
        limit: M0_LIMITS.listPage,
        ...(afterRunId ? { afterRunId } : {}),
      });
      if (!page.ok) {
        showError(`Listing terminals failed: ${describeCall(page)}`);
        return;
      }
      collected.push(...page.value.runs);
      afterRunId = page.value.nextAfterRunId;
    } while (afterRunId);
    runs = collected;
    renderRuns();
  } finally {
    listing = false;
  }
}

function renderTerminalStatus(entry: OpenTerminal): void {
  if (current !== entry) return;
  const snapshot = entry.controller.snapshot();
  const parts = [`Terminal ${entry.run.runId.slice(0, 12)}`, phaseLabel(snapshot)];
  if (snapshot.appliedGeometry)
    parts.push(
      `${snapshot.appliedGeometry.geometry.cols}×${snapshot.appliedGeometry.geometry.rows}`,
    );
  parts.push(snapshot.controlEpoch === undefined ? "viewing" : "controlling");
  // Diagnostic only: the active renderer is the view's private choice and may fall back to DOM.
  parts.push(`renderer ${entry.view.renderer}`);
  if (snapshot.execution.status === "exited") {
    const { exitCode, signal } = snapshot.execution;
    parts.push(
      signal ? `exited (signal ${signal})` : `exited (code ${exitCode === null ? "?" : exitCode})`,
    );
  }
  if (entry.inputNotice) parts.push(entry.inputNotice);
  terminalStatus.textContent = parts.join(" · ");
  terminalStatus.dataset.phase = snapshot.phase;
  terminalStatus.dataset.execution = snapshot.execution.status;
  terminalStatus.dataset.renderer = entry.view.renderer;
}

function phaseLabel(snapshot: TerminalSnapshot): string {
  switch (snapshot.phase) {
    case "ready":
      return "attached";
    case "unavailable":
      return "unavailable (open it again to retry)";
    case "disposed":
      return "closed";
    default:
      return "attaching";
  }
}

// The focused client owns the PTY size. Whenever this client holds control and its view's
// measured grid differs from the applied one, ask once for that size.
function syncSize(entry: OpenTerminal): void {
  if (current !== entry || entry.resizing || entry.focusing) return;
  const snapshot = entry.controller.snapshot();
  if (snapshot.controlEpoch === undefined || snapshot.phase !== "ready") return;
  const measured = entry.view.measureGrid();
  const applied = snapshot.appliedGeometry?.geometry;
  if (applied && sameGeometry(applied, measured)) return;
  if (entry.requested && sameGeometry(entry.requested, measured)) return;
  entry.requested = measured;
  entry.retakeAfterRecovery = true;
  entry.resizing = true;
  const recoveries = entry.recoveries;
  void entry.controller.requestResize(measured).then((outcome) => {
    entry.resizing = false;
    if (outcome.ok || current !== entry) return;
    // A recovery that started meanwhile superseded this request; the retake after it settles
    // the size. Otherwise the rejection was definite: show it and allow a later retry.
    if (entry.recoveries !== recoveries) return;
    delete entry.requested;
    entry.retakeAfterRecovery = false;
    entry.inputNotice = `resize refused: ${describe(outcome.error)}`;
    renderTerminalStatus(entry);
  });
}

function closeCurrent(): void {
  const entry = current;
  current = undefined;
  if (!entry) return;
  for (const disposable of entry.disposables) disposable.dispose();
  // Disposal releases the server subscription and disposes the view.
  entry.controller.dispose();
  terminalHost.replaceChildren();
  terminalStatus.textContent = "No terminal open";
}

async function openRun(run: RunRef): Promise<void> {
  if (current?.run.runId === run.runId && current.controller.snapshot().phase !== "unavailable")
    return;
  closeCurrent();
  clearError();
  const view = createXtermTerminalView(terminalHost, viewOptions);
  const opened = client.openTerminal({
    run,
    viewId: `harness-${crypto.randomUUID()}`,
    view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  if (!opened.ok) {
    view.dispose();
    showError(`Opening the terminal failed: ${describe(opened.error)}`);
    return;
  }
  const entry: OpenTerminal = {
    run,
    controller: opened.value,
    view,
    disposables: [],
    resizing: false,
    focusing: false,
    operating: false,
    retakeAfterRecovery: false,
    lastPhase: "idle",
    recoveries: 0,
    inputNotice: "",
  };
  current = entry;
  renderRuns();
  entry.disposables.push(
    entry.controller.onState((snapshot) => {
      renderTerminalStatus(entry);
      const holder = snapshot.appliedAuthority?.holder;
      if (holder && holder.subscriptionId !== snapshot.subscription?.subscriptionId) {
        entry.operating = false;
        entry.retakeAfterRecovery = false;
      }
      const enteredReady = snapshot.phase === "ready" && entry.lastPhase !== "ready";
      if (entry.lastPhase === "ready" && snapshot.phase !== "ready") entry.recoveries++;
      entry.lastPhase = snapshot.phase;
      // A resize is recovered with a fresh baseline into a rebuilt xterm, which drops DOM
      // focus and this client's control. Restore DOM focus while the user operates here, and
      // control only after this client's own resize, never after another client's: two pages
      // retaking control after each other's resizes would trade it back and forth forever.
      if (enteredReady && entry.operating)
        terminalHost.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      if (enteredReady && entry.retakeAfterRecovery) {
        entry.retakeAfterRecovery = false;
        takeControl(entry);
      }
      syncSize(entry);
    }),
    entry.controller.onInputOutcome((notice) => {
      if (notice.kind === "renderer-rejection")
        entry.inputNotice = `input rejected by the view: ${describe(notice.error)}`;
      else if (!notice.outcome.ok)
        entry.inputNotice = `input not delivered: ${describe(notice.outcome.error)}`;
      else entry.inputNotice = "";
      renderTerminalStatus(entry);
    }),
    view.onFailure((error) => showError(`Terminal view failed: ${describe(error)}`)),
    // A renderer fallback changes the cell metrics, so the grid that fits may change too.
    view.onRendererChange(() => {
      renderTerminalStatus(entry);
      syncSize(entry);
    }),
  );
  renderTerminalStatus(entry);
  const attached = await entry.controller.attach();
  if (current !== entry) return;
  if (!attached.ok) {
    showError(`Attaching the terminal failed: ${describe(attached.error)}`);
    renderTerminalStatus(entry);
    return;
  }
  // The view publishes a focus intent before each deliberate input, but the controller only
  // honors it while the host page is in the foreground. Typing then takes control.
  entry.controller.setInputTarget(document.visibilityState === "visible", false);
  renderTerminalStatus(entry);
}

// Take control with this view's measured grid so the PTY follows the operating client. The
// focus carries the grid, so no separate resize is needed for it.
function takeControl(entry: OpenTerminal): void {
  if (current !== entry || entry.focusing || document.visibilityState !== "visible") return;
  const snapshot = entry.controller.snapshot();
  if (
    snapshot.phase !== "ready" ||
    snapshot.controlEpoch !== undefined ||
    snapshot.execution.status === "exited"
  )
    return;
  const measured = entry.view.measureGrid();
  const applied = snapshot.appliedGeometry?.geometry;
  const resizes = !applied || !sameGeometry(applied, measured);
  if (resizes) entry.retakeAfterRecovery = true;
  entry.requested = measured;
  entry.focusing = true;
  const recoveries = entry.recoveries;
  entry.controller.setInputTarget(true, true);
  void entry.controller.requestFocus(measured).then((outcome) => {
    entry.focusing = false;
    if (current !== entry) return;
    // A focus that changed the grid may be overtaken by the recovery it caused; the retake
    // after that recovery then settles it. Any other failure is reported and forgotten.
    if (!outcome.ok && entry.recoveries === recoveries) {
      delete entry.requested;
      if (resizes) entry.retakeAfterRecovery = false;
      entry.inputNotice = `focus refused: ${describe(outcome.error)}`;
      renderTerminalStatus(entry);
    }
    syncSize(entry);
  });
}

// A click in the terminal is a deliberate request to operate it.
function focusCurrent(): void {
  if (!current) return;
  current.operating = true;
  takeControl(current);
}

async function settle(initial: OperationRecord): Promise<OperationRecord> {
  let operation = initial;
  const deadline = Date.now() + OPERATION_WAIT_MS;
  while (operation.state === "accepted" || operation.state === "running") {
    if (Date.now() > deadline)
      throw new Error(`operation ${operation.operationId} is still ${operation.state}`);
    await new Promise((done) => setTimeout(done, 100));
    const polled = await client.getOperation(operation.operationId);
    if (!polled.ok)
      throw new Error(
        `operation ${operation.operationId} was accepted, but polling it failed (${describeCall(polled)})`,
      );
    operation = polled.value.operation;
  }
  return operation;
}

async function createTerminal(): Promise<void> {
  newTerminalButton.disabled = true;
  clearError();
  try {
    const created = await client.call("terminal.create", {
      executable: info.shell,
      argv: [],
      cwd: info.cwd,
      geometry: estimateGrid(),
      operationId: crypto.randomUUID(),
      expectedRelayInstanceId: info.instance,
    });
    if (!created.ok) {
      showError(`Creating a terminal failed: ${describeCall(created)}`);
      return;
    }
    const operation = await settle(created.value.operation);
    const run = operation.result?.run ?? operation.run;
    if (operation.state !== "succeeded" || !run) {
      showError(
        `Creating a terminal ${operation.state}${operation.error ? `: ${operation.error.kind}` : ""}`,
      );
      return;
    }
    await refreshRuns();
    await openRun(run);
  } catch (error) {
    showError(`Creating a terminal failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    newTerminalButton.disabled = client.snapshot().status !== "connected";
  }
}

async function connect(reconnect: boolean): Promise<void> {
  reconnectButton.hidden = true;
  const outcome = await (reconnect ? client.reconnect() : client.connect());
  if (!outcome.ok) {
    showError(`Cannot connect to ${info.endpoint}: ${describe(outcome.error)}`);
    reconnectButton.hidden = false;
    return;
  }
  clearError();
  await refreshRuns();
  // A previous connection's controller cannot continue on the new one; open it afresh.
  const previous = current?.run;
  if (reconnect && previous) {
    closeCurrent();
    await openRun(previous);
  }
}

function start(): void {
  const taken = takeConnectionInfo(location, history);
  if (typeof taken === "string") {
    connectionLabel.textContent = "not configured";
    showError(taken);
    return;
  }
  const choice = readRendererChoice(location);
  if (typeof choice === "string") {
    connectionLabel.textContent = "not configured";
    showError(choice);
    return;
  }
  info = taken;
  viewOptions = choice;
  client = createClient({
    expectedServerId: info.serverId,
    expectedRelayInstanceId: info.instance,
    buildVersion: BUILD_VERSION,
    credentials: () => ({ authorization: `Bearer ${info.secret}`, terminalSecret: info.secret }),
    codec: createUtf8Codec(),
    createOpaqueId: () => crypto.randomUUID(),
    scheduler: createDefaultScheduler(),
    ...createWebPorts({ endpoint: info.endpoint }),
  });
  let wasConnected = false;
  client.onState((snapshot) => {
    connectionLabel.textContent = snapshot.status;
    newTerminalButton.disabled = snapshot.status !== "connected";
    if (snapshot.status === "connected") wasConnected = true;
    else if (wasConnected && snapshot.status !== "connecting") {
      wasConnected = false;
      showError(
        `Connection lost (${snapshot.status}${snapshot.lastError ? `: ${describe(snapshot.lastError)}` : ""})`,
      );
      reconnectButton.hidden = false;
    }
  });
  newTerminalButton.addEventListener("click", () => void createTerminal());
  reconnectButton.addEventListener("click", () => void connect(true));
  terminalHost.addEventListener("pointerdown", focusCurrent);
  // Typing takes control through the view's own focus intents; remember the intent to operate.
  terminalHost.addEventListener("keydown", () => current && (current.operating = true), true);
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => current && syncSize(current), 100);
  });
  document.addEventListener("visibilitychange", () => {
    const entry = current;
    if (!entry || entry.controller.snapshot().phase === "disposed") return;
    // Applies in every phase, including mid-recovery: a hidden page releases control and
    // drops any pending retake; becoming visible again only re-enables taking control.
    const visible = document.visibilityState === "visible";
    if (!visible) {
      entry.operating = false;
      entry.retakeAfterRecovery = false;
    }
    entry.controller.setInputTarget(visible, false);
  });
  setInterval(() => void refreshRuns(), LIST_REFRESH_MS);
  void connect(false);
}

start();
