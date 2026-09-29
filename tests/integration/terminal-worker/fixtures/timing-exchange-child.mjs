import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [nonce, receiptDir] = process.argv.slice(2);
if (!nonce || !receiptDir) process.exit(64);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.on("SIGHUP", () => process.exit(0));
const received = [];
let pending = Buffer.alloc(0);
let index = 0;
writeFileSync(
  join(receiptDir, "start.json"),
  JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid }),
);
const emit = (next) => process.stdout.write(`OUT:${nonce}:${next}\n`);
emit(index);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, Buffer.from(chunk)]);
  while (index < 8) {
    const expected = Buffer.from(`IN:${nonce}:${index}\n`);
    if (pending.length < expected.length) return;
    if (!pending.subarray(0, expected.length).equals(expected)) process.exit(65);
    received.push(expected);
    pending = pending.subarray(expected.length);
    index++;
    if (index < 8) emit(index);
  }
  if (pending.length) process.exit(66);
  const bytes = Buffer.concat(received);
  writeFileSync(
    join(receiptDir, "finish.json"),
    JSON.stringify({
      nonce,
      pid: process.pid,
      exchanges: index,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
});
