import { execFile } from "node:child_process";

const VERSION_TIMEOUT_MS = 5_000;
export const DIAL_PROTOCOL = 1;
export class TsnetBinaryError extends Error {}

export type BinaryIdentity = { readonly build: string; readonly protocol: number };

const VERSION_LINE = /^cove-tsnet build=([A-Za-z0-9.+_-]{1,128}) protocol=([0-9]{1,6})\n?$/;

// `cove-tsnet version`: the build a daemon started from `path` reports in its hello, which is
// what "the current build" means for the version rules (D14), and its local protocol.
export function binaryIdentity(path: string): Promise<BinaryIdentity> {
  return new Promise((resolve, reject) => {
    execFile(
      path,
      ["version"],
      { timeout: VERSION_TIMEOUT_MS, maxBuffer: 4096, encoding: "utf8" },
      (error, stdout) => {
        const match = VERSION_LINE.exec(stdout);
        if (error || !match) {
          reject(
            new TsnetBinaryError(
              `${path} did not report a cove-tsnet version` +
                (error ? ` (${error.message.split("\n")[0]})` : ""),
            ),
          );
          return;
        }
        resolve({ build: match[1]!, protocol: Number(match[2]) });
      },
    );
  });
}
