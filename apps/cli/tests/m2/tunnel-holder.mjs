import { openSshTunnel } from "../../dist/remote/ssh-tunnel.js";

// A command that opens the SSH entry's tunnel (the compiled openSshTunnel) and holds it until it is
// killed: `node tunnel-holder.mjs TARGET REMOTE_PORT`. It prints the tunnel's local port once it
// is ready. s6-ssh-entry.test.mjs kills it to check that no ssh outlives a killed command.
const [target, remotePort] = process.argv.slice(2);
const tunnel = await openSshTunnel({ target, remotePort: Number(remotePort) });
process.stdout.write(`${tunnel.localPort}\n`);
setInterval(() => undefined, 60_000);
