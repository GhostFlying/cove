import { isAbsolute } from "node:path";
import { TsnetBinaryError } from "@cove/node-client";
import {
  installedClosureRoot,
  tsnetBinaryPath as buildTsnetBinaryPath,
  workspaceRootOf,
} from "@cove/server/build-id";

// Which `cove-tsnet` this CLI starts (m2 D9, D14), and which build it is.
//
// The lookup is the one the server uses (@cove/server/build-id tsnetBinaryPath, m2 T3): the
// executable of this CLI's own build, `bin/cove-tsnet` of the installed closure it runs from
// (found by the closure's stamp, `cove-install.json`, at the closure root), else the output of
// `pnpm tsnet:build` in the development workspace it was built in. Null when the build has none:
// the tsnet entry is then unavailable and nothing else is affected.
//
// Development and test overrides. COVE_TSNET_BINARY names another executable (the CLI scenarios
// use it for a fake dial daemon and for builds of other versions); COVE_TSNET_CONTROL_URL points a
// daemon the CLI starts at a test control plane. They take effect only when this CLI runs from a
// development workspace, which is where tests run it. An installed closure (or a layout that is
// neither) rejects them with an error before a daemon is started or anything is sent, rather than
// ignoring them silently or letting an inherited variable swap the executable or the control plane
// of a real installation; it always uses its own `bin/cove-tsnet`. COVE_TSNET_BINARY is never a
// fallback: when it is set it is the only candidate, and it must be an absolute path.

const OVERRIDES = ["COVE_TSNET_BINARY", "COVE_TSNET_CONTROL_URL"] as const;

// Shared dial protocol/version parser; executable lookup and override policy stay with the CLI.
export { binaryIdentity, DIAL_PROTOCOL, TsnetBinaryError } from "@cove/node-client";
export type { BinaryIdentity } from "@cove/node-client";

// Throws TsnetBinaryError when a development or test override is set and this CLI does not run
// from a development workspace. The `remote tsnet` commands call it before they read input; every
// path that starts a daemon or opens a stream passes through it.
export function checkTsnetOverrides(): void {
  if (workspaceRootOf() !== null) return;
  const set = OVERRIDES.filter((name) => process.env[name]);
  if (set.length === 0) return;
  const closure = installedClosureRoot();
  throw new TsnetBinaryError(
    `${set.join(" and ")} ${set.length > 1 ? "are" : "is a"} development and test ` +
      `override${set.length > 1 ? "s" : ""}, and this Cove is ` +
      (closure
        ? `an installed closure (${closure}), which always uses its own bin/cove-tsnet`
        : "not a development workspace") +
      `; unset ${set.length > 1 ? "them" : "it"}. No dial daemon was started and nothing was sent`,
  );
}

// The cove-tsnet executable this CLI starts, or null when this build has none.
export function tsnetBinaryPath(): string | null {
  checkTsnetOverrides();
  const override = process.env.COVE_TSNET_BINARY;
  if (override) {
    if (!isAbsolute(override))
      throw new TsnetBinaryError("COVE_TSNET_BINARY must be an absolute path");
    return override;
  }
  return buildTsnetBinaryPath();
}

// The control plane a daemon the CLI starts uses: Tailscale's (undefined), or a test control
// plane from a development workspace.
export function tsnetControlUrl(): string | undefined {
  checkTsnetOverrides();
  return process.env.COVE_TSNET_CONTROL_URL || undefined;
}
