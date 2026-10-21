import { openSshTunnel } from "../../dist/remote/ssh-tunnel.js";

// A command that opens the SSH entry's tunnel (the compiled openSshTunnel):
// `node tunnel-holder.mjs TARGET REMOTE_PORT [close]`. It prints the tunnel's local port once it
// is ready, then holds the tunnel until it is killed (s6-ssh-entry.test.mjs kills it to check that
// no ssh outlives a killed command). With `close` it closes the tunnel at once instead and, when
// the process exits on its own, prints the milliseconds from the end of close() to its exit: a
// timer left behind by close() would keep a short command alive.
const [target, remotePort, mode] = process.argv.slice(2);
const tunnel = await openSshTunnel({ target, remotePort: Number(remotePort) });
process.stdout.write(`${tunnel.localPort}\n`);
if (mode === "close") {
  await tunnel.close();
  const closed = Date.now();
  process.on("exit", () => process.stdout.write(`exit ${Date.now() - closed}\n`));
} else setInterval(() => undefined, 60_000);
