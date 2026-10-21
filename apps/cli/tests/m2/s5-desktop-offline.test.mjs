import { rm, stat } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { waitFor } from "../recording-view.mjs";
import { attachedTerminal, createSshFixture, unavailable } from "./ssh-scenario.mjs";

// m2 S5 (operation without the Desktop), against the compiled CLI and server and a task-owned sshd
// (sshd-fixture.mjs). A client standing in for the Desktop pairs, issues an invitation for another
// device, and then is gone: none of its commands runs and its client directory is deleted. Another
// device pairs over the SSH entry with that invitation, creates a task and a tab over SSH, and
// drives the tab's terminal (input in, output out). With no client connected the run keeps
// producing output, and reconnecting reaches the same run.

let ssh;

beforeEach(async () => {
  if (!unavailable) ssh = await createSshFixture();
});

afterEach(async () => {
  await ssh?.cleanup();
  ssh = undefined;
});

// A run that prints a numbered tick every 100 ms in the background and answers each input line.
const TICKER = [
  "( i=0; while :; do i=$((i+1)); printf 'tick-%d\\n' \"$i\"; sleep 0.1; done ) &",
  "printf 'loop-ready\\n'",
  "while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",
].join("\n");

// The highest tick a terminal has shown.
function lastTick(text) {
  return Math.max(0, ...[...text.matchAll(/tick-(\d+)/g)].map((match) => Number(match[1])));
}

test.skipIf(unavailable)(
  "with the Desktop gone, a device paired over SSH creates a task and tab and drives its terminal; the run outlives every client",
  async () => {
    const { fixture, sshd } = ssh;
    const serverHome = fixture.home("server");
    const server = await fixture.startAuthServer(serverHome, [], { sshTarget: sshd.target });

    // The Desktop: paired, it issues the invitation for the laptop, then disappears.
    const desktop = fixture.home("desktop");
    await fixture.pairOk(desktop, "box", (await fixture.invite(serverHome)).invitation);
    const issued = await fixture.coveJson(["--server", "box", "auth", "invite", "create"], {
      home: desktop,
    });
    await rm(desktop, { recursive: true, force: true });
    await expect(stat(desktop)).rejects.toThrow("ENOENT");

    // The laptop pairs over SSH and works only through it.
    const laptop = fixture.home("laptop");
    const paired = await fixture.pairOk(laptop, "box", issued.invitation, ["--via", "ssh"]);
    expect(paired).toMatchObject({ defaultEntry: "ssh" });
    const remote = (args) => fixture.coveJson(["--server", "box", ...args], { home: laptop });
    const { task } = await remote(["task", "create", "Remote work"]);
    const created = await remote(
      ["tab", "create", task.taskId, "--name", "work", "--"].concat(["/bin/sh", "-c", TICKER]),
    );
    const tabId = created.operation.result.resource.id;
    const run = created.operation.run;
    expect(created.tab.latestRun).toEqual(run);

    // Terminal input and output over the SSH entry.
    const first = await ssh.session(laptop, "box", undefined);
    const terminal = await attachedTerminal(first.client, run, "laptop-1");
    await terminal.sees("loop-ready");
    await terminal.type("hello\r");
    await terminal.sees("echo:hello");
    const seenBefore = lastTick(terminal.text());
    await ssh.closeSession(first);

    // No client is connected: the Desktop is gone and the laptop's session and commands ended.
    // The run keeps producing output meanwhile.
    await new Promise((done) => setTimeout(done, 1_500));
    expect(await fixture.serverRuns(server)).toBe(true);

    // Reconnecting reaches the same run, which kept running: its baseline holds ticks printed
    // while nobody was connected, and it still answers input.
    const tab = await remote(["tab", "get", tabId]);
    expect(tab.latestRun).toMatchObject({ run, lifecycle: "running" });
    const second = await ssh.session(laptop, "box", undefined);
    const again = await attachedTerminal(second.client, run, "laptop-2");
    await again.sees("echo:hello");
    await waitFor(
      "ticks printed while disconnected",
      () => lastTick(again.text()) > seenBefore + 5,
    );
    await again.type("again\r");
    await again.sees("echo:again");
    expect((await remote(["tab", "runs", tabId])).runs).toHaveLength(1);
    expect(await ssh.untouched()).toBe(true);
  },
  120_000,
);
