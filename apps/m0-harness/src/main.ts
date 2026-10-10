// M0 test harness page: the minimal browser client the M0 scenarios drive (run list, create,
// attach, focus, input, resize, exit and error display). It is not the phase-2 Web App and not
// the Electron renderer; keep it a plain consumer of @cove/client and @cove/terminal-web.
import {
  createClient,
  type CallOutcome,
  type Client,
  type TerminalController,
  type TerminalControlOutcome,
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
  // A grid asked for by a focus or resize whose result is unknown: the server may have applied
  // it, so it stays requested (never sent again) until a fact settles the size, that is until the
  // applied grid matches it or a later recovery reaches ready.
  unknownGrid?: Geometry;
  resizing: boolean;
  focusing: boolean;
  // The user is operating this terminal here: set by a click or key in it, cleared when the
  // page is hidden or another client takes control.
  operating: boolean;
  // This client changed the grid itself, so the recovery that follows must not cost it control.
  retakeAfterRecovery: boolean;
  // The controller's recoverySequence of the last ready this page has acted on. Observers see
  // coalesced snapshots and can miss intermediate phases, so a recovery is recognized by a ready
  // snapshot with a sequence not handled yet, not by watching the phase leave ready.
  handledRecovery: number;
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
  const recoveries = snapshot.recoverySequence;
  void entry.controller.requestResize(measured).then((outcome) => {
    entry.resizing = false;
    if (outcome.ok || current !== entry) return;
    // An unknown result may have resized the PTY: it is shown, and the grid stays requested so
    // this page never hands the same resize off again before a fact settles the size.
    if (mayHaveTakenEffect(outcome)) {
      entry.unknownGrid = measured;
      entry.inputNotice = `resize ${describeControlFailure(outcome)}`;
      renderTerminalStatus(entry);
      return;
    }
    // A request refused while a recovery started meanwhile was superseded by it; the retake
    // after that recovery settles the size. One the server accepted failed in its own right,
    // even though its own recovery ran meanwhile (its grant was lost or expired before it became
    // usable), so it is shown like any other failure and a later retry is allowed.
    if (!outcome.accepted && entry.controller.snapshot().recoverySequence !== recoveries) return;
    delete entry.requested;
    entry.retakeAfterRecovery = false;
    entry.inputNotice = `resize ${describeControlFailure(outcome)}`;
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
    handledRecovery: 0,
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
      const enteredReady =
        snapshot.phase === "ready" && snapshot.recoverySequence !== entry.handledRecovery;
      if (enteredReady) entry.handledRecovery = snapshot.recoverySequence;
      // A fact settles an unknown request: its grid is applied, or a recovery reached ready with
      // the server's current grid. Only a grid that is not applied may then be requested again.
      const applied = snapshot.appliedGeometry?.geometry;
      const unknownGrid = entry.unknownGrid;
      if (unknownGrid && (enteredReady || (applied && sameGeometry(applied, unknownGrid)))) {
        delete entry.unknownGrid;
        if (
          (!applied || !sameGeometry(applied, unknownGrid)) &&
          entry.requested &&
          sameGeometry(entry.requested, unknownGrid)
        )
          delete entry.requested;
      }
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
      else if (notice.kind === "input-rejections")
        entry.inputNotice = `${notice.count} inputs not delivered: ${notice.groups
          .map((group) => `${group.count} ${group.source} ${group.error}`)
          .join(", ")}`;
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
  const recoveries = snapshot.recoverySequence;
  entry.controller.setInputTarget(true, true);
  void entry.controller.requestFocus(measured).then((outcome) => {
    entry.focusing = false;
    if (current !== entry) return;
    // A focus whose result is unknown may hold control on the server: it is shown, not called
    // refused, and its grid stays requested until a fact settles it (see unknownGrid).
    if (!outcome.ok && mayHaveTakenEffect(outcome)) {
      entry.unknownGrid = measured;
      entry.inputNotice = `focus ${describeControlFailure(outcome)}`;
      renderTerminalStatus(entry);
    }
    // A focus refused while a recovery started meanwhile was overtaken by it; the retake after
    // that recovery then settles it. A focus the server accepted that failed afterwards (e.g.
    // another client took control during the recovery the focus itself caused) is a real
    // failure: it is reported and forgotten, so this page does not take control back.
    else if (
      !outcome.ok &&
      (outcome.accepted || entry.controller.snapshot().recoverySequence === recoveries)
    ) {
      delete entry.requested;
      if (resizes) entry.retakeAfterRecovery = false;
      entry.inputNotice = `focus ${describeControlFailure(outcome)}`;
      renderTerminalStatus(entry);
    }
    syncSize(entry);
  });
}

// Whether a failed control command without `accepted` may still have taken effect: its error
// says the server accepted it or that its acceptance is unknown (RESULT_UNKNOWN after the command
// was handed to the socket). A local error means it was never sent; a domain error that was not
// accepted is a refusal.
function mayHaveTakenEffect(outcome: Extract<TerminalControlOutcome, { ok: false }>): boolean {
  return (
    !outcome.accepted &&
    "acceptance" in outcome.error &&
    outcome.error.acceptance !== "not-accepted"
  );
}

// A failure with `accepted` was accepted by the server and lost afterwards (the grant was lost,
// superseded or timed out before it became usable); one that may have taken effect has an
// unknown result; only the rest were refused.
function describeControlFailure(outcome: Extract<TerminalControlOutcome, { ok: false }>): string {
  if (outcome.accepted)
    return `accepted at epoch ${outcome.accepted.epoch} but not usable: ${describe(outcome.error)}`;
  if (mayHaveTakenEffect(outcome))
    return `result unknown (it may have taken effect): ${describe(outcome.error)}`;
  return `refused: ${describe(outcome.error)}`;
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
