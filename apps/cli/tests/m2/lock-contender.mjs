import { appendFileSync } from "node:fs";
import { withServerLock } from "../../dist/remote/credentials.js";

// One contender for a paired server's record lock (credential-lock.test.mjs), using the compiled
// withServerLock: `node lock-contender.mjs HOME SERVER_ID LOG NAME HOLD_MS`. It prints "waiting"
// before it asks for the lock and "held" once it has it, and appends "enter NAME" and "exit NAME"
// to LOG (O_APPEND, one write each) around its hold. HOLD_MS "forever" holds the lock until the
// process is killed.
const [home, serverId, log, name, hold] = process.argv.slice(2);
process.stdout.write("waiting\n");
await withServerLock(home, serverId, async () => {
  appendFileSync(log, `enter ${name}\n`);
  process.stdout.write("held\n");
  await new Promise((done) =>
    hold === "forever" ? setInterval(() => undefined, 60_000) : setTimeout(done, Number(hold)),
  );
  appendFileSync(log, `exit ${name}\n`);
});
