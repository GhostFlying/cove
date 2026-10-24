import {
  ActionError,
  ConnectionError,
  connectionReason,
  type ConnectionFailure,
} from "./action-error.js";
import { createServerSession, type ServerSession, type ServerSessionSnapshot } from "@cove/client";
import { createDefaultScheduler } from "@cove/client/web-ports";
import { decodeInvitation } from "@cove/protocol/auth";
import { NativePorts, type NativeDriver } from "./native-ports.js";
import { loadServer, saveServer, type SecureTokenStore } from "./credentials.js";
import { verifyServer, MOBILE_BUILD_VERSION } from "./entry.js";
import { pairServer } from "./pairing.js";
import { utf8 } from "./codec.js";
import { LocalStore, credentialKey, type Profile, type Journal } from "./local-store.js";
import { Operations } from "./operation-store.js";

export interface MobileNode {
  status: string;
  driver: NativeDriver;
  refresh(): Promise<string>;
  login(key: string): Promise<string>;
  logout(): Promise<string>;
  close(): Promise<void>;
}
export interface MobileState {
  profiles: Profile[];
  operations: Journal[];
  sessions: Readonly<Record<string, ServerSessionSnapshot>>;
  failures: Readonly<Record<string, ConnectionFailure>>;
  nodeState: string;
  authURL: string;
  foreground: boolean;
  version: number;
}
export interface HostOptions {
  store: LocalStore;
  openNode(): Promise<MobileNode>;
  secure(key: string): SecureTokenStore;
  uuid(): string;
  digest(text: string): Promise<string>;
}

/** RN owns transport, credentials and domain clients; navigation and terminal focus stay local. */
export class MobileHost {
  readonly operations: Operations;
  private generation = 0;
  private node: MobileNode | undefined;
  private ports: NativePorts | undefined;
  private opening: { promise: Promise<MobileNode>; claimed: boolean } | undefined;
  private resumeProfiles: string[] = [];
  private sessions = new Map<string, ServerSession>();
  private subscriptions = new Map<string, { dispose(): void }>();
  private listeners = new Set<() => void>();
  private closing: Promise<void> = Promise.resolve();
  private state: MobileState = {
    profiles: [],
    operations: [],
    sessions: {},
    failures: {},
    nodeState: "stopped",
    authURL: "",
    foreground: false,
    version: 0,
  };
  constructor(readonly options: HostOptions) {
    this.operations = new Operations(options.store, options.uuid, options.digest);
  }
  snapshot = (): MobileState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<MobileState> = {}): void {
    this.state = {
      ...this.state,
      ...patch,
      sessions: Object.fromEntries(
        [...this.sessions].map(([id, session]) => [id, session.snapshot()]),
      ),
      version: this.state.version + 1,
    };
    for (const listener of this.listeners) listener();
  }
  async reload(): Promise<void> {
    const [profiles, operations] = await Promise.all([
      this.options.store.profiles(),
      this.options.store.operations(),
    ]);
    this.publish({ profiles, operations });
  }
  async initialize(): Promise<void> {
    await this.options.store.initialize();
    await this.reload();
  }
  async foreground(): Promise<void> {
    const generation = ++this.generation;
    const resume = [...new Set([...this.resumeProfiles, ...this.sessions.keys()])];
    await this.closeOwned();
    if (generation !== this.generation) return;
    this.publish({ foreground: true, nodeState: "starting" });
    const attempt = { promise: this.options.openNode(), claimed: false };
    this.opening = attempt;
    const node = await attempt.promise;
    if (this.opening === attempt) this.opening = undefined;
    if (generation !== this.generation) {
      if (!attempt.claimed) await node.close();
      return;
    }
    this.node = node;
    this.ports = new NativePorts(node.driver);
    this.nodeStatus(node.status);
    // Background disposal retains no client-side input queue. Reconnect is read-only; each
    // entry verifies peer/server before its token supplier can be used.
    for (const profile of this.state.profiles.filter((p) => resume.includes(p.id))) {
      if (generation !== this.generation) return;
      if (profile.state === "ready") await this.connect(profile.id).catch(() => {});
    }
  }
  background(): void {
    const generation = ++this.generation;
    this.resumeProfiles = [...this.sessions.keys()];
    this.publish({ foreground: false, authURL: "", nodeState: "stopping" });
    // OS suspension fences immediately. Completion is still an observed receipt, not an
    // inference from loss of contact; delayed results cannot update a newer incarnation.
    void this.closeOwned().then(
      () => {
        if (generation === this.generation) this.publish({ nodeState: "stopped" });
      },
      () => {
        if (generation === this.generation) this.publish({ nodeState: "shutdown-unverified" });
      },
    );
  }
  async stop(): Promise<void> {
    const generation = ++this.generation;
    this.resumeProfiles = [];
    this.publish({ foreground: false, authURL: "", nodeState: "stopping" });
    try {
      await this.closeOwned();
      if (generation === this.generation) this.publish({ nodeState: "stopped" });
    } catch {
      if (generation === this.generation) this.publish({ nodeState: "shutdown-unverified" });
      throw new ConnectionError({ stage: "shutdown", category: "shutdown-unverified" });
    }
  }
  private closeOwned(): Promise<void> {
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.ports?.dispose();
    this.ports = undefined;
    const node = this.node;
    const opening = this.opening;
    if (opening) opening.claimed = true;
    this.opening = undefined;
    this.node = undefined;
    this.publish();
    // Preserve a rejected close, including across repeated background notifications. It is
    // never converted to success just because the JS resource reference was retired.
    if (node || opening)
      this.closing = this.closing.then(async () => {
        if (node) await node.close();
        if (opening) await (await opening.promise).close();
      });
    return this.closing;
  }
  private nodeStatus(raw: string): void {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new ActionError("Node state unavailable");
    const state =
      "state" in value && typeof value.state === "string" && value.state.length <= 64
        ? value.state
        : "unknown";
    const authURL =
      "authURL" in value &&
      typeof value.authURL === "string" &&
      value.authURL.startsWith("https://") &&
      value.authURL.length <= 4096
        ? value.authURL
        : "";
    this.publish({ nodeState: state, authURL });
  }
  async network(action: "login" | "refresh" | "logout"): Promise<void> {
    const node = this.node;
    const generation = this.generation;
    if (!node) throw new ActionError("Start the local network node first");
    if (action === "logout") {
      this.resumeProfiles = [];
      // Retire sessions before the single logout receipt; a lost response never retries.
      for (const session of this.sessions.values()) session.suspend();
    }
    const status = await (action === "login"
      ? node.login("")
      : action === "logout"
        ? node.logout()
        : node.refresh());
    if (node === this.node && generation === this.generation) this.nodeStatus(status);
  }
  profile(id: string): Profile {
    const profile = this.state.profiles.find((p) => p.id === id);
    if (!profile) throw new ActionError("Saved server is unavailable");
    return profile;
  }
  currentSession(id: string): ServerSession | undefined {
    const value = this.sessions.get(id);
    return value?.snapshot().status === "current" ? value : undefined;
  }
  session(id: string): ServerSession {
    const session = this.currentSession(id);
    if (!session || session.snapshot().status !== "current")
      throw new ActionError("Reconnect and verify server first");
    return session;
  }
  async pair(invitation: string, label: string, deviceName: string): Promise<void> {
    const payload = decodeInvitation(invitation.trim());
    if (!payload?.entries.tsnet) throw new ActionError("Invitation needs a Mobile tsnet entry");
    const ports = this.ports;
    const generation = this.generation;
    if (!ports) throw new ActionError("Start and enroll the local network node first");
    const profile: Profile = {
      id: this.options.uuid(),
      serverId: payload.serverId,
      label,
      peerID: payload.entries.tsnet.nodeId,
      port: payload.pairingPort,
      state: "pending",
    };
    await this.options.store.putProfile(profile);
    await this.reload();
    if (ports !== this.ports || generation !== this.generation)
      throw new ActionError("Connection changed before pairing");
    const saved = await pairServer(
      ports,
      invitation,
      deviceName,
      this.options.secure(credentialKey(profile)),
    );
    // Native pairing itself has exactly one redemption attempt. Even if this commit fails,
    // its already allocated slot remains discoverable for explicit read-only recovery.
    await this.options.store.putProfile({ ...profile, port: saved.port, state: "ready" });
    await this.reload();
    if (generation === this.generation) await this.connect(profile.id);
  }
  async recoverPair(id: string): Promise<void> {
    const profile = this.profile(id);
    const ports = this.ports;
    const generation = this.generation;
    if (!ports) throw new ActionError("Start the local network node first");
    const saved = await loadServer(this.options.secure(credentialKey(profile)));
    if (!saved || saved.serverId !== profile.serverId)
      throw new ActionError("No saved pairing; use a new invitation");
    const entry = ports.entry(saved.peerID, saved.port);
    try {
      await verifyServer(entry.http, profile.serverId);
      if (generation !== this.generation) throw new ActionError("Connection changed");
      await this.options.store.putProfile({
        ...profile,
        peerID: saved.peerID,
        port: saved.port,
        state: "ready",
      });
    } finally {
      entry.close();
    }
    await this.reload();
    await this.connect(id);
  }
  async connect(id: string): Promise<void> {
    const profile = this.profile(id);
    const ports = this.ports;
    if (!ports || profile.state !== "ready") throw new ActionError("Server pairing is not ready");
    if (!this.sessions.has(id) && this.sessions.size >= 8)
      throw new ActionError("Eight server connections are active; disconnect another server first");
    this.subscriptions.get(id)?.dispose();
    this.sessions.get(id)?.dispose();
    const scheduler = createDefaultScheduler();
    let bindingFailure: ConnectionFailure | undefined;
    const failures = { ...this.state.failures };
    delete failures[id];
    this.publish({ failures });
    const session = createServerSession({
      serverId: profile.serverId,
      scheduler,
      codec: utf8,
      bind: () => {
        let cancelled = false;
        let close: (() => void) | undefined;
        const result = (async () => {
          let saved;
          try {
            saved = await loadServer(this.options.secure(credentialKey(profile)));
          } catch {
            bindingFailure = { stage: "credentials", category: "store-unavailable" };
            throw new ConnectionError(bindingFailure);
          }
          if (!saved || saved.serverId !== profile.serverId) {
            bindingFailure = { stage: "credentials", category: "missing-slot" };
            throw new ConnectionError(bindingFailure);
          }
          if (cancelled || ports !== this.ports) throw new ActionError("Connection superseded");
          let entry;
          try {
            entry = ports.entry(profile.peerID, profile.port);
          } catch {
            bindingFailure = { stage: "entry", category: "peer-transport-unverified" };
            throw new ConnectionError(bindingFailure);
          }
          close = () => entry.close();
          try {
            const identity = await verifyServer(entry.http, profile.serverId);
            if (cancelled || ports !== this.ports) throw new ActionError("Connection superseded");
            return {
              identity: { serverId: profile.serverId, relayInstanceId: identity.relayInstanceId },
              client: {
                http: entry.http,
                terminal: entry.terminal,
                credentials: () => ({
                  authorization: `Bearer ${saved.token}`,
                  terminalSecret: saved.token,
                }),
                codec: utf8,
                scheduler,
                createOpaqueId: this.options.uuid,
                buildVersion: MOBILE_BUILD_VERSION,
              },
              events: entry.socket("/events"),
              dispose: close,
            };
          } catch (error) {
            bindingFailure =
              error instanceof ConnectionError
                ? error.failure
                : { stage: "entry", category: "peer-transport-unverified" };
            entry.close();
            throw new ConnectionError(bindingFailure);
          }
        })();
        return {
          result,
          dispose: () => {
            cancelled = true;
            close?.();
          },
        };
      },
    });
    this.sessions.set(id, session);
    this.subscriptions.set(
      id,
      session.onState((value) => {
        const failure =
          value.status === "stale" && value.lastError
            ? (bindingFailure ?? connectionReason(value.lastError))
            : undefined;
        this.publish(failure ? { failures: { ...this.state.failures, [id]: failure } } : {});
      }),
    );
    this.publish();
    const outcome = await session.connect();
    if (!outcome.ok) {
      const reason = session.snapshot().lastError ?? outcome.reason;
      const failure = bindingFailure ?? connectionReason(reason);
      if (this.sessions.get(id) === session)
        this.publish({ failures: { ...this.state.failures, [id]: failure } });
      throw new ConnectionError(failure);
    }
  }
  disconnect(id: string): void {
    this.subscriptions.get(id)?.dispose();
    this.subscriptions.delete(id);
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
    this.resumeProfiles = this.resumeProfiles.filter((v) => v !== id);
    this.publish();
  }
  async changeEntry(id: string, peerID: string, port: number): Promise<void> {
    const profile = this.profile(id);
    const ports = this.ports;
    if (!ports) throw new ActionError("Start the local network node first");
    const entry = ports.entry(peerID, port);
    const generation = this.generation;
    try {
      await verifyServer(entry.http, profile.serverId);
      if (generation !== this.generation) throw new ActionError("Connection superseded");
      const saved = await loadServer(this.options.secure(credentialKey(profile)));
      if (!saved || saved.serverId !== profile.serverId)
        throw new ActionError("Credential slot unavailable");
      await saveServer(this.options.secure(credentialKey(profile)), { ...saved, peerID, port });
      await this.options.store.putProfile({ ...profile, peerID, port });
    } finally {
      entry.close();
    }
    await this.reload();
    await this.connect(id);
  }
  async forget(id: string): Promise<void> {
    const profile = this.profile(id);
    await this.options.store.putProfile({ ...profile, state: "forgetting" });
    this.subscriptions.get(id)?.dispose();
    this.sessions.get(id)?.dispose();
    this.subscriptions.delete(id);
    this.sessions.delete(id);
    await this.reload();
    await this.options.secure(credentialKey(profile)).remove();
    await this.options.store.removeProfile(id);
    await this.reload();
  }
}
