import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createServerSession,
  credentialSupplier,
  type ServerSession,
  type TerminalController,
  type VerifiedServerBinding,
} from "@cove/client";
import {
  createDefaultScheduler,
  createUtf8Codec,
  createWebSocketPort,
} from "@cove/client/web-ports";
import {
  createNodeConnectionAdapters,
  createNodePorts,
  createNodeClient,
  parseInvitation,
  preAuthIdentity,
  verifiedIdentity,
  type Via,
} from "@cove/node-client";
import { RendezvousSchema } from "@cove/protocol/bootstrap";
import { DeviceNameSchema } from "@cove/protocol/auth";
import {
  OperationRecordSchema,
  isWriteRpcMethod,
  validateRpcMethodParams,
  type RpcMethod,
} from "@cove/protocol/rpc";
import { RunRefSchema, type RunRef } from "@cove/protocol/identity";
import { DEFAULT_APPEARANCE, GeometrySchema } from "@cove/protocol/profile";
import {
  createTerminalViewBridgeHost,
  type TerminalViewBridgeHost,
} from "@cove/terminal-web/view-bridge";
import type {
  DesktopApi,
  DesktopSnapshot,
  HostReply,
  PendingOperation,
  ViewDescriptor,
} from "../shared/api.js";
import { DesktopStorage, type StoredServer } from "./storage.js";

type OpenView = {
  serverId: string;
  descriptor: ViewDescriptor;
  bridge: TerminalViewBridgeHost;
  controller?: TerminalController;
  stateListener?: { dispose(): void };
  inputListener?: { dispose(): void };
};
const METHODS = new Set([
  "server.status",
  "repo.register",
  "repo.update",
  "repo.remove",
  "repo.list",
  "repo.get",
  "task.create",
  "task.update",
  "task.archive",
  "task.unarchive",
  "task.list",
  "task.get",
  "mount.add",
  "mount.remove",
  "mount.retry",
  "binding.convert",
  "binding.delete",
  "binding.list",
  "tab.create",
  "tab.reopen",
  "tab.stop",
  "tab.close",
  "tab.get",
  "tab.list",
  "tab.runs",
  "operation.get",
  "operation.continue",
  "operation.abandon",
  "auth.device.list",
  "auth.device.revoke",
]);
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : "The operation could not be verified";
const succeeded = (value?: unknown): HostReply => ({
  ok: true,
  ...(value === undefined ? {} : { value }),
});

/** One app owns its clients and views; the execution server and the shared network daemon are never children to clean up. */
export class DesktopHost {
  private ready = false;
  private error: string | null = null;
  private disposed = false;
  private foreground = false;
  private windowVisible = true;
  private readonly sessions = new Map<string, ServerSession>();
  private readonly listeners = new Map<string, { dispose(): void }>();
  private readonly views = new Map<string, OpenView>();
  private viewGeneration = 0;
  private readonly adapters;
  private readonly scheduler = createDefaultScheduler();
  private readonly codec = createUtf8Codec();
  constructor(
    private readonly storage: DesktopStorage,
    private readonly home: string,
    private readonly build: string,
    private readonly emit: (
      event: "state" | "view" | "terminal" | "input",
      ...args: unknown[]
    ) => void,
  ) {
    this.adapters = createNodeConnectionAdapters({
      tsnet: { binaryPath: () => join(this.home, "install", "current", "bin", "cove-tsnet") },
    });
  }
  async initialize(): Promise<void> {
    try {
      await this.storage.load();
      this.ready = true;
    } catch {
      this.error =
        "Desktop secure storage could not be opened. Unlock macOS Keychain, then restart Cove. Existing data was preserved.";
    }
    this.publish();
  }
  snapshot(): DesktopSnapshot {
    return {
      localHome: this.home,
      ready: this.ready,
      servers: this.storage.serverRecords().map(({ token: _token, ...server }) => server),
      sessions: Object.fromEntries(
        [...this.sessions].map(([id, session]) => [id, session.snapshot()]),
      ),
      operations: this.storage.pendingOperations(),
      error: this.error,
    };
  }
  private publish(): void {
    if (!this.disposed) this.emit("state", this.snapshot());
  }
  private record(serverId: string): StoredServer {
    if (!this.ready || this.disposed) throw new Error("Desktop secure storage is unavailable");
    const record = this.storage.serverRecords().find((server) => server.serverId === serverId);
    if (!record) throw new Error("The server is not paired in this Desktop");
    return record;
  }
  private async attempt(action: () => Promise<unknown>): Promise<HostReply> {
    try {
      return succeeded(await action());
    } catch (error) {
      return { ok: false, error: reason(error) };
    } finally {
      this.publish();
    }
  }
  pair: DesktopApi["pair"] = (input) =>
    this.attempt(async () => {
      if (!this.ready || this.disposed) throw new Error("Desktop secure storage is unavailable");
      if (
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.alias) ||
        !DeviceNameSchema.safeParse(input.name).success ||
        !["loopback", "ssh", "tsnet"].includes(input.via)
      )
        throw new Error("Enter a valid alias, device name and entry before pairing");
      const payload = parseInvitation(input.invitation);
      if (
        this.storage
          .serverRecords()
          .some((server) => server.serverId === payload.serverId || server.alias === input.alias)
      )
        throw new Error(
          "Server or alias already paired; explicitly forget and revoke its old device first",
        );
      const via: Via | undefined = input.via === "loopback" ? undefined : input.via;
      const result = await this.adapters.redeemInvitation(
        payload,
        input.name,
        via,
        this.build,
        this.home,
      );
      const port = result.businessPort;
      const entries = {
        ...(input.via === "loopback" ? { loopback: { port } } : {}),
        ...(payload.entries.ssh ? { ssh: { target: payload.entries.ssh.target, port } } : {}),
        ...(payload.entries.tsnet ? { tsnet: { ...payload.entries.tsnet, port } } : {}),
      };
      try {
        if (this.disposed) throw new Error("Desktop closed before storage completed");
        await this.storage.saveServer({
          alias: input.alias,
          serverId: result.serverId,
          deviceId: result.deviceId,
          token: result.token,
          defaultEntry: input.via,
          entries,
        });
      } catch {
        throw new Error(
          `Pairing redeemed device ${result.deviceId}, but Keychain-protected storage failed. Desktop is not paired. Revoke that device on the server and use a new invitation.`,
        );
      }
      return { serverId: result.serverId };
    });
  pairLocal: DesktopApi["pairLocal"] = (input) =>
    this.attempt(async () => {
      if (!this.ready || this.disposed) throw new Error("Desktop secure storage is unavailable");
      if (
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.alias) ||
        !DeviceNameSchema.safeParse(input.name).success
      )
        throw new Error("Enter a valid alias and device name before local pairing");
      const home = await realpath(input.home);
      let text;
      try {
        text = await readFile(join(home, "server", "run", "rendezvous.json"), "utf8");
      } catch {
        throw new Error(
          "Local server is unavailable. Install it with `cove server install`, then use `cove server service start`. Cove never installs or replaces it automatically.",
        );
      }
      const local = RendezvousSchema.parse(JSON.parse(text));
      const endpoint = new URL(local.endpoint);
      if (
        endpoint.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
        endpoint.pathname !== "/"
      )
        throw new Error("Local bootstrap requires a numeric loopback server endpoint");
      const identity = await preAuthIdentity(
        local.endpoint,
        this.build,
        "the explicitly selected local server",
      );
      if (
        identity.serverId !== local.serverId ||
        identity.relayInstanceId !== local.relayInstanceId
      )
        throw new Error("Local server identity changed; no owner secret was sent");
      if (
        this.storage
          .serverRecords()
          .some((server) => server.serverId === local.serverId || server.alias === input.alias)
      )
        throw new Error("Server or alias already paired; no new invitation was created");
      const owner = createNodeClient(
        { ...local },
        () => ({ kind: "local-secret", secret: local.secret }),
        this.build,
      );
      try {
        const connected = await owner.connect();
        if (!connected.ok)
          throw new Error("Local bootstrap connection failed; check server status");
        const operationId = randomUUID();
        await this.storage.recordOperation({
          serverId: local.serverId,
          relayInstanceId: local.relayInstanceId,
          operationId,
          method: "auth.invite.create",
          createdAtMs: Date.now(),
          status: "pending",
        });
        const outcome = await owner.call("auth.invite.create", { operationId });
        if (!outcome.ok || !outcome.value.secrets?.invitation)
          throw new Error(
            "Local invitation creation could not be verified. It will not be replayed; inspect `cove auth invite list` before trying again.",
          );
        await this.storage.recordOperation({
          serverId: local.serverId,
          relayInstanceId: local.relayInstanceId,
          operationId,
          method: "auth.invite.create",
          createdAtMs: Date.now(),
          status: "observed",
          result: outcome.value.operation,
        });
        const result = await this.pair({
          alias: input.alias,
          invitation: outcome.value.secrets.invitation,
          via: "loopback",
          name: input.name,
        });
        if (!result.ok) throw new Error(result.error);
        return result.value;
      } finally {
        owner.dispose();
      }
    });
  connect: DesktopApi["connect"] = (serverId, via) =>
    this.attempt(async () => {
      const record = this.record(serverId);
      if (!record.entries[via])
        throw new Error(
          `No ${via} entry is recorded. Nothing was sent; choose an available entry explicitly.`,
        );
      this.closeServerViews(serverId);
      this.listeners.get(serverId)?.dispose();
      this.sessions.get(serverId)?.dispose();
      const session = createServerSession({
        serverId,
        scheduler: this.scheduler,
        codec: this.codec,
        bind: () => {
          let cancelled = false;
          let binding: VerifiedServerBinding | undefined;
          const result = (async () => {
            const entry = await this.adapters.openEntry(
              { ...record, defaultEntry: via },
              undefined,
              this.home,
            );
            try {
              const identity = await verifiedIdentity(record, entry, this.build);
              if (cancelled || this.disposed) throw new Error("Connection superseded");
              const ports = createNodePorts(entry.endpoint);
              binding = {
                identity: { serverId, relayInstanceId: identity.relayInstanceId },
                client: {
                  ...ports,
                  buildVersion: this.build,
                  credentials: credentialSupplier(
                    () => ({ kind: "device-token", token: this.record(serverId).token }),
                    serverId,
                  ),
                  codec: this.codec,
                  scheduler: this.scheduler,
                  createOpaqueId: randomUUID,
                },
                events: createWebSocketPort({ endpoint: entry.endpoint, path: "/events" }),
                dispose: () => {
                  void entry.close();
                },
              };
              return binding;
            } catch (error) {
              await entry.close();
              throw error;
            }
          })();
          return {
            result,
            dispose: () => {
              cancelled = true;
              binding?.dispose();
            },
          };
        },
      });
      this.sessions.set(serverId, session);
      this.listeners.set(
        serverId,
        session.onState(() => this.publish()),
      );
      const outcome = await session.connect();
      if (!outcome.ok)
        throw new Error(`Cannot connect over ${via}: ${outcome.reason}. No other entry was tried.`);
      return { serverId };
    });
  disconnect: DesktopApi["disconnect"] = (serverId) =>
    this.attempt(async () => {
      this.closeServerViews(serverId);
      this.sessions.get(serverId)?.suspend();
    });
  forget: DesktopApi["forget"] = (serverId) =>
    this.attempt(async () => {
      this.record(serverId);
      await this.storage.forgetServer(serverId);
      this.closeServerViews(serverId);
      this.listeners.get(serverId)?.dispose();
      this.listeners.delete(serverId);
      this.sessions.get(serverId)?.dispose();
      this.sessions.delete(serverId);
    });
  call: DesktopApi["call"] = (serverId, method, params) =>
    this.attempt(async () => {
      this.record(serverId);
      if (!METHODS.has(method)) throw new Error("This operation is not exposed by Desktop");
      const session = this.sessions.get(serverId);
      if (!session || session.snapshot().status !== "current")
        throw new Error("Connect and verify this server before operating");
      if (!params || typeof params !== "object" || Array.isArray(params))
        throw new Error("Invalid request");
      const input = { ...params } as Record<string, unknown>;
      const write = isWriteRpcMethod(method);
      const operationId = write ? randomUUID() : undefined;
      if (operationId) input.operationId = operationId;
      const parsed = validateRpcMethodParams(method as RpcMethod, input);
      if (!parsed) throw new Error("The request is invalid; check the entered fields");
      let pending: PendingOperation | undefined;
      if (operationId) {
        pending = {
          serverId,
          relayInstanceId: session.snapshot().identity!.relayInstanceId,
          operationId,
          method,
          createdAtMs: Date.now(),
          status: "pending",
        };
        // The reference must survive a crash BEFORE transport can receive the write. A failed
        // durable admission prevents dispatch; there is no deferred-send queue in this file.
        await this.storage.recordOperation(pending);
        this.publish();
      }
      const outcome = await session.call(parsed.method, parsed.params as never);
      if (pending) {
        const record =
          outcome.ok && typeof outcome.value === "object" && outcome.value !== null
            ? OperationRecordSchema.safeParse((outcome.value as { operation?: unknown }).operation)
            : null;
        await this.storage.recordOperation({
          ...pending,
          status: record?.success
            ? "observed"
            : !outcome.ok &&
                (outcome.kind === "operation-not-sent" ||
                  (outcome.kind === "rpc-error" &&
                    "acceptance" in outcome.error &&
                    outcome.error.acceptance === "not-accepted"))
              ? "not-sent"
              : "unknown",
          ...(record?.success ? { result: record.data } : {}),
        });
      }
      return outcome;
    });
  queryOperation: DesktopApi["queryOperation"] = (serverId, operationId) =>
    this.attempt(async () => {
      this.record(serverId);
      const pending = this.storage
        .pendingOperations()
        .find((value) => value.serverId === serverId && value.operationId === operationId);
      if (!pending) throw new Error("Unknown local operation reference");
      const session = this.sessions.get(serverId);
      if (!session || session.snapshot().status !== "current")
        throw new Error("Reconnect and verify this server first");
      const outcome = await session.call("operation.get", { operationId });
      if (outcome.ok) {
        const record = OperationRecordSchema.parse(outcome.value.operation);
        if (record.method !== pending.method)
          throw new Error("Operation identity mismatch; result remains unknown");
        await this.storage.recordOperation({ ...pending, status: "observed", result: record });
      }
      // not-found, no contact and restart do not prove that the original effect did not happen.
      return outcome;
    });
  acknowledgeOperation: DesktopApi["acknowledgeOperation"] = (serverId, operationId) =>
    this.attempt(() => this.storage.acknowledgeOperation(serverId, operationId));
  networkStatus: DesktopApi["networkStatus"] = () =>
    this.attempt(async () => {
      const daemon = await this.adapters.probeDaemon(this.home);
      if (!daemon)
        return {
          state: "not-started",
          guidance: "Use Tailnet login, or `cove remote tsnet login` after installing Cove CLI.",
        };
      try {
        return await daemon.channel.request({ op: "status" }, 10_000);
      } finally {
        daemon.channel.close();
      }
    });
  networkLogin: DesktopApi["networkLogin"] = () =>
    this.attempt(async () => {
      const daemon = await this.adapters.openDaemon(this.home);
      try {
        return await daemon.channel.request({ op: "login", timeoutMs: 15_000 }, 30_000);
      } finally {
        daemon.channel.close();
      }
    });
  openView(serverId: string, rawRun: RunRef): ViewDescriptor {
    this.record(serverId);
    const run = RunRefSchema.parse(rawRun);
    if (run.serverId !== serverId) throw new Error("Terminal server mismatch");
    if (this.views.size >= 4) throw new Error("Visible terminal capacity reached");
    const session = this.sessions.get(serverId);
    if (!session || session.snapshot().status !== "current")
      throw new Error("Server is not connected");
    const descriptor = { viewId: randomUUID(), generation: ++this.viewGeneration };
    const bridge = createTerminalViewBridgeHost({
      bridgeGeneration: descriptor.generation,
      postMessage: (message) => this.emit("view", descriptor, message),
    });
    const view: OpenView = { serverId, descriptor, bridge };
    this.views.set(descriptor.viewId, view);
    void bridge.ready
      .then(async () => {
        if (this.views.get(descriptor.viewId) !== view) return;
        const opened = session.openTerminal({
          run,
          viewId: descriptor.viewId,
          view: bridge,
          initialAppearance: DEFAULT_APPEARANCE,
        });
        if (!opened.ok) throw new Error("Terminal attachment could not be verified");
        view.controller = opened.value;
        // Host eligibility is separate from a deliberate view focus gesture. New views
        // may observe while foreground; only their next user gesture requests control.
        opened.value.setInputTarget(this.foreground, false);
        opened.value.setVisibility(this.windowVisible);
        view.stateListener = opened.value.onState((state) =>
          this.emit("terminal", descriptor, state),
        );
        view.inputListener = opened.value.onInputOutcome((notice) =>
          this.emit("input", descriptor, notice),
        );
        const outcome = await opened.value.attach();
        if (!outcome.ok) bridge.invalidate();
        else await session.call("terminal.get", { run });
      })
      .catch(() => bridge.invalidate());
    return descriptor;
  }
  viewMessage(descriptor: ViewDescriptor, message: string): void {
    const view = this.views.get(descriptor.viewId);
    if (view?.descriptor.generation === descriptor.generation && typeof message === "string")
      view.bridge.receiveMessage(message);
  }
  focusView: DesktopApi["focusView"] = (descriptor, rawGeometry) =>
    this.attempt(async () => {
      const view = this.views.get(descriptor.viewId);
      if (
        view?.descriptor.generation !== descriptor.generation ||
        !view.controller ||
        !this.foreground ||
        !this.windowVisible
      )
        throw new Error("This terminal view is not foreground and ready for control");
      const geometry = GeometrySchema.parse(rawGeometry);
      view.controller.setInputTarget(true, true);
      const outcome = await view.controller.requestFocus(geometry);
      if (!outcome.ok)
        throw new Error("Terminal control was not verified; inspect current state before typing");
      return { ok: true };
    });
  blurView: DesktopApi["blurView"] = (descriptor) =>
    this.attempt(async () => {
      const view = this.views.get(descriptor.viewId);
      if (view?.descriptor.generation !== descriptor.generation || !view.controller) return;
      view.controller.setInputTarget(this.foreground, false);
      await view.controller.blur();
    });
  closeView(descriptor: ViewDescriptor): void {
    const view = this.views.get(descriptor.viewId);
    if (!view || view.descriptor.generation !== descriptor.generation) return;
    this.views.delete(descriptor.viewId);
    view.stateListener?.dispose();
    view.inputListener?.dispose();
    view.controller?.dispose();
    view.bridge.dispose();
  }
  releaseViews(): void {
    for (const view of [...this.views.values()]) this.closeView(view.descriptor);
  }
  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    for (const view of this.views.values()) {
      // Returning to foreground restores eligibility, never the old control intent.
      view.controller?.setInputTarget(foreground, false);
      if (!foreground) void view.controller?.blur();
    }
  }
  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    for (const view of this.views.values()) view.controller?.setVisibility(visible);
  }
  private closeServerViews(serverId: string): void {
    // All views in this single-window workbench belong to its selected server; close them
    // before retiring a session so stale callbacks cannot attach to a successor instance.
    for (const view of [...this.views.values()])
      if (view.serverId === serverId) this.closeView(view.descriptor);
  }
  dispose(): void {
    this.disposed = true;
    this.releaseViews();
    for (const listener of this.listeners.values()) listener.dispose();
    for (const session of this.sessions.values()) session.dispose();
    this.listeners.clear();
    this.sessions.clear();
  }
}
