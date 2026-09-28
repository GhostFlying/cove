import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";

const [mode, nonce, receiptDir, ackPath] = process.argv.slice(2);
if (!mode || !nonce || !receiptDir) process.exit(64);
process.stdin.setRawMode?.(true);
process.stdin.resume();
let windowSize = null;
try {
  windowSize = execFileSync("/bin/stty", ["size"], {
    stdio: ["inherit", "pipe", "ignore"],
    encoding: "utf8",
  }).trim();
} catch {
  /* The parent also checks the resize result. */
}
writeFileSync(
  `${receiptDir}/start.json`,
  JSON.stringify({ mode, nonce, pid: process.pid, ppid: process.ppid, windowSize }),
);
process.on("SIGHUP", () => process.exit(0));

if (mode === "interactive") {
  const initial = Buffer.from([0x41, 0x00, 0x80, 0xff, 0xe2, 0x82, 0xac]);
  process.stdout.write(initial, (error) => {
    writeFileSync(
      `${receiptDir}/initial-emission.json`,
      JSON.stringify({
        nonce,
        pid: process.pid,
        ok: !error,
        ...(error
          ? { errorCode: error.code ?? "unknown" }
          : {
              length: initial.length,
              hex: initial.toString("hex"),
              sha256: createHash("sha256").update(initial).digest("hex"),
            }),
      }),
    );
  });
  process.stdout.write(Buffer.from(`READY:${nonce}\n\u001b[5n`));
  const parts = [];
  process.stdin.on("data", (chunk) => {
    parts.push(Buffer.from(chunk));
    const bytes = Buffer.concat(parts);
    const reply = bytes.indexOf(Buffer.from("\u001b[0n"));
    const input = bytes.indexOf(Buffer.from([0x00, 0x80, 0xff, 0xe2, 0x82, 0xac, 0x51]));
    if (reply < 0 || input < 0) return;
    let windowSizeAfter = null;
    try {
      windowSizeAfter = execFileSync("/bin/stty", ["size"], {
        stdio: ["inherit", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
    } catch {
      /* The parent also checks the resize result. */
    }
    writeFileSync(
      `${receiptDir}/finish.json`,
      JSON.stringify({
        nonce,
        pid: process.pid,
        receivedHex: bytes.toString("hex"),
        reply,
        input,
        windowSizeAfter,
      }),
    );
    process.stdout.write(Buffer.from(`DONE:${nonce}\n`));
    process.exit(23);
  });
} else if (mode === "bulk") {
  if (!ackPath) process.exit(64);
  const total = 768 * 1024;
  const chunkBytes = 1024;
  const digest = createHash("sha256");
  let scheduled = 0;
  let emitted = 0;
  let acknowledged = 0;
  let callbackError = null;
  let activeSeq = -1;
  let callbackDone = false;
  let ackDone = false;
  let stallRecorded = false;
  let started = false;
  let input = "";
  const control = createConnection(ackPath);
  const fail = (reason) => {
    callbackError = reason;
    writeFileSync(
      `${receiptDir}/emission-failure.json`,
      JSON.stringify({ nonce, pid: process.pid, scheduled, emitted, acknowledged, callbackError }),
    );
    control.destroy();
  };
  const next = () => {
    if (callbackError || scheduled >= total) return;
    if (scheduled === 64 * 1024 && !stallRecorded) {
      stallRecorded = true;
      writeFileSync(
        `${receiptDir}/stall.json`,
        JSON.stringify({ nonce, pid: process.pid, scheduled, acknowledged }),
      );
      setTimeout(next, 1500);
      return;
    }
    const bytes = Buffer.alloc(chunkBytes, 0x42);
    activeSeq++;
    callbackDone = false;
    ackDone = false;
    scheduled += bytes.length;
    process.stdout.write(bytes, (error) => {
      if (error) {
        fail(error.code ?? "unknown");
        return;
      }
      digest.update(bytes);
      emitted += bytes.length;
      callbackDone = true;
      advance();
    });
  };
  const advance = () => {
    if (!callbackDone || !ackDone || callbackError) return;
    if (acknowledged === total / chunkBytes) {
      writeFileSync(
        `${receiptDir}/finish.json`,
        JSON.stringify({
          nonce,
          pid: process.pid,
          scheduled,
          emitted,
          acknowledged,
          chunks: total / chunkBytes,
          callbackError,
          sha256: digest.digest("hex"),
        }),
      );
      return;
    }
    next();
  };
  control.on("connect", () => {
    control.write(`${JSON.stringify({ type: "hello", nonce, pid: process.pid })}\n`);
  });
  control.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (input.length > 4096) return fail("control-frame-overflow");
    while (input.includes("\n")) {
      const index = input.indexOf("\n");
      let frame;
      try {
        frame = JSON.parse(input.slice(0, index));
      } catch {
        return fail("invalid-control-frame");
      }
      input = input.slice(index + 1);
      if (frame.nonce !== nonce) return fail("control-nonce-mismatch");
      if (frame.type === "start" && !started) {
        started = true;
        next();
      } else if (frame.type === "ack" && started && frame.seq === activeSeq && !ackDone) {
        ackDone = true;
        acknowledged++;
        advance();
      } else {
        return fail("control-sequence-mismatch");
      }
    }
  });
  control.on("error", (error) => fail(error.code ?? "control-error"));
  setInterval(() => {}, 1000);
} else if (mode === "hold") {
  process.stdout.write(Buffer.from(`READY:${nonce}\n`));
  setInterval(() => {}, 1000);
} else {
  process.exit(65);
}
