import { waitFor } from "./recording-view.mjs";

export const within = (promise, ms) =>
  Promise.race([promise, new Promise((done) => setTimeout(() => done("timeout"), ms))]);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// Never leave a server or its PTYs behind, even when orderly shutdown hangs. `serverPid`
// is the real server under the `cove server start` wrapper; it is unknown when startup
// failed before the start report, leaving the wrapper as the only handle.
export async function stopServer(wrapper, exited, serverPid) {
  wrapper.kill("SIGTERM");
  const code = await within(exited, 15_000);
  if (code !== "timeout") return code;
  wrapper.kill("SIGKILL");
  if (serverPid && alive(serverPid)) {
    try {
      process.kill(serverPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if ((await within(exited, 5_000)) === "timeout")
    throw new Error("the cove server start wrapper survived SIGKILL");
  if (serverPid) await waitFor("the server process to exit", () => !alive(serverPid), 5_000);
  return code;
}
