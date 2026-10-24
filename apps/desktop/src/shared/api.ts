import type { ServerSessionSnapshot, TerminalSnapshot, TerminalInputNotice } from "@cove/client";
import type { ConnectionRecord, EntryKind } from "@cove/node-client";
import type { RunRef } from "@cove/protocol/identity";
import type { Geometry } from "@cove/protocol/profile";

export interface SavedServer extends ConnectionRecord {
  readonly deviceId: string;
}
export interface PendingOperation {
  readonly serverId: string;
  readonly relayInstanceId: string;
  readonly operationId: string;
  readonly method: string;
  readonly createdAtMs: number;
  readonly status: "pending" | "unknown" | "observed" | "not-sent";
  readonly result?: unknown;
}
export interface DesktopSnapshot {
  readonly localHome: string;
  readonly ready: boolean;
  readonly servers: readonly SavedServer[];
  readonly sessions: Readonly<Record<string, ServerSessionSnapshot>>;
  readonly operations: readonly PendingOperation[];
  readonly error: string | null;
}
export interface ViewDescriptor {
  readonly viewId: string;
  readonly generation: number;
}
export type HostReply =
  { readonly ok: true; readonly value?: unknown } | { readonly ok: false; readonly error: string };
export interface DesktopApi {
  snapshot(): Promise<DesktopSnapshot>;
  onState(callback: (snapshot: DesktopSnapshot) => void): () => void;
  pair(input: {
    alias: string;
    invitation: string;
    via: "loopback" | "ssh" | "tsnet";
    name: string;
  }): Promise<HostReply>;
  pairLocal(input: { alias: string; home: string; name: string }): Promise<HostReply>;
  connect(serverId: string, via: EntryKind): Promise<HostReply>;
  disconnect(serverId: string): Promise<HostReply>;
  forget(serverId: string): Promise<HostReply>;
  call(serverId: string, method: string, params: unknown): Promise<HostReply>;
  queryOperation(serverId: string, operationId: string): Promise<HostReply>;
  acknowledgeOperation(serverId: string, operationId: string): Promise<HostReply>;
  networkStatus(): Promise<HostReply>;
  networkLogin(): Promise<HostReply>;
  openLink(url: string): Promise<HostReply>;
  openView(serverId: string, run: RunRef): Promise<ViewDescriptor>;
  closeView(descriptor: ViewDescriptor): Promise<void>;
  focusView(descriptor: ViewDescriptor, geometry: Geometry): Promise<HostReply>;
  blurView(descriptor: ViewDescriptor): Promise<HostReply>;
  viewMessage(descriptor: ViewDescriptor, message: string): void;
  onViewMessage(callback: (descriptor: ViewDescriptor, message: string) => void): () => void;
  onTerminalState(
    callback: (descriptor: ViewDescriptor, state: TerminalSnapshot) => void,
  ): () => void;
  onTerminalInput(
    callback: (descriptor: ViewDescriptor, notice: TerminalInputNotice) => void,
  ): () => void;
}

export const IPC = {
  command: "cove:command",
  state: "cove:state",
  view: "cove:view",
  terminal: "cove:terminal",
  input: "cove:input",
} as const;
