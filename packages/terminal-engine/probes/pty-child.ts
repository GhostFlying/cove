import { createHash } from "node:crypto";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdout.write("READY\r\n");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (input.length > 1024) process.exit(17);
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line.startsWith("PING ")) {
      const nonce = line.slice(5);
      const digest = createHash("sha256").update(nonce).digest("hex").slice(0, 16);
      process.stdout.write(`ACK ${digest}\r\n`);
    } else if (line === "SIZE") {
      const [columns, rows] = process.stdout.getWindowSize();
      process.stdout.write(`SIZE ${columns} ${rows}\r\n`);
    } else if (line === "EXIT") {
      process.stdout.write("BYE\r\n", () => process.exit(23));
    } else {
      process.exit(18);
    }
    newline = input.indexOf("\n");
  }
});
