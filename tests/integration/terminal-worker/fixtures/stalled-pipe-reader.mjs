import { writeFileSync } from "node:fs";

const [nonce, receiptPath] = process.argv.slice(2);
if (!nonce || !receiptPath || !process.send) process.exit(64);
const chunks = [];
let total = 0;
process.on("message", (message) => {
  if (message !== "drain") return;
  process.stdin.on("data", (chunk) => {
    total += chunk.length;
    if (total > 1024 * 1024) process.exit(65);
    chunks.push(Buffer.from(chunk));
  });
  process.stdin.once("end", () => {
    writeFileSync(
      receiptPath,
      JSON.stringify({
        nonce,
        pid: process.pid,
        total,
        hex: Buffer.concat(chunks).toString("hex"),
      }),
    );
    process.disconnect();
  });
  process.stdin.resume();
});
process.send({ nonce, pid: process.pid, state: "held-open-unread" });
