#!/usr/bin/env node
import { runWorkerPipe } from "./pipe-endpoint.js";

const pipe = runWorkerPipe(process.stdin, process.stdout, { buildVersion: "0.0.0" });

const terminate = (): void => {
  void pipe.shutdown("termination-signal");
};

process.once("SIGINT", terminate);
process.once("SIGTERM", terminate);

void pipe.closed.then(({ reason }) => {
  process.off("SIGINT", terminate);
  process.off("SIGTERM", terminate);
  if (reason !== "stdin-eof" && reason !== "termination-signal") process.exitCode = 1;
});
