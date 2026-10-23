import { openSshTunnel as openSharedSshTunnel, type SshTunnelOptions } from "@cove/node-client";
export { resolvedPins, sshArguments, OPTIONAL_PINS, SUPERVISOR } from "@cove/node-client";
export type { SshTunnel, SshTunnelOptions } from "@cove/node-client";
export function openSshTunnel(options: SshTunnelOptions) {
  return openSharedSshTunnel({
    ...options,
    onWarning:
      options.onWarning ??
      ((message) => {
        process.stderr.write(`cove-ssh: ${message}\n`);
      }),
  });
}
