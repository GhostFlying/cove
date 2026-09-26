const nonce = process.argv[2];
if (!nonce) process.exit(64);
process.stdin.resume();
process.stdout.write(`READY ${nonce}\n`);
if (process.argv[3] === "echo") {
  process.stdin.once("data", (chunk) => {
    process.stdout.write(`SEEN ${Buffer.from(chunk).toString("hex")}\n`, () => process.exit(0));
  });
} else {
  setInterval(() => {}, 1_000);
}
