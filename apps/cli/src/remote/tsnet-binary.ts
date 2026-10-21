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
// Development and test overrides. COVE_TSNET_BINARY names another executable (the CLI scenarios
// use it for a fake dial daemon and for builds of other versions); COVE_TSNET_CONTROL_URL points a
// daemon the CLI starts at a test control plane. They take effect only when this CLI runs from a
// development workspace, which is where tests run it. An installed closure (or a layout that is
// neither) rejects them with an error before anything is read or started, rather than ignoring
// them silently or letting an inherited variable swap the executable or the control plane of a
// real installation; it always uses its own `bin/cove-tsnet`. COVE_TSNET_BINARY is never a
// fallback: when it is set it is the only candidate, and it must be an absolute path.
//
// The installed closure is recognized by its stamp. T3 (#162) defines the closure; until its
// stamp and layout are on main, any directory carrying `cove-install.json` above this module is
// taken as one.

const INSTALL_STAMP = "cove-install.json";
const VERSION_TIMEOUT_MS = 5_000;
const OVERRIDES = ["COVE_TSNET_BINARY", "COVE_TSNET_CONTROL_URL"] as const;

// The local dial-socket protocol this CLI speaks (native/tailscale/PROTOCOL.md "Versioning").
export const DIAL_PROTOCOL = 1;

export type TsnetLayout =
  | { readonly kind: "installed" | "workspace"; readonly root: string; readonly binary: string }
  | { readonly kind: "none" };

// The layout this module runs from: walking up from `from`, the nearer of an installed closure
// and a development workspace.
export function tsnetLayout(from = dirname(fileURLToPath(import.meta.url))): TsnetLayout {
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(join(current, INSTALL_STAMP)))
      return { kind: "installed", root: current, binary: join(current, "bin", "cove-tsnet") };
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      const arch = process.arch === "x64" ? "amd64" : process.arch;
      return {
        kind: "workspace",
        root: current,
        binary: join(
          current,
          "native",
          "tailscale",
          "dist",
          `${process.platform}-${arch}`,
          "cove-tsnet",
        ),
      };
    }
    if (dirname(current) === current) return { kind: "none" };
  }
}

export class TsnetBinaryError extends Error {}

// Throws TsnetBinaryError when a development or test override is set and this CLI does not run
// from a development workspace. Every tsnet command calls it before it reads input or starts a
// process.
export function checkTsnetOverrides(layout: TsnetLayout = tsnetLayout()): void {
  if (layout.kind === "workspace") return;
  const set = OVERRIDES.filter((name) => process.env[name]);
  if (set.length === 0) return;
  throw new TsnetBinaryError(
    `${set.join(" and ")} ${set.length > 1 ? "are" : "is a"} development and test ` +
      `override${set.length > 1 ? "s" : ""}, and this Cove is ` +
      (layout.kind === "installed"
        ? `an installed closure (${layout.root}), which always uses its own bin/cove-tsnet`
        : "not a development workspace") +
      `; unset ${set.length > 1 ? "them" : "it"}. Nothing was read, started or sent`,
  );
}

// The cove-tsnet executable this CLI starts, or null when this build has none.
export function tsnetBinaryPath(): string | null {
  const layout = tsnetLayout();
  checkTsnetOverrides(layout);
  const override = process.env.COVE_TSNET_BINARY;
  if (override) {
    if (!isAbsolute(override))
      throw new TsnetBinaryError("COVE_TSNET_BINARY must be an absolute path");
    return override;
  }
  if (layout.kind === "none") return null;
  return existsSync(layout.binary) ? layout.binary : null;
}

// The control plane a daemon the CLI starts uses: Tailscale's (undefined), or a test control
// plane from a development workspace.
export function tsnetControlUrl(): string | undefined {
  checkTsnetOverrides();
  return process.env.COVE_TSNET_CONTROL_URL || undefined;
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
