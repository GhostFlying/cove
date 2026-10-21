#!/usr/bin/env node
// A test-only cove-server entry (s10-operation-retention.test.mjs): the compiled server
// (runServerProcess from dist/entry/main.js) on a shifted wall clock. COVE_TEST_CLOCK_OFFSET_MS is
// added to Date.now on the main thread, where every receipt timestamp and the retention purge's
// clock come from, so "30 days later" is a restart with a larger offset rather than a wait. The
// production executable has no such seam.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const offset = Number(process.env.COVE_TEST_CLOCK_OFFSET_MS ?? "0");
if (!Number.isSafeInteger(offset)) throw new Error("COVE_TEST_CLOCK_OFFSET_MS is not an integer");
const realNow = Date.now;
Date.now = () => realNow() + offset;

const serverPackage = dirname(createRequire(import.meta.url).resolve("@cove/server/package.json"));
const { runServerProcess } = await import(
  pathToFileURL(join(serverPackage, "dist", "entry", "main.js")).href
);
runServerProcess(process.argv.slice(2));
