import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const [mode, nonce] = process.argv.slice(2);

if (!mode || !nonce) process.exit(64);

process.stdin.setRawMode?.(true);
process.stdin.resume();

if (mode === "bytes") {
  process.stdout.write(Buffer.from([0x41, 0x00, 0x80, 0xff, 0xe2, 0x82, 0xac]));
  process.stdout.write(Buffer.from("READY:" + nonce + "\n"));
  const chunks = [];
  process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength < 7) return;
    process.stdout.write(Buffer.from("RECEIPT:" + bytes.subarray(0, 7).toString("hex") + "\n"));
    process.exit(23);
  });
} else if (mode === "slow") {
  process.stdout.write(Buffer.from("READY:" + nonce + "\n"));
  process.stdin.pause();
  setTimeout(() => {
    const hash = createHash("sha256");
    let received = 0;
    process.stdin.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      received += bytes.byteLength;
      if (received < 65_536) return;
      process.stdout.write(Buffer.from("DIGEST:" + hash.digest("hex") + "\n"));
      process.exit(0);
    });
    process.stdin.resume();
  }, 150);
} else if (mode === "query") {
  process.stdout.write(Buffer.from("READY:" + nonce + "\n"));
  process.stdin.once("data", (chunk) => {
    const receipt = Buffer.from(chunk).subarray(0, 1).toString("hex");
    process.stdout.write(Buffer.from("QUERY:" + receipt + "\n"));
    process.exit(0);
  });
} else if (mode === "engine-query") {
  process.stdout.write(Buffer.from("\u001b[5n"));
  process.stdin.once("data", (chunk) => {
    process.stdout.write(
      Buffer.from("ANSWER:" + Buffer.from(chunk).toString("hex") + ":" + nonce + "\n"),
    );
    process.exit(0);
  });
} else if (mode === "live-hup") {
  process.on("SIGHUP", () => process.exit(0));
  process.stdout.write(Buffer.from("READY:" + nonce + "\n"));
  setInterval(() => {}, 1_000);
} else if (mode === "live-force" || mode === "helper") {
  process.on("SIGHUP", () => {});
  process.stdout.write(Buffer.from("READY:" + nonce + "\n"));
  setInterval(() => {}, 1_000);
} else if (mode === "leader-with-helper") {
  const helper = spawn(process.execPath, [process.argv[1], "helper", nonce], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  helper.stdout.once("data", () => {
    process.stdout.write(Buffer.from("READY:" + nonce + ":" + helper.pid + "\n"));
  });
  process.on("SIGHUP", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else {
  process.exit(65);
}
