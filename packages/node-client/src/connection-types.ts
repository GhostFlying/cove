// Connection locations are independent of how the host registers a device or stores its token.
// A CLI file record and a Desktop Keychain record can both provide this non-secret metadata.
export const ENTRY_KINDS = ["loopback", "ssh", "tsnet"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export type LoopbackEntry = { readonly port: number };
export type SshEntry = { readonly target: string; readonly port: number };
export type TsnetEntry = { readonly nodeId: string; readonly name: string; readonly port: number };
export type ServerEntries = {
  readonly loopback?: LoopbackEntry;
  readonly ssh?: SshEntry;
  readonly tsnet?: TsnetEntry;
};
export interface ConnectionRecord {
  readonly alias: string;
  readonly serverId: string;
  readonly defaultEntry: EntryKind;
  readonly entries: ServerEntries;
}
