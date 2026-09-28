#!/usr/bin/env node
import { runWorkerPipe } from "./pipe-endpoint.js";

const pipe = runWorkerPipe(process.stdin, process.stdout, { buildVersion: "0.0.0" });

const terminate = (): void => {
  void pipe.shutdown("termination-signal");
};

process.once("SIGINT", terminate);
process.once("SIGTERM", terminate);

void pipe.closed.then(({ reason, disposalReceipts, disposalUnverifiable }) => {
  process.off("SIGINT", terminate);
  process.off("SIGTERM", terminate);
  if (reason === "stdin-eof" || reason === "termination-signal") return;
  process.exitCode = 1;
  const normalizedReason = /^[A-Za-z0-9_-]{1,80}$/.test(reason) ? reason : "unknown";
  const complete = disposalReceipts.filter(
    (receipt) => receipt.ownershipEvidence === "closure-proven",
  ).length;
  const uncertain = disposalReceipts.length - complete + Number(disposalUnverifiable);
  const onStderrError = (): void => {};
  // An unavailable diagnostic fd must not replace the completed shutdown receipt.
  process.stderr.on("error", onStderrError);
  process.stderr.once("close", () => process.stderr.off("error", onStderrError));
  try {
    process.stderr.write(
      `worker-shutdown reason=${normalizedReason} disposal-complete=${complete} disposal-uncertain=${uncertain}\n`,
    );
  } catch {
    // Best effort; the worker's exit status still reports the abnormal close.
  }
});
