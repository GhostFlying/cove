# Cove 当前交接

更新：2026-10-21。只记录当前状态（不超过 150 行）。恢复工作前先核对 GitHub 与各 checkout；
历史在 Git、Issue 与 PR 中（接管前的长版交接见 `git show 3d7349a:docs/handoff.md`）。

## 授权阶段

- M0 实施于 2026-09-26 获批；2026-10-15 用户批准 M0 退出与 M1 进入，并对 M1 的 D1–D10 作出决定
  （[M1](milestones/m1.md)）。
- **M1 已退出**：用户于 2026-10-21 批准 M1 退出，并只批准 M2 规划。M2 计划草案见 [M2](milestones/m2.md)（PR #142），
  D1–D13 待用户决策；用户批准计划与决策之前不开始任何 M2 实施。
- 合入规则（用户于 2026-10-17 决定，见 AGENTS.md 与[工程 §6.1](engineering-plan.md#61-角色授权与执行入口2026-10-09-用户调整)）：
  所需 CI 全绿且一次完整独立 review 没有未关闭的 P0/P1 时，协调者可 rebase & merge；P2/P3 转为后续 issue。
- 威胁模型：单用户，经认证的用户是受信任的所有者；不防范其自我攻击，判据是不丢数据
  （AGENTS.md「Trust the authenticated owner」）。每个 review 提示都写明这一点。

## Main

- main 为 `ee1f0cc`：M1 的最后一个实现 PR 是 #131（T5），之后合入了 T6 文档与试用修复（#134、#136、#137、#139、#141）。
- 已实现的范围（[M1 交付范围](milestones/m1.md#交付范围)）：
  - 持久 server 身份与 SQLite 存储（数据库在专用 worker thread 中执行，D5/D6），操作记录跨重启去重；
  - repo 注册；task/workspace（入口目录与挂载清单 `cove-workspace.json`）；checkout 与托管 worktree 挂载、
    逐仓结果、`mount retry`、`operation continue/abandon`；
  - checkout 转到独立 worktree（D3）与托管 worktree 删除（D10）、绑定历史；
  - tab/run（注入 `COVE_TASK_ID`/`COVE_TAB_ID`），重启后旧 run 显示为会话中断，不自动重跑；
  - 以上全部经 `cove` CLI 操作，JSON 输出。
- 场景 S1–S10 是启动编译产物的测试（`apps/cli/tests/m1/`），M0 的 S1–S8 在 `apps/cli/tests/scenarios.test.mjs`，
  都在 macOS 与 Ubuntu CI 上运行。
- 用法：[开发说明 · M1 本机试用与 CLI 用法](development.md#m1-本机试用与-cli-用法)；
  tend 可用的接口：[Shepherd/tend 集成说明](integrations/shepherd-tend.md)（PENDING 为空）。

## 本机运行（M2 安装能力合入之前）

1. 在一个单独的 checkout（不是正在开发的 worktree，M1 D7）中按开发说明构建：冻结安装、`pnpm native:prepare`、
   `pnpm build`；用 `node apps/cli/dist/main.js` 作为 `cove`。
2. `cove server init`（可选 `--workspace-root DIR`），再 `cove server start --harness` 前台运行；
   数据目录默认 `~/.cove`，一次性使用可用 `--home DIR`，其他命令带同一个 `--home`。
   用法见[开发说明](development.md#m1-本机试用与-cli-用法)。

## 保留的用户决定

- 恢复期间输入的内容先暂存，视图就绪后发送一次（#83）；控制采用前缀封闭
  （[relay-protocol §9.1](relay-protocol.md#91-focus控制权与自动-resize)）。
- harness 从不自动重试可能已生效的控制命令，也不在没有用户手势时重新取得控制权。
- 协议首个正式版本（含 alpha）之前不提升协议版本、不承诺兼容。
- tend 集成方向已接受但未排期（[设计 §7.1](design.md#71-以-tend-实现-shepherd经-cli-集成方向已接受未排期)）：
  经 CLI，worker 是 Cove tab，需要 `tab send`；位置在 M1 之后，具体 milestone 另行批准。

## 未关闭的后续 issue（不阻塞 M1）

- #87 测试 flake：依赖计时的 `untilTurn` 等待，以及 worker-query-observation 读到截断的 JSON。
- #97 持久操作记录没有保存期限，需要在不破坏去重语义的前提下决定过期规则与重发窗口。
- #100 T1 测试夹具在失败路径上的清理缺口（只涉及测试，用户已豁免为非阻塞）。
- #101 CI：tend 可见接口变化时要求同时修改 Shepherd/tend 集成说明。
- #107 D6 残留：20 RPC/s 时主线程请求路径使回显增加约 0.3–0.6 ms（与数据库无关）。
- #110 repo 注册测试 “escaped descendant closed its output” 偶发找不到 descendant.pid。
- #125 T4 后续：`tab stop --run` 的实例分类、reopen 的 revision 溢出、跨重启停止的覆盖。
- #126 T3b 后续（P2）：远端已删除的主分支可能从陈旧的跟踪 ref 选中、受理时的记录大小上限等。
- #127 run 退役与 run 编号上限的后续（PR #121 第二轮 review 的 P2/P3）。
- #129 macOS 上忽略 SIGTERM 的 git 可能超过期限仍在运行（进程组 KILL 漏掉组长）。
- #132 T5 后续：删除恢复分支、被 lock 的 worktree、`sourceChanges` 解析的独立测试覆盖。
- #23、#24、#25、#28 已移出 M0（兼容参考、混合版本、有界队列与调度、兼容演进），留待后续阶段。

## 未建 issue 的 M0 已知问题

- 在 harness 中点击 xterm 屏幕之外会让键盘焦点离开终端。
- 128 个受控 run 之后 arbiter 返回 BUSY。

## 下一步

1. 用户 review M2 计划（PR #142）并对 D1–D13 作出决定。
2. 计划获批后按 [M2 任务拆分](milestones/m2.md#任务拆分) 派发；在此之前不开始 M2 实施。

## 环境

- 固定工具链：Node 26.10.0、pnpm 12.6.0（见[开发说明](development.md#固定工具版本)），使用前放在 `PATH` 最前面。
- 只能有一个活跃的协调者；接管前的 Codex 自动化保持暂停。
- 接管前的证据目录、M0 试用 server 与其构建目录不在仓库中；清理或停止它们需要用户同意。
