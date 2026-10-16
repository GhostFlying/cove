# Shepherd/tend 集成说明

面向 [tend](https://github.com/GhostFlying/tend) 开发者，只记录当前状态。核对基准：Cove main `399c20b`（2026-10-16）。
设计与决策见 [设计 §7.1](../design.md#71-以-tend-实现-shepherd经-cli-集成方向已接受未排期)；
本文只说明 tend 现在能用什么、计划提供什么。任何改变下文所列接口的 Cove PR 都必须同时更新本文及其变更记录。

标记：**AVAILABLE** 表示已在 main 上，并注明引入的提交；**PLANNED** 表示已决定或已排期但尚未合入。

## 1. 集成模型

- 每台执行主机上的 tend-runner 调用本机的 `cove` CLI；tend 不连接远端 Cove server。
- Worker 是普通 Cove tab：tend-runner 创建 task/workspace/挂载，再以 agent 命令创建 tab。Cove 不知道 tab 属于 tend。
- tend 不解析终端字节流。Agent hook 配置、rollout/transcript 读取都由 tend-runner 负责；Cove 不实现 agent 状态 hook。
- 无人值守的 TUI agent 由 tend 的启动配方选择不阻塞的权限模式；Cove 不检查。
- 人工接管：人在 Cove 客户端取得该终端的控制权即为接管。tend 观察控制者变化，暂停自动干预；
  人仍持有控制权时 Cove 拒绝程序化输入。观看不是接管。
- tend 判断任务完成不等于停止 run 或删除 worktree；这些需要 tend 显式调用对应 CLI 操作。

## 2. 现在可用（AVAILABLE）

| 能力                     | CLI                                                                                     | 引入                                                                                                             | 说明                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据目录                 | 全局 `--home DIR`，或 `$COVE_HOME`，默认 `~/.cove`                                      | `c02367b`                                                                                                        | 同一数据目录只允许一个 server                                                                                                                                                                                                       |
| 初始化                   | `cove server init [--workspace-root DIR]`                                               | `c02367b`                                                                                                        | 服务未运行时使用                                                                                                                                                                                                                    |
| 启动 server              | `cove server start [--port N] [--origin URL]...`                                        | `8b06fe4`（未初始化时按默认值初始化：`d99ef5d`）                                                                 | 前台运行                                                                                                                                                                                                                            |
| 状态                     | `cove status`                                                                           | `8b06fe4`                                                                                                        |                                                                                                                                                                                                                                     |
| 读取设置                 | `cove config get`                                                                       | `c02367b`                                                                                                        |                                                                                                                                                                                                                                     |
| 修改设置                 | `cove config set workspaceRoot <DIR> [--expected-revision N] [--operation-id ID]`       | `c02367b`                                                                                                        | 只影响之后新建的 workspace                                                                                                                                                                                                          |
| 重置设置                 | `cove config reset workspaceRoot [--expected-revision N] [--operation-id ID]`           | `c02367b`                                                                                                        | 同上                                                                                                                                                                                                                                |
| 终端 run（不属于 tab）   | `cove terminal create [--cwd DIR] [--cols N] [--rows N] -- <可执行文件> [参数...]`      | `8b06fe4`                                                                                                        | M0 路径；tab 尚未提供（见 §3）                                                                                                                                                                                                      |
| 查看与停止 run           | `cove terminal list`、`terminal get <runId>`、`terminal stop <runId>`                   | `8b06fe4`                                                                                                        |                                                                                                                                                                                                                                     |
| 操作身份                 | 写命令接受 `--operation-id ID`；`cove operation get <id>`、`cove operation resend <id>` | `c02367b`（重发只发保存的请求：`2d89043`）                                                                       | 首次发送前把请求保存为本机待定记录；`resend` 只向原 server 原样重发，已有记录时返回原记录、不重复执行                                                                                                                               |
| 重启后的 run 与操作记录  | server 停止与启动时处理，无单独命令                                                     | `d99ef5d`（存储原语：`299514d`）                                                                                 | 正常停止时当前实例存活的 run 记为 stopped-with-server；启动时，旧实例中仍为 starting/running（没有结束记录）的 run 记为 interrupted/unverifiable，已有的结束记录不变；不探测旧 PID、不重跑。无法证明结果的操作为 requires_attention |
| 输出                     | 每个命令向 stdout 输出 JSON                                                             | `8b06fe4`                                                                                                        | 尚无版本号与稳定性承诺（见 §6）                                                                                                                                                                                                     |
| 退出码与错误             | 0 成功，2 用法错误，1 其他错误                                                          | `8b06fe4`                                                                                                        | CLI 自身的错误以 `cove: <消息>` 写到 stderr，尚无结构化错误输出                                                                                                                                                                     |
| 子 server 进程的退出状态 | `cove server start`、`cove server init`                                                 | `0a76f8c`（start 保留退出状态，信号为 128+N）、`2d3628a`（就绪前退出时同样保留）、`c02367b`（init 使用同一映射） | 原样转发子 server 进程的 stderr，并以其退出状态结束；`8b06fe4` 时信号结束的 server 仍返回 1                                                                                                                                         |

## 3. 计划中（PLANNED）

M1（已批准，实施中，见 [M1](../milestones/m1.md)）：

- `repo` 注册；`task`/`workspace` 与 checkout、托管 worktree 挂载；逐仓准备结果。
- `tab create/stop/reopen/close` 与 run 历史；`tab create` 保存启动配方（可执行文件与参数），默认 cwd 为 workspace 入口目录。
  注入 `COVE_TASK_ID` 等少量 Cove 标识，不保存其他环境变量。
- 重启后 run 显示为会话中断的 CLI 读取路径；`operation continue/abandon`。

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

| 日期       | Cove 提交                 | 对 tend 的变化                                                                                                  |
| ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | main `399c20b` 时建立本文 | 首次列出 §2 的可用接口；记录设计 §7.1 的已决定事项（`tab send` 规则、环境变量、重启）                           |
| 2026-10-16 | main `399c20b`            | 更正：重启语义区分正常停止与崩溃，引入提交改为 `d99ef5d`；拆分 `config` 行；区分 CLI 错误与子 server 进程的输出 |
| 2026-10-16 | main `399c20b`            | 更正：子 server 进程退出状态单列一行，注明 `0a76f8c`、`2d3628a`、`c02367b`                                      |
