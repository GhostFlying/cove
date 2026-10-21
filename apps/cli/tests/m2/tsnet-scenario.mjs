import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { openRemoteSession } from "../../dist/session.js";
import { createAuthFixture, portOf } from "./auth-fixtures.mjs";
import {
  clientEnv,
  endDaemon,
  removeRoot,
  shortRoot,
  startServeNode,
  withTsnetEntry,
} from "./tsnet-fixtures.mjs";

// Shared setup of the scenarios that reach a Cove server over tsnet (m2 S7 tsnet part, S8): the
// auth fixture (compiled CLI and server, temporary root, secret scan), a server with a fixed
// pairing port, a serve node on the test tailnet standing in for the server's own tailnet wiring
// (T5b) that forwards the business and pairing ports to the server's loopback ports of the same
// numbers, and a client home whose CLI commands, and this process's in-process sessions, use the
// test tailnet and the current cove-tsnet build.
//
// The test tailnet's auth key is remembered by the secret scan, so cleanup fails if it is in any
// file under the root (the client's tsnet state and daemon log included) or in server output.

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

export async function createTsnetScenario(builds, tailnet) {
  const fixture = await createAuthFixture();
  const tsnet = clientEnv(tailnet, builds.current);
  Object.assign(fixture.env, tsnet);
  fixture.remember(tailnet.authKey);
  // In-process sessions (openRemoteSession) start the daemon from this process's environment.
  const saved = Object.fromEntries(Object.keys(tsnet).map((name) => [name, process.env[name]]));
  Object.assign(process.env, tsnet);
  const sessions = [];
  const homes = new Set();
  const nodes = [];
  const nodeRoots = [];

  const scenario = {
    fixture,
    async startServer(home = fixture.home("server")) {
      const pairingPort = await freePort();
      const server = await fixture.startAuthServer(home, ["--pairing-port", String(pairingPort)]);
      return { home, server, businessPort: portOf(server), pairingPort };
    },
    // A serve node on the tailnet, logged in, forwarding the server's two ports.
    async serveNode(target, { hostname = "cove-srv" } = {}) {
      const root = await shortRoot("ct4s");
      nodeRoots.push(root);
      await mkdir(root, { recursive: true });
      const node = await startServeNode(builds, tailnet, root, { hostname });
      nodes.push(node);
      await node.login();
      await node.serve(
        new Map([
          [target.businessPort, () => target.businessPort],
          [target.pairingPort, () => target.pairingPort],
        ]),
      );
      return node;
    },
    // A client home; its daemon is ended at cleanup.
    client(name = "c") {
      const home = fixture.home(name);
      homes.add(home);
      return home;
    },
    login(home) {
      homes.add(home);
      return fixture.coveInput(["remote", "tsnet", "login"], `${tailnet.authKey}\n`, { home });
    },
    // Pairs `home` as `alias` with an invitation of `serverHome` that names `node`; `via` as for
    // `cove remote add`.
    async pair(home, alias, serverHome, node, via) {
      const { invitation } = await fixture.invite(serverHome);
      const advertised = withTsnetEntry(invitation, node.self);
      fixture.remember(advertised);
      return fixture.pairOk(home, alias, advertised, via ? ["--via", via] : []);
    },
    async session(home, alias, via) {
      const session = await openRemoteSession(home, alias, via);
      sessions.push(session);
      return session;
    },
    async closeSession(session) {
      sessions.splice(sessions.indexOf(session), 1);
      session.client.dispose();
      await session.close?.();
    },
    async cleanup() {
      try {
        for (const session of sessions.splice(0)) {
          session.client.dispose();
          await session.close?.();
        }
        for (const home of homes) await endDaemon(home);
        for (const node of nodes) await node.stop();
        for (const root of nodeRoots) await removeRoot(root);
      } finally {
        for (const [name, value] of Object.entries(saved))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        await fixture.cleanup();
      }
    },
  };
  return scenario;
}

// The tsnet entry's dial socket path must fit in 103 bytes; the auth fixture's root is a system
// temporary directory, so client homes use short names.
export const tsnetHomeOf = (home) => join(home, "tsnet-client");
