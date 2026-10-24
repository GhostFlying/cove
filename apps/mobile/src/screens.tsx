import { ActionError } from "../dist/action-error.js";
import { useEffect, useState } from "react";
import { Alert, Button, FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import type { ReactNode } from "react";
import type { RpcMethod, ServerSessionSnapshot } from "@cove/client";
import type { TaskRecord, MountSpec, RunHistoryRecord } from "@cove/protocol/workspace";
import type { DeviceRecord } from "@cove/protocol/auth";
import { MobileHost, type MobileState } from "../dist/mobile-host.js";
import type { Profile } from "../dist/local-store.js";
import type { Route } from "../dist/navigation.js";
import { requireResult } from "../dist/presentation.js";

type ReadonlyTask = Extract<
  ServerSessionSnapshot["mirror"]["records"][number],
  { kind: "task" }
>["record"];

export type Act = (body: () => Promise<unknown>) => void;
export interface ScreenProps {
  host: MobileHost;
  state: MobileState;
  profile: Profile;
  snapshot: ServerSessionSnapshot | undefined;
  act: Act;
  busy: boolean;
  navigate(route: Route): void;
}
export const styles = StyleSheet.create({
  page: { padding: 18, gap: 12, backgroundColor: "#f4f6f9" },
  heading: { fontSize: 24, fontWeight: "700", color: "#16273f" },
  title: { fontSize: 18, fontWeight: "600", color: "#16273f" },
  card: {
    padding: 14,
    gap: 8,
    borderRadius: 12,
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#dce3ec",
  },
  input: {
    padding: 10,
    borderWidth: 1,
    borderColor: "#bbc8d8",
    borderRadius: 8,
    color: "#16273f",
    backgroundColor: "white",
  },
  note: { color: "#47576c", fontSize: 13 },
  error: { padding: 12, backgroundColor: "#fff1df", color: "#703808" },
});
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  );
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  secret?: boolean;
  multiline?: boolean;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.note}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={styles.input}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secret}
        multiline={multiline}
      />
    </View>
  );
}
export function Confirm({
  title,
  detail,
  disabled,
  run,
}: {
  title: string;
  detail: string;
  disabled: boolean;
  run(): void;
}) {
  return (
    <Button
      title={title}
      disabled={disabled}
      onPress={() =>
        Alert.alert(title, detail, [
          { text: "Cancel", style: "cancel" },
          { text: title, style: "destructive", onPress: run },
        ])
      }
    />
  );
}
export function Rows<T>({ rows, render }: { rows: readonly T[]; render(value: T): ReactNode }) {
  const [page, setPage] = useState(0);
  const actual = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  return (
    <View style={{ gap: 8 }}>
      <FlatList
        scrollEnabled={false}
        data={rows.slice(actual * 50, actual * 50 + 50)}
        keyExtractor={(_, i) => String(i + actual * 50)}
        renderItem={({ item }) => <View style={{ marginBottom: 8 }}>{render(item)}</View>}
      />
      <Text style={styles.note}>
        {rows.length} records · page {actual + 1}
      </Text>
      <Button title="Previous page" disabled={actual === 0} onPress={() => setPage(actual - 1)} />
      <Button
        title="Next page"
        disabled={(actual + 1) * 50 >= rows.length}
        onPress={() => setPage(actual + 1)}
      />
    </View>
  );
}
function useWrite(props: ScreenProps) {
  return (method: RpcMethod, params: Record<string, unknown>, summary: string) =>
    props.act(async () => {
      try {
        requireResult(
          await props.host.operations.write(
            props.profile,
            props.host.session(props.profile.id),
            method,
            params,
            summary,
          ),
        );
      } finally {
        await props.host.reload();
      }
    });
}
export function Servers({
  host,
  state,
  act,
  busy,
  navigate,
}: Omit<ScreenProps, "profile" | "snapshot">) {
  const [invitation, setInvitation] = useState("");
  const [label, setLabel] = useState("");
  const [name, setName] = useState("Cove Mobile");
  return (
    <>
      <Text style={styles.heading}>Your servers</Text>
      <Text style={styles.note}>
        Direct connections from this phone. Remote terminals keep running when Cove is closed.
      </Text>
      <Card title="Tailnet on this phone">
        <Text>{state.nodeState}</Text>
        <Text style={styles.note}>
          Stop closes this phone's node. Logout removes this node's Tailnet enrollment. Neither
          revokes a Cove device.
        </Text>
        <Button
          title="Start / reconnect network"
          disabled={busy}
          onPress={() => act(() => host.foreground())}
        />
        <Button
          title="Log in to Tailnet"
          disabled={busy || !state.foreground}
          onPress={() => act(() => host.network("login"))}
        />
        <Button
          title="Refresh network status"
          disabled={busy || !state.foreground}
          onPress={() => act(() => host.network("refresh"))}
        />
        <Button
          title="Stop this phone's network"
          disabled={busy}
          onPress={() => host.background()}
        />
        <Confirm
          title="Log out this phone from Tailnet"
          detail="All server connections on this phone will close. Remote terminals and Cove pairings remain."
          disabled={busy || !state.foreground}
          run={() => act(() => host.network("logout"))}
        />
      </Card>
      <Rows
        rows={state.profiles}
        render={(profile) => (
          <Card title={profile.label}>
            <Text selectable>{profile.serverId}</Text>
            <Text>
              {profile.state} · {state.sessions[profile.id]?.status ?? "disconnected"}
            </Text>
            <Text style={styles.note}>
              {profile.peerID}:{profile.port}
            </Text>
            {profile.state === "ready" ? (
              <>
                <Button
                  title="Open server"
                  onPress={() => navigate({ screen: "server", profileId: profile.id })}
                />
                <Button
                  title="Reconnect selected entry"
                  disabled={busy || !state.foreground}
                  onPress={() => act(() => host.connect(profile.id))}
                />
              </>
            ) : profile.state === "pending" ? (
              <Button
                title="Check saved pairing"
                disabled={busy}
                onPress={() => act(() => host.recoverPair(profile.id))}
              />
            ) : null}
            <Confirm
              title="Forget on this phone"
              detail="Removes this phone's credential slot. Does not revoke the device on the server or log out Tailnet. Unresolved operation references remain."
              disabled={busy}
              run={() => act(() => host.forget(profile.id))}
            />
          </Card>
        )}
      />
      <Card title="Retained operation references">
        <Rows
          rows={state.operations.filter(
            (row) => !state.profiles.some((profile) => profile.id === row.profileId),
          )}
          render={(row) => (
            <View>
              <Text>
                {row.summary}: {row.state} · {row.observation}
              </Text>
              <Text selectable>{row.operationId}</Text>
              <Text style={styles.note}>
                Original credential slot was forgotten. A new pairing cannot query or replay this
                reference.
              </Text>
              <Button
                title="Acknowledge terminal / not-sent reference"
                disabled={
                  busy ||
                  !(
                    row.state === "not-sent" ||
                    (row.state === "observed" &&
                      row.record &&
                      ["succeeded", "failed", "cancelled"].includes(row.record.state))
                  )
                }
                onPress={() =>
                  act(async () => {
                    await host.operations.acknowledge(undefined, row.operationId);
                    await host.reload();
                  })
                }
              />
            </View>
          )}
        />
      </Card>
      <Card title="Add a server">
        <Field label="Server label" value={label} onChange={setLabel} />
        <Field label="Device name on server" value={name} onChange={setName} />
        <Field label="One-use invitation" value={invitation} onChange={setInvitation} secret />
        <Button
          title="Pair once"
          disabled={busy || !invitation || !label}
          onPress={() => {
            const value = invitation;
            setInvitation("");
            act(() => host.pair(value, label, name));
          }}
        />
        <Text style={styles.note}>
          If redemption is uncertain, check the saved pairing or request a new invitation. Cove
          never redeems the previous invitation again.
        </Text>
      </Card>
    </>
  );
}
function MountEditor({
  repos,
  add,
}: {
  repos: { repoId: string; displayName: string }[];
  add(mount: MountSpec): void;
}) {
  const [selected, setSelected] = useState("");
  const [source, setSource] = useState<"checkout" | "worktree">("checkout");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [noFetch, setNoFetch] = useState(false);
  return (
    <Card title="Add a repository mount">
      <Rows
        rows={repos}
        render={(repo) => (
          <Button
            title={`${selected === repo.repoId ? "✓ " : ""}${repo.displayName}`}
            onPress={() => setSelected(repo.repoId)}
          />
        )}
      />
      <Button
        title={`Source: ${source} (tap to change)`}
        onPress={() => setSource(source === "checkout" ? "worktree" : "checkout")}
      />
      <Field label="Mount name (optional)" value={name} onChange={setName} />
      {source === "checkout" ? (
        <Field label="Existing server checkout path (optional)" value={path} onChange={setPath} />
      ) : (
        <>
          <Field label="New branch (optional)" value={branch} onChange={setBranch} />
          <Field label="Base commit / ref (optional)" value={base} onChange={setBase} />
          <Button
            title={`Skip fetch: ${noFetch ? "yes" : "no"}`}
            onPress={() => setNoFetch(!noFetch)}
          />
        </>
      )}
      <Button
        title="Add mount to request"
        disabled={!selected}
        onPress={() =>
          add(
            source === "checkout"
              ? { repoId: selected, source, ...(name ? { name } : {}), ...(path ? { path } : {}) }
              : {
                  repoId: selected,
                  source,
                  ...(name ? { name } : {}),
                  ...(branch ? { branch } : {}),
                  ...(base ? { base } : {}),
                  noFetch,
                },
          )
        }
      />
    </Card>
  );
}
export function ServerScreen(props: ScreenProps) {
  const { profile, snapshot, busy, navigate, act, host } = props;
  const write = useWrite(props);
  const records = snapshot?.mirror.records ?? [];
  const repos = records.filter((v) => v.kind === "repo").map((v) => v.record);
  const tasks = records.filter((v) => v.kind === "task").map((v) => v.record);
  const [path, setPath] = useState("");
  const [repoName, setRepoName] = useState("");
  const [mainBranch, setMainBranch] = useState("");
  const [title, setTitle] = useState("");
  const [mounts, setMounts] = useState<MountSpec[]>([]);
  const [peer, setPeer] = useState(profile.peerID);
  const [port, setPort] = useState(String(profile.port));
  const [archived, setArchived] = useState(false);
  return (
    <>
      <Text style={styles.heading}>{profile.label}</Text>
      <Text selectable>{profile.serverId}</Text>
      <Text>
        {snapshot?.status ?? "disconnected"} · catalog {snapshot?.mirror.status ?? "unavailable"}
      </Text>
      <Button
        title="Reconnect this entry"
        disabled={busy}
        onPress={() => act(() => host.connect(profile.id))}
      />
      <Button
        title="Disconnect this server"
        disabled={busy}
        onPress={() => host.disconnect(profile.id)}
      />
      <Button
        title="Operations"
        onPress={() => navigate({ screen: "operations", profileId: profile.id })}
      />
      <Button
        title="Devices"
        onPress={() => navigate({ screen: "devices", profileId: profile.id })}
      />
      <Card title="Connection entry">
        <Field label="Stable Tailnet peer ID" value={peer} onChange={setPeer} />
        <Field label="Server business port" value={port} onChange={setPort} />
        <Button
          title="Verify and use this entry"
          disabled={busy}
          onPress={() => act(() => host.changeEntry(profile.id, peer, Number(port)))}
        />
      </Card>
      <Card title="Tasks">
        <Button
          title={archived ? "Show current tasks" : "Show archived tasks"}
          onPress={() => setArchived(!archived)}
        />
        <Rows
          rows={tasks.filter((task) => task.archived === archived)}
          render={(task) => (
            <View>
              <Button
                title={task.title}
                onPress={() =>
                  navigate({ screen: "task", profileId: profile.id, taskId: task.taskId })
                }
              />
              <Text style={styles.note}>
                workspace revision {task.workspace.revision} · path not checked
              </Text>
            </View>
          )}
        />
      </Card>
      <Card title="Create task">
        <Field label="Task title" value={title} onChange={setTitle} />
        <Rows
          rows={mounts}
          render={(mount) => (
            <Text>
              {mount.source}:{" "}
              {repos.find((repo) => repo.repoId === mount.repoId)?.displayName ?? mount.repoId}{" "}
              {mount.name ?? ""}
            </Text>
          )}
        />
        <Button title="Clear draft mounts" onPress={() => setMounts([])} />
        <Button
          title="Create task with these mounts"
          disabled={busy || !title}
          onPress={() => write("task.create", { title, mounts }, "Create task")}
        />
      </Card>
      <MountEditor
        repos={repos}
        add={(mount) => setMounts((old) => (old.length < 16 ? [...old, mount] : old))}
      />
      <Card title="Registered repositories">
        <Rows
          rows={repos}
          render={(repo) => (
            <Card title={repo.displayName}>
              <Text selectable>{repo.path}</Text>
              <Text>Main branch: {repo.mainBranch ?? "server default"}</Text>
              <Button
                title="Use entered name / branch for this repo"
                disabled={busy || (!repoName && !mainBranch)}
                onPress={() =>
                  write(
                    "repo.update",
                    {
                      repoId: repo.repoId,
                      expectedRevision: repo.revision,
                      ...(repoName ? { displayName: repoName } : {}),
                      ...(mainBranch ? { mainBranch } : {}),
                    },
                    "Update repository",
                  )
                }
              />
              <Confirm
                title="Remove registration"
                detail="Only removes the registration; the server repository directory is kept."
                disabled={busy}
                run={() =>
                  write(
                    "repo.remove",
                    { repoId: repo.repoId, expectedRevision: repo.revision },
                    "Remove repository registration",
                  )
                }
              />
            </Card>
          )}
        />
        <Field label="Server repository path" value={path} onChange={setPath} />
        <Field label="Repository display name" value={repoName} onChange={setRepoName} />
        <Field label="Main branch (optional)" value={mainBranch} onChange={setMainBranch} />
        <Button
          title="Register server repository"
          disabled={busy || !path || !repoName}
          onPress={() =>
            write("repo.register", { path, displayName: repoName }, "Register repository")
          }
        />
      </Card>
    </>
  );
}
export function TaskScreen(props: ScreenProps & { taskId: string }) {
  const { host, profile, snapshot, taskId, act, busy, navigate } = props;
  const write = useWrite(props);
  const [detail, setDetail] = useState<{
    task: TaskRecord;
    version: number;
    generation: number;
  } | null>(null);
  const [readError, setReadError] = useState("");
  const [title, setTitle] = useState("");
  const [tabName, setTabName] = useState("");
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const [cwdMount, setCwdMount] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [history, setHistory] = useState<RunHistoryRecord[]>([]);
  const [historyTab, setHistoryTab] = useState("");
  const [next, setNext] = useState<string | undefined>();
  const version = snapshot?.mirror.version;
  const generation = snapshot?.generation;
  useEffect(() => {
    let current = true;
    setReadError("");
    if (snapshot?.status !== "current") return;
    const session = host.session(profile.id);
    void session.call("task.get", { taskId }).then((result) => {
      if (
        !current ||
        session.snapshot().generation !== generation ||
        session.snapshot().mirror.version !== version
      )
        return;
      if (result.ok)
        setDetail({ task: result.value.task, version: version!, generation: generation! });
      else
        setReadError(
          "Current server paths could not be checked. Last catalog facts remain unverified.",
        );
    });
    return () => {
      current = false;
    };
  }, [host, profile.id, taskId, generation, version, snapshot?.status]);
  const projected = snapshot?.mirror.records.find((v) => v.kind === "task" && v.id === taskId);
  const checked =
    detail !== null &&
    detail.version === version &&
    detail.generation === generation &&
    snapshot?.status === "current";
  const task: ReadonlyTask | undefined =
    checked && detail ? detail.task : projected?.kind === "task" ? projected.record : undefined;
  const repos =
    snapshot?.mirror.records.filter((v) => v.kind === "repo").map((v) => v.record) ?? [];
  const tabs =
    snapshot?.mirror.records
      .filter((v) => v.kind === "tab")
      .map((v) => v.record)
      .filter((v) => v.taskId === taskId) ?? [];
  const overrides = { ...(branch ? { branch } : {}), ...(base ? { base } : {}) };
  function loadHistory(tabId: string, beforeRunId?: string) {
    act(async () => {
      const result = requireResult(
        await host
          .session(profile.id)
          .call("tab.runs", { tabId, limit: 50, ...(beforeRunId ? { beforeRunId } : {}) }),
      );
      setHistoryTab(tabId);
      setHistory(result.runs);
      setNext(result.nextBeforeRunId);
    });
  }
  return (
    <>
      <Text style={styles.heading}>{task?.title ?? "Task unavailable"}</Text>
      <Text style={styles.note}>
        {checked ? "Server paths checked" : "Catalog only · paths unverified"}
      </Text>
      {readError ? <Text style={styles.error}>{readError}</Text> : null}
      <Button
        title="Refresh current server paths"
        disabled={busy}
        onPress={() =>
          act(async () => {
            const session = host.session(profile.id);
            const v = session.snapshot().mirror.version;
            const g = session.snapshot().generation;
            const result = requireResult(await session.call("task.get", { taskId }));
            if (session.snapshot().mirror.version === v && session.snapshot().generation === g)
              setDetail({ task: result.task, version: v, generation: g });
          })
        }
      />
      {task ? (
        <>
          <Card title="Workspace">
            <Text selectable>{task.workspace.entryPath}</Text>
            <Text>
              revision {task.workspace.revision} ·{" "}
              {checked ? task.workspace.entryState : "unobserved"}
            </Text>
            <Field label="New task title" value={title} onChange={setTitle} />
            <Button
              title="Rename task"
              disabled={busy || !title}
              onPress={() =>
                write(
                  "task.update",
                  { taskId, expectedRevision: task.revision, title },
                  "Rename task",
                )
              }
            />
            <Confirm
              title={task.archived ? "Unarchive task" : "Archive task"}
              detail="Changes the task's archived state. It does not stop its runs."
              disabled={busy}
              run={() =>
                write(
                  task.archived ? "task.unarchive" : "task.archive",
                  { taskId, expectedRevision: task.revision },
                  "Change task archive state",
                )
              }
            />
          </Card>
          <Field
            label="Branch override for retry / conversion (optional)"
            value={branch}
            onChange={setBranch}
          />
          <Field
            label="Base ref for retry / conversion (optional)"
            value={base}
            onChange={setBase}
          />
          <Rows
            rows={task.workspace.mounts}
            render={(mount) => (
              <Card title={mount.name}>
                <Text>
                  {mount.source} · {checked ? mount.state : "unobserved"}
                </Text>
                <Text selectable>{mount.path}</Text>
                <Text>branch {mount.branch ?? "—"}</Text>
                <Text>shared with {mount.sharedWithTaskIds.length} other tasks</Text>
                {mount.error ? <Text style={styles.error}>{mount.error.kind}</Text> : null}
                <Confirm
                  title="Remove mount (keep directory)"
                  detail="Unlinks the mount from this workspace; its server directory is preserved."
                  disabled={busy}
                  run={() =>
                    write(
                      "mount.remove",
                      {
                        taskId,
                        mountId: mount.mountId,
                        expectedWorkspaceRevision: task.workspace.revision,
                      },
                      "Remove mount",
                    )
                  }
                />
                {mount.source === "checkout" ? (
                  <Confirm
                    title="Convert to managed worktree"
                    detail="Creates a managed worktree from a commit. Existing checkout changes remain in their original directory."
                    disabled={busy}
                    run={() =>
                      write(
                        "binding.convert",
                        {
                          taskId,
                          mountId: mount.mountId,
                          expectedWorkspaceRevision: task.workspace.revision,
                          ...overrides,
                        },
                        "Convert checkout mount",
                      )
                    }
                  />
                ) : (
                  <>
                    <Button
                      title="Retry failed mount"
                      disabled={busy || mount.state !== "failed"}
                      onPress={() =>
                        write(
                          "mount.retry",
                          { taskId, mountId: mount.mountId, ...overrides },
                          "Retry failed mount",
                        )
                      }
                    />
                    <Confirm
                      title="Delete managed worktree"
                      detail={`Deletes ${mount.path} on the server after server safety checks; the branch is kept. Review dirty files and live runs first.`}
                      disabled={busy}
                      run={() =>
                        write(
                          "binding.delete",
                          {
                            taskId,
                            mountId: mount.mountId,
                            expectedWorkspaceRevision: task.workspace.revision,
                            confirmed: true,
                          },
                          "Delete managed worktree",
                        )
                      }
                    />
                  </>
                )}
                <Button
                  title="Use this mount for new terminal"
                  onPress={() => setCwdMount(mount.mountId)}
                />
              </Card>
            )}
          />
          <MountEditor
            repos={repos}
            add={(mount) =>
              write(
                "mount.add",
                { taskId, expectedWorkspaceRevision: task.workspace.revision, mount },
                "Add mount",
              )
            }
          />
        </>
      ) : null}
      <Card title="Terminals">
        <Text style={styles.note}>
          Shell activity: unknown. Selecting a terminal never starts or reopens a run.
        </Text>
        <Rows
          rows={tabs}
          render={(tab) => (
            <Card title={tab.name}>
              <Text selectable>{tab.tabId}</Text>
              <Text>{tab.latestRun ? `run ${tab.latestRun.runId}` : "No run"}</Text>
              <Button
                title="Open existing live run"
                disabled={busy}
                onPress={() =>
                  act(async () => {
                    const session = host.session(profile.id);
                    const result = requireResult(
                      await session.call("tab.get", { tabId: tab.tabId }),
                    );
                    if (
                      !result.latestRun ||
                      result.latestRun.verification !== "live" ||
                      result.latestRun.run.relayInstanceId !==
                        session.snapshot().identity?.relayInstanceId
                    )
                      throw new ActionError(
                        "The selected run is not verified live; refresh its history before reopening",
                      );
                    navigate({
                      screen: "terminal",
                      profileId: profile.id,
                      tabId: tab.tabId,
                      run: result.latestRun.run,
                    });
                  })
                }
              />
              <Button title="Run history" disabled={busy} onPress={() => loadHistory(tab.tabId)} />
              <Confirm
                title="Stop current run"
                detail="Requests the server to stop this exact recorded run. Loss of contact is not proof that it exited."
                disabled={busy || !tab.latestRun}
                run={() =>
                  write(
                    "tab.stop",
                    { tabId: tab.tabId, ...(tab.latestRun ? { run: tab.latestRun } : {}) },
                    "Stop terminal run",
                  )
                }
              />
              <Confirm
                title="Reopen as a new run"
                detail="Starts a new run from the saved recipe. It does not restore the old process, output, or input."
                disabled={busy}
                run={() => write("tab.reopen", { tabId: tab.tabId }, "Reopen terminal")}
              />
              <Confirm
                title="Delete stopped tab record"
                detail="Deletes the logical tab; the server refuses while a run is alive."
                disabled={busy}
                run={() => write("tab.close", { tabId: tab.tabId }, "Delete stopped tab")}
              />
            </Card>
          )}
        />
      </Card>
      {historyTab ? (
        <Card title={`History · ${historyTab}`}>
          <Rows
            rows={history}
            render={(run) => (
              <View>
                <Text>
                  {run.run.runId}: {run.lifecycle} · {run.verification}
                </Text>
                <Text selectable>{run.cwd}</Text>
                <Text style={styles.note}>
                  {new Date(run.startedAtMs).toLocaleString()} · exit {run.exitCode ?? "unknown"}
                </Text>
              </View>
            )}
          />
          <Button
            title="Older runs"
            disabled={busy || !next}
            onPress={() => loadHistory(historyTab, next)}
          />
        </Card>
      ) : null}
      <Card title="New terminal">
        <Field label="Tab name (optional)" value={tabName} onChange={setTabName} />
        <Field
          label="Executable (empty = login shell)"
          value={executable}
          onChange={setExecutable}
        />
        <Field label="Arguments, one per line" value={args} onChange={setArgs} multiline />
        <Text>
          CWD:{" "}
          {cwdMount
            ? (task?.workspace.mounts.find((mount) => mount.mountId === cwdMount)?.name ??
              "unknown mount")
            : "workspace entry"}
        </Text>
        <Button title="Use workspace entry" onPress={() => setCwdMount("")} />
        <Button
          title="Create and start terminal"
          disabled={busy}
          onPress={() =>
            write(
              "tab.create",
              {
                taskId,
                ...(tabName ? { name: tabName } : {}),
                recipe: executable
                  ? { kind: "command", executable, argv: args ? args.split("\n") : [] }
                  : { kind: "shell" },
                cwd: cwdMount ? { kind: "mount", mountId: cwdMount } : { kind: "entry" },
              },
              "Create terminal",
            )
          }
        />
      </Card>
    </>
  );
}
export function OperationsScreen(props: ScreenProps) {
  const { host, profile, state, snapshot, busy, act } = props;
  const write = useWrite(props);
  const local = state.operations.filter((row) => row.profileId === profile.id);
  const remote =
    snapshot?.mirror.records.filter((v) => v.kind === "operation").map((v) => v.record) ?? [];
  return (
    <>
      <Text style={styles.heading}>Operations</Text>
      <Text style={styles.note}>
        Original IDs are only queried. Missing records and lost contact never authorize replay.
      </Text>
      <Rows
        rows={local}
        render={(row) => (
          <Card title={row.summary}>
            <Text selectable>{row.operationId}</Text>
            <Text>
              {row.state} · {row.observation} · {row.record?.state ?? "result unknown"}
            </Text>
            <Text style={styles.note}>
              {row.method} · {row.relayInstanceId}
            </Text>
            {row.record?.error ? <Text style={styles.error}>{row.record.error.kind}</Text> : null}
            <Rows
              rows={row.record?.result?.mounts ?? []}
              render={(mount) => (
                <Text>
                  {mount.mountId}: {mount.state} {mount.errorKind ?? ""}{" "}
                  {mount.left ? `left ${mount.left} ${mount.branch ?? ""}` : ""}
                </Text>
              )}
            />
            <Button
              title="Query original ID"
              disabled={busy}
              onPress={() =>
                act(async () => {
                  try {
                    await host.operations.reconcile(
                      profile,
                      host.session(profile.id),
                      row.operationId,
                    );
                  } finally {
                    await host.reload();
                  }
                })
              }
            />
            <Button
              title="Acknowledge completed / not-sent record"
              disabled={
                busy ||
                !(
                  row.state === "not-sent" ||
                  (row.state === "observed" &&
                    row.record &&
                    ["succeeded", "failed", "cancelled"].includes(row.record.state))
                )
              }
              onPress={() =>
                act(async () => {
                  let session;
                  try {
                    session = host.session(profile.id);
                  } catch {
                    /* cold observations can be acknowledged offline */
                  }
                  await host.operations.acknowledge(session, row.operationId);
                  await host.reload();
                })
              }
            />
          </Card>
        )}
      />
      <Card title="Server unresolved operations">
        <Rows
          rows={remote}
          render={(row) => (
            <View>
              <Text selectable>{row.operationId}</Text>
              <Text>
                {row.method}: {row.state}
              </Text>
              {row.error ? <Text>{row.error.kind}</Text> : null}
              {row.progress?.recoveryActions.map((action) => (
                <Confirm
                  key={action}
                  title={`${action} operation`}
                  detail="Creates a new explicit recovery operation targeting this original ID. Check the server's remaining effects first."
                  disabled={busy}
                  run={() =>
                    write(
                      action === "continue" ? "operation.continue" : "operation.abandon",
                      { targetOperationId: row.operationId },
                      `${action} operation`,
                    )
                  }
                />
              ))}
            </View>
          )}
        />
      </Card>
    </>
  );
}
export function DevicesScreen(props: ScreenProps) {
  const { host, profile, busy, act } = props;
  const write = useWrite(props);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [read, setRead] = useState(false);
  return (
    <>
      <Text style={styles.heading}>Devices on {profile.label}</Text>
      <Text style={styles.note}>
        Revocation is a server operation. Forgetting a server only removes this phone's saved
        credential. Revoking this phone can make its receipt unknown; it never retries.
      </Text>
      <Button
        title="Read current devices"
        disabled={busy}
        onPress={() =>
          act(async () => {
            const result = requireResult(
              await host.session(profile.id).call("auth.device.list", { includeRevoked: true }),
            );
            setDevices(result.devices);
            setRead(true);
          })
        }
      />
      {!read ? <Text>Devices not queried yet.</Text> : null}
      <Rows
        rows={devices}
        render={(device) => (
          <Card title={device.name}>
            <Text selectable>{device.deviceId}</Text>
            <Text>
              {device.revokedAtMs ? "revoked" : "authorized"} ·{" "}
              {device.neverConnected
                ? "never connected"
                : `last used ${new Date(device.lastUsedAtMs!).toLocaleString()}`}
            </Text>
            <Confirm
              title="Revoke device"
              detail="Closes this device's server connections and rejects its token. This may include the phone you are using."
              disabled={busy || device.revokedAtMs !== null}
              run={() =>
                write("auth.device.revoke", { deviceId: device.deviceId }, "Revoke device")
              }
            />
          </Card>
        )}
      />
    </>
  );
}
