import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode === "bytes") {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(Buffer.from([0x41, 0x00, 0x80, 0xff, 0xe2]));
  setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 5);
  setTimeout(() => process.stdout.write("READY\n"), 10);
  const received = [];
  let count = 0;
  process.stdin.on("data", (chunk) => {
    received.push(chunk);
    count += chunk.length;
    if (count < 7) return;
    process.stdout.write(`RECEIPT:${Buffer.concat(received).toString("hex")}\n`, () => {
      process.exitCode = 23;
      process.stdin.pause();
    });
  });
} else if (mode === "pause") {
  process.stdout.write("BEGIN\n");
  setTimeout(() => process.stdout.write("AFTER\n"), 160);
  setTimeout(() => {
    process.exitCode = 0;
  }, 450);
} else if (mode === "stall") {
  process.stdin.setRawMode(true);
  process.stdin.pause();
  process.stdout.write("STALLED\n");
  setInterval(() => {}, 1_000);
} else if (mode === "helper") {
  setInterval(() => {}, 1_000);
} else if (mode === "descendant") {
  const helper = spawn(process.execPath, [import.meta.filename, "helper", process.argv[3]], {
    stdio: "ignore",
  });
  writeFileSync(process.argv[4], String(helper.pid));
  process.stdout.write(`HELPER:${helper.pid}\n`);
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`Unknown fixture mode ${mode}`);
}
