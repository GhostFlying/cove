import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [mode, nonce, receiptDir] = process.argv.slice(2);
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
  process.stdout.write(Buffer.from([0x41, 0x00, 0x80, 0xff, 0xe2, 0x82, 0xac]));
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
  let emitted = 0;
  let stalled = false;
  const timer = setInterval(() => {
    if (emitted >= 192 * 1024 || stalled) return;
    process.stdout.write(Buffer.alloc(8192, 0x42));
    emitted += 8192;
    if (emitted === 64 * 1024) {
      stalled = true;
      writeFileSync(
        `${receiptDir}/stall.json`,
        JSON.stringify({ nonce, pid: process.pid, emitted }),
      );
      setTimeout(() => {
        stalled = false;
      }, 1500);
    }
    if (emitted === 192 * 1024)
      writeFileSync(
        `${receiptDir}/finish.json`,
        JSON.stringify({ nonce, pid: process.pid, emitted }),
      );
  }, 2);
  timer.unref();
  setInterval(() => {}, 1000);
} else if (mode === "hold") {
  process.stdout.write(Buffer.from(`READY:${nonce}\n`));
  setInterval(() => {}, 1000);
} else {
  process.exit(65);
}
