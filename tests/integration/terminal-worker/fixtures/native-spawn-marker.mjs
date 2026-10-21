import { publishReceipt } from "./publish-receipt.mjs";

const [nonce, marker] = process.argv.slice(2);
if (!nonce || !marker) process.exit(64);
publishReceipt(marker, JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid }) + "\n");
