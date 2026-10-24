import type {
  Client,
  ClientSnapshot,
  TerminalController,
  TerminalInputNotice,
  TerminalSnapshot,
} from "@cove/client";

// Ordinary UI actions advance the app's async generation. These subscriptions
// instead belong to the exact host/controller and remain valid until retirement.
export function observeConnectedClient(
  client: Pick<Client, "onState" | "snapshot">,
  current: () => boolean,
  lost: () => void,
): () => void {
  let active = true;
  let subscription: { dispose(): void } | undefined;
  const stop = () => {
    if (!active) return;
    active = false;
    subscription?.dispose();
  };
  const observe = (state: ClientSnapshot) => {
    if (!active || !current() || state.status === "connected") return;
    stop();
    lost();
  };
  subscription = client.onState(observe);
  if (!active) subscription.dispose();
  observe(client.snapshot());
  return stop;
}

export function terminalPresentation(state: TerminalSnapshot): {
  readonly status: string;
  readonly canControl: boolean;
} {
  if (state.phase === "disposed" || state.phase === "unavailable")
    return { status: "终端连接未核实；远端运行状态未知，不会重放输入", canControl: false };
  if (state.execution.status === "exited")
    return { status: "服务端已确认所选 run 退出", canControl: false };
  if (state.phase !== "ready")
    return { status: "终端正在连接或恢复；输入暂不可用", canControl: false };
  if (state.execution.status !== "live")
    return { status: "终端运行状态未核实；输入暂不可用", canControl: false };
  return {
    status: state.inputReady ? "已取得控制" : "终端已连接；控制后点击终端输入",
    canControl: true,
  };
}

function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "未核实";
}

// Keep one bounded display value, not a notice history. Never reflect a raw
// error, input source/value or renderer detail; none authorize replay.
export function inputOutcomePresentation(notice: TerminalInputNotice): string {
  if (notice.kind === "renderer-rejection") return "渲染器拒绝了输入；不会自动重试";
  if (notice.kind === "input-rejections")
    return `输入未发送：拒绝 ${count(notice.count)} 次；不会自动重试`;
  const receipt = notice.outcome.value;
  const label = notice.outcome.ok ? "输入回执" : "输入未完成";
  return `${label}：写入 ${count(receipt.writtenBytes)} B；未知 ${count(receipt.unknownBytes)} B；未发送 ${count(receipt.notSentBytes)} B；不会自动重试`;
}

export function observeTerminal(
  controller: Pick<TerminalController, "onState" | "snapshot" | "onInputOutcome">,
  current: () => boolean,
  state: (value: ReturnType<typeof terminalPresentation>) => void,
  input: (message: string) => void,
): () => void {
  let active = true;
  const observeState = (snapshot: TerminalSnapshot) => {
    if (active && current()) state(terminalPresentation(snapshot));
  };
  const states = controller.onState(observeState);
  const notices = controller.onInputOutcome((notice) => {
    if (active && current()) input(inputOutcomePresentation(notice));
  });
  observeState(controller.snapshot());
  return () => {
    if (!active) return;
    active = false;
    states.dispose();
    notices.dispose();
  };
}
