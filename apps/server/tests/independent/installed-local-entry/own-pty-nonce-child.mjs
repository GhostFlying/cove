// Future exactly two genuine native invocations; --check performs no FS/PTY work.
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
const [path, nonce] = process.argv.slice(2);
let fd,
  count = 0,
  closed = false,
  primary;
const cleanup = [];
const report = () => {
  process.exitCode = 1;
  process.stderr.write(
    JSON.stringify({
      kind: "nonce-child-failure",
      primary: primary?.name,
      cleanup: cleanup.map((error) => error.name),
    }) + "\n",
  );
};
const close = () => {
  if (closed) return;
  closed = true;
  if (fd !== undefined) {
    try {
      fsyncSync(fd);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      closeSync(fd);
    } catch (error) {
      cleanup.push(error);
    }
  }
};
const stop = () => {
  close();
  try {
    process.stdin.destroy();
  } catch (error) {
    cleanup.push(error);
  }
  if (primary || cleanup.length) report();
};
try {
  fd = openSync(path, "wx", 0o600);
  process.stdin.on("data", (raw) => {
    try {
      const row = Buffer.from(
        JSON.stringify({ ordinal: ++count, bytes: raw.byteLength, hex: raw.toString("hex") }) +
          "\n",
      );
      let n = 0;
      while (n < row.length) {
        const wrote = writeSync(fd, row, n);
        if (wrote <= 0) throw new Error("Receipt write made no progress");
        n += wrote;
      }
      fsyncSync(fd);
      process.stdout.write(Buffer.from(`QN_OWN_${nonce}_INPUT_${raw.toString("hex")}\r\n`));
    } catch (error) {
      primary ??= error;
      stop();
    }
  });
  process.stdin.once("end", stop);
  process.stdin.on("error", (error) => {
    primary ??= error;
    stop();
  });
  process.once("SIGTERM", stop);
  process.stdout.on("error", (error) => {
    primary ??= error;
    stop();
  });
  process.stdout.write(Buffer.from(`QN_OWN_${nonce}_READY\r\n`));
} catch (error) {
  primary = error;
  stop();
}
