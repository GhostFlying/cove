import { expect, test } from "vitest";
import { M0_LIMITS } from "@cove/protocol/budgets";
import { DOMAIN_ERROR_KINDS, domainError } from "@cove/protocol/errors";
import {
  RPC_DOMAINS,
  RPC_METHODS,
  WRITE_RPC_METHODS,
  canonicalOperationIntent,
  canonicalWriteIntent,
  classifyRpcItem,
  composeRpcMethodResult,
  isWriteRpcMethod,
  validateOperationRecord,
  validateRpcMethodParams,
  validateRpcResultForCall,
} from "@cove/protocol/rpc";
import {
  GitRefSchema,
  M1_LIMITS,
  MountNameSchema,
  MountOutcomeSchema,
  MountStateSchema,
  ResourceIdSchema,
  OperationStateSchema,
  TaskRecordSchema,
  WorkspaceRecordSchema,
} from "@cove/protocol/workspace";

const encoder = (text) => new TextEncoder().encode(text);
const run = { serverId: "s1", relayInstanceId: "i1", runId: "r1" };

// One valid params object per M1 method; the table test requires every method to have one.
const validParams = {
  "server.status": {},
  "terminal.list": { limit: 1 },
  "terminal.get": { run },
  "terminal.create": {
    operationId: "o1",
    expectedRelayInstanceId: "i1",
    executable: "/bin/sh",
    argv: [],
    cwd: "/tmp",
    geometry: { cols: 80, rows: 24 },
  },
  "terminal.stop": { operationId: "o1", expectedRelayInstanceId: "i1", run },
  "operation.get": { operationId: "o1" },
  "operation.continue": { operationId: "o2", targetOperationId: "o1" },
  "operation.abandon": { operationId: "o2", targetOperationId: "o1" },
  "config.get": {},
  "config.set": { operationId: "o1", patch: { workspaceRoot: "/w" } },
  "repo.register": { operationId: "o1", path: "/src/app" },
  "repo.list": { limit: 10 },
  "repo.get": { repoId: "repo-1" },
  "repo.update": { operationId: "o1", repoId: "repo-1", mainBranch: "trunk" },
  "repo.remove": { operationId: "o1", repoId: "repo-1" },
  "task.create": {
    operationId: "o1",
    title: "Investigate reconnect",
    mounts: [
      { source: "checkout", repoId: "repo-1" },
      { source: "worktree", repoId: "repo-2", base: "origin/main", noFetch: true },
    ],
  },
  "task.list": { limit: 10, archived: "include" },
  "task.get": { taskId: "task-1" },
  "task.update": { operationId: "o1", taskId: "task-1", title: "Renamed" },
  "task.archive": { operationId: "o1", taskId: "task-1", expectedRevision: 3 },
  "task.unarchive": { operationId: "o1", taskId: "task-1" },
  "mount.add": {
    operationId: "o1",
    taskId: "task-1",
    mount: { source: "checkout", repoId: "repo-1", name: "app", path: "/src/app-wt" },
  },
  "mount.remove": { operationId: "o1", taskId: "task-1", mountId: "m1" },
  "mount.retry": { operationId: "o1", taskId: "task-1", mountId: "m1", branch: "cove/x-2" },
  "tab.create": { operationId: "o1", taskId: "task-1", recipe: { kind: "shell" } },
  "tab.list": { taskId: "task-1", limit: 10 },
  "tab.get": { tabId: "tab-1" },
  "tab.runs": { tabId: "tab-1", limit: 10 },
  "tab.reopen": { operationId: "o1", tabId: "tab-1" },
  "tab.stop": { operationId: "o1", tabId: "tab-1", run },
  "tab.close": { operationId: "o1", tabId: "tab-1" },
  "binding.convert": { operationId: "o1", taskId: "task-1", mountId: "m1" },
  "binding.delete": { operationId: "o1", taskId: "task-1", mountId: "m1", confirmed: true },
  "binding.list": { taskId: "task-1", mountId: "m1" },
};

test("the method table classifies every M1 method and names its server module", () => {
  expect(Object.keys(RPC_METHODS).sort()).toEqual(Object.keys(validParams).sort());
  expect(
    Object.entries(RPC_METHODS)
      .filter(([, spec]) => spec.class === "write")
      .map(([method]) => method),
  ).toEqual([...WRITE_RPC_METHODS]);
  const domains = new Set(Object.values(RPC_METHODS).map((spec) => spec.domain));
  expect([...domains].sort()).toEqual([...RPC_DOMAINS].sort());
  for (const [method, spec] of Object.entries(RPC_METHODS)) {
    expect(validateRpcMethodParams(method, validParams[method])?.method).toBe(method);
    expect(["read", "write"]).toContain(spec.class);
    expect(["instance", "server"]).toContain(spec.scope);
    expect(isWriteRpcMethod(method)).toBe(spec.class === "write");
  }
  for (const method of WRITE_RPC_METHODS) {
    // Every write needs an operation ID and returns an operation record.
    const { operationId: _omit, ...withoutId } = validParams[method];
    expect(validateRpcMethodParams(method, withoutId)).toBeNull();
    expect(RPC_METHODS[method].result).toBe(RPC_METHODS["terminal.create"].result);
    expect(RPC_METHODS[method].scope).toBe("server");
  }
  // Only live terminal reads and server status stay bound to the current relay instance.
  expect(
    Object.entries(RPC_METHODS)
      .filter(([, spec]) => spec.scope === "instance")
      .map(([method]) => method),
  ).toEqual(["server.status", "terminal.list", "terminal.get"]);
  expect(RPC_METHODS["operation.continue"].domain).toBe("mount");
  expect(RPC_METHODS["mount.add"].domain).toBe("task");
  expect(isWriteRpcMethod("operation.get")).toBe(false);
  expect(isWriteRpcMethod("not.a.method")).toBe(false);
});

test("operation.get is keyed by operation ID alone", () => {
  expect(validateRpcMethodParams("operation.get", { operationId: "o1" })).toEqual({
    method: "operation.get",
    params: { operationId: "o1" },
  });
  // A stale instance field from an older client is not part of the query.
  expect(
    validateRpcMethodParams("operation.get", { operationId: "o1", expectedRelayInstanceId: "old" })
      ?.params,
  ).toEqual({ operationId: "o1" });
});

test("managed worktree deletion requires confirmed true in the request itself", () => {
  const base = validParams["binding.delete"];
  const { confirmed: _confirmed, ...unconfirmed } = base;
  for (const params of [
    unconfirmed,
    { ...base, confirmed: false },
    { ...base, confirmed: "yes" },
  ]) {
    expect(validateRpcMethodParams("binding.delete", params)).toBeNull();
    expect(
      classifyRpcItem({ jsonrpc: "2.0", id: "q1", method: "binding.delete", params }),
    ).toMatchObject({ kind: "error", response: { error: { code: -32602 } } });
  }
  expect(validateRpcMethodParams("binding.delete", base)).not.toBeNull();
});

test("updates and patches must change at least one field", () => {
  expect(validateRpcMethodParams("repo.update", { operationId: "o1", repoId: "r" })).toBeNull();
  expect(
    validateRpcMethodParams("repo.update", { operationId: "o1", repoId: "r", mainBranch: null }),
  ).not.toBeNull();
  expect(validateRpcMethodParams("config.set", { operationId: "o1", patch: {} })).toBeNull();
  expect(
    validateRpcMethodParams("config.set", { operationId: "o1", patch: { workspaceRoot: null } }),
  ).not.toBeNull();
});

test("git refs and mount names refuse option-like or path-escaping values", () => {
  for (const ref of ["main", "origin/main", "cove/fix-reconnect", "v1.2"])
    expect(GitRefSchema.safeParse(ref).success).toBe(true);
  for (const ref of ["-x", "--upload-pack=x", "a b", "a\nb", "a:b", "HEAD~1", ""])
    expect(GitRefSchema.safeParse(ref).success).toBe(false);
  for (const name of ["app", "app-2", "App.web"])
    expect(MountNameSchema.safeParse(name).success).toBe(true);
  for (const name of [".", "..", "a/b", "-a", ""])
    expect(MountNameSchema.safeParse(name).success).toBe(false);
  expect(
    validateRpcMethodParams("task.create", {
      ...validParams["task.create"],
      mounts: Array.from({ length: M1_LIMITS.mountsPerWorkspace + 1 }, () => ({
        source: "checkout",
        repoId: "repo-1",
      })),
    }),
  ).toBeNull();
});

test("a task record states its workspace entry and gives a checkout no entry path", () => {
  const checkout = {
    mountId: "mount-1",
    name: "app",
    source: "checkout",
    repoId: "repo-1",
    path: "/src/app",
    entryPath: null,
    state: "ready",
    branch: null,
    baseCommit: null,
    sharedWithTaskIds: ["task-2"],
  };
  const task = {
    taskId: "task-1",
    revision: 0,
    title: "Investigate",
    slug: "investigate",
    archived: false,
    createdAtMs: 1,
    workspace: {
      workspaceId: "workspace-1",
      revision: 0,
      entryPath: "/w/investigate-1a2b3c4d",
      entryState: "pending",
      mounts: [checkout],
    },
  };
  expect(TaskRecordSchema.safeParse(task).success).toBe(true);
  // A slug keeps the title's script and case; it is one ref component of at most 64 code points.
  const slug = (value) => TaskRecordSchema.safeParse({ ...task, slug: value }).success;
  for (const value of ["转换测试", "Fix-bug", "v1.2_x", "task", "a", "转".repeat(64)])
    expect({ value, ok: slug(value) }).toEqual({ value, ok: true });
  for (const value of ["", "-a", "a-", ".a", "a.", "a..b", "a.lock", "a b", "a/b", "转".repeat(65)])
    expect({ value, ok: slug(value) }).toEqual({ value, ok: false });
  const { entryState, ...withoutState } = task.workspace;
  expect(entryState).toBe("pending");
  expect(TaskRecordSchema.safeParse({ ...task, workspace: withoutState }).success).toBe(false);
  expect(
    TaskRecordSchema.safeParse({ ...task, workspace: { ...task.workspace, entryState: "gone" } })
      .success,
  ).toBe(false);
});

test("a read may report an entry or a mount as unavailable, which an operation result never records", () => {
  const checkout = {
    mountId: "mount-1",
    name: "app",
    source: "checkout",
    repoId: "repo-1",
    path: "/src/app",
    entryPath: null,
    state: "unavailable",
    branch: null,
    baseCommit: null,
    sharedWithTaskIds: [],
  };
  const workspace = {
    workspaceId: "workspace-1",
    revision: 0,
    entryPath: "/w/investigate-1a2b3c4d",
    entryState: "unavailable",
    mounts: [checkout],
  };
  expect(WorkspaceRecordSchema.safeParse(workspace).success).toBe(true);
  expect(MountStateSchema.safeParse("unavailable").success).toBe(false);
  expect(MountOutcomeSchema.safeParse({ mountId: "mount-1", state: "unavailable" }).success).toBe(
    false,
  );
});

test("domain write fingerprints ignore the operation ID and key order only", () => {
  const params = validParams["task.create"];
  const intent = canonicalWriteIntent("task.create", params, encoder);
  expect(intent).not.toBeNull();
  expect(intent).not.toContain('"o1"');
  const reordered = Object.fromEntries(
    Object.entries({ ...params, operationId: "other" }).reverse(),
  );
  expect(canonicalWriteIntent("task.create", reordered, encoder)).toBe(intent);
  expect(canonicalWriteIntent("task.create", { ...params, title: "Other" }, encoder)).not.toBe(
    intent,
  );
  expect(canonicalWriteIntent("repo.register", validParams["repo.register"], encoder)).not.toBe(
    canonicalWriteIntent("repo.register", { ...validParams["repo.register"], path: "/x" }, encoder),
  );
  expect(canonicalWriteIntent("task.create", { title: "missing id" }, encoder)).toBeNull();
  // Terminal writes keep the unchanged fingerprint, preconditions included.
  for (const method of ["terminal.create", "terminal.stop"]) {
    expect(canonicalWriteIntent(method, validParams[method], encoder)).toBe(
      canonicalOperationIntent(method, validParams[method], encoder),
    );
  }
  expect(canonicalWriteIntent("operation.get", validParams["operation.get"], encoder)).toBeNull();
});

test("domain operation records carry references and per-mount outcomes within budget", () => {
  expect(OperationStateSchema.options).toEqual([
    "accepted",
    "running",
    "recovering",
    "requires_attention",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  const record = {
    operationId: "o1",
    method: "task.create",
    revision: 3,
    state: "failed",
    result: {
      resource: { kind: "task", id: "task-1", revision: 1 },
      workspaceRevision: 2,
      mounts: Array.from({ length: M1_LIMITS.mountsPerWorkspace }, (_, index) => ({
        mountId: `mount-${index}`,
        state: index === 1 ? "failed" : "ready",
        ...(index === 1 ? { errorKind: "BRANCH_EXISTS" } : {}),
      })),
    },
    error: domainError("BRANCH_EXISTS"),
  };
  expect(validateOperationRecord(record, encoder)).toEqual(record);
  const attention = {
    operationId: "o1",
    method: "mount.add",
    revision: 4,
    state: "requires_attention",
    progress: {
      completedSteps: ["branch-created"],
      remainingEffects: ["worktree-registered"],
      recoveryActions: ["continue", "abandon"],
    },
    error: domainError("RESULT_UNKNOWN", "unknown"),
  };
  expect(validateOperationRecord(attention, encoder)).toEqual(attention);
  expect(
    validateOperationRecord(
      { ...attention, progress: { ...attention.progress, completedSteps: ["/private/path"] } },
      encoder,
    ),
  ).toBeNull();
  // A terminal operation must name its run; a domain operation need not.
  expect(
    validateOperationRecord(
      { operationId: "o1", method: "terminal.create", revision: 0, state: "accepted" },
      encoder,
    ),
  ).toBeNull();
  expect(composeRpcMethodResult("task.create", { operation: record })).toEqual({
    operation: record,
  });
  expect(composeRpcMethodResult("mount.add", { operation: record })).toBeNull();
  expect(
    validateRpcResultForCall("task.create", validParams["task.create"], { operation: record }),
  ).toBe(true);
  expect(
    validateRpcResultForCall(
      "task.create",
      { ...validParams["task.create"], operationId: "o2" },
      { operation: record },
    ),
  ).toBe(false);
  expect(
    validateRpcResultForCall("operation.get", { operationId: "o1" }, { operation: record }),
  ).toBe(true);
  expect(
    validateRpcResultForCall("operation.get", { operationId: "o9" }, { operation: record }),
  ).toBe(false);
});

test("the largest schema-valid operation records fit the receipt budget", () => {
  const id = (length) => "a".repeat(length);
  const longest = (values) => values.reduce((a, b) => (b.length > a.length ? b : a));
  const errors = [
    ...DOMAIN_ERROR_KINDS.map((kind) => domainError(kind)),
    domainError("RESULT_UNKNOWN", "unknown", "input"),
  ];
  const largestError = errors.reduce((a, b) =>
    JSON.stringify(b).length > JSON.stringify(a).length ? b : a,
  );
  const max = Number.MAX_SAFE_INTEGER;
  const run = { serverId: id(128), relayInstanceId: id(128), runId: id(128) };
  const progress = {
    completedSteps: Array.from({ length: M1_LIMITS.progressTokens }, () => id(32)),
    remainingEffects: Array.from({ length: M1_LIMITS.progressTokens }, () => id(32)),
    recoveryActions: ["continue", "abandon"],
  };
  const common = {
    operationId: id(128),
    revision: max,
    state: longest(OperationStateSchema.options),
    run,
    progress,
    error: largestError,
  };
  // Every mount failed with the longest error kind and the longest ID.
  const domain = {
    ...common,
    method: longest(WRITE_RPC_METHODS.filter((method) => !method.startsWith("terminal."))),
    result: {
      resource: { kind: "config", id: id(40), revision: max },
      workspaceRevision: max,
      mounts: Array.from({ length: M1_LIMITS.mountsPerWorkspace }, () => ({
        mountId: id(40),
        state: "missing",
        errorKind: longest(DOMAIN_ERROR_KINDS),
      })),
      sourceChanges: { staged: max, unstaged: max, untracked: max },
      targetOperationId: id(128),
    },
  };
  // The same with every mount's `left` set, which the schema admits only without sourceChanges
  // and targetOperationId.
  const leftOver = {
    ...domain,
    result: {
      ...domain.result,
      mounts: domain.result.mounts.map((mount) => ({ ...mount, left: "worktree" })),
      sourceChanges: undefined,
      targetOperationId: undefined,
    },
  };
  delete leftOver.result.sourceChanges;
  delete leftOver.result.targetOperationId;
  // Control characters are the widest JSON escape for the free-form signal text.
  const terminal = {
    ...common,
    method: "terminal.create",
    result: { run, exitCode: -max, signal: "\u0001".repeat(64) },
  };
  for (const record of [domain, leftOver, terminal]) {
    expect(encoder(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(
      M0_LIMITS.operationRecordBytes,
    );
    expect(validateOperationRecord(record, encoder)).toEqual(record);
  }
  // The maximal values above are the schema's limits.
  expect(ResourceIdSchema.safeParse(id(41)).success).toBe(false);
  const overfull = {
    ...domain,
    result: { ...domain.result, mounts: [...domain.result.mounts, domain.result.mounts[0]] },
  };
  expect(validateOperationRecord(overfull, encoder)).toBeNull();
  // `left` with either of the fields it excludes, or an unknown value, is refused; the source
  // counts of a conversion (m1 T5) go with `left` on its single mount only.
  for (const extra of [
    { sourceChanges: domain.result.sourceChanges },
    { targetOperationId: domain.result.targetOperationId },
  ])
    expect(
      validateOperationRecord({ ...leftOver, result: { ...leftOver.result, ...extra } }, encoder),
    ).toBeNull();
  const converted = {
    ...leftOver,
    method: "binding.convert",
    result: {
      ...leftOver.result,
      mounts: leftOver.result.mounts.slice(0, 1),
      sourceChanges: domain.result.sourceChanges,
    },
  };
  expect(encoder(JSON.stringify(converted)).byteLength).toBeLessThanOrEqual(
    M0_LIMITS.operationRecordBytes,
  );
  expect(validateOperationRecord(converted, encoder)).toEqual(converted);
  expect(
    validateOperationRecord(
      { ...converted, result: { ...converted.result, mounts: leftOver.result.mounts.slice(0, 2) } },
      encoder,
    ),
  ).toBeNull();
  const unknownLeft = leftOver.result.mounts.map((mount) => ({ ...mount, left: "checkout" }));
  expect(
    validateOperationRecord(
      { ...leftOver, result: { ...leftOver.result, mounts: unknownLeft } },
      encoder,
    ),
  ).toBeNull();
  const longStep = { ...progress, completedSteps: [id(33)] };
  expect(validateOperationRecord({ ...domain, progress: longStep }, encoder)).toBeNull();
  const tooManySteps = { ...progress, remainingEffects: [...progress.remainingEffects, "x"] };
  expect(validateOperationRecord({ ...domain, progress: tooManySteps }, encoder)).toBeNull();
});

test("results split by method and stored errors carry no run details", () => {
  const run = { serverId: "s1", relayInstanceId: "i1", runId: "r1" };
  const base = { operationId: "o1", revision: 1, state: "succeeded" };
  expect(
    validateOperationRecord(
      {
        ...base,
        method: "terminal.create",
        run,
        result: { run, resource: { kind: "tab", id: "t", revision: 0 } },
      },
      encoder,
    ),
  ).toBeNull();
  expect(
    validateOperationRecord(
      {
        ...base,
        method: "terminal.create",
        run,
        result: { run, workspaceRevision: 1 },
      },
      encoder,
    ),
  ).toBeNull();
  expect(
    validateOperationRecord(
      { ...base, method: "tab.create", run, result: { exitCode: 0 } },
      encoder,
    ),
  ).toBeNull();
  const tab = {
    ...base,
    method: "tab.create",
    run,
    result: { resource: { kind: "tab", id: "tab-1", revision: 0 } },
  };
  expect(validateOperationRecord(tab, encoder)).toEqual(tab);
  const refusal = domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, { runs: [run] });
  expect(validateOperationRecord({ ...tab, state: "failed", error: refusal }, encoder)).toBeNull();
  const { details: _details, ...withoutDetails } = refusal;
  expect(
    validateOperationRecord({ ...tab, state: "failed", error: withoutDetails }, encoder),
  ).not.toBeNull();
});

test("a failed binding.delete stores up to four blocking runs within the receipt budget", () => {
  const id = (length) => "a".repeat(length);
  const run = { serverId: id(128), relayInstanceId: id(128), runId: id(128) };
  const runs = Array.from({ length: M1_LIMITS.storedErrorRuns }, () => run);
  const record = {
    operationId: id(128),
    method: "binding.delete",
    revision: Number.MAX_SAFE_INTEGER,
    state: "requires_attention",
    result: {
      resource: { kind: "mount", id: id(40), revision: Number.MAX_SAFE_INTEGER },
      workspaceRevision: Number.MAX_SAFE_INTEGER,
    },
    progress: {
      completedSteps: Array.from({ length: M1_LIMITS.progressTokens }, () => id(32)),
      remainingEffects: Array.from({ length: M1_LIMITS.progressTokens }, () => id(32)),
      recoveryActions: ["continue", "abandon"],
    },
    error: domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, { runs }),
  };
  expect(encoder(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(
    M0_LIMITS.operationRecordBytes,
  );
  expect(validateOperationRecord(record, encoder)).toEqual(record);
  const more = domainError("LIVE_RUNS_PRESENT", "not-accepted", undefined, {
    runs: [...runs, run],
  });
  expect(validateOperationRecord({ ...record, error: more }, encoder)).toBeNull();
  // Any other write keeps the runs in the RPC error response only.
  expect(
    validateOperationRecord({ ...record, method: "binding.convert", state: "failed" }, encoder),
  ).toBeNull();
});

test("tab launches validate appearance exactly like terminal.create", () => {
  const duplicate = {
    palette: [
      { index: 1, rgb: "ffff/ffff/ffff" },
      { index: 1, rgb: "0000/0000/0000" },
    ],
  };
  const valid = { palette: [{ index: 1, rgb: "ffff/ffff/ffff" }] };
  for (const method of ["terminal.create", "tab.create", "tab.reopen"]) {
    expect(
      validateRpcMethodParams(method, { ...validParams[method], appearance: duplicate }),
    ).toBeNull();
    expect(
      classifyRpcItem({
        jsonrpc: "2.0",
        id: "q1",
        method,
        params: { ...validParams[method], appearance: duplicate },
      }),
    ).toMatchObject({ kind: "error", response: { error: { code: -32602 } } });
    expect(
      validateRpcMethodParams(method, { ...validParams[method], appearance: valid })?.method,
    ).toBe(method);
  }
});

test("a historical terminal record matches the instance its own request named", () => {
  const oldRun = { serverId: "s1", relayInstanceId: "old", runId: "r1" };
  const create = { ...validParams["terminal.create"], expectedRelayInstanceId: "old" };
  const record = {
    operationId: "o1",
    method: "terminal.create",
    revision: 2,
    state: "succeeded",
    run: oldRun,
    result: { run: oldRun },
  };
  expect(validateRpcResultForCall("terminal.create", create, { operation: record })).toBe(true);
  expect(
    validateRpcResultForCall("terminal.create", validParams["terminal.create"], {
      operation: record,
    }),
  ).toBe(false);
  expect(
    validateRpcResultForCall("operation.get", { operationId: "o1" }, { operation: record }),
  ).toBe(true);
  const stop = { operationId: "o1", expectedRelayInstanceId: "old", run: oldRun };
  const { result: _result, ...running } = record;
  expect(
    validateRpcResultForCall("terminal.stop", stop, {
      operation: { ...running, method: "terminal.stop", state: "running" },
    }),
  ).toBe(true);
});
