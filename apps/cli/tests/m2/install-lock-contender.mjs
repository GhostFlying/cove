import { acquireInstallLock, installLayout } from "../../dist/install/layout.js";

// One contender for a data directory's install lock (install-safety.test.mjs), as a separate
// process because the lock belongs to a process: `node install-lock-contender.mjs HOME HOLD_MS`.
// Prints "acquired" and holds the lock for HOLD_MS before releasing it, or prints "refused".
const [home, holdMs] = process.argv.slice(2);
let release;
try {
  release = await acquireInstallLock(installLayout(home));
} catch (error) {
  if (!/another installation command/.test(error.message)) throw error;
  console.log("refused");
  process.exit(0);
}
console.log("acquired");
await new Promise((done) => setTimeout(done, Number(holdMs)));
release();
