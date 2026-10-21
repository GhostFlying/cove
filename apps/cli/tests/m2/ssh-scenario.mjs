import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createRecordingView, waitFor } from "../recording-view.mjs";
import { openRemoteSession } from "../../dist/session.js";
import { createAuthFixture } from "./auth-fixtures.mjs";
import { sshClients, sshdUnavailable, startSshd } from "./sshd-fixture.mjs";

// Shared setup of the SSH entry scenarios (m2 S5–S7): the auth fixture plus a task-owned sshd
// (sshd-fixture.mjs) whose target the server advertises, with the fixture's ssh first on the PATH
// of every CLI the fixture runs and of this test process (the tunnels of in-process sessions).
//
// Where an unprivileged sshd cannot run, createSshFixture fails with the reason: the test gate
// counts a skipped required test as a failure, so the SSH cases never pass by not running.

export async function createSshFixture() {
  const unavailable = await sshdUnavailable();
  if (unavailable)
    throw new Error(`the m2 SSH scenarios need an unprivileged sshd: ${unavailable}`);
  const fixture = await createAuthFixture();
  let sshd;
  const savedPath = process.env.PATH;
  const sessions = [];
  try {
    sshd = await startSshd(join(fixture.root, "ssh"));
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
  fixture.env.PATH = sshd.env(fixture.env).PATH;
  process.env.PATH = sshd.env(process.env).PATH;
  const pristine = {
    knownHosts: await readFile(sshd.knownHosts),
    config: await readFile(sshd.clientConfig),
  };
  return {
    fixture,
    sshd,
    // A session of this process with the paired server `alias` of `home`, over `via`: the
    // compiled openRemoteSession, as a command with --server/--via opens it.
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
    // Whether the CLI left the fixture's known_hosts and ssh config as they were (S6). A scenario
    // that pins another host key restores it first.
    async untouched() {
      return (
        (await readFile(sshd.knownHosts)).equals(pristine.knownHosts) &&
        (await readFile(sshd.clientConfig)).equals(pristine.config)
      );
    },
    async cleanup() {
      try {
        for (const session of sessions.splice(0)) {
          session.client.dispose();
          await session.close?.();
        }
        // No ssh client of this scenario outlives its command or session.
        await waitFor(
          "every ssh client of the scenario to exit",
          async () => (await sshClients(sshd.clientConfig)).length === 0,
          10_000,
        );
      } finally {
        process.env.PATH = savedPath;
        await sshd.stop();
        await fixture.cleanup();
      }
    },
  };
}

// A terminal of `client` on `run`, attached, with input and focus taken: `type(text)` sends
// keyboard input, `text()` is everything the view received.
export async function attachedTerminal(client, run, viewId) {
  const recording = createRecordingView();
  const opened = client.openTerminal({
    run,
    viewId,
    view: recording.view,
    initialAppearance: DEFAULT_APPEARANCE,
  });
  if (!opened.ok) throw new Error(`openTerminal failed: ${JSON.stringify(opened)}`);
  const controller = opened.value;
  const attached = await controller.attach();
  if (!attached.ok) throw new Error(`attach failed: ${JSON.stringify(attached)}`);
  controller.setInputTarget(true, true);
  for (let attempt = 0; ; attempt++) {
    const focus = await controller.requestFocus();
    if (focus.ok) break;
    const busy = focus.error.kind === "BUSY" && focus.error.acceptance === "not-accepted";
    if (!busy || attempt === 20) throw new Error(`focus failed: ${JSON.stringify(focus)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  const encoder = new TextEncoder();
  return {
    controller,
    text: recording.text,
    async type(text) {
      const sent = await controller.sendInput({ source: "keyboard", bytes: encoder.encode(text) });
      if (!sent.ok || sent.value.unknownBytes !== 0 || sent.value.notSentBytes !== 0)
        throw new Error(`input failed: ${JSON.stringify(sent)}`);
    },
    async sees(marker, timeoutMs = 15_000) {
      await waitFor(
        `terminal output ${marker}`,
        () => recording.text().includes(marker),
        timeoutMs,
      );
    },
  };
}

// A shell loop for a run: prints `ready`, then answers each line with `echo:<line>`.
export const ECHO_LOOP =
  "printf 'loop-ready\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done";
