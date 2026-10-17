import type { Client } from "@cove/client";
import type { OperationRecord } from "@cove/protocol/rpc";
import { M1_LIMITS, type RunHistoryRecord, type TabRecord } from "@cove/protocol/workspace";
import type { Session } from "../session.js";
import {
  describeFailure,
  flag,
  integerFlag,
  one,
  print,
  takeFlags,
  unwrap,
  UsageError,
  withSession,
  type Arguments,
} from "./_common.js";
import { operationIdFor, printSucceeded, submitWrite } from "./_pending.js";

export const usage = `  tab create <taskId> [--name NAME] [--cwd entry|mount:MOUNT_ID] [--start yes|no] [--cols N --rows N] [--operation-id ID] [-- <executable> [args...]]
  tab list <taskId>
  tab get <tabId>
  tab runs <tabId>
  tab reopen <tabId> [--cols N --rows N] [--operation-id ID]
  tab stop <tabId> [--run RUN_ID] [--operation-id ID]
  tab close <tabId> [--operation-id ID]

A tab is a task's durable terminal: its name, launch recipe (the command after \`--\`, or the
user's login shell when none is given) and cwd (the workspace entry by default, or a mount). Each
run of a tab is an ordinary terminal run (\`cove terminal list\`). tab create starts the first run
unless --start no; tab reopen starts a new run (a new run ID) with the recorded recipe and is
refused while the tab has a run that has not ended; tab stop stops the latest run and waits for
its exit; tab close deletes the tab record, refused while a run has not ended. A run of an earlier
server instance is never live: it is stopped-with-server after an orderly stop, otherwise
interrupted and unverifiable; nothing is restarted.`;

function geometry(args: Arguments): { geometry?: { cols: number; rows: number } } {
  const cols = flag(args, "--cols");
  const rows = flag(args, "--rows");
  if (cols === undefined && rows === undefined) return {};
  if (cols === undefined || rows === undefined)
    throw new UsageError("--cols and --rows go together");
  return {
    geometry: { cols: integerFlag(args, "--cols", 0), rows: integerFlag(args, "--rows", 0) },
  };
}

function cwd(args: Arguments): { cwd?: TabRecord["cwd"] } {
  const value = flag(args, "--cwd");
  if (value === undefined) return {};
  if (value === "entry") return { cwd: { kind: "entry" } };
  if (value.startsWith("mount:") && value.length > "mount:".length)
    return { cwd: { kind: "mount", mountId: value.slice("mount:".length) } };
  throw new UsageError("--cwd is entry or mount:MOUNT_ID");
}

function start(args: Arguments): { start?: boolean } {
  const value = flag(args, "--start");
  if (value === undefined) return {};
  if (value !== "yes" && value !== "no") throw new UsageError("--start is yes or no");
  return { start: value === "yes" };
}

async function getTab(
  client: Client,
  tabId: string,
): Promise<{ tab: TabRecord; latestRun: RunHistoryRecord | null }> {
  return unwrap("tab.get", await client.call("tab.get", { tabId }));
}

async function listTabs(client: Client, taskId: string): Promise<TabRecord[]> {
  const tabs: TabRecord[] = [];
  let afterTabId: string | undefined;
  do {
    const page = unwrap(
      "tab.list",
      await client.call("tab.list", {
        taskId,
        limit: M1_LIMITS.listPage,
        ...(afterTabId ? { afterTabId } : {}),
      }),
    );
    tabs.push(...page.tabs);
    afterTabId = page.nextAfterTabId;
  } while (afterTabId);
  return tabs;
}

async function listRuns(client: Client, tabId: string): Promise<RunHistoryRecord[]> {
  const runs: RunHistoryRecord[] = [];
  let beforeRunId: string | undefined;
  do {
    const page = unwrap(
      "tab.runs",
      await client.call("tab.runs", {
        tabId,
        limit: M1_LIMITS.listPage,
        ...(beforeRunId ? { beforeRunId } : {}),
      }),
    );
    runs.push(...page.runs);
    beforeRunId = page.nextBeforeRunId;
  } while (beforeRunId);
  return runs;
}

// The tab a settled write names, read after it. Three answers stay distinct: the tab with its
// latest run (`latestRun` null when it has none); `tab: null` when there is no tab to show (the
// operation names none, or the server confirmed TAB_NOT_FOUND, as for a resent create whose tab
// was closed since); and `tabReadError` when the read itself failed, which says nothing about the
// tab, so neither `tab` nor `latestRun` is printed.
type TabView =
  { tab: TabRecord | null; latestRun: RunHistoryRecord | null } | { tabReadError: string };

async function readTab(client: Client, operation: OperationRecord): Promise<TabView> {
  const tabId = operation.result?.resource?.kind === "tab" ? operation.result.resource.id : null;
  if (!tabId) return { tab: null, latestRun: null };
  try {
    const outcome = await client.call("tab.get", { tabId });
    if (outcome.ok) return outcome.value;
    if (
      outcome.kind === "rpc-error" &&
      "kind" in outcome.error &&
      outcome.error.kind === "TAB_NOT_FOUND"
    )
      return { tab: null, latestRun: null };
    return { tabReadError: `tab.get failed: ${describeFailure(outcome)}` };
  } catch (error) {
    return { tabReadError: `tab.get failed: ${error instanceof Error ? error.message : error}` };
  }
}

// The ending of a write that starts or stops a run: print the settled operation with the tab as
// it is now, also when the operation did not succeed (a tab.create whose first run failed still
// recorded its tab). Exits 1 unless the operation succeeded and the tab could be read; the
// printed operation is the write's outcome either way.
export async function printTabOperation(
  client: Client,
  operation: OperationRecord,
): Promise<number> {
  const view = await readTab(client, operation);
  print({ operation, ...view });
  if ("tabReadError" in view)
    process.stderr.write(
      `cove: ${operation.method} ${operation.operationId} ${operation.state}; ` +
        `the tab could not be read afterwards (${view.tabReadError})\n`,
    );
  if (operation.state === "succeeded") return "tabReadError" in view ? 1 : 0;
  const reason = operation.error ? `: ${operation.error.kind}` : "";
  process.stderr.write(
    `cove: ${operation.method} ${operation.operationId} ${operation.state}${reason}\n`,
  );
  return 1;
}

function runRef(session: Session, runId: string) {
  return {
    serverId: session.record.serverId,
    relayInstanceId: session.record.relayInstanceId,
    runId,
  };
}

export async function run(args: Arguments): Promise<number> {
  const sub = args.words[1];
  if (sub === "create") {
    takeFlags(args, ["--name", "--cwd", "--start", "--cols", "--rows", "--operation-id"]);
    const [, , taskId] = args.words;
    if (!taskId || args.words.length !== 3)
      throw new UsageError(
        "tab create needs a task id (and optionally `-- <executable> [args...]`)",
      );
    const [executable, ...argv] = args.command ?? [];
    if (args.command && !executable) throw new UsageError("`--` needs an executable");
    const recipe = executable
      ? { kind: "command" as const, executable, argv }
      : { kind: "shell" as const };
    const name = flag(args, "--name");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      const operation = await submitWrite(args, session, "tab.create", {
        operationId,
        taskId,
        recipe,
        ...(name === undefined ? {} : { name }),
        ...cwd(args),
        ...start(args),
        ...geometry(args),
      });
      return printTabOperation(session.client, operation);
    });
  }
  if (sub === "list") {
    takeFlags(args, []);
    const taskId = one(args, "task id");
    return withSession(args, async ({ client }) => {
      print({ tabs: await listTabs(client, taskId) });
      return 0;
    });
  }
  if (sub === "get") {
    takeFlags(args, []);
    const tabId = one(args, "tab id");
    return withSession(args, async ({ client }) => {
      print(await getTab(client, tabId));
      return 0;
    });
  }
  if (sub === "runs") {
    takeFlags(args, []);
    const tabId = one(args, "tab id");
    return withSession(args, async ({ client }) => {
      print({ runs: await listRuns(client, tabId) });
      return 0;
    });
  }
  if (sub === "reopen") {
    takeFlags(args, ["--cols", "--rows", "--operation-id"]);
    const tabId = one(args, "tab id");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) =>
      printTabOperation(
        session.client,
        await submitWrite(args, session, "tab.reopen", { operationId, tabId, ...geometry(args) }),
      ),
    );
  }
  if (sub === "stop") {
    takeFlags(args, ["--run", "--operation-id"]);
    const tabId = one(args, "tab id");
    const runId = flag(args, "--run");
    const operationId = operationIdFor(args);
    // A pinned run names the current server instance's run: a run of an earlier instance is
    // never live and cannot be stopped.
    return withSession(args, async (session) =>
      printTabOperation(
        session.client,
        await submitWrite(args, session, "tab.stop", {
          operationId,
          tabId,
          ...(runId === undefined ? {} : { run: runRef(session, runId) }),
        }),
      ),
    );
  }
  if (sub === "close") {
    takeFlags(args, ["--operation-id"]);
    const tabId = one(args, "tab id");
    const operationId = operationIdFor(args);
    return withSession(args, async (session) => {
      printSucceeded(await submitWrite(args, session, "tab.close", { operationId, tabId }));
      return 0;
    });
  }
  throw new UsageError(`Unknown tab command ${sub ?? ""}`.trim());
}
