#!/usr/bin/env node
import { D6Probe } from "./d6-probe.js";
import { runServerProcess } from "./main.js";

// The D6 latency probe's server entry (apps/cli/tests/m1/d6-latency-probe.mjs). It is the normal
// server plus the instrumentation of d6-probe.ts, including the SIGUSR2 switch to the non-durable
// memory backend. It is deliberately not a package executable: only the probe script starts it,
// by path, with a data directory of its own. COVE_D6_PROBE_DIR names where the measurements go and
// is required.

const directory = process.env.COVE_D6_PROBE_DIR;
if (!directory) {
  process.exitCode = 1;
  process.stderr.write("cove-server d6 probe: COVE_D6_PROBE_DIR is required\n");
} else runServerProcess(process.argv.slice(2), new D6Probe(directory));
