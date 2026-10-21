# Shepherd/tend 集成说明

面向 [tend](https://github.com/GhostFlying/tend) 开发者，只记录当前状态。核对基准：Cove main `9638501`（2026-10-21，PR #136 合入）。
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
| 终端 run（不属于 tab）   | `cove terminal create [--cwd DIR] [--cols N] [--rows N] -- <可执行文件> [参数...]`      | `8b06fe4`；run ID 编号：`c63d7cd`、`373cf71`                                                                     | M0 路径；不注入 Cove 标识。tab 与 run ID 编号见下文 T4                                                                                                                                                                                        |
| 查看与停止 run           | `cove terminal list`、`terminal get <runId>`、`terminal stop <runId>`                   | `8b06fe4`                                                                                                        |                                                                                                                                                                                                                                               |
| 操作身份                 | 写命令接受 `--operation-id ID`；`cove operation get <id>`、`cove operation resend <id>` | `c02367b`（重发只发保存的请求：`2d89043`）                                                                       | 首次发送前把请求保存为本机待定记录；`resend` 只向原 server 原样重发，已有记录时返回原记录、不重复执行                                                                                                                                         |
| Repo 注册                | `cove repo register/list/get/set/reset/remove`                                          | `200e24d`（T2）；`REPO_IN_USE`：`09a61c3`                                                                        | 注册不改动 clone；`remove` 只删除注册，仍有挂载引用时拒绝（见下文 T3a）                                                                                                                                                                       |
| Task 与 workspace        | `cove task create/list/get/rename/archive/unarchive`                                    | `3d65dc4`（CLI）、`fc41992`（server），T3a                                                                       | 见下文 T3a                                                                                                                                                                                                                                    |
| Tab 与 run               | `cove tab create/list/get/runs/reopen/stop/close`                                       | `c63d7cd`（server）、`d6f495a`（CLI），T4                                                                        | 见下文 T4                                                                                                                                                                                                                                     |
| Checkout 挂载            | `cove mount add <taskId> --checkout SPEC`、`cove mount remove <taskId> <mountId>`       | `3d65dc4`、`fc41992`，T3a                                                                                        | 见下文 T3a；托管 worktree 挂载见下一行                                                                                                                                                                                                        |
| 托管 worktree 挂载       | `--worktree SPEC`、`cove mount retry`、`cove operation continue/abandon`                | `79106c0`（protocol）、`4df69ac`（server）、`b2f71b2`（CLI），T3b                                                | 见下文 T3b                                                                                                                                                                                                                                    |
| 绑定变更与 worktree 删除 | `cove mount convert`、`cove mount delete-worktree`、`cove mount history`                | `1a4bfe2`（protocol）、`18d15be`（server）、`e1699fd`（CLI），T5                                                 | 见下文 T5                                                                                                                                                                                                                                     |
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
  已归档 task 也允许。`--worktree` 见下文 T3b。会使 task 记录无法放进一次读取响应的 `task create` 或 `mount add`
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

T4（PR #121，合入于 `ffa1910`；server `c63d7cd`，被拒 spawn 的 run 退役 `99bb65e`，run ID 不重发 `373cf71`，CLI `d6f495a`，tab 读取失败的输出 `9c867d8`）：

- `cove tab create <taskId> [--name N] [--cwd entry|mount:MOUNT_ID] [--start yes|no] [--cols N --rows N] [-- <可执行文件> [参数...]]`：
  记录 tab（名称、启动配方、cwd），默认立即启动首个 run。`--` 之后为配方；省略时为 server 用户的登录 shell
  （`-l`）。cwd 默认为 workspace 入口目录；`mount:` 须是记录为 ready 的挂载，已移除为 `MOUNT_NOT_FOUND`，
  未 ready 为 `INVALID_ARGUMENT`。不传 `--cols/--rows` 时由 server 取默认尺寸（80×24），因此以同一
  `--operation-id` 重建的请求指纹不变。已归档 task 返回 `TASK_ARCHIVED`。
- `cove tab list <taskId>`、`tab get <tabId>`（`{ tab, latestRun }`）、`tab runs <tabId>`（新到旧，CLI 取完所有页）。
- `cove tab reopen <tabId>`：按记录的配方新建 run（新 runId），旧 run 留在历史中；`cove tab stop <tabId> [--run RUN_ID]`：
  停止最新的 run 并等到其退出；`cove tab close <tabId>`：删除 tab 记录，其 run 仍保留（`tabId` 变为 null）。
  tab 有未结束的 run（starting/running，包括 worker 失联而无法核实的 run）时，`reopen` 与 `close` 以
  `LIVE_RUNS_PRESENT` 拒绝。`--run` 不是最新 run 时为 `REVISION_CONFLICT`，旧实例的 run 为 `INSTANCE_MISMATCH`。
- 写命令的输出分两类，与 `repo`、`task`、`mount` 相同。**受理前的拒绝**（RPC 错误，未记录任何操作）：stdout 为空，
  stderr 为 `cove: <method> failed: <KIND> (<acceptance>, next: <nextAction>)`，退出 1；包括 `LIVE_RUNS_PRESENT`、
  `TASK_NOT_FOUND`、`TAB_NOT_FOUND`、`MOUNT_NOT_FOUND`、`TASK_ARCHIVED`、`INVALID_ARGUMENT`、`REVISION_CONFLICT`、
  `INSTANCE_MISMATCH`、`BUSY`。错误的 `details`（如 `LIVE_RUNS_PRESENT` 列出的 run）不输出，用 `tab get`/`tab runs`
  查看。**已受理的操作**：CLI 等到操作结算后输出，记录可用 `cove operation get` 再读。
  - `tab create`、`tab reopen`、`tab stop`：结算后再读一次 tab，输出 `{ operation, tab, latestRun }`（`latestRun`
    在 tab 尚无 run 时为 null）。操作不指向 tab，或 server 确认 tab 已不存在（`TAB_NOT_FOUND`，例如以同一
    `--operation-id` 重发的 create，其 tab 已被 close）时为 `tab: null, latestRun: null`。这次读取本身失败
    （连接中断、超时等）时输出 `{ operation, tabReadError }`，不含 `tab` 与 `latestRun`，stderr 说明并以 1 退出；
    `operation` 仍是写入的结果，不要因此重发。操作未成功（failed、requires_attention 等）时同样输出并以 1 退出。
    首个 run 被 worker 拒绝时 tab 仍保留（无 run），操作为 failed，结果中给出该 tab。
  - `tab close`：成功时输出操作记录本身（不包在 `{ operation }` 中，与 `task rename/archive` 相同）；操作未成功时
    stdout 为空，stderr 为 `cove: tab.close <operationId> <state>[: <KIND>]`，退出 1。
- run 记录（`latestRun` 与 `runs[]`）：`run`、`tabId`、`taskId`、启动时的 `workspaceRevision`、`cwd`、
  `mounts`（启动时各挂载的名称、来源、真实路径，之后的绑定变化不改写）、`lifecycle`（starting、running、exited、
  stopped-with-server、interrupted）、`verification`（live、unverifiable、final）、`startedAtMs`、`endedAtMs`、
  `lastObservedAtMs`、`exitCode`、`signal`。当前实例的 run 只在 worker 报告存活时为 live，worker 失联时为
  unverifiable，只有退出事实才使其 exited。重启后旧实例的 run 为 stopped-with-server 或 interrupted，从不为 live。
- tab 的 run 也是普通终端 run，出现在 `cove terminal list` 中。
- run ID 仍为 `run-N`，但新实例从本 server 发出过的最大 N 之后继续编号（此前每个实例都从 `run-1` 开始），
  包括 spawn 被拒、没有 run 记录、只在 failed 操作中出现的 run ID，因此同一 server 的 run ID 从不重发，
  按 run ID 固定的 `tab stop --run` 不会匹配到别的 run；也适用于 `cove terminal create`。spawn 被 worker 明确拒绝的
  run 不出现在 `cove terminal list` 中。
- tab 中运行的进程从环境变量得知自己所属的 task 与 tab，见下文 #120。

#120（PR #128，合入于 `64de013`；protocol `341011e`，worker `8dd7a10`，server `a4c8f15`）：

- tab 的每个 run（`tab create` 启动的首个 run 与 `tab reopen` 的 run）的环境中有 `COVE_TASK_ID`（所属 task 的
  `taskId`）与 `COVE_TAB_ID`（所属 tab 的 `tabId`），其余环境变量继承自 server。只注入这两个，不注入 run ID 或
  server ID（用 `tab get` 读取 `latestRun`）。值与 `tab get` 中的 ID 相同，因此是 1–40 个 `[A-Za-z0-9._-]` 字符。
- `cove terminal create` 的 run 不属于 tab，没有这两个变量。server 从自己的环境继承到的同名变量（例如在 Cove tab
  中启动 server）不会传给任何 run：tab 的 run 得到自己的值，`terminal create` 的 run 得不到值。
- 不保存其他环境变量；不能经 CLI 或 RPC 传入任意环境变量（配方环境变量见下文 PLANNED）。
- CLI 命令、参数、JSON 输出与退出码都不变。

T3b（PR #124，合入于 `66048d7`；protocol `79106c0`，server `4df69ac`，CLI `b2f71b2`）：

- `--worktree REPO_ID[,name=N][,branch=B][,base=REF][,no-fetch]`（`task create` 可多个，`mount add` 一个）
  在 `<入口目录>/<name>` 创建 Cove 托管的 worktree，新分支 B 默认 `cove/<slug>`，已存在时该挂载以
  `BRANCH_EXISTS` 失败。创建前从 `origin` fetch；fetch 失败时该挂载以 `FETCH_FAILED` 失败且不创建任何东西，
  只有显式 `no-fetch` 跳过 fetch。基点依次为：`base=REF`；repo 的 `mainBranch` 设置对应的
  `origin/<分支>`（远端没有时不换别的分支）；`origin/HEAD`；远端 HEAD（`ls-remote`，`no-fetch` 时不问）；
  `origin/main`、`master`、`trunk`、`develop` 中第一个存在的。从不用本地 HEAD，都没有时为
  `MAIN_BRANCH_UNRESOLVED`。挂载先记为 pending，命令等待各仓依次准备完（最多约 30 秒轮询，与其他写命令相同）。
  fetch 与 `ls-remote` 沿用运行 server 的用户的 SSH agent（`SSH_AUTH_SOCK`），从不交互提示（无终端提示、无 askpass），
  需要口令的远端直接 `FETCH_FAILED`。
- 同时准备 worktree 的操作有上限（默认 2 个执行、8 个排队）；超出时 `task create`/`mount add`（含 `--worktree`）、
  `mount retry`、`operation continue/abandon` 以 `BUSY` 拒绝（未接受，稍后以同一请求再发）。受理前的分支名检查
  也占用 server 共享的 Git 槽位，槽位在期限内未空出时同样以 `BUSY` 拒绝。
- 逐仓结果：`operation.result.mounts[]` 每项 `{mountId, state, errorKind?, left?}`；`left`（`worktree`、`branch`
  或 `both`）只出现在失败的挂载上，表示留在原处的产物：删除它可能丢失工作，因此 Cove 没有删除；
  带 `left` 的结果不带 `sourceChanges` 与 `targetOperationId`。一个仓失败不影响其他仓，
  操作以第一个失败挂载的错误为 `failed`，已创建的 worktree 保留。task 记录中 worktree 挂载的
  `branch`、`baseCommit` 有值；每次挂载状态变化都使 workspace revision 加一。被手工删除的托管 worktree
  读取时为 missing，不会重建。准备中的 worktree 挂载，以及所属操作尚未结束（含 `requires_attention`）的
  worktree 挂载，不能 `mount remove` 或 `mount retry`（`OPERATION_EFFECTS_ACTIVE`）；操作的结果在最后一个挂载
  结束的同一事务中写入。
- 新命令 `cove mount retry <taskId> <mountId> [--branch B] [--base REF] [--no-fetch] [--operation-id ID]`：
  只对失败的 worktree 挂载，作为新操作重新准备；未给的选项沿用添加时的设置。上一次尝试记录的 Git 进程可能
  仍在运行时以 `OPERATION_EFFECTS_ACTIVE` 拒绝。输出 `{ operation, task }`，成功为 0，否则 1。`--no-fetch` 只能打开“跳过 fetch”：以 `no-fetch` 添加的挂载在重试时也不 fetch，M1 不提供改回 fetch 的选项。
- 新命令 `cove operation continue <id> [--operation-id ID]` 与 `cove operation abandon <id> [--operation-id ID]`：
  作用于 `requires_attention` 的操作，各自是有自己操作 ID 的写操作。`requires_attention` 出现于：server 在 Git
  步骤中崩溃后重启；某步骤（含 fetch）超时、未看到结束，即使状态看起来已完成；workspace 入口目录被替换；
  已记录完成的分支或 worktree 消失或改变（包括目录被删除而 Git 仍登记该 worktree）；检出前 worktree 中已有
  文件或暂存内容（不检出，以免覆盖）。记录带 `progress.completedSteps`（可含 `fetch`、`base`、`intent`、
  `branch`、`worktree`、`checkout`）、`remainingEffects`（另可含 `record`、`remove-worktree`、`delete-branch`、
  `git-process`、`more-mounts`、`cleanup`）与 `recoveryActions`。该操作启动的 Git 进程可能仍在运行时两者都以
  `OPERATION_EFFECTS_ACTIVE` 拒绝（未接受，稍后以同一请求再发）。continue 按记录的步骤继续：对未看到结束的步骤先
  重新观察状态，看它是否恰是该步骤按记录意图产生的结果（分支看形状，worktree 看其内容），确定不了就再次停在
  `requires_attention`，不重复已生效的步骤。abandon 先被接受（running），之后清理记录中记入的、从未 ready 的产物：
  注册在记录路径与该分支上的 worktree，不论检出是否执行过，都以普通的 `git worktree remove <path>`（不加 `--force`）
  删除，Git 因任何原因拒绝（有改动或未跟踪文件等）时保留，这是唯一的防护，被忽略的文件随之删除；目录中只有
  `.git` 且没有 index 的未检出 worktree 直接删除；分支仍在基点、不是符号引用、未被其他 worktree 检出时删除
  （保留下来的 worktree 检出着它，分支也随之保留）。其余留在原处，列入目标的 `progress.remainingEffects` 与挂载结果的 `left`，目标变为 `cancelled`，该挂载变为
  failed（`OPERATION_NOT_RESUMABLE`），可再 `mount retry`。abandon 进行期间对 clone 或 worktree 的并发改动不受防护。
  abandon 未能完成时自身为 `requires_attention`（`recoveryActions: ["continue"]`），对它 continue 即重新核实并继续
  删除；进行中的 abandon 占有目标，此时对目标的 continue/abandon 以 `OPERATION_EFFECTS_ACTIVE` 拒绝；超时后仍可能
  在运行的删除结束前，对 abandon 的 continue 同样以 `OPERATION_EFFECTS_ACTIVE` 拒绝。输出
  `{ operation, target, leftovers }`，`leftovers` 为 `[{mountId, path, branch, repoPath, effects}]`（由挂载结果的
  `left` 与 task.get、repo.get 联合而来，查不到的字段为 null；没有遗留时为 `[]`）；continue 在目标 succeeded 时为 0，
  abandon 在目标 cancelled 时为 0（有遗留时 stderr 写 `left in place: ...`），否则 1。`task create`、`mount add`、
  `mount retry` 失败且有遗留时，输出同样带 `leftovers`（没有遗留时不带此字段）。
- 新的 stderr 提示（`cove: ` 开头，只供人读，不是结构化输出）：`requires_attention` 时按记录的
  `recoveryActions` 提示 continue/abandon（未能完成的 abandon 只提示对它 continue）；
  `FETCH_FAILED` 提示 `mount retry ... --no-fetch`；`MAIN_BRANCH_UNRESOLVED` 提示 `--base REF` 或
  `repo set <repoId> mainBranch`；`BRANCH_EXISTS` 提示 `--branch NEW`；每个遗留提示人工检查后可执行的命令
  `git -C <repo> worktree remove <path>`、`git -C <repo> branch -d <branch>`（Cove 不执行）。

T5（PR #131，合入于 `ea4fe84`；绑定变更与托管 worktree 删除，见 [M1](../milestones/m1.md) D3/D10。protocol `1a4bfe2`、
失败删除记录中的阻塞 run `c986851`；server `18d15be`，删除期间拒绝 run `90a5c9f`、`f9b68a0`，核实后才切换绑定 `87f0257`，
`terminal create` 的 cwd 按真实路径记录与判断 `2b470b7`、`cd18f13`；CLI `e1699fd`；受理后失败的删除列出阻塞 run `8d7c59f`（server 与 CLI））：

- `cove mount convert <taskId> <mountId> [--branch B] [--base REF] [--no-fetch] [--expected-revision N] [--operation-id ID]`：
  把 ready 的 checkout 挂载换成同仓库的新托管 worktree（`<entry>/<name>`，基准规则与 `--worktree` 创建相同），
  保留 mountId 与名称。输出与 `mount add` 相同（`{operation, task[, leftovers]}`），成功以 0 退出；操作结果带
  `sourceChanges: {staged, unstaged, untracked}`（来源 checkout 的改动计数，改动留在来源，不进入新 worktree；
  有改动时 stderr 另有一行提示）。**目标核实 ready 之前挂载仍是 checkout**：准备期间 `task get`、清单与新 run
  （含入口 tab）看到的都是 checkout，revision 不变；成功时挂载才变为 worktree，revision 加一。准备失败或被放弃时
  checkout 仍是当前绑定，操作为 failed / cancelled，`left` 与 T3b 相同（`leftovers` 的路径为 `<entry>/<name>`，
  分支为 null）。目标已 ready、但切换时前提不再成立（准备期间本 task 有 run 开始使用该 checkout）时，操作为
  `requires_attention`，`error.kind` 为原因（如 `LIVE_RUNS_PRESENT`），`progress.remainingEffects` 为
  `["switch-binding"]`：结束该 run 后 `operation continue` 完成切换，`operation abandon` 删除目标。转换未结束时
  该挂载的 `mount remove` 与再次转换为 `OPERATION_EFFECTS_ACTIVE`。本 task 有使用该 checkout 的存活 run 时受理前
  拒绝 `LIVE_RUNS_PRESENT`；挂载不是 ready 的 checkout、或 task 已归档时 `INVALID_ARGUMENT` / `TASK_ARCHIVED`。
- `cove mount delete-worktree <taskId> <mountId> [--yes] [--expected-revision N] [--operation-id ID]`：删除挂载的托管
  worktree（含未提交与未跟踪的改动，`git worktree remove --force`）并移除挂载，分支保留；也适用于失败或放弃的准备
  留下的 worktree（`left`）。**脚本必须传 `--yes`**：无终端且无 `--yes` 时以 2 退出、stdout 为空、不发送请求；
  终端上 y/N 询问，回答非 y 时以 1 退出、不发送请求。成功时输出 `{operation, task}` 并以 0 退出（挂载已不在 task 中）。
  受理前的拒绝：有存活 run 使用它 `LIVE_RUNS_PRESENT`；checkout 挂载或没有可删的托管 worktree `INVALID_ARGUMENT`；
  挂载的准备或另一次删除未结束 `OPERATION_EFFECTS_ACTIVE`。受理后什么都没删除时操作为 failed（挂载恢复原状态）：
  `LIVE_RUNS_PRESENT`、`GIT_UNAVAILABLE`（含 Git 拒绝，例如被 lock 的 worktree）或 `INVALID_ARGUMENT`（路径上不是
  Git 已知的 worktree）。删除未能确认（重启、Git 步骤未看到结束）时为 `requires_attention`，`recoveryActions` 只有
  `continue`；删除不能 abandon（`OPERATION_NOT_RESUMABLE`）。删除期间挂载为 pending，且
  **不接受使用该 worktree 的新 run**：该 task 的入口 tab（其挂载映射包含全部挂载）、以该挂载为 cwd 的 tab，以及
  cwd 在该 worktree 下的 `terminal create`（cwd 按真实路径判断，经 `/tmp` 这类已有别名给出的也算；无法解析时不受理：不存在或非目录为 `INVALID_ARGUMENT`，其他为 `BUSY`；存活 run 的
  检查同样如此），`tab create`/`tab reopen`/`terminal create` 均以
  `OPERATION_EFFECTS_ACTIVE` 拒绝；删除结束后恢复。受理后才发现 run 的 failed 记录中，`error.details.runs` 至多
  带 4 个 run（存储的操作记录只有这一种情形带错误详情）。
- `LIVE_RUNS_PRESENT` 拒绝时，`mount convert` 与 `mount delete-worktree` 在 stderr 为每个 run 打一行
  `cove: live run <runId> uses the path; ...`（只供人读）；`mount delete-worktree` 对受理后失败的记录中带的 run
  同样打印。
- `cove mount history <taskId> <mountId>`：输出 `{bindings: [{workspaceRevision, mountId, source, path, branch, boundAtMs, unboundAtMs}]}`，
  按时间先后，当前绑定 `unboundAtMs` 为 null；挂载移除或 worktree 删除后仍可查询；task 不存在 `TASK_NOT_FOUND`，
  挂载从未存在 `MOUNT_NOT_FOUND`。

CLI 试用可用性（PR #134，合入于 `fe0fc13`；只改 CLI，协议与 server 不变；新写法发送的请求与原写法相同，stdout 的 JSON 形状不变。按组的帮助 `ff67ee5`、`7c0f721`；`--checkout PATH` `6138f38`、`3216929`、`d57a5b1`；`mount convert` 省略 mountId `fffa407`；`mount delete-worktree` 省略 mountId 与 PATH `be97856`、`3b6625a`；`LIVE_RUNS_PRESENT` 的 run 提示 `9db122f`、`2562057`）：

- 帮助：`cove help`、`cove --help` 打印完整 usage，`cove help <组>`、`cove <组> --help`（`--` 之前任意位置）只打印
  该组；显式请求的帮助写到 stdout 并以 0 退出（此前 `--help` 是用法错误），命令其余部分不完整（如选项缺值）时也是如此。`cove <组>` 不带子命令与组内的用法错误
  仍以 2 退出，stderr 只附该组的 usage（此前附完整 usage）。`cove` 不带参数与未知命令不变。
- `--checkout PATH[,name=N]`（`task create`、`mount add`）：第一个逗号之前的部分以 `/`、`.`、`~` 开头或含 `/` 时为路径，
  否则仍是 repo ID。CLI 经 `repo.list` 与 PATH 的 Git 公共目录找出所属的已注册 repo，再发送
  `{repoId}`（PATH 在 clone 本身中）或 `{repoId, path}`（其他 worktree），与 `REPO_ID[,path=]` 相同；
  不属于任何已注册 repo 时不保存、不发送，以 1 退出。CLI 需要本机 `git`（2.31 及以上；#143 起为 2.45，见 §3），以与 server 相同的环境白名单运行
  （继承的 `GIT_DIR`、`GIT_WORK_TREE` 等不生效），已注册 clone 至多 8 个同时检查；`git` 缺失、版本过旧、执行失败
  （含资源不足）与“不是仓库”“未注册”各有不同的 stderr 提示，都以 1 退出且不发送。`~` 只替换家目录前缀，
  `..` 在跟随符号链接之后生效。
- `mount convert <taskId> [mountId]`：省略时取该 task 唯一的 checkout 挂载；没有或有多个时不发送，stderr 列出候选
  （mountId、名称、路径），以 2 退出。
- `mount delete-worktree <taskId> [mountId]`：省略规则同上，只看托管 worktree 挂载。`mount delete-worktree <PATH>`：
  CLI 按真实路径在全部 task（含已归档，`task.list`）中找出该托管 worktree 挂载并发送同一 `binding.delete`；
  PATH 必须能解析为真实路径，不能解析（如目录已不存在）时不发送并以 1 退出，提示改用 task ID 与 mountId；
  不是托管 worktree（checkout、非 Cove 的 worktree）时同样不发送并以 1 退出。`--yes` 规则不变：无终端且无
  `--yes` 时在任何读取之前以 2 退出。
- `LIVE_RUNS_PRESENT`（`mount convert`、`mount delete-worktree` 的受理前拒绝与停下或失败的记录）：stderr 每个阻塞 run
  一行，仍以 `cove: live run <runId>` 开头，改为写明其 tab ID 与名称和可复制的停止命令 `cove tab stop <tabId>`；
  不属于该 task 任何 tab 的 run 给出 `cove terminal stop <runId>`。tab 经 `tab.list` 查得，查询失败时退回原来的
  通用提示。停在 `requires_attention` 的转换记录不带 run，改为列出该 task 中按 server 相同规则（启动 cwd 或启动时的
  挂载映射在该 checkout 内）使用它的存活 tab run。仍只供人读。

task 命名、默认分支与转换的重试提示（PR #136，合入于 `9638501`；请求与 stdout 的 JSON 形状不变，协议中 `slug` 的取值范围放宽。命名与默认分支 `3fcf3bd`（server）；转换的提示 `6293756`（CLI））：

- 新 task 的 `slug` 保留标题的文字与大小写（如“转换测试”为 `转换测试`，“Fix bug”为 `Fix-bug`；此前为小写 ASCII，
  没有 ASCII 时为 `task`），至多 48 个码位，为空时为 `task`；入口目录为 `<slug>-<短 ID>`。已有 task 不迁移。
- `--worktree` 与 `mount convert` 未给 `--branch` 时，默认分支为 `cove/<slug>`，因此**分支名可能不是 ASCII**；
  该分支已在本地或任一远端的远端跟踪分支中存在（不区分大小写）时依次改为 `cove/<slug>-2` 至 `-100`，**分支名
  可能带后缀**，实际分支以 task JSON 中挂载的 `branch` 为准。都被占用、或显式 `--branch` 已存在时以 `BRANCH_EXISTS` 失败。
- `mount convert` 失败（`BRANCH_EXISTS`、`FETCH_FAILED`、`MAIN_BRANCH_UNRESOLVED`）时，stderr 提示改为重新执行
  `cove mount convert <taskId> <mountId>` 并附 `--branch NEW`、`--no-fetch` 或 `--base REF`（其余选项需重新给出）；
  此前提示的 `cove mount retry` 对仍是 checkout 的挂载返回 `INVALID_ARGUMENT`。`operation continue` 不知道 task ID 时，
  提示中以 `<taskId>` 占位（此前为不带 ID 的 `cove mount retry`）。仍只供人读。

## 3. 进行中（PENDING）与计划中（PLANNED）

PENDING：

#141（托管 worktree 稳健性，#126、#132、#138，未合入）：请求不变；操作结果的挂载结果新增可选字段 `branch`。

- 挂载结果（`operation.result.mounts[]`）在 `left` 为 `branch` 或 `both` 时，单挂载结果（`mount retry`、`mount convert`、
  单挂载的 `task create`/`mount add`）另带 `branch`：留在原处的分支名。`leftovers[].branch` 取它，所以失败的
  `mount convert` 的 `leftovers` 不再是 `branch: null`，stderr 的人工命令也不再带 `<branch>` 占位。
- 上次失败的尝试因 Git 拒绝删除而留下 worktree 或分支、路径仍被占时，同一挂载的 `mount retry` 与同名的再次
  `mount convert` **不再在受理前以 `MOUNT_NAME_CONFLICT` 拒绝**（此前 stdout 为空）：照常受理，新尝试先以普通的
  `git worktree remove`（不加 `--force`）与 `branch -d` 规则删除遗留，再照常创建。Git 仍拒绝时操作为 failed，
  挂载结果 `errorKind: "MOUNT_NAME_CONFLICT"`，`left` 与 `branch` 给出仍在的遗留，输出带 `leftovers` 并以 1 退出；
  stderr 提示在其中没有会丢失的内容后重新执行同一命令，worktree 挂载另提示可用 `cove mount delete-worktree`
  连同改动丢弃（该命令也移除挂载）。遗留的分支在选默认分支时仍算占用，所以这次的分支取下一个后缀。
  曾作用于遗留的操作的 Git 进程可能仍在运行时，操作为 `requires_attention`。
  对这样的重试或转换 `operation abandon` 时，也先核实并按同样规则删除或保留遗留，仍在的遗留列入目标的
  `progress.remainingEffects` 与 `left`。
- 默认分支的后缀判断：`cove/` 下的本地与远端跟踪分支由 server 在 Unicode 规范化与大小写折叠后比较，
  因此 `cove/école` 已存在时 `École` 取 `cove/École-2`；位于候选名之下、大小写不同的分支（如 `cove/FIX/topic`
  之于 `cove/Fix`）也算占用；名字含 `/` 的远端（如 `team/upstream`）的远端跟踪分支按完整前缀识别。
- 设置了 `worktree.useRelativePaths=true` 的 clone 中，`--worktree` 创建与 `mount convert` 能正常 ready（此前停在
  `requires_attention`）。
- 存储一时拒绝（队列满或 SQLite 争用使事务回滚）时，准备、abandon、转换与删除先有界重试，仍被拒绝则操作转为
  `requires_attention`；不再因一时的拒绝无执行者地停在 `running` 直到重启。持久的存储错误不重试，见 #145。
- 多次未确认的 fetch 填满步骤记录后，abandon 仍能完成（此前停在 `requires_attention`）。

#143（run 退役、操作回执输出与 Git 2.45 下限，#126、#127，未合入）：请求不变。

- `cove operation continue/abandon` 已被受理、之后读取失败时（轮询本操作或读取目标的 `operation.get` 失败、
  等待超时），stdout 仍输出 `{ operation, targetReadError }` 并以 1 退出（此前 stdout 为空）：`operation` 是最后
  读到的本操作记录（轮询本身失败时可能仍为 `running`），`targetReadError` 是失败原因；不带 `target` 与
  `leftovers`，因为失败的读取说明不了它们。stderr 写明本操作已受理、目标结果未知，并给出两者的
  `cove operation get <id>`；不要重发任一操作。
- Git 下限提高到 **2.45**（`GIT_NO_LAZY_FETCH` 从 2.45 才有，更早的 Git 静默忽略它，partial clone 中读取缺失对象时
  可能联网 fetch，`--no-fetch` 也拦不住）。server 启动时检查自己 `PATH` 上的 `git`：缺失、早于 2.45 或不报版本时
  不启动，`cove server start` 以非 0 退出，stderr 为 `cove-server: git <版本> is too old: Cove requires Git 2.45 or later; ...`
  之类的说明（此前只有读取 checkout 的 HEAD 时拒绝旧 Git，表现为 `GIT_UNAVAILABLE`）。运行中 `PATH` 上的 `git`
  变为不满足要求时，需要 Git 的请求以 `GIT_UNAVAILABLE` 拒绝（未接受）。CLI 自己的 `--checkout PATH` 查找同样要求
  2.45，过旧时提示 `git <主.次> is too old for --checkout PATH, which needs Git 2.45 or later`，不发送并以 1 退出。
  macOS 上 Xcode Command Line Tools 的 `/usr/bin/git` 可能早于 2.45，需把更新的 Git（如 Homebrew 的）放在 `PATH` 前面。

#145（Git 下限、存储错误重试与 CLI 回执输出，#144，未合入）：请求与输出格式不变。

- 只有一时的存储拒绝会重试：队列满，或 SQLite 争用（`SQLITE_BUSY`、`SQLITE_LOCKED` 及其扩展码）。持久的
  操作错误（如 `SQLITE_READONLY`、`SQLITE_CORRUPT`、`SQLITE_IOERR_*`、`SQLITE_FULL`）不重试：操作立即转
  `requires_attention`；若这次转交也同样失败，记录可能停在 `running`、没有执行者，store 仍打开、server 继续服务，
  直到下次启动核实并恢复该操作（被拒 spawn 的 run 清理失败时，run 停在 starting，下次启动标为 interrupted）。
  server 在 stderr 为每个这样的错误写一行
  `{"event":"store-operation-failed","operation":"<store 操作名>","code":"<SQLite 错误码或 null>"}`（不含参数与错误文本）；
  看到它说明数据库需要处理（权限、磁盘空间或损坏），处理后重启 server。
- `cove operation continue/abandon` 受理后读取失败时，`operation` 确为最后读到的本操作记录（此前轮询成功后
  再失败时输出的是受理时 revision 0 的回执）。
- Git 下限的检查：转交给另一个 Git 的 `git`（Apple 的 xcrun shim `/usr/bin/git`、包装脚本）每条命令前都重新检查
  版本，切换 Xcode 选择后不会运行旧 Git；`PATH` 项按 shell 的方式拼接（不按字面化简 `..`）；等待共享版本检查的
  请求以自己的期限为界。

#150（M2 T0 契约，未合入）：现有请求与 JSON 输出不变。

- `cove status` 与 bootstrap 中的 `buildVersion` 不再是 `0.0.0`，而是 `<版本>+<16 位十六进制>`（随编译产物、package 清单与锁文件变化），
  或在找不到 workspace 根目录时为 `unidentified`。只用于诊断，不应据此判断兼容。
- 新增错误 kind（`error.data.kind`）：`DEVICE_REVOKED`、`INVITATION_UNAVAILABLE`、`INVITATION_NOT_FOUND`、
  `DEVICE_NOT_FOUND`、`SERVER_ID_MISMATCH`、`PEER_IDENTITY_MISMATCH`、`ENTRY_UNAVAILABLE`、`OPERATION_HISTORY_EXPIRED`
  （整数码 1042–1049）。本机 CLI 现有命令不会产生它们；认证、远程入口与保存期限由后续 M2 任务实现。
- 携带输入秘密的写（首个为 M2 的 `server tsnet login`）的本地待定记录只保存被省略的字段名：
  对它 `cove operation resend` 在本地拒绝、不发送并以 1 退出，提示重新执行原命令（`cove operation get <id>` 可查是否已记录）。
  同一 operationId 以不同的秘密字段重用（先不带、后带 auth key，或相反）时不发送并以 1 退出，需换新的 `--operation-id`。
  请求在写盘前按方法 schema 校验，会被去掉或改变的字段（如放错位置的秘密）使命令不写盘、不发送并以 1 退出。
  现有命令没有秘密字段，不受影响。

#152（M2 T6 操作记录保存期限，#97，未合入）：请求与成功输出不变；新增两类失败，都以 1 退出且 stdout 为空。

- 已结束（succeeded、failed、cancelled）的操作记录在结束 30 天后由 server 清除，只保留 operationId：
  - 对它 `cove operation get <id>` 与 `cove operation resend <id>` 以 1 退出，stdout 为空；
  - stderr 含 `OPERATION_HISTORY_EXPIRED`，说明操作已结束超过 30 天、永不再执行；
  - 直接 RPC 重发同一请求返回该 kind（acceptance `not-accepted`）；以不同参数重用这个 ID 返回 `OPERATION_ID_CONFLICT`。
  - 这不是成功，也没有执行任何东西：应改为检查该操作影响的资源，不要换新 ID 重做，除非确实要再执行一次。
- 未结束的记录（含 `requires_attention`）从不自动清除。
- 本机待定记录保存 30 天后过期：
  - `cove operation resend <id>` 在本地拒绝、不发送并以 1 退出，stderr 含 `expired after 30 days` 与 `nothing was sent`；
  - 以同一 `--operation-id` 重新执行命令同样拒绝，需换新的 ID。
  - `cove operation get <id>` 不受影响，仍向 server 查询。
- tend 若长期保存 operationId 用于重试，30 天后的重试会得到上述结果；在 30 天内按原 ID 重发的语义不变。

#153（M2 T1 设备授权核心与客户端登记，只有 loopback 入口，未合入）：本机命令的请求与 JSON 输出不变。

- 新的全局参数 `--server ALIAS`（或 `$COVE_SERVER`）与 `--via ssh|tsnet`：把命令发给用 `cove remote add` 配对过的 server。
  tend-runner 调用本机 CLI 时不要设置 `COVE_SERVER`，否则命令会发往该 server。本 PR 只有 loopback 入口（同一主机上的
  server）可用；`--via ssh|tsnet` 以 `ENTRY_UNAVAILABLE` 失败并以 1 退出，不会改用别的入口。`server` 与 `remote` 两组命令只作用于本机，
  给 `--server` 时为用法错误（2），且不受 `COVE_SERVER` 影响。
- `--server` 模式下路径参数是 server 主机上的路径：相对路径或以 `~` 开头时以 2 退出，不写待定记录也不发送；绝对路径原样发送。
  `terminal create` 必须给出绝对的 `--cwd`；`--checkout PATH` 只匹配 server 报告的已注册 clone 路径，其余以 1 退出并提示
  `REPO_ID,path=PATH`。本机模式保持原行为。
- `cove auth invite create [--ttl-minutes N]` 输出 `{ operation, invitation }`；邀请只在首次响应中出现，以同一 `--operation-id`
  重发时只输出记录并以 1 退出。另有 `auth invite list/cancel`、`auth device list [--include-revoked]/rename/revoke`。
  `auth device revoke` 等被撤销设备的连接关闭后才返回；有连接未在期限内关闭时仍输出记录，但以 1 退出。
  `auth device rotate` 只能带 `--server`，用于轮换本客户端自己的 token。
- `cove remote add <ALIAS> [--name N]` 只从隐藏提示或 stdin 读邀请，从不从参数读。另有 `remote list/remove`、
  `remote entry default <ALIAS> <kind>`。`remote tsnet ...` 以 `CAPABILITY_UNAVAILABLE` 失败并以 1 退出。
  输出不含 token；token 保存在 `<home>/client/servers/<serverId>.json` 中（0600）。
- 带有效设备 token 的请求可用全部现有方法。撤销后的设备在 HTTP 上得到 401 `DEVICE_REVOKED`，在 WS 上被以 policy 关闭；
  它已受理的操作照常完成，其他主体可查询。

PLANNED：

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
  已有结束记录的 run 保持不变。任何情况都不重跑（记录已 AVAILABLE，CLI 读取路径见 §2 的 T4）。
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

| 日期       | Cove 提交                                       | 对 tend 的变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | main `399c20b` 时建立本文                       | 首次列出 §2 的可用接口；记录设计 §7.1 的已决定事项（`tab send` 规则、环境变量、重启）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-16 | main `399c20b`                                  | 更正：重启语义区分正常停止与崩溃，引入提交改为 `d99ef5d`；拆分 `config` 行；区分 CLI 错误与子 server 进程的输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-10-16 | main `399c20b`                                  | 更正：子 server 进程退出状态单列一行，注明 `0a76f8c`、`2d3628a`、`c02367b`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-10-16 | main `e11f175`（PR #105）                       | `cove status` 输出新增 `workers[]`（worker 过载状态，只作提示），由 `e11f175` “feat(terminal): report an overloaded worker without acting on it” 引入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-17 | main `deb33ea`；#109（T3a，未合入）             | 基准改为 main `deb33ea`；新增 `repo`（T2，`200e24d`）；新增 PENDING 标记，列出 #109 的 `task`、`mount add/remove`、task 的 JSON 输出（含 unavailable 与读取预算）、记录过大时的 `INVALID_ARGUMENT`、文件系统工作已满时的 `BUSY` 与 `repo remove` 的 `REPO_IN_USE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-17 | main `47229e6`；#109（T3a，未合入）             | 基准改为 main `47229e6`；`deb33ea` 之后的 `b62d876`、`a568b22`、`0db08c8`、`47229e6` 只改 CI、测试、terminal-web 与 m0-harness，本文所列接口不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-17 | main `6a838af`（PR #109）                       | 基准改为 main `6a838af`；T3a 合入，#109 的 PENDING 项改为 AVAILABLE：`task` 与 `mount add/remove`、task 的 JSON 输出、`INVALID_ARGUMENT` 与 `BUSY` 的拒绝由 `fc41992`（server）与 `3d65dc4`（CLI）引入，`repo remove` 的 `REPO_IN_USE` 由 `09a61c3` 引入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-17 | main `0bba191`；#121（T4，未合入）              | 新增 PENDING #121：`tab create/list/get/runs/reopen/stop/close` 与 run 记录的 JSON 字段；run ID 跨实例不再重复（也适用于 `terminal create`）；`COVE_TASK_ID`/`COVE_TAB_ID` 注入明确为待定（#120），此前文档把它列在 tab 计划中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-10-17 | main `0bba191`；#121（T4，未合入）              | 更正 PENDING #121 的输出说明：受理前的拒绝（含 `LIVE_RUNS_PRESENT`、`TASK_NOT_FOUND`、`MOUNT_NOT_FOUND`）stdout 为空、写 stderr 并以 1 退出；`tab close` 输出操作记录本身；tab 已不存在时为 `tab: null, latestRun: null`，结算后读取失败时为 `tabReadError` 并以 1 退出（此前静默省略 tab 字段并以 0 退出）。spawn 被拒的 run ID 重启后也不重发，且不再列在 `terminal list` 中。基准改为 main `0bba191`（#119、#117、#123 不改本文所列接口）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-10-18 | main `ffa1910`（PR #121）；#128（#120，未合入） | 基准改为 main `ffa1910`；T4 合入，#121 的 PENDING 项改为 AVAILABLE：tab 命令与 run 记录由 `c63d7cd`（server）与 `d6f495a`（CLI）引入，被拒 spawn 的 run 退役由 `99bb65e`、run ID 不重发由 `373cf71`、tab 读取失败的输出由 `9c867d8` 引入；新增 PENDING #128：tab 的 run 注入 `COVE_TASK_ID`/`COVE_TAB_ID`，`terminal create` 的 run 不注入，继承来的同名变量不传给任何 run；从 PLANNED 中移除该项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-18 | main `64de013`（PR #128）                       | 基准改为 main `64de013`；#120 合入，#128 的 PENDING 项改为 AVAILABLE（§2 #120）：tab 的 run 注入 `COVE_TASK_ID`/`COVE_TAB_ID` 由 `341011e`（protocol）、`8dd7a10`（worker）与 `a4c8f15`（server）引入；CLI 接口不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-18 | main `64de013`；#124（T3b，未合入）             | 新增 PENDING #124：`--worktree` 创建（fetch 使用 SSH agent 且不交互、基点顺序、`no-fetch`、`BRANCH_EXISTS`、`FETCH_FAILED`、`MAIN_BRANCH_UNRESOLVED`）、`BUSY` 上限（含受理前分支名检查占用的共享 Git 槽位）、逐仓结果及其 `left`、`mount retry`（上次尝试的进程可能运行时拒绝）、`operation continue/abandon`（含 `OPERATION_EFFECTS_ACTIVE`；abandon 先接受再删除（停在基点、未被检出的普通分支；以普通的 `git worktree remove` 删除 worktree，Git 拒绝时保留；没有 index 的未检出 worktree），不强制；超时后仍可能运行的删除结束前拒绝 continue；可自身 `requires_attention` 并由 continue 继续）及其 `leftovers` 输出（失败的 `task create`/`mount add`/`mount retry` 有遗留时也带）、`requires_attention` 的情形（含检出前已有文件或暂存内容、已检出 worktree 消失）与 progress 词汇、所属操作未结束的挂载不能 `mount remove/retry`，以及按 `recoveryActions` 给出的 stderr 提示与遗留的人工删除命令；PLANNED 中托管 worktree 与 `operation continue/abandon` 两项移除 |
| 2026-10-18 | main `9a89968`；#124（T3b，未合入）             | 更正 PENDING #124 的 abandon 判据：从未 ready 的托管 worktree 不论检出是否执行过，都以普通的 `git worktree remove`（不加 `--force`）删除，Git 的拒绝是唯一的防护（拒绝时保留并列入 `left`，分支随之保留），被忽略的文件随之删除；此前的说明要求状态完全干净且忽略文件也算改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-10-18 | main `66048d7`（PR #124）                       | 基准改为 main `66048d7`；T3b 合入，#124 的 PENDING 项改为 AVAILABLE（§2 T3b）：`--worktree` 创建、`BUSY` 上限、逐仓结果与 `left`、`mount retry`、`operation continue/abandon` 及其 `leftovers` 输出与 stderr 提示由 `79106c0`（protocol）、`4df69ac`（server）与 `b2f71b2`（CLI）引入；删除 T3a 中“合入之前以 `CAPABILITY_UNAVAILABLE` 拒绝”的说明；PLANNED 补列此前遗漏的 M1 T5（`mount convert`、`mount delete-worktree`、`mount history`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-10-18 | main `66048d7`；#131（T5，未合入）              | 新增 PENDING #131：`mount convert`（`sourceChanges`、绑定在接受时切换）、`mount delete-worktree`（脚本须 `--yes`，无终端时以 2 退出且不发送；分支保留；不能 abandon）、`mount history`，以及 `LIVE_RUNS_PRESENT` 时逐 run 的 stderr 提示；PLANNED 中 M1 T5 一项移除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-18 | main `66048d7`；#131（T5，未合入）              | 更正 PENDING #131：`mount convert` 改为目标核实后才切换绑定（准备期间挂载、清单、revision 与新 run 仍是 checkout；失败或放弃时 checkout 保持绑定；切换被拒为 `requires_attention` 且 `remainingEffects` 为 `switch-binding`；转换期间 `mount remove` 为 `OPERATION_EFFECTS_ACTIVE`）；删除期间使用该 worktree 的 `tab create/reopen`（含入口 tab）与 `terminal create` 以 `OPERATION_EFFECTS_ACTIVE` 拒绝；受理后失败的删除记录保留至多 4 个阻塞 run，CLI 一并打印。（同一 PR 后续）`terminal create` 的 cwd 按真实路径判断：经已有别名给出的 cwd 在删除期间同样被拒绝，这样启动的存活 run 同样阻止删除（转换只考虑该 task 自己的 run，`terminal create` 的 run 不阻止转换）；cwd 无法解析时不受理（`INVALID_ARGUMENT`/`BUSY`）                                                                                                                                                                                                                                             |
| 2026-10-20 | main `ea4fe84`（PR #131）                       | 基准改为 main `ea4fe84`；T5 合入，#131 的 PENDING 项改为 AVAILABLE（§2 T5）：`mount convert`、`mount delete-worktree`、`mount history` 由 `1a4bfe2`、`c986851`（protocol）、`18d15be`、`90a5c9f`、`87f0257`、`2b470b7`、`f9b68a0`、`cd18f13`（server）与 `e1699fd`、`8d7c59f`（CLI）引入；接口与此前 PENDING 的说明相同；PENDING 现为空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-10-20 | main `92e24e9`；#134（未合入）                  | 基准改为 main `92e24e9`（`ea4fe84` 之后只有文档提交，本文所列接口不变）；新增 PENDING #134（CLI 试用可用性）：按组的帮助与显式帮助以 0 退出、`--checkout PATH`、`mount convert` 与 `mount delete-worktree` 省略 mountId、`mount delete-worktree <PATH>`、`LIVE_RUNS_PRESENT` 提示给出 tab 与停止命令；请求与 JSON 输出不变。（同一 PR 后续）PATH 必须能解析才会删除；`~` 不再提前折叠 `..`；CLI 的 Git 查询使用环境白名单、有界并发，并区分 Git 缺失/过旧/执行失败；转换停下时只列出使用该 checkout 的 run；缺值选项不再阻止 `--help`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-21 | main `fe0fc13`；#136（未合入）                  | 新增 PENDING #136：`slug` 保留标题的文字与大小写（至多 48 个码位，为空时为 `task`），入口目录 `<slug>-<短 ID>`；默认分支 `cove/<slug>` 因此可能不是 ASCII，已存在（本地或远端跟踪，不区分大小写）时加 `-2`…`-100` 后缀，显式 `--branch` 不加；已有 task 不迁移；`mount convert` 失败时的 stderr 提示改为重新执行 `cove mount convert <taskId> <mountId>`（此前的 `cove mount retry` 对 checkout 返回 `INVALID_ARGUMENT`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-10-21 | main `9638501`（PR #134、#136）；#141（未合入） | 基准改为 main `9638501`；#134 与 #136 的 PENDING 项改为 AVAILABLE（§2），注明各项引入的提交，接口与此前 PENDING 的说明相同；新增 PENDING #141：挂载结果的 `branch` 与 `leftovers[].branch`、遗留占住路径时 `mount retry`/`mount convert` 改为受理并先删除遗留（Git 仍拒绝时为 `MOUNT_NAME_CONFLICT` 并给出遗留）、默认分支后缀按 Unicode 大小写折叠、子分支与含 `/` 的远端判断、相对路径 worktree 能 ready、存储拒绝时转为 `requires_attention`、步骤记录填满后 abandon 仍能完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-10-21 | main `ee1f0cc`；#143（未合入）                  | 新增 PENDING #143：`operation continue/abandon` 受理后读取失败时输出 `{ operation, targetReadError }` 并以 1 退出（此前 stdout 为空）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-21 | main `ee1f0cc`；#143（未合入）                  | PENDING #143 增加 Git 2.45 下限：server 在 Git 缺失、过旧或不报版本时不启动并说明原因，运行中变为不满足时请求为 `GIT_UNAVAILABLE`；`--checkout PATH` 的 CLI 查找由 2.31 提高到 2.45                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-21 | main `7a67bc7`；#145（未合入）                  | 新增 PENDING #145：持久的存储操作错误不再重试，转交也失败时记录可停在 `running` 直到下次启动恢复，server 写 `store-operation-failed` 诊断事件；`operation continue/abandon` 读取失败时输出最后读到的记录；转交给另一个 Git 的 `git`（xcrun shim、包装脚本）每条命令前重新检查版本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-10-21 | main `a8f17f6`；#150（M2 T0，未合入）           | 新增 PENDING #150：`buildVersion` 改为真实构建标识；新增 M2 错误 kind（1042–1049）；带输入秘密的写的待定记录不保存秘密且不能 `operation resend`；现有请求与输出不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-10-21 | main `8855e3b`；#150（M2 T0，未合入）           | 更正 PENDING #150：`buildVersion` 也随 package 清单变化；以不同秘密字段重用 operationId、或请求含会被 schema 去掉的字段时，CLI 不写盘、不发送并以 1 退出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-21 | main `e8b35bf`；#152（M2 T6，未合入）           | 新增 PENDING #152：已结束操作的记录 30 天后清除，`operation get`/`resend` 与直接 RPC 重发返回 `OPERATION_HISTORY_EXPIRED`（以 1 退出、不执行），未结束的记录不清除；本机待定记录 30 天后过期，`resend` 与同 ID 重用在本地拒绝、不发送                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-21 | main `034ffc9`；#153（M2 T1，未合入）           | 新增 PENDING #153：全局 `--server`/`$COVE_SERVER` 与 `--via`（只有 loopback 可用，其余入口为 `ENTRY_UNAVAILABLE`，`server`/`remote` 组拒绝 `--server`）；`--server` 模式下相对路径与 `~` 以 2 退出且不发送，`terminal create` 须给绝对 `--cwd`；新增 `auth invite create/list/cancel`、`auth device list/rename/revoke/rotate`（邀请与新 token 只在首次响应中，重发以 1 退出；撤销有连接未关闭时以 1 退出）与 `remote add/list/remove/entry default`（邀请只经提示或 stdin）；本机命令的请求与输出不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
