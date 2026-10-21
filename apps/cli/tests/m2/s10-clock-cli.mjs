#!/usr/bin/env node
// A test-only `cove` entry (s10-operation-retention.test.mjs): the compiled CLI entry named by the
// first argument, run in this process on a wall clock shifted by COVE_TEST_CLOCK_OFFSET_MS, so a
// local pending record can be read "30 days after" it was saved without waiting. The remaining
// arguments are the CLI's own; the environment is the caller's (an isolatedEnv).

import { pathToFileURL } from "node:url";

const offset = Number(process.env.COVE_TEST_CLOCK_OFFSET_MS ?? "0");
if (!Number.isSafeInteger(offset)) throw new Error("COVE_TEST_CLOCK_OFFSET_MS is not an integer");
const realNow = Date.now;
Date.now = () => realNow() + offset;

// The CLI reads its arguments from process.argv.slice(2) when it is imported.
const [entry] = process.argv.splice(2, 1);
await import(pathToFileURL(entry).href);
