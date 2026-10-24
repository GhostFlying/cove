import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execute = promisify(execFile);

export async function closeNativeApp(currentApp) {
  const child = currentApp.process();
  let timer;
  try {
    await Promise.race([
      currentApp.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Own Electron did not close in 10 seconds")),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    // The handle identifies only this launch. A failed Keychain request must not hang
    // fixture cleanup or turn an unrelated process name/PID into a cleanup target.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Own Electron exit remains unverified")),
          5_000,
        );
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGKILL");
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export async function cleanKeychain(profile) {
  const service = `Cove-${profile} Safe Storage`;
  const account = `Cove-${profile} Key`;
  const keychain = join(process.env.HOME, "Library/Keychains/login.keychain-db");
  const args = ["-s", service, "-a", account, keychain];
  const observed = await execute("security", ["find-generic-password", ...args]).catch((error) => {
    if (error.code === 44) return null;
    throw error;
  });
  if (!observed) return "absent";
  if (
    !observed.stdout.includes(`"svce"<blob>="${service}"`) ||
    !observed.stdout.includes(`"acct"<blob>="${account}"`)
  )
    throw new Error("Own Keychain item attributes could not be verified; it was preserved");
  await execute("security", ["delete-generic-password", ...args]);
  try {
    await execute("security", ["find-generic-password", ...args]);
  } catch (error) {
    if (error.code === 44) return "removed-and-verified-absent";
    throw error;
  }
  throw new Error("Own Keychain item is still present after cleanup");
}
