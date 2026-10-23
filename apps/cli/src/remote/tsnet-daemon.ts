export {
  Channel,
  ChannelBroken,
  DaemonUnavailable,
  DialError,
  MAX_FRAME_BYTES,
  describeStreams,
  printable,
  socketPath,
  tsnetHome,
} from "@cove/node-client";
export type { Daemon, Hello, OpenOptions, StreamInfo } from "@cove/node-client";
import { nodeAdapters } from "./adapters.js";
export const { currentBinary, openDaemon, probeDaemon } = nodeAdapters;
