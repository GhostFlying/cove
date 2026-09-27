import { spawn } from "node:child_process";

const [mode, nonce] = process.argv.slice(2);
if (!nonce || !["graceful", "ignore-hup", "leader-with-helper", "helper"].includes(mode)) {
  process.exit(2);
}

if (mode === "helper") {
  process.on("SIGHUP", () => {});
  process.stdout.write(`HELPER-READY ${nonce}\n`);
} else if (mode === "leader-with-helper") {
  const helper = spawn(process.execPath, [process.argv[1], "helper", nonce], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  helper.stdout.once("data", () => {
    process.stdout.write(`READY ${nonce} ${helper.pid}\n`);
  });
  process.on("SIGHUP", () => process.exit(0));
} else {
  if (mode === "graceful") process.on("SIGHUP", () => process.exit(0));
  else process.on("SIGHUP", () => {});
  process.stdout.write(`READY ${nonce}\n`);
}

setInterval(() => {}, 1000);
