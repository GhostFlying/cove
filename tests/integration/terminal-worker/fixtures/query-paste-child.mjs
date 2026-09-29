import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [nonce, receiptDir] = process.argv.slice(2);
if (!nonce || !receiptDir) process.exit(64);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.on("SIGHUP", () => process.exit(0));
const expected = Buffer.from("\u001b[0n");
const received = [];
let phase = "automatic";
writeFileSync(
  join(receiptDir, "start.json"),
  JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid }),
);
process.stdout.write(`READY:${nonce}\n\u001b[5n`);
process.stdin.on("data", (part) => {
  received.push(Buffer.from(part));
  const bytes = Buffer.concat(received);
  if (bytes.length < expected.length) return;
  if (phase === "automatic") {
    if (!bytes.subarray(0, expected.length).equals(expected)) process.exit(65);
    phase = "user";
    writeFileSync(
      join(receiptDir, "automatic.json"),
      JSON.stringify({
        nonce,
        pid: process.pid,
        length: expected.length,
        hex: expected.toString("hex"),
      }),
    );
  }
  if (bytes.length < expected.length * 2) return;
  const user = bytes.subarray(expected.length);
  writeFileSync(
    join(receiptDir, "finish.json"),
    JSON.stringify({
      nonce,
      pid: process.pid,
      total: bytes.length,
      automaticHex: bytes.subarray(0, expected.length).toString("hex"),
      userHex: user.toString("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  process.exit(bytes.length === expected.length * 2 && user.equals(expected) ? 0 : 66);
});
