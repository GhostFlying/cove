import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Where this build's `cove-tsnet` is (m2 D9, D14), and which build it is.
//
// Lookup order, the same as the server's (m2 T3, network/listeners.ts tsnetBinaryPath): walking up
// from this module, the nearer of an installed closure (its stamp `cove-install.json`; the
// executable is `<closure>/bin/cove-tsnet`) and a development workspace (`pnpm-workspace.yaml`; the
// output of `pnpm tsnet:build`, `native/tailscale/dist/<platform>-<arch>/cove-tsnet`). Null when
// the layout has none: the tsnet entry is then unavailable and nothing else is affected.
//
// COVE_TSNET_BINARY names another executable instead. It is a development and test override only
// (the CLI scenarios use it for a fake dial daemon and for builds of other versions), never a
// fallback: when it is set it is the only candidate, and it must be an absolute path.

const INSTALL_STAMP = "cove-install.json";
const VERSION_TIMEOUT_MS = 5_000;

// The local dial-socket protocol this CLI speaks (native/tailscale/PROTOCOL.md "Versioning").
export const DIAL_PROTOCOL = 1;

function layoutBinary(from: string): string | null {
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(join(current, INSTALL_STAMP))) return join(current, "bin", "cove-tsnet");
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      const arch = process.arch === "x64" ? "amd64" : process.arch;
      return join(
        current,
        "native",
        "tailscale",
        "dist",
        `${process.platform}-${arch}`,
        "cove-tsnet",
      );
    }
    if (dirname(current) === current) return null;
  }
}

export class TsnetBinaryError extends Error {}

// The cove-tsnet executable this CLI starts, or null when this build has none.
export function tsnetBinaryPath(): string | null {
  const override = process.env.COVE_TSNET_BINARY;
  if (override) {
    if (!isAbsolute(override))
      throw new TsnetBinaryError("COVE_TSNET_BINARY must be an absolute path");
    return override;
  }
  const candidate = layoutBinary(dirname(fileURLToPath(import.meta.url)));
  return candidate !== null && existsSync(candidate) ? candidate : null;
}

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
