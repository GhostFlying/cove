import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";

const [nonce, fifoPath, receiptPath] = process.argv.slice(2);
if (!nonce || !fifoPath || !receiptPath || !process.send) process.exit(64);
const fd = openSync(fifoPath, constants.O_RDONLY);
let released = false;
process.on("message", (message) => {
  if (message !== "drain" || released) return;
  released = true;
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(16 * 1024);
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > 1024 * 1024) process.exit(65);
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  closeSync(fd);
  writeFileSync(
    receiptPath,
    JSON.stringify({ nonce, pid: process.pid, total, hex: Buffer.concat(chunks).toString("hex") }),
  );
  process.disconnect();
});
process.send({ nonce, pid: process.pid, state: "fifo-open-unread" });
