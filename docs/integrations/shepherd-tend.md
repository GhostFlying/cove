# Shepherd/tend 集成说明

面向 [tend](https://github.com/GhostFlying/tend) 开发者，只记录当前状态。核对基准：Cove main `6a838af`（2026-10-17，T3a PR #109 合入）。
设计与决策见 [设计 §7.1](../design.md#71-以-tend-实现-shepherd经-cli-集成方向已接受未排期)；
本文只说明 tend 现在能用什么、计划提供什么。任何改变下文所列接口的 Cove PR 都必须同时更新本文及其变更记录。

标记：**AVAILABLE** 表示已在 main 上，并注明引入的提交；**PENDING** 表示已在某个未合入的 PR 中实现，注明 PR，合入前仍可能变化，合入后改为 AVAILABLE 并注明合入提交；**PLANNED** 表示已决定或已排期但尚未实现。

## 1. 集成模型

- 每台执行主机上的 tend-runner 调用本机的 `cove` CLI；tend 不连接远端 Cove server。
- Worker 是普通 Cove tab：tend-runner 创建 task/workspace/挂载，再以 agent 命令创建 tab。Cove 不知道 tab 属于 tend。
- tend 不解析终端字节流。Agent hook 配置、rollout/transcript 读取都由 tend-runner 负责；Cove 不实现 agent 状态 hook。
- 无人值守的 TUI agent 由 tend 的启动配方选择不阻塞的权限模式；Cove 不检查。
- 人工接管：人在 Cove 客户端取得该终端的控制权即为接管。tend 观察控制者变化，暂停自动干预；
  人仍持有控制权时 Cove 拒绝程序化输入。观看不是接管。
- tend 判断任务完成不等于停止 run 或删除 worktree；这些需要 tend 显式调用对应 CLI 操作。

## 2. 现在可用（AVAILABLE）

| 能力                     | CLI                                                                                     | 引入                                                                                                             | 说明                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据目录                 | 全局 `--home DIR`，或 `$COVE_HOME`，默认 `~/.cove`                                      | `c02367b`                                                                                                        | 同一数据目录只允许一个 server                                                                                                                                                                                                                 |
| 初始化                   | `cove server init [--workspace-root DIR]`                                               | `c02367b`                                                                                                        | 服务未运行时使用                                                                                                                                                                                                                              |
| 启动 server              | `cove server start [--port N] [--origin URL]...`                                        | `8b06fe4`（未初始化时按默认值初始化：`d99ef5d`）                                                                 | 前台运行                                                                                                                                                                                                                                      |
| 状态                     | `cove status`                                                                           | `8b06fe4`；`workers[]`：`e11f175`                                                                                | 输出新增 `workers[]`：每个存活 terminal worker 的 `health`（`state` 为 `normal` 或 `overloaded`，`reasons` 为 `event-loop-delay`、`heartbeat-gap`、`command-age`）、`stateAgeMs` 与 `signals`。过载只作提示，不影响 run；旧 server 不带该字段 |
| 读取设置                 | `cove config get`                                                                       | `c02367b`                                                                                                        |                                                                                                                                                                                                                                               |
| 修改设置                 | `cove config set workspaceRoot <DIR> [--expected-revision N] [--operation-id ID]`       | `c02367b`                                                                                                        | 只影响之后新建的 workspace                                                                                                                                                                                                                    |
| 重置设置                 | `cove config reset workspaceRoot [--expected-revision N] [--operation-id ID]`           | `c02367b`                                                                                                        | 同上                                                                                                                                                                                                                                          |
| 终端 run（不属于 tab）   | `cove terminal create [--cwd DIR] [--cols N] [--rows N] -- <可执行文件> [参数...]`      | `8b06fe4`                                                                                                        | M0 路径；tab 尚未提供（见 §3）                                                                                                                                                                                                                |
| 查看与停止 run           | `cove terminal list`、`terminal get <runId>`、`terminal stop <runId>`                   | `8b06fe4`                                                                                                        |                                                                                                                                                                                                                                               |
| 操作身份                 | 写命令接受 `--operation-id ID`；`cove operation get <id>`、`cove operation resend <id>` | `c02367b`（重发只发保存的请求：`2d89043`）                                                                       | 首次发送前把请求保存为本机待定记录；`resend` 只向原 server 原样重发，已有记录时返回原记录、不重复执行                                                                                                                                         |
| Repo 注册                | `cove repo register/list/get/set/reset/remove`                                          | `200e24d`（T2）；`REPO_IN_USE`：`09a61c3`                                                                        | 注册不改动 clone；`remove` 只删除注册，仍有挂载引用时拒绝（见下文 T3a）                                                                                                                                                                       |
| Task 与 workspace        | `cove task create/list/get/rename/archive/unarchive`                                    | `3d65dc4`（CLI）、`fc41992`（server），T3a                                                                       | 见下文 T3a                                                                                                                                                                                                                                    |
| Checkout 挂载            | `cove mount add <taskId> --checkout SPEC`、`cove mount remove <taskId> <mountId>`       | `3d65dc4`、`fc41992`，T3a                                                                                        | 托管 worktree 挂载尚未提供（见 §3）；见下文 T3a                                                                                                                                                                                               |
| 重启后的 run 与操作记录  | server 停止与启动时处理，无单独命令                                                     | `d99ef5d`（存储原语：`299514d`）                                                                                 | 正常停止时当前实例存活的 run 记为 stopped-with-server；启动时，旧实例中仍为 starting/running（没有结束记录）的 run 记为 interrupted/unverifiable，已有的结束记录不变；不探测旧 PID、不重跑。无法证明结果的操作为 requires_attention           |
| 输出                     | 每个命令向 stdout 输出 JSON                                                             | `8b06fe4`                                                                                                        | 尚无版本号与稳定性承诺（见 §6）                                                                                                                                                                                                               |
| 退出码与错误             | 0 成功，2 用法错误，1 其他错误                                                          | `8b06fe4`                                                                                                        | CLI 自身的错误以 `cove: <消息>` 写到 stderr，尚无结构化错误输出                                                                                                                                                                               |
| 子 server 进程的退出状态 | `cove server start`、`cove server init`                                                 | `0a76f8c`（start 保留退出状态，信号为 128+N）、`2d3628a`（就绪前退出时同样保留）、`c02367b`（init 使用同一映射） | 原样转发子 server 进程的 stderr，并以其退出状态结束；`8b06fe4` 时信号结束的 server 仍返回 1                                                                                                                                                   |

T3a（PR #109，合入于 `6a838af`；server `fc41992`，`repo remove` 的 `REPO_IN_USE` `09a61c3`，CLI `3d65dc4`）：

- `cove repo remove` 在仍有任一 task（含已归档）的挂载引用该 repo 时返回 `REPO_IN_USE`，先 `cove mount remove`。
- `cove task create <标题> [--checkout SPEC]... [--worktree SPEC]...`、`task list [--archived exclude/include/only]`、
  `task get`、`task rename`、`task archive`、`task unarchive`。每个 task 一个入口目录
  `<workspaceRoot>/<slug>-<短 ID>`（0700），内有挂载清单 `cove-workspace.json`（0600；每个挂载的名称、真实路径、
  来源、`readOnly`、状态）；checkout 不建链接，经清单中的真实路径访问。归档只改可见性。入口路径已被占用或
  workspace 根目录无法创建时 `task create` 返回 `WORKSPACE_ENTRY_UNAVAILABLE`，不记录任何内容。
- `cove mount add <taskId> (--checkout SPEC | --worktree SPEC)`、`cove mount remove <taskId> <mountId>`，
  `--expected-revision` 为 workspace revision。checkout SPEC：`REPO_ID[,name=N][,path=P]`（`path=` 在最后）；
  Cove 托管的 worktree 不能作为 checkout（`MANAGED_WORKTREE_NOT_MOUNTABLE`）。移除挂载从不删除目录，
  已归档 task 也允许。`--worktree` 在 #124（T3b）合入之前以 `CAPABILITY_UNAVAILABLE` 拒绝且不记录任何内容
  （`task create` 中的其他挂载也不创建）；合入后的行为见下面的 #124。会使 task 记录无法放进一次读取响应的 `task create` 或 `mount add`
  （例如很多真实路径极长的挂载）以 `INVALID_ARGUMENT` 拒绝且不记录。server 的文件系统工作已满（被放弃且
  尚未结束的检查占满上限）时，`task create` 与 `mount add` 以 `BUSY` 拒绝（未接受、不记录，稍后以同一请求
  重试）。`task list` 由 CLI 取完所有页后输出。
- JSON 输出（`task get`、`task list`、`task create`、`mount add`、`mount remove`）：task 记录含
  `workspace.entryState`（ready、pending、missing，或入口路径上有 Cove 不拥有的东西、路径已改变时为
  unavailable；属于记录中返回的 workspace revision）与每个挂载的 `state`：checkout 在每次读取时核对，目录
  不在或已不是被准入的 checkout（其他 clone、普通目录、符号链接、托管 worktree、`.git` 已不在）时为 missing，
  无法核对（Git 未应答或超时、无权限、`.git` 在但 Git 拒绝读取，如 safe.directory）时为 unavailable，从不丢弃。
  读取在约 3 秒内返回，届时未完成的核对为 unavailable。`sharedWithTaskIds` 含已归档 task，直到其挂载移除。CLI 为每个挂载加
  `readOnlyUse`，有 checkout 时加 `notice`。`task create`、`mount add/remove` 输出 `{ operation, task }`，
  操作未成功时仍输出并以 1 退出。

## 3. 进行中（PENDING）与计划中（PLANNED）

PENDING：PR #124（T3b：托管 worktree 创建），未合入：

- `--worktree REPO_ID[,name=N][,branch=B][,base=REF][,no-fetch]`（`task create` 可多个，`mount add` 一个）
  在 `<入口目录>/<name>` 创建 Cove 托管的 worktree，新分支 B 默认 `cove/<slug>`，已存在时该挂载以
  `BRANCH_EXISTS` 失败。创建前从 `origin` fetch；fetch 失败时该挂载以 `FETCH_FAILED` 失败且不创建任何东西，
  只有显式 `no-fetch` 跳过 fetch。基点依次为：`base=REF`；repo 的 `mainBranch` 设置对应的
  `origin/<分支>`（远端没有时不换别的分支）；`origin/HEAD`；远端 HEAD（`ls-remote`，`no-fetch` 时不问）；
  `origin/main`、`master`、`trunk`、`develop` 中第一个存在的。从不用本地 HEAD，都没有时为
  `MAIN_BRANCH_UNRESOLVED`。挂载先记为 pending，命令等待各仓依次准备完（最多约 30 秒轮询，与其他写命令相同）。
- 逐仓结果：`operation.result.mounts[]` 每项 `{mountId, state, errorKind?}`；一个仓失败不影响其他仓，
  操作以第一个失败挂载的错误为 `failed`，已创建的 worktree 保留。task 记录中 worktree 挂载的
  `branch`、`baseCommit` 有值；每次挂载状态变化都使 workspace revision 加一。被手工删除的托管 worktree
  读取时为 missing，不会重建。准备中的 worktree 挂载不能 `mount remove`（`OPERATION_EFFECTS_ACTIVE`）。
- 新命令 `cove mount retry <taskId> <mountId> [--branch B] [--base REF] [--no-fetch] [--operation-id ID]`：
  只对失败的 worktree 挂载，作为新操作重新准备；未给的选项沿用添加时的设置。输出 `{ operation, task }`，
  成功为 0，否则 1。
- 新命令 `cove operation continue <id> [--operation-id ID]` 与 `cove operation abandon <id> [--operation-id ID]`：
  作用于 `requires_attention` 的操作（例如 server 在 Git 步骤中崩溃，重启后该操作带
  `progress.completedSteps`、`remainingEffects`、`recoveryActions`），各自是有自己操作 ID 的写操作。
  该操作启动的 Git 进程可能仍在运行时两者都以 `OPERATION_EFFECTS_ACTIVE` 拒绝（未接受，稍后以同一请求再发）。
  continue 按当前观察继续，不重复已生效的步骤；abandon 把目标改为 `cancelled`，只删除与记录完全一致的
  产物（干净或未检出的 worktree、仍在基点的分支），其余留在原处并列入 `progress.remainingEffects`，
  该挂载变为 failed（`OPERATION_NOT_RESUMABLE`），可再 `mount retry`。输出 `{ operation, target }`；
  continue 在目标 succeeded 时为 0，abandon 在目标 cancelled 时为 0（有遗留时 stderr 写
  `left in place: ...`），否则 1。
- 新的 stderr 提示（`cove: ` 开头，只供人读，不是结构化输出）：`requires_attention` 时提示 continue/abandon；
  `FETCH_FAILED` 提示 `mount retry ... --no-fetch`；`MAIN_BRANCH_UNRESOLVED` 提示 `--base REF` 或
  `repo set <repoId> mainBranch`；`BRANCH_EXISTS` 提示 `--branch NEW`。

PLANNED：

M1（已批准，实施中，见 [M1](../milestones/m1.md)）：

- `tab create/stop/reopen/close` 与 run 历史；`tab create` 保存启动配方（可执行文件与参数），默认 cwd 为 workspace 入口目录。
  注入 `COVE_TASK_ID` 等少量 Cove 标识，不保存其他环境变量。
- 重启后 run 显示为会话中断的 CLI 读取路径。

M1 之后（方向已接受，未排期，见设计 §7.1“已决定”）：

- 只读事件/等待接口（如 `cove tab watch --json`、`cove events --json --since <cursor>`）：run 启动/退出/中断与控制者变化。
- `tab get` 显示控制者（持有控制权的设备与 controlEpoch，或无）。
- 程序化输入 `tab send`（规则见 §4）。
- 启动配方的有界环境变量与每 run 临时值（见 §5）。
- 有版本的 CLI JSON 契约（见 §6）。

## 4. 程序化输入（PLANNED）

- 必须携带观测到的 runId、relayInstanceId 与 controlEpoch，并带 `--operation-id`；三者都是执行前提，写入操作指纹，
  只写向该确切 run。已有相同操作记录时直接返回原记录。
- 只在没有控制者且 epoch 未变时接受；不取得控制权，也不 resize。之后若有人取得控制权，已排队的输入被丢弃并报告。
- 一次 send 有大小上限，但不是原子写入。结果为成功、拒绝（未写入）、部分写入或不确定，并带已写前缀与未知字节数。
  部分写入与不确定不会自动重发；tend 也不应盲目重发。重启后遗留的未决 send 只能核实或放弃。
- 前缀封闭：同一 run 上任一 send 未完整写入时，其后已排队的 send 全部失败、不写入。
  tend 只在确认前一个 send 完整写入后才发送依赖它的输入。
- 可选结尾提交键：只在文本完整写入后发送。各 TUI（Claude Code、Codex）的实际行为在实现时验证。

## 5. 重启与环境变量

- Server 正常停止时，当前实例存活的 run 记为 stopped-with-server（随 server 停止而结束）；崩溃或被强杀后，
  下次启动把旧实例中仍为 starting/running、没有结束记录的 run 记为会话中断（interrupted/unverifiable），
  已有结束记录的 run 保持不变。任何情况都不重跑（记录已 AVAILABLE，CLI 读取路径见 §3）。
  是否继续由 tend 决定：用 agent 的 resume 命令新建 tab。`tab reopen` 只按原配方新建 run，不能临时改参数。
- 配方环境变量（PLANNED）：条数与字节有上限（实现时公布），不得覆盖 `PATH`、`HOME` 等受保护变量及 `COVE_` 前缀；
  值随配方保存并在 `tab get` 中可见，因此不得放机密。
- 每 run 临时值（PLANNED）：只用于本次 run，不落库、不进入操作记录、不随 reopen 复用，适合 hook 令牌；
  `tab get` 只显示名称。Cove 不在日志中写入任何环境变量值。

## 6. 兼容性

- 首个正式发布（含 alpha）之前，CLI 命令、参数、JSON 字段与退出码都可能变化，没有稳定性承诺。
  变化会记录在下面的变更记录中。
- 计划中的 CLI JSON 契约有自己的版本，独立于应用发布与协议版本：同一主版本只做兼容扩展，
  消费者应忽略未知字段、把未知枚举值当作未知；移除或改变语义需升级主版本。

## 7. 变更记录

| 日期       | Cove 提交                           | 对 tend 的变化                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | main `399c20b` 时建立本文           | 首次列出 §2 的可用接口；记录设计 §7.1 的已决定事项（`tab send` 规则、环境变量、重启）                                                                                                                                                                                                                                                                                             |
| 2026-10-16 | main `399c20b`                      | 更正：重启语义区分正常停止与崩溃，引入提交改为 `d99ef5d`；拆分 `config` 行；区分 CLI 错误与子 server 进程的输出                                                                                                                                                                                                                                                                   |
| 2026-10-16 | main `399c20b`                      | 更正：子 server 进程退出状态单列一行，注明 `0a76f8c`、`2d3628a`、`c02367b`                                                                                                                                                                                                                                                                                                        |
| 2026-10-16 | main `e11f175`（PR #105）           | `cove status` 输出新增 `workers[]`（worker 过载状态，只作提示），由 `e11f175` “feat(terminal): report an overloaded worker without acting on it” 引入                                                                                                                                                                                                                             |
| 2026-10-17 | main `deb33ea`；#109（T3a，未合入） | 基准改为 main `deb33ea`；新增 `repo`（T2，`200e24d`）；新增 PENDING 标记，列出 #109 的 `task`、`mount add/remove`、task 的 JSON 输出（含 unavailable 与读取预算）、记录过大时的 `INVALID_ARGUMENT`、文件系统工作已满时的 `BUSY` 与 `repo remove` 的 `REPO_IN_USE`                                                                                                                 |
| 2026-10-17 | main `47229e6`；#109（T3a，未合入） | 基准改为 main `47229e6`；`deb33ea` 之后的 `b62d876`、`a568b22`、`0db08c8`、`47229e6` 只改 CI、测试、terminal-web 与 m0-harness，本文所列接口不变                                                                                                                                                                                                                                  |
| 2026-10-17 | main `6a838af`（PR #109）           | 基准改为 main `6a838af`；T3a 合入，#109 的 PENDING 项改为 AVAILABLE：`task` 与 `mount add/remove`、task 的 JSON 输出、`INVALID_ARGUMENT` 与 `BUSY` 的拒绝由 `fc41992`（server）与 `3d65dc4`（CLI）引入，`repo remove` 的 `REPO_IN_USE` 由 `09a61c3` 引入                                                                                                                          |
| 2026-10-17 | main `0bba191`；#124（T3b，未合入） | 基准改为 main `0bba191`（`6a838af` 之后只有 server 内部修复、测试与本文的 T3a 记录，所列接口不变）；新增 PENDING 标记，列出 #124 的 `--worktree` 创建（fetch、基点顺序、`no-fetch`、`BRANCH_EXISTS`、`FETCH_FAILED`、`MAIN_BRANCH_UNRESOLVED`）、逐仓结果、`mount retry`、`operation continue/abandon`（含 `OPERATION_EFFECTS_ACTIVE`）与新的 stderr 提示；PLANNED 中相应条目移除 |
