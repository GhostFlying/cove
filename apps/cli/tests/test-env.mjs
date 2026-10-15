import { join } from "node:path";

const LOCATIONS = ["COVE_HOME", "COVE_RENDEZVOUS"];

// The environment of every CLI and server process a test starts. The CLI resolves its data
// directory from --home, then COVE_HOME, then ~/.cove, and its server from COVE_RENDEZVOUS, so a
// test must never inherit those from the operator's shell: a test server would otherwise open the
// real database, recover its operations and record test runs there. HOME and COVE_HOME both point into
// the test's own temporary directory; `extra` adds test-specific variables (e.g. COVE_RENDEZVOUS).
//
// apps/cli/tests/m1/test-isolation.test.mjs fails when a test file builds a child environment from
// process.env without this function.
export function isolatedEnv(directory, extra = {}) {
  const env = { ...process.env };
  for (const name of LOCATIONS) delete env[name];
  return { ...env, HOME: directory, COVE_HOME: join(directory, "cove-home"), ...extra };
}
