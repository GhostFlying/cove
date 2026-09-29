import { writeFileSync } from "node:fs";

const [nonce, marker] = process.argv.slice(2);
if (!nonce || !marker) process.exit(64);
writeFileSync(marker, JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid }) + "\n");
