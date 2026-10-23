export { preAuthIdentity, verifiedIdentity, RemoteError } from "@cove/node-client";
export type { OpenedEntry, Via } from "@cove/node-client";
import { nodeAdapters } from "./adapters.js";
export const { openEntry, openPairingEntry } = nodeAdapters;
