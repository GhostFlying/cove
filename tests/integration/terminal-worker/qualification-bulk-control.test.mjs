import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, psIdentity, receipt, until } from "./pipe-harness.mjs";

test("bulk child emits one 1 KiB chunk per bounded fixture acknowledgement", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cove-qual-bulk-control-"));
  const nonce = `bulk-control-${process.pid}-${Date.now()}`;
  const socketPath = join(temp, "ack.sock");
  const evidenceRoot = process.env.COVE_QUALIFICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot ? join(evidenceRoot, nonce) : undefined;
  if (evidencePath) mkdirSync(evidencePath, { recursive: true });
  let control;
  let input = "";
  let hello;
  let child;
  let initialIdentity;
  let primary;
  const cleanupErrors = [];
  const stderr = [];
  const controlErrors = [];
  const hash = createHash("sha256");
  let bytes = 0;
  let pendingBytes = 0;
  let ackSeq = 0;
  const server = createServer((socket) => {
    if (control) return socket.destroy();
    control = socket;
    socket.on("error", (error) => controlErrors.push(error.message));
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (input.includes("\n")) {
        const index = input.indexOf("\n");
        let frame;
        try {
          frame = JSON.parse(input.slice(0, index));
        } catch {
          controlErrors.push("invalid-child-control-frame");
          return;
        }
        input = input.slice(index + 1);
        if (frame.type !== "hello" || frame.nonce !== nonce || frame.pid !== child.pid) {
          controlErrors.push("controlled-peer-identity-mismatch");
          return;
        }
        hello = frame;
        socket.write(`${JSON.stringify({ type: "start", nonce })}\n`);
      }
    });
  });
  server.on("error", (error) => controlErrors.push(error.message));
  const preserve = (stage) => {
    if (!evidencePath) return;
    for (const name of ["start.json", "stall.json", "finish.json", "emission-failure.json"])
      if (existsSync(join(temp, name))) copyFileSync(join(temp, name), join(evidencePath, name));
    writeFileSync(
      join(evidencePath, `${stage}.json`),
      JSON.stringify(
        {
          nonce,
          pid: child?.pid ?? null,
          initialIdentity,
          currentIdentity: child?.pid ? psIdentity(child.pid) : null,
          hello,
          bytes,
          pendingBytes,
          ackSeq,
          controlErrors,
          stderr: Buffer.concat(stderr).toString("utf8"),
          failure: primary && { name: primary.name, message: primary.message },
        },
        null,
        2,
      ) + "\n",
    );
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    child = spawn(process.execPath, [fixture, "bulk", nonce, temp, socketPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    initialIdentity = psIdentity(child.pid);
    expect(initialIdentity).toContain(nonce);
    child.stdout.on("data", (chunk) => {
      if (!Buffer.from(chunk).every((byte) => byte === 0x42)) {
        controlErrors.push("unexpected-output-byte");
        return;
      }
      bytes += chunk.length;
      hash.update(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > 1024) {
        controlErrors.push("unacknowledged-chunk-overflow");
        return;
      }
      if (pendingBytes === 1024) {
        control.write(`${JSON.stringify({ type: "ack", nonce, seq: ackSeq })}\n`);
        ackSeq++;
        pendingBytes = 0;
      }
    });
    const finish = await receipt(join(temp, "finish.json"), "controlled bulk finish");
    expect(finish).toMatchObject({
      nonce,
      pid: child.pid,
      scheduled: 768 * 1024,
      emitted: 768 * 1024,
      acknowledged: 768,
      chunks: 768,
      callbackError: null,
    });
    expect(controlErrors).toEqual([]);
    expect(await receipt(join(temp, "stall.json"))).toMatchObject({
      scheduled: 64 * 1024,
      acknowledged: 64,
    });
    expect(ackSeq).toBe(768);
    expect(pendingBytes).toBe(0);
    expect(bytes).toBe(768 * 1024);
    expect(hash.digest("hex")).toBe(finish.sha256);
    preserve("before-cleanup");
  } catch (error) {
    primary = error;
  } finally {
    try {
      preserve("before-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const current = child?.pid ? psIdentity(child.pid) : null;
      if (current && current !== initialIdentity)
        cleanupErrors.push(Error(`controlled child identity drift: ${current}`));
      else if (current) {
        child.kill("SIGTERM");
        await until(() => !psIdentity(child.pid), 5000, "controlled child exit");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      control?.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      preserve("after-cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(temp, { recursive: true, force: true });
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      "controlled bulk cleanup failed",
    );
  if (primary) throw primary;
});
