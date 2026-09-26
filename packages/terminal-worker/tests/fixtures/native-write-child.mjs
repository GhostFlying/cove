const nonce = process.argv[2];
if (!nonce) process.exit(64);
process.stdin.resume();
process.stdout.write(`READY ${nonce}\n`);
setInterval(() => {}, 1_000);
