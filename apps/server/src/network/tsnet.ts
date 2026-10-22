import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { domainError } from "@cove/protocol/errors";
import {
  TSNET_LIMITS,
  TsnetLoginSecretsSchema,
  TsnetNodeIdSchema,
  TsnetNodeNameSchema,
  type TsnetHoldSchema,
  type TsnetStatusResultSchema,
} from "@cove/protocol/auth";
import { installedClosureRoot, workspaceRootOf } from "../build-id.js";
import { markEntry } from "../transport/connection-entry.js";
import type { TsnetEntry, TsnetEntryContext, TsnetInvitationEntry } from "./listeners.js";

// The server's tsnet entry (m2 D9, D10; T5b): starts and supervises `cove-tsnet serve`, keeps its
// tailnet ports in step with the business and pairing listeners, hands the connections it
// forwards to them, and carries the server.tsnet.* operations (rpc/tsnet.ts) to it. The helper's
// protocol is native/tailscale/PROTOCOL.md (version 1): control frames on its stdin and stdout,
// forwarded connections on a Unix socket in a 0700 directory, each preceded by one header line.
//
// When the helper runs. Only while the node has state (`<home>/tsnet/state`, which the helper
// creates at the first login and a logout deletes) or once a login was asked for: a server whose
// node never logged in starts no process and never contacts a control plane (a node without state
// would not either, PROTOCOL.md "Lifecycle"). The status of such a node is answered here: logged
// out, as the helper would report it.
//
// Supervision (D10). The helper is a child of this process and nothing else depends on it: PTYs,
// runs and the loopback and SSH entries never wait for it, so its crash costs the tsnet entry
// alone. An exit nobody asked for is followed by a restart after a backoff that doubles from 1 s
// up to 60 s, and returns to 1 s once a helper has run for 60 s, so a helper that keeps failing
// (a broken state directory, say) costs one start a minute and a crash after a long run is
// repaired at once. The restarted helper restores the node from its state (no new login) and is
// sent the current ports. Its identity hold, if any, lived in the exited process: the restarted
// one serves as whatever identity was persisted, which clients' stable-ID pinning covers
// (PROTOCOL.md "Identity hold"). A helper speaking another local protocol is not restarted.
//
// Ports (D6). The helper's port set is declarative: the business port always, and the pairing
// port while the pairing listener is open. The pairing listener reports each change and waits
// for the helper's answer (bounded), so an invitation is created only after the tailnet side of
// its pairing port is open. A helper that is down is sent the set when it starts again.
//
// Advertisement. An invitation advertises this node (invitationEntry) only from a status the
// helper reported after the last change that could have altered it, never from a cached answer
// that a change has since made stale: a logout closes the node's listeners before it deletes the
// node, a reauth holds the node, and a port update can time out, while an invitation reuses an
// open pairing listener without any port sync. So three generations are kept: of the helper
// process, of the desired port set (each sync), and of control requests (each login or logout,
// at its start and its end). Each such change drops the advertisement first. A status or setPorts
// answer becomes the advertisement only when the generations it was requested under are still
// current, the helper acknowledged the current port set with a setPorts answer, and no login or
// logout is in flight; and invitationEntry advertises only a running, unheld node that this
// answer shows listening on both ports. A login or logout that ends asks for a fresh status, so
// the node is advertised again once it is observed.
//
// Shutdown order (listeners.ts closes this entry first): no restart is scheduled any more, the
// helper's stdin is closed, which is its orderly stop (it cancels a pending login, answers what it
// can, closes its listeners and the node, keeping the state), and its exit is awaited for up to
// 20 s (its own drain is bounded at 15 s) before it is killed; then the forward socket closes.
// Connections already handed over belong to the business and pairing listeners, which close next.
//
// Secrets. An auth key goes to the helper only inside a login frame on its stdin: never in argv,
// the environment, a log line or an error. Nothing here logs frames or the helper's answers; the
// login URL of an answer is handed to the caller alone (rpc/tsnet.ts returns it only as the
// call's output secret). The helper's stderr lines are logged with every URL replaced, bounded.

const HELPER_PROTOCOL = 1;
const FRAME_BYTES = 64 * 1024;
const HEADER_DEADLINE_MS = 5_000;
// Forwarded connections that have not sent their header yet. The helper opens at most 512
// forwarded connections and the business listener bounds what it receives (#156), so this only
// bounds the header stage.
const PENDING_HEADERS = 64;
const HELLO_TIMEOUT_MS = 10_000;
const PORTS_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 4_000;
const LOGOUT_TIMEOUT_MS = 30_000;
// How long a request waits for a helper that is starting (or about to be restarted): a control
// request may wait longer than a status, which must answer within an ordinary client timeout.
const READY_WAIT_MS = 10_000;
const STATUS_READY_WAIT_MS = 3_000;
const STOP_WAIT_MS = 20_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_RUN_MS = 60_000;
// A Unix socket path is at most 104 bytes on macOS (103 plus the terminator).
const SOCKET_PATH_BYTES = 100;
const STDERR_LINE_CHARS = 512;

// Development and test overrides, honored only when this server runs from a development
// workspace, as the CLI's are (apps/cli remote/tsnet-binary.ts): COVE_TSNET_BINARY names another
// absolute executable, COVE_TSNET_CONTROL_URL another control plane (a test one). An installed
// closure that finds either set does not start the helper at all rather than ignore them or let
// an inherited variable swap the executable or the control plane of a real installation.
const OVERRIDES = ["COVE_TSNET_BINARY", "COVE_TSNET_CONTROL_URL"] as const;

export type TsnetStatus = ReturnType<typeof TsnetStatusResultSchema.parse>;
type TsnetHold = ReturnType<typeof TsnetHoldSchema.parse>;

// What the helper reports (PROTOCOL.md "Status object"); every field is third-party input.
type HelperNode = { stableNodeID?: unknown; name?: unknown };
type HelperStatus = {
  state?: unknown;
  authURL?: unknown;
  self?: HelperNode | null;
  ports?: unknown;
  hold?: unknown;
  warnings?: unknown;
  remoteLogoutConfirmed?: unknown;
};

// The peer a forwarded connection came from, as WhoIs reported it to the helper. Display and
// audit only (PROTOCOL.md "Forwarded connections"): it never authorizes anything.
export type TsnetPeer = { readonly stableNodeID: string | null; readonly name: string | null };

// The outcome of a control request as rpc/tsnet.ts needs it.
export type TsnetLoginOutcome =
  // The helper answered the login with a status; loginUrl is set for an interactive login.
  | { kind: "answered"; status: TsnetStatus; loginUrl?: string; listenFailed?: boolean }
  // The helper refused or failed the login with its error code (PROTOCOL.md "Error codes").
  | { kind: "refused"; code: string }
  // The helper exited, or did not answer in time: the outcome is unknown.
  | { kind: "lost" };
export type TsnetLogoutOutcome =
  | { kind: "answered"; remoteLogoutConfirmed: boolean }
  | { kind: "refused"; code: string }
  | { kind: "lost" };

class HelperLost extends Error {}
class HelperRefused extends Error {
  // `detail` is the helper's message: third-party text (a control plane's), kept in memory only
  // and shown only through sanitizedText.
  constructor(
    readonly code: string,
    readonly detail: string = "",
  ) {
    super(code);
  }
}

// One line-framed JSON control channel to a helper process. Requests are concurrent and matched
// by ID. Frames are never logged; a broken channel fails every pending request with HelperLost.
class HelperChannel {
  private next = 1;
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private buffered = "";
  private broken = false;

  constructor(private readonly child: ChildProcess) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.received(chunk));
    child.stdout!.on("error", () => this.fail());
    child.stdout!.once("close", () => this.fail());
    child.stdin!.on("error", () => this.fail());
  }

  // Resolves with the result of a successful answer; rejects with HelperRefused for an error
  // answer and HelperLost for no answer within `timeoutMs` or a broken channel.
  request(frame: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.broken) return Promise.reject(new HelperLost("the helper channel is closed"));
    const id = String(this.next++);
    return new Promise((resolve, reject) => {
      const entry: {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperLost("the helper did not answer in time"));
      }, timeoutMs);
      entry.timer.unref();
      this.pending.set(id, entry);
      // The frame may hold an auth key: it goes to the pipe and nowhere else.
      this.child.stdin!.write(`${JSON.stringify({ ...frame, id })}\n`);
    });
  }

  close(): void {
    this.child.stdin!.end();
  }

  fail(): void {
    if (this.broken) return;
    this.broken = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new HelperLost("the helper exited"));
    }
    this.pending.clear();
  }

  private received(chunk: string): void {
    this.buffered += chunk;
    for (;;) {
      const end = this.buffered.indexOf("\n");
      if (end < 0) break;
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      this.answer(line);
    }
    // The helper never writes a longer frame; one that does cannot be trusted to resynchronize.
    if (this.buffered.length > FRAME_BYTES) {
      this.fail();
      this.child.kill("SIGKILL");
    }
  }

  private answer(line: string): void {
    let frame: {
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    const entry = typeof frame.id === "string" ? this.pending.get(frame.id) : undefined;
    if (!entry || typeof frame.id !== "string") return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok === true) entry.resolve(frame.result ?? {});
    else
      entry.reject(
        new HelperRefused(
          typeof frame.error?.code === "string" ? frame.error.code : "INTERNAL",
          typeof frame.error?.message === "string" ? frame.error.message : "",
        ),
      );
  }
}

// Text from the helper made fit for a status warning or a log line: no control characters, every
// URL replaced (an interactive login URL must never be shown or logged outside its secret), no
// `secret` and nothing shaped like an auth key anywhere, bounded.
export function sanitizedText(
  value: string,
  limit: number,
  secrets: readonly string[] = [],
): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  text = text.replace(/tskey-\S*/gi, "[redacted]");
  text = [...text.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[url]")]
    .map((char) => (char < " " || char === "\u007f" ? " " : char))
    .join("");
  return text.length > limit ? text.slice(0, limit) : text;
}

const STATES: Readonly<Record<string, TsnetStatus["state"]>> = {
  LoggedOut: "logged-out",
  NoState: "starting",
  Starting: "starting",
  NeedsLogin: "needs-login",
  NeedsMachineAuth: "needs-login",
  Running: "running",
  Stopped: "stopped",
  Unavailable: "failed",
};
const HOLDS: Readonly<Record<string, TsnetHold>> = {
  IDENTITY_CHANGED: "identity-changed",
  LOGIN_UNCERTAIN: "login-uncertain",
};

// The API status of a helper status. Third-party fields are validated, never trusted: an
// unexpected state is `failed`, a node ID or name that does not fit its schema is null.
export function apiStatus(
  helper: HelperStatus,
  hostname: string | null,
  secrets: readonly string[] = [],
): TsnetStatus {
  const state = (typeof helper.state === "string" && STATES[helper.state]) || "failed";
  const id = TsnetNodeIdSchema.safeParse(helper.self?.stableNodeID);
  const rawName = typeof helper.self?.name === "string" ? helper.self.name.replace(/\.$/, "") : "";
  const name = TsnetNodeNameSchema.safeParse(rawName.toLowerCase());
  const ports = Array.isArray(helper.ports)
    ? helper.ports.filter(
        (port): port is number => Number.isInteger(port) && port >= 1 && port <= 65535,
      )
    : [];
  const warnings = Array.isArray(helper.warnings)
    ? helper.warnings
        .filter((warning): warning is string => typeof warning === "string")
        .slice(0, TSNET_LIMITS.warnings)
        .map((warning) => sanitizedText(warning, TSNET_LIMITS.warningChars, secrets))
    : [];
  return {
    state,
    hostname,
    nodeId: id.success ? id.data : null,
    nodeName: name.success && rawName ? name.data : null,
    hold: (typeof helper.hold === "string" && HOLDS[helper.hold]) || null,
    ports: [...new Set(ports)].sort((a, b) => a - b).slice(0, TSNET_LIMITS.ports),
    warnings,
  };
}

function unavailableStatus(hostname: string | null, warning: string): TsnetStatus {
  return {
    state: "failed",
    hostname,
    nodeId: null,
    nodeName: null,
    hold: null,
    ports: [],
    warnings: [sanitizedText(warning, TSNET_LIMITS.warningChars)],
  };
}

// What starts the helper: the executable, the control plane, or why it cannot start.
type Launch = { binary: string; controlUrl: string | undefined } | { refused: string };

function launchOf(defaultBinary: string | null): Launch {
  const overrides = OVERRIDES.filter((name) => process.env[name]);
  if (overrides.length > 0 && (installedClosureRoot() || !workspaceRootOf()))
    return {
      refused:
        `${overrides.join(" and ")} ${overrides.length > 1 ? "are" : "is a"} development and ` +
        "test override; an installed Cove does not start its tsnet node while it is set",
    };
  const override = process.env.COVE_TSNET_BINARY;
  if (override && !isAbsolute(override))
    return { refused: "COVE_TSNET_BINARY must be an absolute path" };
  const binary = override || defaultBinary;
  if (!binary) return { refused: "this Cove build has no cove-tsnet executable" };
  return { binary, controlUrl: process.env.COVE_TSNET_CONTROL_URL || undefined };
}

export class TsnetNode implements TsnetEntry {
  readonly kind = "tsnet" as const;
  private context: TsnetEntryContext | undefined;
  private launch: Launch | undefined;
  private home = "";
  private socketPath = "";
  private socketDirectory: string | undefined;
  private forward: Server | undefined;
  private readonly waiting = new Set<Socket>();
  // Whether the helper should be running; see the module comment.
  private wanted = false;
  private closing = false;
  private child: ChildProcess | undefined;
  private channel: HelperChannel | undefined;
  // Resolves true once the current helper answered hello (its ports are sent next), false when it
  // exited first or speaks another protocol.
  private ready: Promise<boolean> = Promise.resolve(false);
  // Why the last start failed, until a helper answers hello again (downReason).
  private failure: string | undefined;
  // Settles when the current helper is retired (spawnHelper), for close.
  private retirement: Promise<void> | undefined;
  // Why the last login failed, sanitized, until the next login or logout: shown in status, since
  // the operation's record keeps only a fixed, secret-free error.
  private loginFailure: string | undefined;
  private backoffMs = BACKOFF_INITIAL_MS;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private incompatible: string | undefined;
  // See "Advertisement" in the module comment.
  private advertised: HelperStatus | undefined;
  private helperGeneration = 0;
  private portGeneration = 0;
  // The port generation the current helper acknowledged with a setPorts answer.
  private portsAcknowledged = -1;
  private controlGeneration = 0;
  private controls = 0;
  // Logins and logouts started so far: the latest one alone may publish loginFailure.
  private controlsStarted = 0;
  private syncing = 0;
  private portWork: Promise<void> = Promise.resolve();

  // The helper's directory under the data directory; its state is `<tsnetHome>/state`.
  static homeOf(home: string): string {
    return join(home, "tsnet");
  }

  async start(
    context: TsnetEntryContext,
  ): Promise<{ error: ReturnType<typeof domainError> } | void> {
    this.context = context;
    // A composition without a data directory (some tests) has nowhere to keep node state.
    this.launch = context.home ? launchOf(context.binary) : { refused: "no data directory" };
    this.home = TsnetNode.homeOf(context.home);
    context.onPairingPortChange(() => this.syncPorts());
    if ("refused" in this.launch) {
      if (this.hasState() || process.env.COVE_TSNET_BINARY || process.env.COVE_TSNET_CONTROL_URL)
        context.log({ event: "tsnet-unavailable", reason: this.launch.refused });
      return { error: domainError("ENTRY_UNAVAILABLE") };
    }
    // Only a node that has state is started with the server (see the module comment). Startup does
    // not wait for it: the helper restores the node in the background, and a helper that hangs or
    // fails must not delay the business entry; status reports it meanwhile.
    if (!this.hasState()) return { error: domainError("ENTRY_UNAVAILABLE") };
    this.wanted = true;
    this.spawnHelper();
    return undefined;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.restartTimer);
    // Awaited is the helper's retirement (spawnHelper), not its `exit`: a child whose spawn
    // failed asynchronously never emits `exit`, only `error` and `close`.
    const child = this.child;
    const retirement = this.retirement;
    if (child && retirement) {
      this.channel?.close();
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_WAIT_MS);
      timer.unref();
      await retirement;
      clearTimeout(timer);
    }
    for (const socket of this.waiting) socket.destroy();
    this.waiting.clear();
    const forward = this.forward;
    this.forward = undefined;
    if (forward) await new Promise<void>((done) => forward.close(() => done()));
    if (this.socketPath) await unlink(this.socketPath).catch(() => undefined);
    if (this.socketDirectory) await rm(this.socketDirectory, { recursive: true, force: true });
  }

  // Sends the current port set to a running helper and waits for its answer (bounded). Calls are
  // applied in order; this never rejects.
  syncPorts(): Promise<void> {
    // A desired-port transition: what the helper last reported no longer describes it.
    const generation = ++this.portGeneration;
    this.advertised = undefined;
    this.syncing++;
    const work = this.portWork.then(async () => {
      const channel = this.channel;
      if (!channel || this.closing || !(await this.isReady())) return;
      const at = this.generations();
      try {
        const answer = (await channel.request(
          { op: "setPorts", ports: this.desiredPorts() },
          PORTS_TIMEOUT_MS,
        )) as HelperStatus;
        // A newer sync, or another helper, makes this answer describe an older set.
        if (generation === this.portGeneration && at.helper === this.helperGeneration)
          this.portsAcknowledged = generation;
        this.observed(answer, at);
      } catch (error) {
        // LISTEN_FAILED keeps the desired set in the helper; its status reports what is open. A
        // timeout leaves the set unacknowledged: nothing is advertised until a later sync is.
        if (error instanceof HelperRefused)
          this.context?.log({ event: "tsnet-ports", outcome: error.code });
      }
    });
    this.portWork = work.finally(() => this.syncing--);
    return work;
  }

  // The node an invitation may advertise for `pairingPort`: only from a current answer (see
  // "Advertisement" in the module comment) that shows it running, unheld and listening on the
  // business port and that pairing port.
  invitationEntry(pairingPort: number): TsnetInvitationEntry | null {
    const context = this.context;
    if (!context || !this.channel) return null;
    // A port set the helper never acknowledged (its update timed out) is sent again, so that a
    // later invitation can advertise the node; this one does without.
    if (this.portsAcknowledged !== this.portGeneration) {
      if (this.syncing === 0) void this.syncPorts();
      return null;
    }
    if (!this.advertised || this.controls > 0) return null;
    const status = apiStatus(this.advertised, context.hostname);
    if (
      status.state !== "running" ||
      status.hold !== null ||
      status.nodeId === null ||
      status.nodeName === null ||
      !status.ports.includes(context.businessPort) ||
      !status.ports.includes(pairingPort)
    )
      return null;
    return { nodeId: status.nodeId, name: status.nodeName };
  }

  // server.tsnet.status. Null when the helper is busy (a login or logout holds its control lock)
  // and did not answer in time: the caller reports BUSY rather than a state it did not observe.
  async status(): Promise<TsnetStatus | null> {
    const context = this.context;
    const hostname = context?.hostname ?? null;
    if (!context || !this.launch) return unavailableStatus(hostname, "the server is starting");
    if ("refused" in this.launch) return unavailableStatus(hostname, this.launch.refused);
    if (!this.wanted && !this.hasState())
      return {
        state: "logged-out",
        hostname,
        nodeId: null,
        nodeName: null,
        hold: null,
        ports: [],
        warnings: [],
      };
    if (!(await this.whenReady(STATUS_READY_WAIT_MS)))
      return unavailableStatus(hostname, this.downReason());
    const at = this.generations();
    try {
      const answer = (await this.channel!.request(
        { op: "status" },
        STATUS_TIMEOUT_MS,
      )) as HelperStatus;
      this.observed(answer, at);
      return this.withLoginFailure(apiStatus(answer, hostname));
    } catch (error) {
      if (error instanceof HelperRefused)
        return unavailableStatus(hostname, `the tsnet helper refused the status (${error.code})`);
      return null;
    }
  }

  // Whether a control request can be sent now: the helper is started if needed (a login of a node
  // without state starts it) and has answered hello. False with the reason it cannot.
  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.context || !this.launch) return { ok: false, reason: "the server is starting" };
    if ("refused" in this.launch) return { ok: false, reason: this.launch.refused };
    if (this.closing) return { ok: false, reason: "the server is stopping" };
    if (!this.wanted) {
      this.wanted = true;
      this.spawnHelper();
    }
    return (await this.whenReady()) ? { ok: true } : { ok: false, reason: this.downReason() };
  }

  // One login request (PROTOCOL.md `login`): the helper's own `timeoutMs`, and the `deadlineMs`
  // after which its answer is no longer awaited (the outcome is then lost). The key travels in
  // the frame alone.
  login(
    authKey: string | undefined,
    timeoutMs: number,
    deadlineMs: number,
  ): Promise<TsnetLoginOutcome> {
    return this.control(() => this.loginRequest(authKey, timeoutMs, deadlineMs));
  }

  logout(): Promise<TsnetLogoutOutcome> {
    return this.control(() => this.logoutRequest());
  }

  // A login or logout: the node may change from its first moment (a reauth holds it, a logout
  // closes its listeners first), so nothing is advertised from before it, while it runs or from
  // an answer requested meanwhile; once it ends the node is observed again. See "Advertisement".
  private async control<T>(request: () => Promise<T>): Promise<T> {
    this.controls++;
    this.controlsStarted++;
    this.controlGeneration++;
    this.advertised = undefined;
    try {
      return await request();
    } finally {
      this.controls--;
      this.controlGeneration++;
      if (this.controls === 0 && !this.closing) void this.status();
    }
  }

  private async loginRequest(
    authKey: string | undefined,
    timeoutMs: number,
    deadlineMs: number,
  ): Promise<TsnetLoginOutcome> {
    this.loginFailure = undefined;
    // A login or logout that starts after this one supersedes it: this one's failure, ending
    // later, must not be published over that one's outcome (control() counts the starts).
    const started = this.controlsStarted;
    const channel = this.channel;
    if (!channel || !(await this.isReady())) return { kind: "lost" };
    let answer: HelperStatus;
    try {
      answer = (await channel.request(
        { op: "login", ...(authKey ? { authKey } : {}), timeoutMs },
        deadlineMs,
      )) as HelperStatus;
    } catch (error) {
      if (!(error instanceof HelperRefused)) return { kind: "lost" };
      // The login itself completed; only opening a listener failed (serve.go login).
      if (error.code === "LISTEN_FAILED") {
        return {
          kind: "answered",
          status: unavailableStatus(
            this.context?.hostname ?? null,
            "a tailnet port could not be opened",
          ),
          listenFailed: true,
        };
      }
      // The ordinary failures keep their reason for status; a hold reports its own there.
      if (
        (error.code === "LOGIN_FAILED" || error.code === "LOGIN_TIMEOUT") &&
        started === this.controlsStarted
      )
        this.loginFailure = sanitizedText(
          `the last login failed (${error.code}): ${error.detail}`,
          TSNET_LIMITS.warningChars,
          authKey ? [authKey] : [],
        );
      return { kind: "refused", code: error.code };
    }
    const secrets = authKey ? [authKey] : [];
    const status = apiStatus(answer, this.context?.hostname ?? null, secrets);
    const url = TsnetLoginSecretsSchema.shape.loginUrl.safeParse(answer.authURL);
    return { kind: "answered", status, ...(url.success ? { loginUrl: url.data } : {}) };
  }

  private async logoutRequest(): Promise<TsnetLogoutOutcome> {
    this.loginFailure = undefined;
    const channel = this.channel;
    if (!channel || !(await this.isReady())) return { kind: "lost" };
    try {
      const answer = (await channel.request({ op: "logout" }, LOGOUT_TIMEOUT_MS)) as HelperStatus;
      return { kind: "answered", remoteLogoutConfirmed: answer.remoteLogoutConfirmed === true };
    } catch (error) {
      return error instanceof HelperRefused
        ? { kind: "refused", code: error.code }
        : { kind: "lost" };
    }
  }

  // The helper's process ID, for tests and diagnostics only.
  get pid(): number | undefined {
    return this.child?.pid;
  }

  // `status` with the last login's failure as its first warning, within the warning bound.
  private withLoginFailure(status: TsnetStatus): TsnetStatus {
    if (!this.loginFailure) return status;
    return {
      ...status,
      warnings: [this.loginFailure, ...status.warnings].slice(0, TSNET_LIMITS.warnings),
    };
  }

  // The generations an answer is requested under; see "Advertisement".
  private generations(): { helper: number; ports: number; control: number } {
    return {
      helper: this.helperGeneration,
      ports: this.portGeneration,
      control: this.controlGeneration,
    };
  }

  // A status the helper answered to a request made under `at`: the advertisement, if it is
  // current (see "Advertisement").
  private observed(answer: HelperStatus, at: ReturnType<TsnetNode["generations"]>): void {
    if (
      this.controls === 0 &&
      at.helper === this.helperGeneration &&
      at.ports === this.portGeneration &&
      at.control === this.controlGeneration &&
      this.portsAcknowledged === this.portGeneration
    )
      this.advertised = answer;
  }

  // The current helper is gone: nothing it reported describes the next one.
  private retired(): void {
    this.helperGeneration++;
    this.portsAcknowledged = -1;
    this.advertised = undefined;
  }

  private hasState(): boolean {
    return existsSync(join(this.home, "state"));
  }

  private desiredPorts(): number[] {
    const context = this.context!;
    const pairing = context.pairingPort();
    return pairing === undefined ? [context.businessPort] : [context.businessPort, pairing];
  }

  private downReason(): string {
    if (this.incompatible) return this.incompatible;
    if (this.closing) return "the server is stopping";
    if (this.child) return "the tsnet helper is starting";
    if (this.failure) return this.failure;
    return "the tsnet helper is not running; it is restarted after a backoff";
  }

  private async isReady(): Promise<boolean> {
    return this.ready;
  }

  // Waits (bounded) for the current helper, or one about to be restarted, to be ready.
  private async whenReady(waitMs: number = READY_WAIT_MS): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (!this.closing && this.wanted && !this.incompatible) {
      if (this.child && (await this.ready) && this.channel) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((done) => setTimeout(done, 100).unref());
    }
    return false;
  }

  private async prepareForward(): Promise<boolean> {
    if (this.forward) return true;
    try {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await chmod(this.home, 0o700);
      let directory = join(this.home, "run");
      if (Buffer.byteLength(join(directory, "forward.sock")) > SOCKET_PATH_BYTES) {
        // A data directory too deep for a socket path: a private directory of this start.
        directory = await mkdtemp(join(tmpdir(), "cove-tsnet-"));
        this.socketDirectory = directory;
      } else {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      await chmod(directory, 0o700);
      this.socketPath = join(directory, "forward.sock");
      // A socket file left by an earlier server of this data directory, which only one server
      // at a time uses (the database lock).
      await unlink(this.socketPath).catch(() => undefined);
      const server = createServer((socket) => this.forwarded(socket));
      await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(this.socketPath, () => {
          server.off("error", fail);
          done();
        });
      });
      await chmod(this.socketPath, 0o600);
      this.forward = server;
      return true;
    } catch {
      this.failure = "the forward socket cannot be opened; it is retried after a backoff";
      this.context?.log({
        event: "tsnet-unavailable",
        reason: "the forward socket cannot be opened",
      });
      return false;
    }
  }

  private spawnHelper(): void {
    if (this.closing || !this.wanted || this.child || this.incompatible) return;
    const context = this.context!;
    const launch = this.launch as Exclude<Launch, { refused: string }>;
    let readyNow: (value: boolean) => void = () => undefined;
    this.ready = new Promise((done) => (readyNow = done));
    void (async () => {
      if (!(await this.prepareForward()) || this.closing) {
        readyNow(false);
        this.scheduleRestart();
        return;
      }
      const args = ["serve", "--home", this.home, "--forward-socket", this.socketPath];
      if (context.hostname) args.push("--hostname", context.hostname);
      if (launch.controlUrl) args.push("--control-url", launch.controlUrl);
      let child: ChildProcess;
      try {
        child = spawn(launch.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        context.log({ event: "tsnet-helper-failed", code: this.spawnFailure(error) });
        readyNow(false);
        this.scheduleRestart();
        return;
      }
      this.child = child;
      this.helperGeneration++;
      const startedAt = Date.now();
      const channel = new HelperChannel(child);
      this.channel = channel;
      this.logStderr(child);
      // The one way a helper process ends here, whichever event reports it first. A spawn that
      // fails asynchronously (ENOENT, EACCES, EAGAIN) emits `error` and then `close`, never `exit`;
      // a helper that ran emits `exit` and then `close`. Missing any of these would leave `child`
      // set forever: no restart, and status saying the helper is starting. Idempotent, so the
      // events that follow the first change nothing.
      let retired = false;
      let retirementDone: () => void = () => undefined;
      this.retirement = new Promise((done) => (retirementDone = done));
      const retire = (outcome: Record<string, unknown>, spawned: boolean): void => {
        if (retired) return;
        retired = true;
        retirementDone();
        channel.fail();
        readyNow(false);
        if (this.child !== child) return;
        this.child = undefined;
        this.channel = undefined;
        this.retired();
        context.log({ event: spawned ? "tsnet-helper-exited" : "tsnet-helper-failed", ...outcome });
        // Only a helper that really ran for STABLE_RUN_MS earns an immediate restart; a spawn
        // that failed ran nothing, and must not look like a long stable run.
        if (spawned && Date.now() - startedAt >= STABLE_RUN_MS) this.backoffMs = BACKOFF_INITIAL_MS;
        this.scheduleRestart();
      };
      child.on("error", (error) => {
        // `error` also reports a failed kill or write of a running helper, whose `exit` follows;
        // only a process that never started is retired here.
        if (child.pid === undefined) retire({ code: this.spawnFailure(error) }, false);
      });
      child.once("exit", (code, signal) => retire({ code, signal }, true));
      child.once("close", (code, signal) => retire({ code, signal }, child.pid !== undefined));
      try {
        const hello = (await channel.request(
          { op: "hello", protocol: HELPER_PROTOCOL, build: context.buildVersion },
          HELLO_TIMEOUT_MS,
        )) as { protocol?: unknown; build?: unknown };
        if (hello.protocol !== HELPER_PROTOCOL) {
          this.incompatible = `the tsnet helper speaks local protocol ${String(hello.protocol)}, not ${HELPER_PROTOCOL}`;
          context.log({ event: "tsnet-unavailable", reason: "local protocol mismatch" });
          channel.close();
          readyNow(false);
          return;
        }
        // An installed closure stamps its cove-tsnet with the closure's build (scripts/
        // runtime-closure.mjs); a difference means the closure was altered. Logged only.
        if (installedClosureRoot() && hello.build !== context.buildVersion)
          context.log({ event: "tsnet-helper-build-mismatch" });
        this.failure = undefined;
        context.log({ event: "tsnet-helper-started", pid: child.pid });
        readyNow(true);
        await this.syncPorts();
      } catch {
        readyNow(false);
        child.kill("SIGKILL");
      }
    })();
  }

  // Why the helper could not be started, kept for status: the error's code alone (ENOENT,
  // EACCES, ...), never its message, which names paths and is not bounded.
  private spawnFailure(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    const fixed = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
    this.failure = `the tsnet helper could not be started (${fixed}); it is retried after a backoff`;
    return fixed;
  }

  // Schedules the next start after the current backoff, which doubles each time. Whether a run was
  // long enough to reset it is decided where a helper is retired (spawnHelper).
  private scheduleRestart(): void {
    if (this.closing || !this.wanted || this.incompatible || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnHelper();
    }, delay);
    this.restartTimer.unref();
  }

  // The helper's stderr: one-line events (stream IDs, node IDs, ports), logged bounded and with
  // every URL replaced, so even a --verbose build could not put a login URL in the server log.
  private logStderr(child: ChildProcess): void {
    let pending = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line)
          this.context?.log({
            event: "tsnet-helper",
            line: sanitizedText(line, STDERR_LINE_CHARS),
          });
      }
      if (pending.length > FRAME_BYTES) pending = "";
    });
    child.stderr!.on("error", () => undefined);
  }

  // One forwarded connection: its header line (bounded in size and time), then the connection is
  // handed, with the rest of what it sent, to the listener of its tailnet port. Anything else is
  // closed unanswered.
  private forwarded(socket: Socket): void {
    if (this.closing || this.waiting.size >= PENDING_HEADERS) {
      socket.destroy();
      return;
    }
    this.waiting.add(socket);
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => done(null), HEADER_DEADLINE_MS);
    timer.unref();
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end >= 0) done(end);
      else if (buffered.length > FRAME_BYTES) done(null);
    };
    const onEnd = (): void => done(null);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onEnd);
    let finished = false;
    const done = (end: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
      socket.pause();
      this.waiting.delete(socket);
      const header = end === null ? null : headerOf(buffered.subarray(0, end));
      const context = this.context;
      if (!header || !context || this.closing) {
        socket.destroy();
        return;
      }
      const rest = buffered.subarray(end! + 1);
      if (rest.length > 0) socket.unshift(rest);
      socket.on("error", () => undefined);
      markEntry(socket, "tsnet", header.peer);
      if (header.port === context.businessPort) context.acceptBusiness(socket, header.peer);
      else if (header.port === context.pairingPort()) context.acceptPairing(socket, header.peer);
      else {
        socket.destroy();
        return;
      }
      // The socket was paused explicitly so that nothing after the header was lost before the
      // listener attached its own reader; a stream paused that way does not start flowing when a
      // `data` listener is added, so it is resumed here, delivering the unshifted bytes first.
      socket.resume();
    };
  }
}

// The forwarded-connection header (PROTOCOL.md "Forwarded connections"), or null when it is not
// one this server understands. Only the port is used; the peer is kept for display and audit.
function headerOf(bytes: Buffer): { port: number; peer: TsnetPeer | null } | null {
  let header: { protocol?: unknown; port?: unknown; peer?: HelperNode | null };
  try {
    header = JSON.parse(bytes.toString("utf8")) as typeof header;
  } catch {
    return null;
  }
  if (
    !header ||
    header.protocol !== HELPER_PROTOCOL ||
    !Number.isInteger(header.port) ||
    (header.port as number) < 1 ||
    (header.port as number) > 65535
  )
    return null;
  const id = TsnetNodeIdSchema.safeParse(header.peer?.stableNodeID);
  const name = typeof header.peer?.name === "string" ? header.peer.name.replace(/\.$/, "") : "";
  const parsedName = TsnetNodeNameSchema.safeParse(name.toLowerCase());
  return {
    port: header.port as number,
    peer: header.peer
      ? {
          stableNodeID: id.success ? id.data : null,
          name: parsedName.success && name ? parsedName.data : null,
        }
      : null,
  };
}

export function createTsnetEntry(): TsnetNode {
  return new TsnetNode();
}
