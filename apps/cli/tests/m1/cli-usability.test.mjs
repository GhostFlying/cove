import { afterEach, beforeEach, expect, test } from "vitest";
import { createM1Fixture } from "./fixtures.mjs";

// CLI usability from the M1 trial, through the compiled `cove` CLI: per-group help.

let fixture;

beforeEach(async () => {
  fixture = await createM1Fixture();
});

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  await current?.cleanup();
});

const FULL = ["  repo register", "  task create", "  mount add", "  tab create", "  status"];

test("an explicit help request prints the full usage, or one group's, on stdout and exits 0", async () => {
  for (const args of [["--help"], ["help"]]) {
    const result = await fixture.cove(args);
    expect({ args, code: result.code }).toEqual({ args, code: 0 });
    expect(result.stderr).toBe("");
    for (const line of FULL) expect(result.stdout).toContain(line);
  }
  for (const args of [
    ["help", "repo"],
    ["repo", "--help"],
    ["repo", "register", "--help"],
  ]) {
    const result = await fixture.cove(args);
    expect({ args, code: result.code }).toEqual({ args, code: 0 });
    expect(result.stdout).toMatch(/^usage: cove /);
    expect(result.stdout).toContain("  repo register <PATH>");
    expect(result.stdout).not.toContain("  task create");
    expect(result.stdout).toContain("--operation-id ID; the request is saved");
  }
  // A group without write commands has no operation-ID note.
  const status = await fixture.cove(["help", "status"]);
  expect(status.code).toBe(0);
  expect(status.stdout).not.toContain("--operation-id");
  // A --help after `--` belongs to the spawned command, not to cove: the tab command runs (and
  // fails here only for want of a server).
  const recipe = await fixture.cove(["tab", "create", "t1", "--", "prog", "--help"], {
    home: fixture.home("home"),
  });
  expect(recipe.code).toBe(1);
  expect(recipe.stdout).toBe("");
});

test("a group without a subcommand is a usage error that prints only that group's usage", async () => {
  const mount = await fixture.cove(["mount"]);
  expect(mount.code).toBe(2);
  expect(mount.stdout).toBe("");
  expect(mount.stderr).toContain("cove: missing mount command");
  expect(mount.stderr).toContain("  mount convert");
  expect(mount.stderr).not.toContain("  repo register");
  // A usage error inside a group shows that group's usage too.
  const unknown = await fixture.cove(["repo", "frobnicate"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("cove: Unknown repo command frobnicate");
  expect(unknown.stderr).toContain("  repo list");
  expect(unknown.stderr).not.toContain("  mount add");
  // No command and an unknown command keep the full usage.
  for (const args of [[], ["nope"]]) {
    const result = await fixture.cove(args);
    expect({ args, code: result.code }).toEqual({ args, code: 2 });
    for (const line of FULL) expect(result.stderr).toContain(line);
  }
  const unknownGroup = await fixture.cove(["help", "nope"]);
  expect(unknownGroup.code).toBe(2);
  expect(unknownGroup.stderr).toContain("cove: Unknown command group nope");
});
