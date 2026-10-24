import { expect, test } from "vitest";
import { createBusinessMirror } from "@cove/client";
import { BUSINESS_LIMITS } from "@cove/protocol/business-events";
import {
  batch,
  codec,
  config,
  cursor,
  history,
  identity,
  manualClock,
  operation,
  repo,
  runtime,
  snapshot,
} from "./business-fixture.mjs";

function mirror(filter = {}) {
  const value = createBusinessMirror({ scheduler: manualClock(), codec, filter });
  expect(value.begin(identity).ok).toBe(true);
  return value;
}
function apply(value, frames) {
  for (const frame of frames) expect(value.accept(frame)).toEqual({ ok: true });
}

test("paged snapshot replaces atomically, catches concurrent changes and only ready proves current", () => {
  const value = mirror();
  apply(value, snapshot([repo("old")]));
  value.begin(identity);
  apply(value, [
    { type: "snapshot-begin", snapshotId: "new" },
    { type: "snapshot-page", snapshotId: "new", page: 0, records: [repo("new")] },
  ]);
  expect(value.snapshot().records[0].id).toBe("old");
  apply(value, [
    { type: "snapshot-page", snapshotId: "new", page: 1, records: [config()] },
    {
      type: "snapshot-end",
      snapshotId: "new",
      pages: 2,
      cursor: cursor(),
      history: "latest-and-active-runs-unresolved-operations",
    },
  ]);
  expect(value.snapshot().status).toBe("stale");
  const change = batch(cursor(), [{ type: "upsert", value: config(1) }]);
  apply(value, [change, { type: "ready", cursor: change.cursor }]);
  expect(value.snapshot().status).toBe("current");
  expect(value.snapshot().records.map((item) => item.id)).toEqual(["new", "server"]);
  expect(value.snapshot().records[1].record.revision).toBe(1);
  expect(Object.isFrozen(value.snapshot().records[1].record.settings.workspaceRoot)).toBe(true);
  value.dispose();
});

test("incomplete, duplicate and oversized snapshots retain prior confirmed records as stale", () => {
  for (const reason of ["gap", "duplicate", "capacity"]) {
    const value = mirror();
    apply(value, snapshot([config()]));
    value.begin(identity);
    value.accept({ type: "snapshot-begin", snapshotId: "s" });
    let result;
    if (reason === "gap")
      result = value.accept({
        type: "snapshot-end",
        snapshotId: "s",
        pages: 1,
        cursor: cursor(),
        history: "latest-and-active-runs-unresolved-operations",
      });
    else if (reason === "duplicate")
      result = value.accept({
        type: "snapshot-page",
        snapshotId: "s",
        page: 0,
        records: [config(), config()],
      });
    else {
      result = { ok: true };
      for (let page = 0; page < 90 && result.ok; page++) {
        const records = Array.from({ length: 50 }, (_, index) => {
          const entry = repo(`r${page}-${index}`);
          return { ...entry, record: { ...entry.record, path: `/${"x".repeat(4_000)}` } };
        });
        // Every page stays below 256 KiB; their combined valid records exceed 16 MiB.
        result = value.accept({ type: "snapshot-page", snapshotId: "s", page, records });
      }
    }
    expect(result).toEqual({
      ok: false,
      reason:
        reason === "capacity"
          ? "capacity"
          : reason === "gap"
            ? "snapshot-order"
            : "snapshot-record",
    });
    expect(value.snapshot().status).toBe("stale");
    expect(value.snapshot().records).toHaveLength(1);
    expect(value.snapshot().cursor).toBeNull();
    value.dispose();
  }
});

test("filtered empty batches advance global progress and resume rejects different filter and gaps", () => {
  const value = mirror({ kinds: ["config"] });
  const at = cursor(3, identity, { kinds: ["config"] });
  apply(value, snapshot([config()], at));
  const next = batch(at);
  apply(value, [next]);
  expect(value.snapshot().cursor.sequence).toBe(4);
  value.stale();
  expect(value.begin(identity, next.cursor).ok).toBe(true);
  apply(value, [{ type: "ready", cursor: next.cursor }]);
  expect(value.accept(batch(at)).ok).toBe(false);
  expect(value.begin(identity, { ...next.cursor, filter: "repo" }).ok).toBe(false);
  value.dispose();
});

test("ordered same-revision observations apply, deletes remove exact rows and reset clears cursor", () => {
  const value = mirror();
  apply(value, snapshot([repo("r"), config(3)]));
  const change = batch(cursor(), [
    { type: "upsert", value: config(3, "/updated") },
    { type: "delete", kind: "repo", id: "r" },
  ]);
  apply(value, [change]);
  expect(value.snapshot().records[0].record.settings.workspaceRoot.value).toBe("/updated");
  apply(value, [batch(change.cursor, [{ type: "upsert", value: config(2, "/old") }])]);
  expect(value.snapshot().records[0].record.settings.workspaceRoot.value).toBe("/updated");
  expect(value.accept({ type: "reset", reason: "generation" }).ok).toBe(false);
  expect(value.snapshot().cursor).toBeNull();
  expect(value.snapshot().status).toBe("stale");
  value.dispose();
});

test("durable running rows cannot overwrite runtime exit and old run history is bounded", () => {
  const value = mirror();
  apply(value, snapshot([history("old"), runtime("old")]));
  let at = cursor();
  for (let index = 1; index <= 100; index++) {
    const change = batch(at, [
      { type: "upsert", value: history(`r${index}`, "exited", index + 10) },
      {
        type: "upsert",
        value: { kind: "operation", id: `op${index}`, record: operation(`op${index}`) },
      },
    ]);
    apply(value, [change]);
    at = change.cursor;
  }
  expect(value.snapshot().records.filter((item) => item.kind === "run")).toHaveLength(2);
  expect(value.snapshot().records.find((item) => item.kind === "runtime").record.status).toBe(
    "exited",
  );
  expect(value.snapshot().records.some((item) => item.kind === "operation")).toBe(false);
  const standalone = history("standalone", "exited", 200);
  standalone.record.tabId = null;
  const final = batch(at, [
    { type: "upsert", value: runtime("standalone") },
    { type: "upsert", value: standalone },
  ]);
  apply(value, [final]);
  expect(
    value.snapshot().records.some((item) => item.kind === "run" && item.id === standalone.id),
  ).toBe(false);
  expect(
    value.snapshot().records.find((item) => item.kind === "runtime" && item.id === standalone.id)
      .record.status,
  ).toBe("exited");
  expect(value.snapshot().bytes).toBeLessThan(BUSINESS_LIMITS.snapshotBytes);
  value.dispose();
});

test("foreign instance and identity records fail without changing the retained map", () => {
  const value = mirror();
  apply(value, snapshot([config()]));
  const wrong = runtime("wrong");
  wrong.record.run.relayInstanceId = "other";
  expect(value.accept(batch(cursor(), [{ type: "upsert", value: wrong }])).ok).toBe(false);
  expect(value.snapshot().records).toHaveLength(1);
  value.dispose();
});

test("archive stays a confirmed row and task filesystem remains explicitly unobserved", () => {
  const value = mirror();
  const task = {
    kind: "task",
    id: "task-1",
    filesystem: "unobserved",
    record: {
      taskId: "task-1",
      revision: 0,
      title: "task",
      slug: "task",
      archived: false,
      createdAtMs: 0,
      workspace: {
        workspaceId: "workspace-1",
        revision: 0,
        entryPath: "/workspace/task",
        entryState: "unavailable",
        mounts: [],
      },
    },
  };
  apply(value, snapshot([task]));
  apply(value, [
    batch(cursor(), [
      {
        type: "upsert",
        value: { ...task, record: { ...task.record, archived: true, revision: 1 } },
      },
    ]),
  ]);
  expect(value.snapshot().records[0].record.archived).toBe(true);
  expect(value.snapshot().records[0].filesystem).toBe("unobserved");
  value.dispose();
});
