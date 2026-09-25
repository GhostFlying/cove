# M0 协议、最小 server/client/CLI 计划

状态：仅规划，待协调者汇总并经用户批准 M0 入口；不是已冻结 schema 或实现完成报告。

## 所有权与范围

- Owner：Issue [#6](https://github.com/GhostFlying/cove/issues/6)，父任务 [#5](https://github.com/GhostFlying/cove/issues/5)；模块规划 agent，GPT-6 Astra high；协调者接收决策与集成。
- Base：`1e1398462c2aadc5a9171e40aef7c5d9f0ad3da7`；branch：`p/luchengxuan/m0-6-protocol-plan`。
- Checkout：`/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-protocol-plan`；本次唯一可写路径：`docs/plans/m0-protocol.md`。
- 目标：独立 Node server → 统一 pipe → terminal worker → 真实 PTY；CLI 与两个最小客户端走同一公共接口，验证控制、恢复与兼容。
- 已读依据：`AGENTS.md`、`docs/handoff.md`、`docs/design.md`、`docs/relay-protocol.md`、`docs/server-architecture.md`、`docs/terminal-architecture.md` §1–8、`docs/engineering-plan.md` §1–6、8–9。
- 排除：本次不实现、不推送、不创建 PR、不改 root/config/deps/其他文档。M0 不做 repo 注册、task/workspace/tab 持久模型、SQLite、迁移、设备配对、SSH/Tailscale、安装服务、Electron/RN 产品 UI、keeper、100 个真实 agent 容量承诺。
- M1 承接持久业务与操作恢复；M2 承接真实身份、远程安全入口和服务部署。M0 本地演示不能标为这些能力已验证。

## 固定 Orca 对照及取舍

只读核对 `/Users/luchengxuan/orca/orca`：HEAD `322c1839888f4a462e2d68839deafb1fe616c685`，干净 `p/luchengxuan/fork-worktree-scan-candidate`，`package.json:3` 为 `1.4.190`；GhostFlying fork，不宣称 upstream 最新。以下均为该 revision 的仓库相对路径及源码观察，未运行 Orca。

| 证据                                                                                        | 观察                                                                       | Cove 借用 / 避免                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/relay/protocol.ts:36–60`；`src/relay/relay-handshake.ts:100–142`                       | dispatcher 前先读专用握手；`msg.version !== launchVersion` 即拒绝          | 借用先握手后业务；分离 bootstrap、协议、build 和实例，不以 build 一致作为正常接入条件                  |
| `src/shared/terminal-stream-protocol.ts:12–35,45–79`                                        | 二进制帧分 stream/seq；新增 opcode 注释要求协商；未知 opcode 解码返回 null | 借用显式流身份及能力协商；Cove 不静默忽略必需帧，不直接照搬数值或 seq 语义                             |
| `src/main/runtime/rpc/methods/terminal.ts:1706–1726,2193–2246`                              | 单连接复用流；维护连接总 in-flight 额度及分流 ACK；输入受当前 driver 判断  | 借用复用、额度与连接清理；Cove 改为明确 controlEpoch、执行侧校验及可观察拒绝                           |
| `src/main/runtime/rpc/methods/terminal.ts:1139–1155,2262–2294`                              | auto/desktop 显示模式、mobile/desktop 分支与旧端兼容影响 resize/claim      | 不复制平台优先级与历史 fallback；当前有效操作者规则对 CLI、desktop、mobile 一致                        |
| `src/main/runtime/terminal-model-query-authority.ts:31–46`                                  | model 仅在 hidden-delivery 条件且无 remote view subscriber 时回复          | 不采用随观看者切换回复权；Cove worker model 始终唯一回复，客户端适配须证明实时与 replay 都抑制自动回复 |
| `src/main/runtime/rpc/dispatcher.ts:285–300`；`src/main/runtime/rpc/methods/index.ts:44–55` | 方法表集中注册，Zod `safeParse` 校验 params                                | 借用单一注册点；补 result/error、权限与能力契约，避免 transport 对象进入领域服务                       |
| `src/main/runtime/rpc/ws-transport.ts:1–14`                                                 | Node HTTP/HTTPS + ws，自建 transport 限制                                  | 借用显式资源限制；Cove 遵循已选 Fastify + HTTP JSON-RPC，不复制 WS 业务 RPC、TLS/E2EE 或全部 Orca API  |

比较说明：Orca 不同 relay/runtime 层有各自契约，不能把一处 launch-version 判断概括为其所有连接行为。源码展示风险与边界，不构成 Cove 正确性证据。

补充只读比较：协调者本次提供的 `stablyai/orca` main 对象 `646e9a5b02514795af5139961ccca225dfa01b12`，通过 `git show` / `git grep <SHA>` 核对，未切换或修改 Orca checkout；该对象 `package.json:3` 为 `1.4.197`，不将 main 的包版本当作最新已发布 Release。

- `src/relay/relay-handshake.ts:124–140` 仍按 launchVersion 拒绝；`src/main/runtime/terminal-model-query-authority.ts:31–46` 仍在有远端 view 时让出 model 回复权。上述 Cove 不照搬的理由仍成立。
- `src/shared/terminal-stream-protocol.ts:12–79` 与固定 fork 相同，能力协商与未知 opcode 风险没有因上游更新消失。
- 上游已把 multiplex 拆到 `src/main/runtime/rpc/methods/terminal/terminal-multiplex-method.ts:14–55`，连接级 stream/ACK 状态及 delivery/flow-control/cleanup 分开；借鉴职责拆分，避免将整个终端状态机堆在一个方法文件。Cove 不因此引入其全部 legacy 兼容层。

这是关键协议点的对照，不是全量上游审计或运行验证；fork 与 upstream 对象各保留自己的来源及行号。

## 真正的模块边界

| 交付边界                | 最小职责 / 依赖                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`     | Zod JSON 契约、bootstrap、HTTP RPC、terminal frame codec；独立 `pipe` 子模块。不依赖 Fastify/PTY/xterm/数据库                    |
| `apps/server`           | 独立入口、Fastify admission、方法表、实例绑定、运行清单、worker 池路由、全部终端周期预览缓存；不再放 headless 模型               |
| `packages/client`       | transport 注入、身份/版本检查、RPC 操作跟踪、terminal controller、恢复/ACK；无 native/Electron 依赖                              |
| `apps/cli`              | 本机 harness 启动与状态；普通 terminal 操作全部经 client，提供 help/JSON/稳定错误与退出码                                        |
| terminal 领域交付       | 终端模块 owner：`terminal-worker` 持有 PTY/唯一 model/排序/回放；`terminal-engine` 提供 profile/基线                             |
| `packages/terminal-web` | 本计划客户端适配 owner（P1q/P3v）：正式可复用 xterm adapter、查询回复抑制、用户输入分类；不交给仅负责 worker/engine 的终端 owner |
| `tests/harness`         | 两个本地浏览器 view 的演示入口和故障控制；只消费公开 client 与 terminal-web，不形成 Web App 产品                                 |

只有实际复用、部署或 native 隔离需要才建立上述包；目录名为目标 scope，不要求预建空 package。root manifests/lockfile/exports/build 图由协调者指定的单一集成人写入，模块任务提交变更请求。

## 已批准的 M0 本地 profile

用户于 2026-09-25 经协调者确认：本地实验链路、临时访问凭据、本次 server 生命周期内操作记录、两个浏览器终端测试页；持久化及正式配对仍在 M1/M2。汇总 DAG 入口评审仍须通过后才能派发功能实施。
建议命名为实验性 `m0-local` profile，明确不同于产品发布兼容承诺；协议版本、能力与冻结参考 fixtures 仍须真实工作。
仅在显式开发/测试启动方式启用，绑定数字 loopback 地址和任务独占端口，拒绝非 loopback 监听配置，不提供远端模式。
每次运行生成短期 harness secret，经权限受限的本地 rendezvous/测试注入传给 CLI/view；不写 URL、日志或终端内容。
HTTP 校验 secret、Host；浏览器请求和 WS 校验明确的 harness Origin，无通配 CORS。WS 在限时限长 bootstrap 认证通过前禁止业务帧。
这是防止其他网页随意驱动本机 shell 的演示防护，不是设备配对或同机恶意进程隔离；不承诺远端生产安全。
fixture 提供固定 serverId 以验证不同 build；每次 server 启动生成 relayInstanceId。不得以 endpoint、PID、build 或仅 serverId 证明旧 run 仍存活。

M0 使用实例内操作回执，不提前引入持久业务账本；具体有界策略建议：create/stop 携带 operationId、预期 relayInstanceId，同 ID 同意图返回原结果，不同意图拒绝。
保留本实例所有已接受 ID/指纹直至退出；到容量上限拒绝新写入，不淘汰后把旧 ID 当新操作。只记录非敏感控制元数据，不保存 VT。
网络超时后先按原 ID 查询；结果不明不自动重发 spawn 或输入。新实例明确拒绝旧实例操作，既不冒称持久去重，也不重建旧 run。
持久 operation ledger、重启核实和 tab 记录在 M1，不能默认为已实现 `relay-protocol.md` §11 的完整承诺。

## 最小操作与握手顺序（候选名称，P1 冻结）

| 通道                          | M0 操作                                                                       | 可观察结果                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 稳定 bootstrap HTTP / WS 首帧 | identify、negotiate                                                           | bootstrap 格式、server/instance/build/protocol、能力、profile 与限额；错误在业务解码前可读                     |
| JSON-RPC 2.0 over HTTP        | `server.status`、`terminal.list/get`、`terminal.create/stop`、`operation.get` | 当前实例运行事实、预览新鲜度、create/stop 回执及结果；无 task/workspace API                                    |
| 独立 terminal WS              | attach/detach、focus/blur、input/resize、appliedAck、recover                  | 订阅/控制身份、VT 输出/基线、尺寸、退出、控制变更和 typed errors                                               |
| runtime ↔ worker pipe         | hello/ready、spawn/stop、上述 terminal 命令、previewRefresh/status            | 关联命令结果、per-run 有序事件、基线分块与故障；查询回复留在 worker 内部，不绕行 pipe；无第二条 Node send 通道 |

CLI 必须覆盖 status/list/get/create/stop/operation get/wait 和 attach 中的 focus、输入、resize、detach/recover；测试脚本可显式发送控制动作。
启动参数与生效限额通过 CLI help/status 可查；M0 无动态产品设置 API。stop 显式绑定 run/instance，不能将 detach 当 stop。
create 仅执行显式指定的本机 shell/argv/cwd；demo 使用任务私有普通临时目录，不引入注册 repo 或默认操作现有仓库。
JSON-RPC 的 notification、batch、id 回显、result/error 互斥按标准测试；Cove 自身发单条带字符串 id 的调用。路径、HTTP status 映射、整数领域码及限额由 P1 一并记录，避免 transport 各自猜测。

顺序 profile：

1. 启动编译后的 runtime，创建有界 worker 池；各 worker 在 pipe hello/ready 校验内部版本、实例、worker incarnation 与限额后才接 spawn。pipe stdout 专用，日志走 stderr。
2. 客户端通过有限 bootstrap 完成入口防护、身份和协议协商；未知 bootstrap/协议不匹配仅诊断，不执行业务、替换 server 或清理 PTY。HTTP 每次调用重验实例与协议；WS 建连重新协商。
3. RPC create 预分配 runId，worker 明确确认 spawn；响应丢失保留相同操作。run 引用包含 serverId、relayInstanceId、runId；不得从客户端连接或 GUI tab 推导进程身份。
4. WS 协商 profile/能力后 attach，分配新 subscriptionId/generation；worker 串行固定恢复边界。保留本地模型且游标连续时补增量，否则发送基线 start/chunks/end，含 run、seq=N、网格、profile、历史覆盖与 reflow 能力。
5. 基线固定与订阅保留 N 之后增量必须原子衔接；安装/传输期间只保留有界积压。client 安装成功并解析完成后确认 N，随后顺序应用 N+1。安装失败/过期关闭该订阅，以新身份恢复，旧回调全部失效。
6. runtime 按接受顺序仲裁有效 focus；worker 将控制 epoch 变更及必要 resize 串行生效后，才回 grant/生效边界。输入只在恢复就绪且 grant 有效后发出；worker 执行前再次检查 epoch。
7. pipe 每方向一条有界发送队列；不同 run 可公平调度、当前操作者优先，但不跨越同一 run 的输出/resize/control/exit 顺序。命令 ID、事件 seq、输入序号、网络 request ID 各有用途，不能相互代替。

P1a 先提供限长 envelope、身份、错误和 opaque baseline payload 的临时接口，供终端 T1 恢复/查询 spike 使用；只声明试验性质，不宣称已冻结 profile 或恢复保证。
B0 先交付候选依赖 pin 与独立构建/试验入口；终端 T1 与独立 P1q 客户端输入/查询抑制 spike 不等 P3 或 C2 编译集成。二者交付恢复及用户输入可行性与失败边界后，P1b 与终端负责人共同冻结 frame header/端序/整数范围、分块/长度检查、seq 递增与溢出行为、pipe command correlation、终端 profile 和错误码。WS 可复用多个订阅；pipe 与外部协议分别版本化，不承诺任意 runtime/worker 混装。

## 控制、恢复与失败语义

- 一个 run 一个 controller；有效 focus 自动切换，无确认框。连接 generation/viewId/focusSeq 淘汰迟到与重复请求；相同网格不重复 resize。grant 后的输入/resize 携带 epoch；匹配 epoch 才能 blur。断线仅释放其控制权，保留最后尺寸，不选举观看者。
- 订阅、组件重建、输出、控制通知、后台重连不申请 focus；前台恢复且仍是输入目标时可重新申请。观看者使用权威网格、留白或平移，不独立 fit 逻辑列数；选择复制/滚动不接管。
- 控制切换前已写入 PTY 的输入不可撤回；排队旧 epoch 输入明确拒绝。输入 ACK 只表示定义好的 worker 写入边界，不证明 shell 执行完成。未确认输入报告 unknown，不跨重连自动重放。
- server model 唯一回复实时终端查询，完全不依赖 focus/订阅；replay/基线不生成 PTY 回复。用户键盘、粘贴、鼠标与自动回复必须在 adapter 分类，不能靠异步 write 期间一概吞 onData。
- 输出/resize/退出按 worker per-run seq；解析完成游标不能用网络收到或 pipe 写入成功替代。半个 UTF-8/CSI/OSC/DCS 的 checkpoint 与尾部由终端 profile 明确，不能将任意 serialize 结果冒充可接任意后缀的基线。
- 历史裁剪后无法保证 reflow 时，先由 worker 应用新尺寸，再给同一边界的新基线；覆盖 normal/alternate 两份状态。旧历史不直接插入实时 VT，M0 不额外要求独立历史浏览产品。
- preview 与恢复基线分离。runtime 分批错峰刷新所有 run（含未订阅/不活动），无变化复用版本；失败保留旧预览并标陈旧/`unverifiable`。只缓存有限画面，不建立第二个模型。
- client applied ACK 归还本订阅额度；慢端不阻塞其他订阅。越界后 `RESYNC_REQUIRED` 使旧订阅失效；错误无法发出时允许断连接。worker 解析过载对相关 PTY pause/resume，不能丢 VT 后继续同一模型。

| 边界错误（名称建议）                                                     | 接收方动作 / 不允许的推断                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `PROTOCOL_MISMATCH` / `BOOTSTRAP_UNSUPPORTED` / `CAPABILITY_UNAVAILABLE` | 展示版本或 profile 限制，保留运行；不降级猜解、不 spawn/reset                                  |
| `UNAUTHENTICATED` / `FORBIDDEN` / invalid envelope/params                | 明确失败且无副作用；不泄露路径、run 清单、VT 或 secret                                         |
| `INSTANCE_MISMATCH` / `RUN_NOT_FOUND`                                    | 保留旧引用，仅说明当前实例不可接入；不据此声称旧进程 exited                                    |
| `STALE_CONTROL` / `STALE_CONNECTION` / `INVALID_SIZE`                    | 拒绝输入/resize/blur，刷新控制事实；不得静默接管或自动重放输入                                 |
| `RESYNC_REQUIRED` / `RECOVERY_EXPIRED` / `PROFILE_UNSUPPORTED`           | 丢弃旧订阅队列，受限重试新基线或展示不可恢复；不继续缺口流                                     |
| `BUSY` / `OPERATION_ID_CONFLICT` / pipe malformed/timeout                | 区分明确未接受与结果未知；先查原操作；不生成新 ID 重试不确定副作用                             |
| worker/pipe 失联、server 重启                                            | `unverifiable` 直至执行侧有退出证据；新实例不接管旧 run。不提供 keeper，不自动恢复 shell/agent |

错误的数值、transport close code、详情脱敏与后续动作需集中定义；客户端按稳定 kind 而非 message 文本分支。

## 任务图与可验收交付物

以下是 M0 获批后的拆分，不是当前实施授权。协调者为下列角色分配具体 implementer/独立 tester/独立 Sol high reviewer；表中的 owner 是唯一写入责任，不代表已启动 agent。P1a/P1b 由同一协议 writer 负责；terminal owner 只提供语义输入，不并行编辑 protocol。

跨域交付物由协调者映射 task ID/commit：`B0` 归 CI/packages 集成人，先固定候选库/工具版本、root manifests/lockfile/build 引用与可运行的独立试验入口，供 P1a/T1/P1q 使用；无需先有最终应用产物，`C2` 编译集成是后续 gate 而非风险原型前置。
终端 owner 交付 `T-profile`（T1 可恢复状态/查询能力）、`T-worker`（编译 worker + run 顺序/epoch/PTY 生命周期）、`T-recovery`（基线/增量/裁剪后 reflow）、`T-budget`（队列/ACK/调度预算）。`T-view` 原占位取消，改为本计划 P3v 的 `P-view`，避免无人实现或跨域重复写入。不依赖其他 checkout 未提交文件。

| ID                                | Owner                                               | 依赖                                                           | 目标 scope                                                                            | 交付与逐项验收                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 入口及 CI 分配                 | 协调者                                              | 用户批准汇总 DAG；工程 gate 计划                               | task/Issue；本模块只提供需求                                                          | 记录已批准本地边界；明确 B0/root/lockfile/注册点 owner、必需 check 名称及跨域映射；未批准汇总 DAG 不派实施                                                                                                                                |
| P1a 临时 envelope                 | 协议 writer                                         | P0、B0；不等待 T1/profile 实现                                 | `packages/protocol/src/{bootstrap,rpc,terminal,pipe}/`、相邻契约测试                  | 有界字节 envelope、实例/run/请求身份与 opaque baseline 可编译；分包/粘包/恶意长度被限制；输出临时 P-terminal/P-pipe，T1 可用 fixture 驱动且不依赖正式 server/client                                                                       |
| P1q 客户端输入/query 可行性 spike | 客户端适配 owner                                    | P0、B0；不等待 P3、最终 profile 或 C2                          | `tests/experiments/m0-client-input/`；依赖变更交 B0 writer                            | 独立真实浏览器+xterm 入口验证实时/replay 查询回复不外发，异步 write 中键盘/粘贴/鼠标仍完整；与 T1 共用 query 场景但文件不重叠。输出 suppression 方案、adapter 输入接口和失败证据；必要补丁限于实验 scope，失败阻止 P1b 冻结               |
| P1b 基础契约冻结                  | 协议 writer                                         | P1a、P1q、终端 T1 的 T-profile/T-budget 提案                   | protocol 同上、冻结 compatibility fixtures                                            | 冻结方法/字段/错误/预算、T1 证明的恢复边界和 P1q 证明的 input/query adapter 接口；测未知字段/opcode、seq 边界；无 native 依赖，pipe/外部版本独立。正式 P-terminal/P-pipe/adapter contract 经两域签收                                      |
| P2 server 接入与最小控制面        | server owner                                        | P1b；最终验收依赖 T-worker/T-budget                            | `apps/server/src/{entry,transport,terminal,operations}/`、server integration tests    | owns worker-pool admission/routing、HTTP/WS、实例内回执、全部 run 预览刷新/cache；编译入口起真实 worker；重试不重复、detach 不停 PTY、失败标陈旧、worker 退出不重跑、拒绝非本地 harness                                                   |
| P3 公共 client/controller         | 公共 client owner                                   | P1b 冻结接口；可用契约 fixtures 与 P2/P3v 并行，不等其实现     | `packages/client/src/{connection,rpc,terminal}/`、客户端契约测试                      | 旧 generation 隔离、解析后 ACK、基线边界、focus/resize 竞态和未知输入正确；不依赖 Fastify/native/DOM。T-recovery/P-view 实物在 P4/P5 接入，不反向阻塞 P1b                                                                                 |
| P3v 正式 terminal-web adapter     | 客户端适配 owner（承接 P1q）                        | P1b、P1q；与 P3 并行                                           | `packages/terminal-web/src/`、adapter/browser tests                                   | 实现可复用 P-view：xterm 引擎隔离、用户输入分类、持续 query suppression、write 完成/基线安装回调、权威网格/reflow 元数据；无 server native 依赖；真实浏览器验证正常输入不被抑制、实时及恢复零自动回复外发。不是两个 demo 页面里的临时代码 |
| P4 CLI 与两 view harness          | CLI/harness owner                                   | P2、P3、P3v；T-worker/T-recovery 实物                          | `apps/cli/src/`、`tests/harness/m0/`、对应使用说明                                    | 编译 CLI 的最小方法和 JSON 错误可达；两 view 通过公共 client + 正式 P-view；前后台/控制动作可演示；临时目录/端口/进程 finally 清理，无产品 task 模型                                                                                      |
| P5 集成与兼容证据                 | 汇总 DAG 指定的独立集成 tester；CI writer 配置 jobs | P2、P3、P3v、P4；T-worker/T-recovery/T-budget；后续编译集成 C2 | `tests/integration/m0/`、`tests/compatibility/m0/`、任务证据；CI 文件仅指定 writer 写 | macOS/Linux 编译产物和真实 PTY；冻结旧端×新端双向能力及协议拒绝；断线/ACK 丢失/慢端/worker 故障；同 SHA 经 ssh devbox；必需 jobs success，缺失/skip/cancel/零用例不通过                                                                   |

依赖边：`P0 → B0 → P1a → T1`，`B0 → P1q`，`{P1a,T1,P1q} → P1b → {P2,P3,P3v,后续终端实现}`；`{P2,P3,P3v,T-worker,T-recovery} → P4 → P5`。P1q 的浏览器 spike 不依赖 P3；P3/P3v 只依赖已冻结接口并行实现，消除 client↔profile/view 环。
P5、终端计划 T6、工程计划 C6 可由汇总 DAG 映射为同一个独立集成交付物及 evidence SHA，不重复开三个同内容写任务；分域 acceptance 都必须保留。P3 fixture 通过不替代实物联调；独立测试/审查发现变更后回实现者，重跑受影响 gate。

## 最小演示与完成证据

1. 在任务临时目录启动编译 server/worker，以编译 CLI create 一个真实 shell 和一个输出/query fixture run；两个浏览器 view 连接同一 run。记录 commit、OS/arch、Node/native ABI、profile 与资源预算。
2. A focus 输入、B 观看；B focus 换网格，A 跟随权威网格；注入迟到 focus/blur/resize/input 验证旧 epoch 拒绝。CLI 接入也走相同控制权。
3. 触发 DSR/DA 等 profile 内 query；在零、一、两个 view 及恢复期间都只有 worker 一次回复，同时输入/粘贴未丢失。保留非敏感计数/断言。
4. 所有客户端断开，再接回相同实例/run；分别验证增量、强制缺口全基线、半序列、裁剪历史后宽窄宽 resize、normal/alternate 往返。慢 B 被要求恢复时 A 可继续输入。
5. 让无订阅 run 继续输出，验证 runtime 预览持续刷新；注入 worker 查询失败显示陈旧/不可验证。输入 ACK 丢失不重放；同协议不同冻结 build 能接原 run，协议不匹配不启动替代实例。
6. 显式 stop 任务拥有的 run 并核实退出；server 重启显示新实例，旧引用不自动重开。清理仅限本 demo 资源。记录延迟/内存/队列数据，不把未经校准耗时设硬门槛，也不宣称达到 100-agent 容量。

P5 证据需包含真实 PTY、已编译 exports/入口、两个客户端断言与必需 CI，不以 schema 单测或浏览器截图代替。协调者将最终 head/base、独立测试和审查证据汇总给用户做 M0 退出评审；不自动开始 M1。

## 已确认决策与继续上报的边界

协调者已将两项范围选择提交用户，并于 2026-09-25 确认采用：本地临时凭据与两个浏览器测试页；本次 server 生命周期内操作记录。替代方案会把 Electron/RN、正式配对或 SQLite 提前，增加阶段范围，因此不采用，也不再次要求用户选择。

汇总 DAG 与 M0 进入许可仍待用户评审。无需用户选择 opcode、header 位宽、RPC 路径、默认队列水位、库补丁细节等普通实现项；由 P1b 与终端负责人基于风险原型确定。若 profile 验证无法满足已确认的 query/恢复/resize 行为，先报告具体缺口与方案，经协调者提交用户：优先局限于 adapter 补足并量化维护成本，替代是另选兼容引擎或调整范围；不得静默降低验收或改架构。
