import {
  AUTH_LIMITS,
  SshTargetSchema,
  encodeInvitation,
  type DeviceRecord,
  type PairingFailure,
  type PairingRedeemRequest,
  type PairingRedeemResult,
} from "@cove/protocol/auth";
import { parseCredential } from "@cove/protocol/bootstrap";
import { domainError, type DomainError } from "@cove/protocol/errors";
import type { OperationRecord } from "@cove/protocol/rpc";
import {
  executeDatabaseWrite,
  executeSecretWrite,
  recordedWrite,
  storeReadError,
  type DatabaseWriteContext,
  type DatabaseWriteOutcome,
} from "../operations/database-operations.js";
import type { OperationReceipts } from "../operations/operation-receipts.js";
import type { Principal } from "../rpc/context.js";
import type { Store } from "../store/database.js";
import type { OpenInvitation } from "../store/sql/auth.js";
import { DeviceConnections } from "./connections.js";
import { DeviceAuthenticator, type DeviceVerdict, type EntryKind } from "./devices.js";
import { PairingListener } from "./pairing-listener.js";
import { issueToken, newResourceId, newSecret, sameHash, secretHash } from "./tokens.js";

export type { EntryKind } from "./devices.js";

// The verdict on a presented credential (relay-protocol §11.8): the local owner secret of this
// start, a device token, or neither. `revoked` is only for the correct token of a revoked device.
export type Authentication =
  | { readonly kind: "local-owner" }
  | Extract<DeviceVerdict, { kind: "device" }>
  | { readonly kind: "revoked" }
  | { readonly kind: "unauthenticated" };

export type AuthState = Awaited<ReturnType<typeof loadAuthState>>;

// The devices and open invitations of the store, read once at startup before anything is served;
// invitations whose time ran out while the server was down are expired first. The listener opens
// in AuthService.start, once the business port (which a redemption answers with) is bound.
export async function loadAuthState(store: Store, now: () => number = Date.now) {
  const at = now();
  await store.call("auth.invitations.expire", { at });
  return store.call("auth.load", { at });
}

// How long a revocation waits for the device's connections to close before it reports the ones
// still open (D8).
export const REVOCATION_WAIT_MS = 3_000;

export type AuthServiceOptions = {
  store: Store;
  receipts: OperationReceipts;
  serverId: string;
  relayInstanceId: string;
  buildVersion: string;
  encodeUtf8: (text: string) => Uint8Array;
  // The local owner secret of this start (the rendezvous secret).
  localSecret: string;
  // Pairing listener address. `pairingPort` undefined: the port of the open invitations if any,
  // otherwise any free port (m2 T1; T3's entry configuration replaces this).
  host: "127.0.0.1" | "::1";
  pairingPort?: number;
  // The SSH target invitations advertise (entry/m0-local-options.ts). Undefined: no entry can be
  // advertised, so no invitation can be created (ENTRY_UNAVAILABLE).
  sshTarget?: string;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

function constantTimeEqual(expected: string, actual: string): boolean {
  // Hashing first gives both sides one length, so the comparison itself leaks nothing.
  return sameHash(secretHash(expected), secretHash(actual));
}

// Device authorization of one server instance (m2 T1): credential verification for the
// transports, the RPC operations of the auth domain, and the pairing listener.
//
// Invitation and listener state. The store is the source of every invitation's state (D6 table:
// open, then exactly one of redeemed, cancelled or expired, all final). This service keeps only the
// set of open invitations, reloaded from the store after every change that may end or add one
// (create, cancel, redeem, revoke, the expiry timer, startup), and derives from it whether the
// pairing listener must exist: it is open while that set is not empty or an invitation is being
// created, and closed otherwise. Opening and closing run one at a time (`listenerWork`), so a
// reload that finds no open invitation cannot close the listener under a creation that already
// chose its port. A creation opens the listener before it commits: an invitation is never handed
// out for a port nobody listens on, and when the port cannot be bound nothing is committed.
export class AuthService {
  readonly devices: DeviceAuthenticator;
  readonly connections = new DeviceConnections();
  private readonly listener: PairingListener;
  private readonly now: () => number;
  private readonly log: (event: Record<string, unknown>) => void;
  private open: OpenInvitation[] = [];
  private creating = 0;
  private listenerWork: Promise<unknown> = Promise.resolve();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private businessPort: number | undefined;
  private disposed = false;

  // `initial` is what loadAuthState read before the server composition was built.
  constructor(
    private readonly options: AuthServiceOptions,
    initial: AuthState,
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.devices = new DeviceAuthenticator(options.store, this.now, (deviceId) =>
      this.log({ event: "device-use-unrecorded", deviceId }),
    );
    this.listener = new PairingListener(options.host, {
      identity: () => ({
        serverId: options.serverId,
        relayInstanceId: options.relayInstanceId,
        buildVersion: options.buildVersion,
      }),
      redeem: (request) => this.redeem(request),
    });
    this.devices.load(initial.devices);
    this.open = initial.openInvitations;
  }

  // The server serves: open the pairing listener again when invitations survived a restart (S12).
  async start(businessPort: number): Promise<void> {
    this.businessPort = businessPort;
    await this.reconcile();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.expiryTimer);
    await this.listenerWork.catch(() => undefined);
    this.listener.dispose();
    await this.devices.settled();
  }

  get pairingPort(): number | undefined {
    return this.listener.port;
  }

  // ---------------------------------------------------------------------------------------------
  // Credentials

  // Pure verification of a presented credential; the transport calls `admitted` once it admits
  // the request.
  authenticate(value: string | undefined): Authentication {
    const credential = parseCredential(value);
    if (!credential) return { kind: "unauthenticated" };
    if (credential.kind === "local-secret")
      return constantTimeEqual(this.options.localSecret, credential.secret)
        ? { kind: "local-owner" }
        : { kind: "unauthenticated" };
    return this.devices.verify(credential.deviceId, credential.secret);
  }

  admitted(authentication: Authentication, entry: EntryKind): void {
    if (authentication.kind === "device") this.devices.touch(authentication, entry);
  }

  // ---------------------------------------------------------------------------------------------
  // RPC operations (rpc/auth.ts)

  private context(): DatabaseWriteContext {
    return {
      serverId: this.options.serverId,
      receipts: this.options.receipts,
      encodeUtf8: this.options.encodeUtf8,
    };
  }

  // auth.invite.create. The invitation string (holding the one-time secret) is the call's output
  // secret: only its hash is stored, the record keeps the references, and the string is returned
  // only by the call that committed (executeSecretWrite). A resend finds the receipt first and
  // answers with the record alone.
  async createInvitation(
    principal: Principal,
    params: { operationId: string; ttlMs?: number },
  ): Promise<
    { operation: OperationRecord; secrets?: { invitation: string } } | { error: DomainError }
  > {
    const method = "auth.invite.create";
    const recorded = await recordedWrite(this.context(), principal.principalId, method, params);
    if (recorded) return recorded;
    const target = SshTargetSchema.safeParse(this.options.sshTarget);
    if (!target.success) return { error: domainError("ENTRY_UNAVAILABLE") };
    this.creating++;
    try {
      const pairingPort = await this.ensureListener();
      if (pairingPort === null) return { error: domainError("ENTRY_UNAVAILABLE") };
      const inviteId = newResourceId();
      const secret = newSecret();
      const at = this.now();
      const expiresAtMs = at + (params.ttlMs ?? AUTH_LIMITS.invitationDefaultTtlMs);
      const invitation = encodeInvitation({
        serverId: this.options.serverId,
        inviteId,
        secret,
        expiresAtMs,
        pairingPort,
        entries: { ssh: { target: target.data } },
      });
      return await executeSecretWrite(
        this.context(),
        principal.principalId,
        method,
        params,
        {
          name: method,
          args: {
            inviteId,
            secretHash: secretHash(secret),
            at,
            expiresAtMs,
            createdByDeviceId: principal.kind === "device" ? principal.deviceId : null,
            pairingPort,
          },
        },
        { invitation },
      );
    } finally {
      this.creating--;
      await this.reconcile();
    }
  }

  async cancelInvitation(
    principal: Principal,
    params: { operationId: string; inviteId: string },
  ): Promise<DatabaseWriteOutcome> {
    try {
      return await executeDatabaseWrite(
        this.context(),
        principal.principalId,
        "auth.invite.cancel",
        params,
        { name: "auth.invite.cancel", args: { inviteId: params.inviteId, at: this.now() } },
      );
    } finally {
      await this.reconcile();
    }
  }

  async listInvitations(): Promise<unknown> {
    try {
      return {
        invitations: await this.options.store.call("auth.invitations.list", { at: this.now() }),
      };
    } catch (error) {
      return { error: storeReadError(error) };
    }
  }

  async listDevices(principal: Principal, params: { includeRevoked?: boolean }): Promise<unknown> {
    let devices: DeviceRecord[];
    try {
      devices = await this.options.store.call("auth.devices.list", {
        includeRevoked: params.includeRevoked === true,
      });
    } catch (error) {
      return { error: storeReadError(error) };
    }
    return {
      // The authenticator knows a use the store may not have recorded yet (devices.ts touch).
      devices: devices.map((device) => {
        const use = this.devices.lastUse(device.deviceId);
        return use && (device.lastUsedAtMs === null || use.lastUsedAtMs > device.lastUsedAtMs)
          ? { ...device, ...use, neverConnected: false }
          : device;
      }),
      currentDeviceId: principal.kind === "device" ? principal.deviceId : null,
    };
  }

  renameDevice(
    principal: Principal,
    params: { operationId: string; deviceId: string; name: string; expectedRevision?: number },
  ): Promise<DatabaseWriteOutcome> {
    return executeDatabaseWrite(
      this.context(),
      principal.principalId,
      "auth.device.rename",
      params,
      {
        name: "auth.device.rename",
        args: {
          deviceId: params.deviceId,
          name: params.name,
          ...(params.expectedRevision === undefined
            ? {}
            : { expectedRevision: params.expectedRevision }),
        },
      },
    );
  }

  // auth.device.revoke (D8). Order: the transaction marks the device revoked and cancels its open
  // invitations; once it committed, the authenticator refuses the device everywhere and its
  // connections are closed in the same synchronous step (connections.ts explains why none can
  // slip between); then the revocation waits, bounded, for them to close. Operations the device
  // had already had accepted go on and keep their records, which any other principal can read;
  // runs it started keep running. A device revoking itself keeps the request carrying the
  // revocation so it gets this answer. The live answer counts the connections still open after the
  // wait (unclosedConnections), so the caller never mistakes it for a confirmed close.
  async revokeDevice(
    principal: Principal,
    params: { operationId: string; deviceId: string },
  ): Promise<DatabaseWriteOutcome> {
    const outcome = await executeDatabaseWrite(
      this.context(),
      principal.principalId,
      "auth.device.revoke",
      params,
      { name: "auth.device.revoke", args: { deviceId: params.deviceId, at: this.now() } },
    );
    if ("error" in outcome || outcome.operation.state !== "succeeded") return outcome;
    this.devices.markRevoked(params.deviceId);
    const unclosed = await this.connections.closeDevice(
      params.deviceId,
      REVOCATION_WAIT_MS,
      principal,
    );
    this.log({ event: "device-revoked", deviceId: params.deviceId, unclosed });
    await this.reconcile();
    if (unclosed === 0) return outcome;
    const { operation } = outcome;
    return {
      operation: { ...operation, result: { ...operation.result, unclosedConnections: unclosed } },
    };
  }

  // auth.device.rotate (D4 phase one): only the calling device's own token. The new token is the
  // output secret; its hash becomes the pending token once committed, and the current token keeps
  // working until the new one is first used. A lost answer leaves the pending token unknown to
  // anyone, and rotating again with the old token replaces it.
  async rotateToken(
    principal: Principal,
    params: { operationId: string },
  ): Promise<{ operation: OperationRecord; secrets?: { token: string } } | { error: DomainError }> {
    if (principal.kind !== "device") return { error: domainError("FORBIDDEN") };
    const method = "auth.device.rotate";
    const recorded = await recordedWrite(this.context(), principal.principalId, method, params);
    if (recorded) return recorded;
    const { token, hash } = issueToken(principal.deviceId);
    const outcome = await executeSecretWrite(
      this.context(),
      principal.principalId,
      method,
      params,
      { name: method, args: { deviceId: principal.deviceId, pendingTokenHash: hash } },
      { token },
    );
    if ("secrets" in outcome && outcome.secrets) this.devices.setPending(principal.deviceId, hash);
    return outcome;
  }

  // ---------------------------------------------------------------------------------------------
  // Pairing (D6)

  // One redemption: the store redeems the invitation and creates the device in one transaction
  // (store/sql/auth.ts auth.redeem). The token is generated here and only its hash is stored; the
  // answer is its only delivery. Every refusal is INVITATION_UNAVAILABLE. A store failure is BUSY:
  // the transaction may or may not have committed, and either way the user's recovery is a new
  // invitation, with any device it left listed never-connected (D6).
  private async redeem(
    request: PairingRedeemRequest,
  ): Promise<PairingRedeemResult | PairingFailure> {
    const businessPort = this.businessPort;
    if (businessPort === undefined || businessPort < 1024)
      return { type: "cove-pairing-error", kind: "BUSY" };
    const deviceId = newResourceId();
    const { token, hash } = issueToken(deviceId);
    let redeemed: { redeemed: boolean };
    try {
      redeemed = await this.options.store.call("auth.redeem", {
        inviteId: request.inviteId,
        secretHash: secretHash(request.secret),
        at: this.now(),
        device: { deviceId, name: request.deviceName, tokenHash: hash },
      });
    } catch {
      await this.reconcile();
      return { type: "cove-pairing-error", kind: "BUSY" };
    }
    if (redeemed.redeemed)
      this.devices.add({
        deviceId,
        tokenHash: hash,
        pendingTokenHash: null,
        revoked: false,
        lastUsedAtMs: null,
      });
    // The listener closes before the answer is written when this was the last open invitation;
    // the answer still goes out on this connection (pairing-listener.ts close).
    await this.reconcile();
    if (!redeemed.redeemed) return { type: "cove-pairing-error", kind: "INVITATION_UNAVAILABLE" };
    this.log({ event: "device-paired", deviceId, entry: "loopback" });
    return {
      type: "cove-pairing-result",
      serverId: this.options.serverId,
      deviceId,
      token,
      businessPort,
    };
  }

  // Serializes listener changes (see the class comment).
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.listenerWork.then(work, work);
    this.listenerWork = next.catch(() => undefined);
    return next;
  }

  // The bound pairing port, opening the listener when needed, or null when it cannot be bound.
  private ensureListener(): Promise<number | null> {
    return this.serialized(async () => {
      const bound = this.listener.port;
      if (bound !== undefined) return bound;
      if (this.disposed) return null;
      // Open invitations advertise the port they were created with; keep it.
      const port = this.options.pairingPort ?? this.open[0]?.pairingPort ?? 0;
      try {
        const opened = await this.listener.open(port);
        if (opened < 1024) {
          this.listener.close();
          return null;
        }
        this.log({ event: "pairing-listener", state: "open", port: opened });
        return opened;
      } catch {
        this.log({ event: "pairing-listener", state: "unavailable", port });
        return null;
      }
    });
  }

  // Reloads the open invitations, writes the expiry of those whose time is up, and opens or closes
  // the listener to match. Called after anything that may have changed the set.
  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    try {
      const at = this.now();
      await this.options.store.call("auth.invitations.expire", { at });
      this.open = await this.options.store.call("auth.invitations.open", { at });
    } catch {
      // A failed store stops the server (entry/main.ts); until then keep the last known set.
    }
    this.scheduleExpiry();
    if (this.open.length > 0 && this.businessPort !== undefined) await this.ensureListener();
    else if (this.open.length === 0)
      await this.serialized(async () => {
        if (this.open.length > 0 || this.creating > 0 || this.listener.port === undefined) return;
        this.listener.close();
        this.log({ event: "pairing-listener", state: "closed" });
      });
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.disposed || this.open.length === 0) return;
    const next = Math.min(...this.open.map((invitation) => invitation.expiresAtMs));
    // setTimeout holds at most 2^31-1 ms; a longer wait is simply rescheduled when it fires.
    const delay = Math.min(Math.max(0, next - this.now()) + 10, 2 ** 31 - 1);
    this.expiryTimer = setTimeout(() => void this.reconcile(), delay);
    this.expiryTimer.unref();
  }
}
