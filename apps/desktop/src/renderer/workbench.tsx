import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { DesktopApi, DesktopSnapshot, HostReply, SavedServer } from "../shared/api.js";
import type { ReadonlyBusinessRecord } from "@cove/client";
import type { MountSpec, RunHistoryRecord } from "@cove/protocol/workspace";
import { Terminal } from "./terminal.js";

declare global {
  interface Window {
    cove: DesktopApi;
  }
}
type Task = Extract<ReadonlyBusinessRecord, { kind: "task" }>["record"];
type Repo = Extract<ReadonlyBusinessRecord, { kind: "repo" }>["record"];
type Device = {
  deviceId: string;
  name: string;
  neverConnected: boolean;
  revokedAtMs: number | null;
};
type Dialog = { title: string; body: ReactNode };
const BusyContext = createContext(false);

function unwrap(reply: HostReply): unknown {
  if (!reply.ok) throw new Error(reply.error);
  const value = reply.value;
  if (value && typeof value === "object" && "ok" in value) {
    const result = value as { ok: boolean; value?: unknown; kind?: string; error?: unknown };
    if (!result.ok)
      throw new Error(
        `${result.kind ?? "Request failed"}: ${JSON.stringify(result.error ?? "Original operation remains available for verification")}`,
      );
    return result.value;
  }
  return value;
}
function Text({
  name,
  label,
  value = "",
  required = true,
  type = "text",
}: {
  name: string;
  label: string;
  value?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label>
      {label}
      <input name={name} defaultValue={value} required={required} type={type} autoComplete="off" />
    </label>
  );
}
function Form({
  children,
  submit,
  action,
  busy,
}: {
  children: ReactNode;
  submit: string;
  action: (data: FormData) => Promise<void>;
  busy: boolean;
}) {
  const working = useContext(BusyContext) || busy;
  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!working) void action(new FormData(event.currentTarget));
      }}
    >
      {children}
      <button className="primary" disabled={working} type="submit">
        {working ? "Working…" : submit}
      </button>
    </form>
  );
}
const text = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

export function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>({
    localHome: "",
    ready: false,
    servers: [],
    sessions: {},
    operations: [],
    error: null,
  });
  const [serverId, setServerId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [tabId, setTabId] = useState("");
  const [page, setPage] = useState<"tasks" | "repos" | "operations" | "devices">("tasks");
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<unknown>();
  const [deviceResult, setDevices] = useState<{ serverId: string; rows: Device[] }>();
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const deviceRequest = useRef(0);
  const historyRequest = useRef(0);
  const [historyResult, setHistory] = useState<{
    serverId: string;
    taskId: string;
    tabId: string;
    runs: RunHistoryRecord[];
  }>();
  const [checkedTask, setCheckedTask] = useState<Task>();
  useEffect(() => {
    const stop = window.cove.onState(setSnapshot);
    void window.cove
      .snapshot()
      .then(setSnapshot)
      .catch((failure: unknown) => setNotice(String(failure)));
    return stop;
  }, []);
  const server = snapshot.servers.find((value) => value.serverId === serverId);
  const session = snapshot.sessions[serverId];
  const rows = session?.mirror.records ?? [];
  const repos = rows.filter((row) => row.kind === "repo").map((row) => row.record);
  const tasks = rows.filter((row) => row.kind === "task").map((row) => row.record);
  const selectedTask = tasks.find((task) => task.taskId === taskId);
  const task =
    checkedTask?.taskId === selectedTask?.taskId &&
    checkedTask?.revision === selectedTask?.revision &&
    checkedTask?.workspace.revision === selectedTask?.workspace.revision
      ? checkedTask
      : selectedTask;
  const tabs = rows
    .filter(
      (row): row is Extract<ReadonlyBusinessRecord, { kind: "tab" }> =>
        row.kind === "tab" && row.record.taskId === taskId,
    )
    .map((row) => row.record);
  const tab = tabs.find((value) => value.tabId === tabId);
  const current = session?.status === "current";
  const run = tab?.latestRun;
  const devices = deviceResult?.serverId === serverId ? deviceResult.rows : [];
  const history =
    historyResult?.serverId === serverId &&
    historyResult.taskId === taskId &&
    historyResult.tabId === tabId
      ? historyResult.runs
      : undefined;
  function clearHistory() {
    // Invalidate at the navigation event, including A -> B -> A before a reply arrives.
    historyRequest.current++;
    setHistory(undefined);
  }
  useEffect(() => {
    const request = ++deviceRequest.current;
    setDevices(undefined);
    if (page !== "devices" || !current) return;
    let active = true;
    // Reads have their own lifetime: a pending read for A must not prevent loading B.
    void window.cove
      .call(serverId, "auth.device.list", { includeRevoked: true })
      .then((reply) => {
        if (!active || request !== deviceRequest.current) return;
        const value = unwrap(reply) as { devices: Device[] };
        setDevices({ serverId, rows: value.devices });
      })
      .catch((failure: unknown) => {
        if (active && request === deviceRequest.current)
          setNotice(failure instanceof Error ? failure.message : "Device list unavailable");
      });
    return () => {
      active = false;
    };
  }, [serverId, page, current, session?.generation, deviceRefresh]);

  async function perform(action: () => Promise<HostReply>, close = false): Promise<void> {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const value = unwrap(await action());
      setResult(value);
      if (close) setDialog(undefined);
    } catch (failure) {
      setNotice(
        failure instanceof Error
          ? failure.message
          : "Outcome unavailable; inspect operations before another write",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const rpc = (method: string, params: unknown) => window.cove.call(serverId, method, params);
  const mutate = async (method: string, params: unknown) =>
    perform(() => rpc(method, params), true);
  function selectServer(value: SavedServer) {
    deviceRequest.current++;
    setDialog(undefined);
    setServerId(value.serverId);
    setTaskId("");
    setTabId("");
    clearHistory();
    setCheckedTask(undefined);
    setResult(undefined);
  }
  const confirm = (title: string, description: string, action: () => Promise<HostReply>) =>
    setDialog({
      title,
      body: (
        <>
          <p>{description}</p>
          <button className="danger" onClick={() => void perform(action, true)}>
            Confirm {title.toLowerCase()}
          </button>
        </>
      ),
    });

  function addServer(local: boolean) {
    setDialog({
      title: local ? "Pair this Mac's server" : "Pair a server",
      body: (
        <Form
          busy={busy}
          submit="Pair device"
          action={async (data) => {
            const base = { alias: text(data, "alias"), name: text(data, "name") };
            await perform(
              () =>
                local
                  ? window.cove.pairLocal({ ...base, home: text(data, "home") })
                  : window.cove.pair({
                      ...base,
                      invitation: text(data, "invitation"),
                      via: text(data, "via") as "loopback" | "ssh" | "tsnet",
                    }),
              true,
            );
          }}
        >
          <p>Desktop creates its own device authorization, protected by macOS Keychain.</p>
          <Text name="alias" label="Server alias" />
          <Text name="name" label="Device name" value="Cove Desktop" />
          {local ? (
            <>
              <Text
                name="home"
                label="Local Cove home (absolute path)"
                value={snapshot.localHome}
              />
              <p>
                The server must already be installed with <code>cove server install</code>. This
                action creates a device; it does not install, restart or replace the server.
              </p>
            </>
          ) : (
            <>
              <label>
                Invitation
                <textarea name="invitation" required autoComplete="off" spellCheck={false} />
              </label>
              <label>
                Pairing entry
                <select name="via" defaultValue="tsnet">
                  <option value="tsnet">Embedded Tailnet</option>
                  <option value="ssh">SSH (host key already recorded)</option>
                  <option value="loopback">Same host only</option>
                </select>
              </label>
              <p>
                Local-only invitations must use “Same host only”. Entries are never switched
                automatically.
              </p>
            </>
          )}
        </Form>
      ),
    });
  }
  function registerRepo(repo?: Repo) {
    setDialog({
      title: repo ? "Rename repository" : "Register repository",
      body: (
        <Form
          busy={busy}
          submit={repo ? "Save name" : "Register"}
          action={async (data) =>
            mutate(
              repo ? "repo.update" : "repo.register",
              repo
                ? {
                    repoId: repo.repoId,
                    expectedRevision: repo.revision,
                    displayName: text(data, "name"),
                  }
                : {
                    path: text(data, "path"),
                    ...(text(data, "name") ? { displayName: text(data, "name") } : {}),
                  },
            )
          }
        >
          {repo ? (
            <p>{repo.path}</p>
          ) : (
            <Text name="path" label="Absolute repository path on this server" />
          )}
          <Text
            name="name"
            label="Display name"
            required={!!repo}
            value={repo?.displayName ?? ""}
          />
        </Form>
      ),
    });
  }
  function mountEditor(mode: "task" | "mount" | "convert", mountId?: string) {
    setDialog({
      title:
        mode === "task" ? "Create task" : mode === "mount" ? "Add mount" : "Convert to worktree",
      body: (
        <MountForm
          busy={busy}
          repos={repos}
          mode={mode}
          onSubmit={async (title, mounts) => {
            if (mode === "task") await mutate("task.create", { title, mounts });
            else if (mode === "mount")
              await mutate("mount.add", {
                taskId,
                expectedWorkspaceRevision: task!.workspace.revision,
                mount: mounts[0],
              });
            else {
              const mount = mounts[0];
              await mutate("binding.convert", {
                taskId,
                mountId,
                expectedWorkspaceRevision: task!.workspace.revision,
                ...(mount?.source === "worktree" && mount.branch ? { branch: mount.branch } : {}),
                ...(mount?.source === "worktree" && mount.base ? { base: mount.base } : {}),
                ...(mount?.source === "worktree" && mount.noFetch ? { noFetch: true } : {}),
              });
            }
          }}
        />
      ),
    });
  }
  function createTab() {
    setDialog({
      title: "Create terminal tab",
      body: (
        <Form
          busy={busy}
          submit="Create tab and run"
          action={async (data) =>
            mutate("tab.create", {
              taskId,
              name: text(data, "name"),
              recipe: { kind: "shell" },
              cwd: text(data, "mount")
                ? { kind: "mount", mountId: text(data, "mount") }
                : { kind: "entry" },
            })
          }
        >
          <Text name="name" label="Tab name" value="Terminal" />
          <label>
            Start directory
            <select name="mount">
              <option value="">Workspace entry</option>
              {task?.workspace.mounts.map((mount) => (
                <option key={mount.mountId} value={mount.mountId}>
                  {mount.name} — {mount.path}
                </option>
              ))}
            </select>
          </label>
          <p>
            The independent server starts its configured shell. Closing this view keeps the run
            alive.
          </p>
        </Form>
      ),
    });
  }
  function refreshDevices() {
    deviceRequest.current++;
    setDevices(undefined);
    setDeviceRefresh((value) => value + 1);
  }
  async function readHistory() {
    const request = ++historyRequest.current;
    const selection = { serverId, taskId, tabId };
    await perform(async () => {
      const reply = await window.cove.call(selection.serverId, "tab.runs", {
        tabId: selection.tabId,
        limit: 100,
      });
      if (request !== historyRequest.current) return { ok: true };
      const value = unwrap(reply) as { runs: RunHistoryRecord[] };
      setHistory({ ...selection, runs: value.runs });
      return { ok: true };
    });
  }
  return (
    <div className="app-shell">
      <aside className="server-rail">
        <div className="brand">
          Cove<span>Remote workspaces</span>
        </div>
        <div className="rail-heading">Servers</div>
        <nav aria-label="Servers">
          {snapshot.servers.map((item) => (
            <button
              className={item.serverId === serverId ? "selected server-button" : "server-button"}
              key={item.serverId}
              onClick={() => selectServer(item)}
            >
              <span
                className={`dot ${snapshot.sessions[item.serverId]?.status === "current" ? "online" : ""}`}
              />
              {item.alias}
              <small>{snapshot.sessions[item.serverId]?.status ?? "disconnected"}</small>
            </button>
          ))}
        </nav>
        {!snapshot.servers.length ? (
          <p className="quiet">Pair a server to open your workspaces.</p>
        ) : null}
        <div className="rail-actions">
          <button onClick={() => addServer(false)} disabled={!snapshot.ready}>
            ＋ Pair server
          </button>
          <button onClick={() => addServer(true)} disabled={!snapshot.ready}>
            Pair this Mac
          </button>
          <button onClick={() => void perform(window.cove.networkStatus)}>Tailnet status</button>
          <button onClick={() => void perform(window.cove.networkLogin)}>Tailnet login</button>
        </div>
        <p className="rail-foot">
          Execution stays on the server.
          <br />
          Closing Cove leaves runs alive.
        </p>
      </aside>
      <main className="workbench">
        <header className="topbar">
          <div>
            <h1>{server?.alias ?? "Your workspaces"}</h1>
            <span className="quiet">
              {server
                ? `${server.serverId} · ${session?.status ?? "disconnected"}`
                : "Connect to an independent Cove server"}
            </span>
          </div>
          {server ? (
            <div className="actions">
              <label className="inline-label">
                Entry
                <select
                  key={serverId}
                  defaultValue={server.defaultEntry}
                  aria-label="Connection entry"
                  id="entry-choice"
                >
                  {Object.keys(server.entries).map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void perform(() =>
                    window.cove.connect(
                      serverId,
                      (document.getElementById("entry-choice") as HTMLSelectElement)
                        .value as SavedServer["defaultEntry"],
                    ),
                  )
                }
              >
                {current ? "Reconnect" : "Connect"}
              </button>
              <button
                disabled={!session || busy}
                onClick={() => void perform(() => window.cove.disconnect(serverId))}
              >
                Disconnect
              </button>
              <button
                onClick={() =>
                  confirm(
                    "Forget server",
                    "This removes this Desktop's credential only. Revoke the device on the server separately; existing runs and the shared network node continue.",
                    () => window.cove.forget(serverId),
                  )
                }
              >
                Forget
              </button>
            </div>
          ) : null}
        </header>
        {snapshot.error || notice ? (
          <div className="notice" role="alert">
            {snapshot.error ?? notice}
            <button onClick={() => setNotice(undefined)} aria-label="Dismiss notice">
              ×
            </button>
          </div>
        ) : null}
        {server && !current ? (
          <div className="stale-banner">
            {session?.lastError ?? "Choose an entry and connect."} Retained lists are unverified
            until a fresh snapshot completes. Unknown writes are never replayed.
          </div>
        ) : null}
        {!server ? (
          <section className="welcome">
            <div className="welcome-mark">C</div>
            <h2>A place for work in progress.</h2>
            <p>
              Keep tasks, repositories and terminals together. Connect your Mac or a remote
              execution server to begin.
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={() => addServer(false)}
                disabled={!snapshot.ready}
              >
                Pair a server
              </button>
              <button onClick={() => addServer(true)} disabled={!snapshot.ready}>
                Use this Mac's server
              </button>
            </div>
          </section>
        ) : (
          <>
            <nav className="section-tabs" aria-label="Workspace sections">
              {(["tasks", "repos", "operations", "devices"] as const).map((item) => (
                <button
                  key={item}
                  className={page === item ? "active" : ""}
                  onClick={() => {
                    setPage(item);
                  }}
                >
                  {item === "repos" ? "Repositories" : item[0]!.toUpperCase() + item.slice(1)}
                </button>
              ))}
            </nav>
            {page === "repos" ? (
              <section className="content">
                <div className="section-heading">
                  <h2>Repositories</h2>
                  <button
                    className="primary"
                    disabled={!current || busy}
                    onClick={() => registerRepo()}
                  >
                    Register repository
                  </button>
                </div>
                <p className="quiet">
                  Paths belong to {server.alias}. Registration does not move your clone.
                </p>
                {repos.map((repo) => (
                  <article className="resource-row" key={repo.repoId}>
                    <div>
                      <h3>{repo.displayName}</h3>
                      <code>{repo.path}</code>
                      <p className="quiet">
                        Main branch: {repo.mainBranch ?? "resolved from remote"} · revision{" "}
                        {repo.revision}
                      </p>
                    </div>
                    <div className="actions">
                      <button disabled={!current || busy} onClick={() => registerRepo(repo)}>
                        Rename
                      </button>
                      <button
                        disabled={!current || busy}
                        onClick={() =>
                          confirm(
                            "Remove registration",
                            "Only the registration is removed. The clone and its contents remain.",
                            () =>
                              rpc("repo.remove", {
                                repoId: repo.repoId,
                                expectedRevision: repo.revision,
                              }),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
                {!repos.length ? (
                  <p>
                    No repositories registered. Register an existing clone on this server first.
                  </p>
                ) : null}
              </section>
            ) : null}
            {page === "tasks" ? (
              <div className="task-layout">
                <aside className="task-list">
                  <div className="section-heading">
                    <h2>Tasks</h2>
                    <button disabled={!current || busy} onClick={() => mountEditor("task")}>
                      ＋ New
                    </button>
                  </div>
                  {tasks.map((value) => (
                    <button
                      className={value.taskId === taskId ? "task-item selected" : "task-item"}
                      key={value.taskId}
                      onClick={() => {
                        setTaskId(value.taskId);
                        setTabId("");
                        clearHistory();
                        setCheckedTask(undefined);
                      }}
                    >
                      <strong>{value.title}</strong>
                      <span>
                        {value.archived ? "Archived · " : ""}
                        {value.workspace.mounts.length} repositories
                      </span>
                    </button>
                  ))}
                  {!tasks.length ? (
                    <p className="quiet">Create a task, then add one or more repository mounts.</p>
                  ) : null}
                </aside>
                <section className="task-detail">
                  {task ? (
                    <>
                      <div className="section-heading">
                        <div>
                          <h2>{task.title}</h2>
                          <code>{task.workspace.entryPath}</code>
                          <p className="quiet">
                            Workspace revision {task.workspace.revision} ·{" "}
                            {checkedTask === task
                              ? `Last path check: entry ${task.workspace.entryState}`
                              : "Filesystem not checked by event mirror"}
                          </p>
                        </div>
                        <div className="actions">
                          <button
                            disabled={!current || busy}
                            onClick={() =>
                              void perform(async () => {
                                const reply = await rpc("task.get", { taskId });
                                const value = unwrap(reply) as { task: Task };
                                setCheckedTask(value.task);
                                return { ok: true };
                              })
                            }
                          >
                            Check paths
                          </button>
                          <button
                            disabled={!current || busy}
                            onClick={() =>
                              setDialog({
                                title: "Rename task",
                                body: (
                                  <Form
                                    busy={busy}
                                    submit="Save title"
                                    action={async (data) =>
                                      mutate("task.update", {
                                        taskId,
                                        expectedRevision: task.revision,
                                        title: text(data, "title"),
                                      })
                                    }
                                  >
                                    <Text name="title" label="Task title" value={task.title} />
                                  </Form>
                                ),
                              })
                            }
                          >
                            Rename
                          </button>
                          <button
                            disabled={!current || busy}
                            onClick={() =>
                              confirm(
                                task.archived ? "Restore task" : "Archive task",
                                "The server checks this task's current revision and any blocking runs.",
                                () =>
                                  rpc(task.archived ? "task.unarchive" : "task.archive", {
                                    taskId,
                                    expectedRevision: task.revision,
                                  }),
                              )
                            }
                          >
                            {task.archived ? "Restore" : "Archive"}
                          </button>
                        </div>
                      </div>
                      <div className="mount-heading">
                        <h3>Repository mounts</h3>
                        <button
                          disabled={!current || busy || !repos.length}
                          onClick={() => mountEditor("mount")}
                        >
                          Add mount
                        </button>
                      </div>
                      <div className="mount-list">
                        {task.workspace.mounts.map((mount) => (
                          <div className="mount-row" key={mount.mountId}>
                            <div>
                              <strong>{mount.name}</strong>
                              <span className="quiet">
                                {" "}
                                {mount.source} ·{" "}
                                {checkedTask === task ? mount.state : `${mount.state} (unobserved)`}
                              </span>
                              <code>{mount.path}</code>
                              {mount.sharedWithTaskIds.length ? (
                                <small>
                                  Shared checkout with {mount.sharedWithTaskIds.length} other tasks
                                </small>
                              ) : null}
                              {mount.error ? <p role="alert">{mount.error.kind}</p> : null}
                            </div>
                            <div className="actions">
                              {mount.source === "checkout" ? (
                                <button
                                  disabled={!current || busy}
                                  onClick={() => mountEditor("convert", mount.mountId)}
                                >
                                  Make worktree
                                </button>
                              ) : (
                                <>
                                  <button
                                    disabled={!current || busy}
                                    onClick={() =>
                                      void mutate("mount.retry", { taskId, mountId: mount.mountId })
                                    }
                                  >
                                    Retry
                                  </button>
                                  <button
                                    disabled={!current || busy}
                                    onClick={() =>
                                      confirm(
                                        "Delete worktree",
                                        "The server checks for user changes and live runs. This deletes the managed worktree and removes its mount; its branch remains.",
                                        () =>
                                          rpc("binding.delete", {
                                            taskId,
                                            mountId: mount.mountId,
                                            expectedWorkspaceRevision: task.workspace.revision,
                                            confirmed: true,
                                          }),
                                      )
                                    }
                                  >
                                    Delete worktree
                                  </button>
                                </>
                              )}
                              <button
                                disabled={!current || busy}
                                onClick={() =>
                                  confirm(
                                    "Remove mount",
                                    "This removes the task's mount reference. It does not delete the checkout or worktree contents.",
                                    () =>
                                      rpc("mount.remove", {
                                        taskId,
                                        mountId: mount.mountId,
                                        expectedWorkspaceRevision: task.workspace.revision,
                                      }),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="tab-heading">
                        <h3>Terminals</h3>
                        <button className="primary" disabled={!current || busy} onClick={createTab}>
                          New terminal
                        </button>
                      </div>
                      <nav className="terminal-tabs" aria-label="Terminal tabs">
                        {tabs.map((value) => (
                          <button
                            className={value.tabId === tabId ? "active" : ""}
                            key={value.tabId}
                            onClick={() => {
                              setTabId(value.tabId);
                              clearHistory();
                            }}
                          >
                            {value.name}
                          </button>
                        ))}
                      </nav>
                      {tab ? (
                        <>
                          <div className="terminal-toolbar">
                            <span>{run ? `Run ${run.runId}` : "No run"}</span>
                            <div className="actions">
                              <button
                                onClick={() => {
                                  clearHistory();
                                  setTabId("");
                                }}
                              >
                                Close view
                              </button>
                              <button
                                disabled={!current || busy}
                                onClick={() => void readHistory()}
                              >
                                Run history
                              </button>
                              <button
                                disabled={!current || busy || !run}
                                onClick={() =>
                                  confirm(
                                    "Stop run",
                                    "This explicitly stops the selected server run. Closing the view alone would leave it running.",
                                    () => rpc("tab.stop", { tabId, run }),
                                  )
                                }
                              >
                                Stop run
                              </button>
                              <button
                                disabled={!current || busy}
                                onClick={() =>
                                  confirm(
                                    "Reopen tab",
                                    "Creates a new run only after the server confirms the previous run ended. No old input is replayed.",
                                    () => rpc("tab.reopen", { tabId }),
                                  )
                                }
                              >
                                Reopen
                              </button>
                              <button
                                disabled={!current || busy}
                                onClick={() =>
                                  confirm(
                                    "Delete tab",
                                    "Removes the logical tab record. The server refuses while its run is alive.",
                                    () => rpc("tab.close", { tabId }),
                                  )
                                }
                              >
                                Delete tab
                              </button>
                            </div>
                          </div>
                          {history ? (
                            <div className="history">
                              <h3>Retained run history</h3>
                              {history.map((item) => (
                                <p key={item.run.runId}>
                                  <code>{item.run.runId}</code> · {item.lifecycle} ·{" "}
                                  {item.verification} · exit {item.exitCode ?? "unknown"} ·{" "}
                                  <code>{item.cwd}</code>
                                </p>
                              ))}
                              <p className="quiet">
                                Terminal screen contents are not persisted across server restart.
                              </p>
                            </div>
                          ) : run && current ? (
                            <Terminal
                              key={`${run.relayInstanceId}:${run.runId}`}
                              serverId={serverId}
                              run={run}
                            />
                          ) : (
                            <p>Select or explicitly reopen a run after connecting.</p>
                          )}
                        </>
                      ) : (
                        <p className="quiet empty-terminal">
                          Select a terminal tab, or create a new one.
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="empty-task">
                      <h2>Select a task</h2>
                      <p>Tasks group repository mounts and independent terminal runs.</p>
                    </div>
                  )}
                </section>
              </div>
            ) : null}
            {page === "operations" ? (
              <section className="content">
                <h2>Operation results</h2>
                <p className="quiet">
                  References survive app restart. Reconnect to verify them; no write or input is
                  automatically repeated. “Not found” does not establish that an effect never
                  happened.
                </p>
                {snapshot.operations
                  .filter((operation) => operation.serverId === serverId)
                  .map((operation) => (
                    <article className="operation-row" key={operation.operationId}>
                      <div>
                        <h3>
                          {operation.method} · {operation.status}
                        </h3>
                        <code>{operation.operationId}</code>
                        <p className="quiet">Original instance {operation.relayInstanceId}</p>
                        {operation.result ? (
                          <pre>{JSON.stringify(operation.result, null, 2)}</pre>
                        ) : null}
                      </div>
                      <div className="actions">
                        <button
                          disabled={!current || busy}
                          onClick={() =>
                            void perform(() =>
                              window.cove.queryOperation(serverId, operation.operationId),
                            )
                          }
                        >
                          Verify original ID
                        </button>
                        {recoveryActions(operation.result).map((action) => (
                          <button
                            key={action}
                            disabled={!current || busy}
                            onClick={() =>
                              confirm(
                                `${action === "continue" ? "Continue" : "Abandon"} operation`,
                                action === "continue"
                                  ? "Explicitly asks the server to continue the original recorded work. It does not resubmit a new copy of the original intent."
                                  : "Records abandonment of the original work. Previously completed or uncertain effects are not undone.",
                                () =>
                                  rpc(`operation.${action}`, {
                                    targetOperationId: operation.operationId,
                                  }),
                              )
                            }
                          >
                            {action === "continue"
                              ? "Continue original work"
                              : "Abandon original work"}
                          </button>
                        ))}
                        {operation.status === "observed" || operation.status === "not-sent" ? (
                          <button
                            onClick={() =>
                              void perform(() =>
                                window.cove.acknowledgeOperation(serverId, operation.operationId),
                              )
                            }
                          >
                            Acknowledge
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))}
              </section>
            ) : null}
            {page === "devices" ? (
              <section className="content">
                <div className="section-heading">
                  <h2>Paired devices</h2>
                  <button disabled={!current || busy} onClick={() => void refreshDevices()}>
                    Refresh devices
                  </button>
                </div>
                <p className="quiet">
                  Revoking a device closes its authenticated connections. Forgetting a server only
                  removes this Desktop's credential.
                </p>
                {devices.map((device) => (
                  <article className="resource-row" key={device.deviceId}>
                    <div>
                      <h3>{device.name}</h3>
                      <code>{device.deviceId}</code>
                      <p>
                        {device.revokedAtMs
                          ? "Revoked"
                          : device.neverConnected
                            ? "Never connected"
                            : "Authorized"}
                      </p>
                    </div>
                    <button
                      disabled={!current || busy || !!device.revokedAtMs}
                      onClick={() =>
                        confirm(
                          "Revoke device",
                          `Revoke ${device.name}? This may disconnect another client or this Desktop. It does not stop server runs.`,
                          () => rpc("auth.device.revoke", { deviceId: device.deviceId }),
                        )
                      }
                    >
                      Revoke device
                    </button>
                  </article>
                ))}
              </section>
            ) : null}
          </>
        )}
        {result !== undefined ? (
          <details className="last-result">
            <summary>Last operation response</summary>
            <pre>{JSON.stringify(result, null, 2)}</pre>
            {result &&
            typeof result === "object" &&
            "authURL" in result &&
            typeof result.authURL === "string" ? (
              <button
                onClick={() => void perform(() => window.cove.openLink(result.authURL as string))}
              >
                Open Tailnet login
              </button>
            ) : null}
          </details>
        ) : null}
      </main>
      {dialog ? (
        <div className="modal-backdrop" onClick={() => !busy && setDialog(undefined)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.title}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <h2>{dialog.title}</h2>
              <button
                aria-label="Close dialog"
                disabled={busy}
                onClick={() => setDialog(undefined)}
              >
                ×
              </button>
            </div>
            <BusyContext.Provider value={busy}>{dialog.body}</BusyContext.Provider>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function recoveryActions(result: unknown): Array<"continue" | "abandon"> {
  if (
    !result ||
    typeof result !== "object" ||
    !("progress" in result) ||
    !result.progress ||
    typeof result.progress !== "object" ||
    !("recoveryActions" in result.progress) ||
    !Array.isArray(result.progress.recoveryActions)
  )
    return [];
  return result.progress.recoveryActions.filter(
    (action): action is "continue" | "abandon" => action === "continue" || action === "abandon",
  );
}

function MountForm({
  mode,
  repos,
  busy,
  onSubmit,
}: {
  mode: "task" | "mount" | "convert";
  repos: readonly Repo[];
  busy: boolean;
  onSubmit: (title: string, mounts: MountSpec[]) => Promise<void>;
}) {
  const [count, setCount] = useState(mode === "task" ? 0 : 1);
  return (
    <Form
      busy={busy}
      submit={
        mode === "task" ? "Create task" : mode === "mount" ? "Add mount" : "Create managed worktree"
      }
      action={async (data) => {
        const mounts: MountSpec[] = [];
        for (let index = 0; index < count; index++) {
          const source = mode === "convert" ? "worktree" : text(data, `source-${index}`);
          const common = {
            repoId: text(data, `repo-${index}`),
            ...(text(data, `name-${index}`) ? { name: text(data, `name-${index}`) } : {}),
          };
          mounts.push(
            source === "worktree"
              ? {
                  ...common,
                  source,
                  ...(text(data, `branch-${index}`)
                    ? { branch: text(data, `branch-${index}`) }
                    : {}),
                  ...(text(data, `base-${index}`) ? { base: text(data, `base-${index}`) } : {}),
                  ...(data.has(`noFetch-${index}`) ? { noFetch: true } : {}),
                }
              : {
                  ...common,
                  source: "checkout",
                  ...(text(data, `path-${index}`) ? { path: text(data, `path-${index}`) } : {}),
                },
          );
        }
        await onSubmit(text(data, "title"), mounts);
      }}
    >
      {mode === "task" ? <Text name="title" label="Task title" /> : null}
      {Array.from({ length: count }, (_, index) => (
        <fieldset key={index}>
          <legend>Repository {index + 1}</legend>
          <label>
            Registered repository
            <select name={`repo-${index}`} required>
              {repos.map((repo) => (
                <option key={repo.repoId} value={repo.repoId}>
                  {repo.displayName} — {repo.path}
                </option>
              ))}
            </select>
          </label>
          {mode !== "convert" ? (
            <label>
              Source
              <select name={`source-${index}`}>
                <option value="checkout">Existing checkout</option>
                <option value="worktree">New independent worktree</option>
              </select>
            </label>
          ) : null}
          <Text name={`name-${index}`} label="Mount name (optional)" required={false} />
          <Text
            name={`path-${index}`}
            label="Existing checkout path (optional, server path)"
            required={false}
          />
          <Text name={`branch-${index}`} label="Worktree branch (optional)" required={false} />
          <Text name={`base-${index}`} label="Worktree base (optional)" required={false} />
          <label className="checkbox">
            <input type="checkbox" name={`noFetch-${index}`} />
            Skip fetch for this worktree explicitly
          </label>
        </fieldset>
      ))}
      {mode === "task" ? (
        <button
          type="button"
          disabled={!repos.length || count >= 16}
          onClick={() => setCount((value) => value + 1)}
        >
          Add repository mount
        </button>
      ) : null}
      <p className="quiet">
        Operations can complete partially across repositories. Inspect the original operation result
        before deciding a next action.
      </p>
    </Form>
  );
}
