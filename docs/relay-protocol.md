# Relay 协议与生命周期

状态：设计草案。协议独立版本、同版本兼容、跨版本显式 recovery/reset
是已确认要求；本文中的字段名、发现方式和具体恢复步骤是建议方案，已实现的部分逐节注明。
M0 实现了 bootstrap 握手、HTTP RPC 与终端 WebSocket 的本机链路，M1 实现了持久操作记录（§11），
M2 实现了设备凭据、配对监听与 loopback、SSH、tsnet 三种入口上的同一套握手与授权（§4、§11.8）。

## 1. 必须成立的行为

**客户端更新不应改变正在运行的 relay 或 PTY 的归属。**

- 相同协议版本的客户端和 relay 必须互相兼容，不要求来自同一个应用版本或构建（自首次发布起生效，见第 10 节）。
- 桌面和 mobile 的兼容性标准相同，不能要求用户同步升级全部客户端。
- 协议版本不同时，明确提示不兼容及 recovery/reset 入口。
- 不因协议不同、暂时断线、认证失败或 session 查找失败，自动启动替代 relay 或 agent。
- 客户端退出、升级、设备休眠或最后一个连接断开，默认只 detach，relay 继续持有 PTY。
- Relay 是独立持久 server，desktop/mobile 可直接连接；不存在必须在线的 desktop owning client。
- 零客户端、零活跃 tab 或零 PTY 都不触发服务空闲退出；PTY 不因断线超时而被清理。
- 内置 Tailscale 与 host 网络共享相同 server 状态和会话归属，网络入口不是实例身份。
- 本协议处理终端与进程归属，不管理 agent 内部执行循环、原生 session 或 rollout 数据库。

## 2. 服务、构建、协议和运行实例的身份分开

| 字段（建议）      | 用途                                                  | 何时变化                             |
| ----------------- | ----------------------------------------------------- | ------------------------------------ |
| `serverId`        | 本机用户/profile 下的持久服务身份，对应同一份业务状态 | 普通服务重启、升级或切换网络入口不变 |
| `buildVersion`    | 诊断当前客户端或 relay 二进制（格式见 §11.8）         | 随构建变化                           |
| `protocolVersion` | 标识基础 wire 格式及行为契约                          | 发生不兼容变化时显式增加             |
| `relayInstanceId` | 标识实际持有 PTY 的一次 relay 运行实例                | 新进程实例获得新 ID；重连不变        |

初期建议 `protocolVersion` 使用独立整数。不是每次客户端或 relay 构建都增加协议版本。
相同数字代表相同的基础契约，不能仅因消息形状没变就沿用旧版本。首次发布前的例外见第 10 节。

Terminal 的远端引用至少包括 host、relay instance 和 terminal ID。
Host 的服务身份通过认证建立，不由 IP、域名或 Tailscale node 名称推断。
相同 terminal ID 出现在不同实例中，不意味着同一 PTY。
Task 和 workspace 的稳定身份也不能替代进程实例身份。

## 3. 稳定发现，先找到原 relay

建议每个 host、OS 用户及 Cove profile 有稳定的发现入口。
实例登记和入口不以客户端版本、relay 构建 hash 或安装目录作为身份。
二进制文件可以按版本存放，但不因此创建一套新的“当前会话”。

发现记录至少包含实例 ID、协议版本、连接 endpoint 及验证实例所需的信息。
静态记录只能提供候选位置，不能单独证明进程存活、死亡或 endpoint 属于谁。
PID 也不能单独作为所有权证明，需要防止 PID 复用和陈旧记录。

连接流程：

1. 根据 host/profile 发现已有实例，保留 session 记录原本引用的实例信息。
2. 使用小而稳定的发现/握手格式验证 endpoint 和实例身份。
3. 完成认证，再读取会话清单或进行控制操作。
4. 检查协议版本和能力，兼容时接入原实例。
5. 非兼容或不可验证时进入对应状态，不把“连接失败”转换成“创建新实例”。

首次启动与恢复区别处理：确认该范围内没有已有实例及待恢复归属时，才能走正常新建。
发现入口丢失但本地仍有旧 session 引用时，先提供恢复，不静默按首次启动处理。

并发启动需要实例所有权锁与实际 endpoint 绑定检查；失败的一方不得发布自己为当前实例。
重连到新实例后若旧 session 属于另一实例，不自动改绑或覆盖旧引用。

## 4. 握手本身必须跨业务协议可读

版本不兼容时也必须能告诉用户“哪里不兼容”。因此，版本识别发生在业务帧解码前。

建议设置固定格式、有限长度的 bootstrap handshake，包含：

- Cove relay 标识及 bootstrap 格式版本。
- 客户端期望的协议版本，以及 relay 实际协议版本。
- relay 实例身份、认证挑战和 build 信息。
- 认证成功后返回协商的能力和连接结果。

Bootstrap 格式与业务 `protocolVersion` 分开演进。最初的版本探测格式需长期保留可读性；
若连 bootstrap 也无法识别，则显示“不受支持的 relay 握手”，保留原实例，走显式恢复。
未知响应不能交给另一个版本的业务解码器尝试执行。

认证前不泄露 task、路径、终端输出或会话清单，也不开放 reset。
通信载体已选择 HTTP + WebSocket；Desktop/Mobile 的接入细节另行确定。
Server 的各网络入口必须执行一致的协议协商和授权规则；不能因换入口绕过版本检查。

已实现（M0 握手，M2 认证与入口；字段见 §11.1、§11.8）：

- bootstrap 是固定路径上的 JSON（HTTP `POST /bootstrap`，终端 WebSocket 的首帧），`bootstrapVersion` 为 1，
  与业务 `protocolVersion`（当前为 2）分开。失败以 `cove-bootstrap-error`（`kind`、`message` 与 `supportedVersions`）应答，
  不进入业务解码：请求不是本 bootstrap 版本的合法请求（含不支持的 `bootstrapVersion`）为 `BOOTSTRAP_UNSUPPORTED`，HTTP 400；
  `protocolVersion` 不符为 `PROTOCOL_MISMATCH`、期望的 serverId 或 relayInstanceId 不符为 `INSTANCE_MISMATCH`，两者为 HTTP 409。
- 认证没有采用挑战-应答：凭据是 `Authorization: Bearer`（终端 WS 首帧的 `secret`）中的本机秘密或设备 token，
  每个请求都携带并单独校验；握手成功不使后续请求跳过检查。缺凭据或凭据错误为 `UNAUTHENTICATED`、已撤销为
  `DEVICE_REVOKED`（HTTP 401，WS 以 policy 关闭），两者不区分设备不存在与秘密错误。
- 认证前可读的只有 bootstrap 身份：不带 `Authorization`、也不带 `Origin` 的 `POST /bootstrap` 只返回
  `cove-bootstrap-identity`（bootstrap/协议版本、build、serverId 与 relayInstanceId），供客户端在发送 token 前核对 serverId；
  带 `Origin` 的浏览器请求不带凭据时仍为 `UNAUTHENTICATED`。带凭据的 bootstrap 才返回能力与预算。
- 配对监听不经业务 RPC 解码器，只接受 `/bootstrap` 与 `/pair` 两个 POST（§11.8）。
- loopback、SSH 转发与 tsnet 转交的连接进入同一个业务监听，执行同样的原始连接上限、Host/Origin 校验、凭据检查与协议协商；
  SSH 与 tsnet 入口不另设监听或另一套规则（[Server 架构 §4](server-architecture.md#4-host-网络和内置-tailscale)）。

### 4.1 通信载体（已选择 HTTP + WebSocket）

| 通道               | 职责                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| 统一 HTTP RPC      | repo/task/workspace、设置、操作提交与查询；按领域方法分发，长操作返回 operation ID |
| 业务事件 WebSocket | 多客户端状态变化、操作进度和结果；基于游标恢复订阅                                 |
| 独立终端 WebSocket | VT 二进制数据、输入、focus、resize 和终端控制；在终端协议内定义顺序                |
| HTTP 文件传输      | 分块、校验、续传、取消；独立并发和带宽预算                                         |

这些通道属于同一 server，复用设备授权、server 身份和协议兼容规则。
HTTP 请求同样需校验协议及可选能力，不能仅在 WebSocket 握手时检查。
HTTP 响应与事件到达顺序不固定，通过操作 ID、资源 revision 和事件游标协调；
终端流使用自身序号及控制 epoch，不与业务事件游标混用。
终端连接数量、多终端复用方式和路由/schema 尚未冻结；100 个存活 TTY 不要求每个客户端订阅全部输出。
每个订阅须有有界队列和应用层流控；重连补发、慢客户端恢复与输入去重仍由 Cove 协议负责。
分离文件通道可以避免文件字节占据终端连接的发送队列，但不能消除共享链路上的带宽竞争。
HTTP/WebSocket 框架已选择 Fastify + @fastify/websocket，业务 API 已选择统一 HTTP RPC。
RPC 按领域命名方法，CLI、desktop、mobile 复用同一契约；文件内容仍走独立 HTTP 传输接口。

### 4.2 业务事件 v1

`GET /events` upgrade 后，客户端先发既有带凭据的 bootstrap，明确请求 `business-events-v1`。
它是可选能力，不提高 protocolVersion 或原客户端必需能力；未协商该能力或没有持久资源服务时明确不可用。
凭据轮换确认、撤销关闭和通道 server/instance 绑定与终端相同，不能通过另开事件连接绕过鉴权。

随后仅允许一次 `subscribe`：`{type, filter: {kinds?}, since?}`。v1 kinds 为
`repo/task/tab/run/operation/config/runtime`；默认全选，仅按类型过滤，不按 task 或 archive 过滤。
排序去重后的 kinds 字符串是过滤身份。归档 task 仍在快照中；workspace/mount 嵌于 task 投影。
Cursor `{serverId, relayInstanceId, streamId, sequence, filter}` 与 PTY seq、controlEpoch 无关。
改变过滤范围必须取新快照，不能把旧范围的 cursor 用作新范围的完整性证明。

没有 `since` 时，服务端依次发送 `snapshot-begin(snapshotId)`、从 0 连续编号的
`snapshot-page(snapshotId,page,records)`、`snapshot-end(snapshotId,pages,cursor,history)`。
`history` 固定为 `latest-and-active-runs-unresolved-operations`：当前资源完整，但不声称完整保留历史。
没有合法 end 的快照不能应用为完整视图。快照之后重放增量，再发 `ready(cursor)`，然后继续 live。
有 `since` 时直接重放到当前 watermark，再发 ready；cursor 过期、异实例/stream/filter、缺口明确 reset，
绝不静默从现在开始。reset 后重新订阅需要新连接和无 since 的快照。

增量为 `{type:"changes", after, cursor, changes}`，每批 sequence 恰增 1，after 必须等于客户端已应用的 cursor。
change 为 `upsert(value)` 或 `delete(kind,id)`；upsert 的 value 复用既有公共 record schema。
run/runtime 的 id 为 `JSON.stringify([relayInstanceId, runId])`，其他资源按公共 ID，config 为 `server` 或 `entry`。entry 投影仅有 revision/settings；需要监听状态与 restartRequired 时读 entry.get。
过滤掉全部变化时仍发空批次推进 watermark，不能把过滤产生的序号跳跃误作丢失或无声跳过。
按 cursor 顺序应用相同 revision 的新观察；不以较旧的 HTTP/旧连接结果覆盖新事实。
runtime/control 与 durable run history 分开维护，contact loss 不会产生退出事实；不因同步事件而 focus/resize。

task 事件是存储投影，携带 `filesystem:"unobserved"`，入口状态 unavailable；它不证明磁盘上仍有 ready 目录。
客户端需要即时文件系统核实状态时通过 task.get/list 读取，并保留观察代际，不能把相同 revision 当永不变化。
reset/快照不清除客户端自己保存的未决 operation ID；仍使用 operation.get 查询，任何未知结果均不自动重放。

`reset.reason`：identity、generation、filter、gap、overflow、publication-uncertain、unavailable。
`error.reason`：snapshot-too-large、busy、unavailable。任何连接断开都令镜像失去 current 标记；
未送达 reset 不代表可以继续使用旧 cursor。帧/窗口/快照/连接队列及发送进展有明确上限，见 Server §3.1。
业务流不保证 HTTP 响应先于事件，也不提供跨重启历史；持久 operation 的身份和查询语义保持不变。
schema 工具已选择 Zod，共享业务契约使用可导出的 JSON 子集；转换与领域规则单独处理。
业务消息格式已选择标准 JSON-RPC 2.0 over HTTP；具体路径与实现库另定。
这不把业务事件 WS 或终端二进制帧改成 JSON-RPC，也不将 JSON-RPC 的版本号用作 Cove 协议版本。
已选择 SSH/Tailscale 负责通道加密与对端验证，Cove 负责设备 token 授权；Cove 不使用系统 Tailscale，
两端都只用内嵌的 tsnet（[M2 D9](milestones/m2.md#d9-网络入口不使用系统-tailscale范围变更)）。
所有远程通道（包括配对和文件传输）必须经过安全入口；断线不降级为裸网络连接。
本机使用 loopback（M2 未选 Unix socket）；首期不实现应用层 E2EE 或自建 TLS 证书体系。
Web App 已纳入二期，当前仅经 Tailscale；原建议的 Tailscale 管理证书的同源 HTTPS/WSS 依赖系统 tailscaled，二期重新评估。
浏览器会话仍映射到独立 Cove 设备授权，并参与统一撤销；具体 cookie/请求防伪与 WS 认证绑定另定。
Web 入口与 Electron 共享边界见 [Web App 设计](server-architecture.md#95-web-app-与-electron-共享边界)。
稳定 bootstrap 和必要配对入口不依赖普通业务 RPC 解码器。
配对采用 server 创建的一次性邀请；server CLI 开放认证端口，已配对 desktop 也可申请新邀请供 mobile 使用。
日常重连使用独立可撤销的设备凭据。Server 身份不随网络入口变化；serverId 本身不能代替密码学身份验证。
配对监听的生命周期与业务监听分开；关闭配对入口不影响活跃终端。
已确认的配对流程和安全通道方案见 [Server 配对设计](server-architecture.md#93-单用户设备配对)。

## 5. 同协议版本的兼容契约

基础能力至少覆盖版本/身份识别、会话清单、attach/detach、focus/blur、控制权变化、输入输出、resize、退出通知，
以及有明确权限的终止操作。最终方法表和字段定义在实现前固定。本节契约自首次发布（含 alpha）起生效，此前见第 10 节。

- 同版本新增字段必须可选；缺失时有原有行为，不要求旧客户端发送新字段。
- 不能改变已有字段的含义、单位、空值语义、错误含义或已有事件的关键行为。
- 新客户端不能把基础功能依赖到旧 relay 没有的可选能力上。
- 可选能力在握手中显式协商；未确认支持时不得发送新的指令或帧类型。
- opcode、方法和枚举值不得复用旧含义；不能用未知指令被静默丢弃作为降级机制。
- 不支持的请求返回明确错误；未知必需行为不能按成功应答。
- 同版本基础契约若无法继续满足，应提升协议版本，不能借 build 版本制造隐式分叉。

例如，新客户端增加一种输出压缩方式：未协商时仍使用原始基础格式。
旧 mobile 和新 desktop 可以连接同一个 relay，各自使用已协商的能力。

客户端终端后端名称、图形 API 和实现库版本不是协议兼容性条件。
快照编码/版本与 terminal profile 显式协商，不能传递某个渲染库的私有内存对象。
已确认终端数据采用 VT 字节流，不传字符网格快照或 cell 增量。恢复基线采用 VT 序列加必要元数据，
具体 schema 待设计；同协议后端替换必须保留基础恢复格式。
缺少必要能力时明确拒绝对应 attach，不通过重启 PTY 或 reset 来“适配”渲染器。

一期按协议版本相等作为正常兼容路径。跨版本转换或旧协议适配器若未来加入，
必须成为明确可选择、经过验证的恢复能力，不静默猜测兼容或宣称无损转换。

## 6. 同版本更新的正常路径

```text
客户端 A，build 0.1，protocol 1
                  │
                  └── relay R，protocol 1 ── 原 PTY / agent

客户端更新为 B，build 0.2，protocol 1
                  │
                  └── 发现并重新 attach relay R ── 同一个 PTY / agent
```

客户端更新不强制刷新远端 relay 二进制，不重启原 relay，不重建 terminal ID。
如果某个新功能需要更新 relay，但原实例仍满足基础协议，显示该功能暂不可用，
保持已有终端正常工作；用户可以另行安排 relay 维护。

Relay 自身升级是独立操作。协议兼容不意味着重启进程后原 PTY 自动存活或自动接管。
一期不承诺 relay 进程热升级或跨实例 PTY 转移；可等待会话结束后更新，
或由用户按显式 reset 流程停止原实例再启动新版本。

## 7. 不兼容和异常的状态

| 观察                         | 用户可见结果                                       | 自动行为                       |
| ---------------------------- | -------------------------------------------------- | ------------------------------ |
| 实例身份正确且协议相同       | 已连接，展示原会话                                 | attach 原实例                  |
| 已认证，协议不同             | 协议不兼容，显示两端协议版本及 recovery/reset 入口 | 保留原实例，不执行普通业务命令 |
| 网络或主机不可达             | 无法连接，进程状态为 `unverifiable`                | 可重试连接，不创建替代 session |
| 认证失败                     | 认证失败                                           | 修复认证，不重置实例或凭据     |
| 会话引用的实例与当前实例不同 | 会话属于其他 relay，需要恢复                       | 不向当前实例自动发 spawn       |
| 握手格式未知                 | 无法识别 relay，需要恢复                           | 不猜解业务帧、不清理旧实例     |
| 执行主机证实原进程已退出     | `exited`，保留历史                                 | 用户可选择新开终端             |

协议状态与执行状态是两套信息。不兼容不意味着进程退出，reset 提示也不能暗示旧工作已经丢失。
当前实例返回“没有这个 session”，只证明该实例没有它；不能据此断言旧实例的进程已退出。

## 8. Recovery 和 reset

### 8.1 Recovery 优先保留原工作

Recovery 是检查和重新接入原实例的入口，不是默认杀进程的同义词。

- 修复连接或发现记录后，重新验证并接入原 relay。
- 若协议不兼容，指引使用支持原协议的客户端或已验证的兼容连接工具。
  此类工具的分发方式尚未确定，界面不能承诺一个尚不存在的恢复实现。
- 原客户端仍可连接时，用户可以先继续或结束原工作，再安排 relay 更新。
- 协议不兼容时能通过稳定控制面提供的诊断信息，应有单独且最小的契约；
  不假装完整会话业务 API 已经兼容。

### 8.2 Reset 是显式的破坏性操作

Reset 前展示 host/profile、准确实例、涉及会话及停止进程的影响。
若会话清单不可获取，明确说明影响范围未知，不能显示“没有活跃会话”。
用户明确确认对应操作后才允许终止该实例及其拥有的 PTY。

- 发起时绑定预期 instance ID；执行前重新验证，避免误杀刚接管入口的新实例。
- 不按进程名称批量 kill，不以新客户端启动作为 reset 授权。
- 已有 desktop/mobile 连接应收到维护或断开原因，不能误判为任务自然完成。
- 确认原实例退出并释放 endpoint 后，才允许新建实例接管同一范围。
- 响应丢失时重新核实实际实例状态，不重复清理、不删除归属记录后宣称完成。
- 无法安全控制旧版本时提供明确的主机侧恢复步骤；不绕过身份验证强行 reset。

Reset 不删除 task、workspace、仓库目录或 rollout。旧 session 保留为历史，
新实例产生新的执行身份，不能冒充旧会话继续运行。

## 9. 回放和输入也是协议行为

仅保留同一个 PTY 还不足以让重连可靠：

- 输出回放需要明确的序号/游标与流身份，避免把 replay 当成新输出重复处理。
- 已确认恢复基线携带普通/备用缓冲区必要状态，scrollback 可裁剪；全量恢复不等于全部历史。
  基线需表达历史覆盖范围及重排上下文能力。上下文不足时，尺寸变化后取得服务端新基线再接增量，不能仅靠本地 resize 保证一致。
  普通与备用缓冲区都在验证范围内；字段和握手未冻结，恢复目标限于服务端当前保留的权威状态。
- 回放窗口不足时明确报告缺口，并按能力提供终端快照或重新绘制；不能静默声称完整历史。
- 已确认严重落后时 server 可以终止订阅并报告必须全量恢复；客户端取得新基线后重新订阅，不能续用旧订阅的残留数据。
  新基线与新订阅须衔接同一运行身份及事件边界，并在衔接期间保留有界增量；具体错误码与握手尚未冻结。
  连接整体无法继续发送时可以断开连接，不能要求错误一定送达才允许释放积压。
- 旧实例或旧订阅延迟到达的数据，不能覆盖新绑定的状态。
- 已应用确认（applied-ack）与基线进度（baseline-progress）是累积、单调的：每个订阅每类同时至多一条未结算，
  客户端把较新的值并入待发的最新值。对连接与 worker 都在线的活订阅，server 按序应用每条确认及 detach，
  不因任何容量拒绝或丢弃它们及其结果，包括请求与字节预算、worker 的路由控制窗口、pipe 与出站队列。它们至多等待
  按订阅预先支付的槽位释放。因此一个连接订阅多个持续输出的终端时不会丢失订阅，客户端也可以把已交出的确认视为
  覆盖其后发出的命令。确认仍可能因失联、连接关闭或取值被拒而失败。同一订阅同类的第二条未结算命令以 BUSY
  （not-accepted）拒绝，不结束该订阅；遵守协议的客户端不会收到。客户端在确认的任何失败后结束该订阅；
  取值被拒（如 RESYNC_REQUIRED）时 server 不一定退役路由（#96，细节见 [终端架构](terminal-architecture.md) 3.3 节）。
- worker 忙不是失联（#103）。server 只在 worker 退出、pipe 失败、协议违规或 runtime 观察到连续 120 s 收不到 worker 的任何帧（含心跳；该窗口与 `recoveryDeadlineMs` 无关）时
  判定失联并结束其上全部订阅；worker 慢时订阅保持，输出按确认流控变慢。单条命令超过期限只结束这一条：一半期限内未得到标记的 attach/recover
  得到 RECOVERY_EXPIRED（not-accepted，早于客户端自己的期限，因此不必退役整个连接），已发出的输入等命令得到 RESULT_UNKNOWN
  （不重放），尚未发出的得到 BUSY。确认与 detach 在 worker 存活期间
  没有期限；客户端为它们等待 `ROUTE_CONTROL_DEADLINE_MS`（150 s，仅作 server 不应答时的兜底），不能早于 server 放弃。细节见 [终端架构](terminal-architecture.md) 3.3 节“worker 存活与命令期限”。
  worker 的过载状态只作提示：`server.status` 的 `workers[]` 报告它（旧 server 不带该字段），订阅上的
  `worker-health` 事件（无 seq、不占信用、无需 ACK）在状态变化时告知客户端；判据见同节“worker 过载状态”。
- 预览（preview）事件不带请求 ID，只靠 previewId 与请求关联：`preview-result` 在 `status` 为 `transfer` 时必须携带它完成的
  `previewId`，为 `unchanged` 时不得携带。客户端只在结果与实际收到的传输 ID 精确匹配时完成预览；同一请求出现第二个或不匹配的
  传输、或结果 ID 不符时按无效应答结束该预览，不能把迟到的旧传输归到同一 run 的新请求上。
- 输入重试不能重复提交命令。除非有明确的去重和确认契约，不自动重放断线前不确定的输入。
- 多客户端的输入和 viewport/resize 跟随当前操作者，由显式 focus 协议切换；这些规则也受协议版本约束。

具体 buffer 大小、帧编码和快照机制后续确定。

### 9.1 Focus、控制权与自动 resize

已确认的产品行为：终端获得有效 focus 时自动成为当前操作者，并按该客户端的网格尺寸调整终端。
不弹接管或恢复尺寸确认框。此行为不改变协议不兼容时明确 recovery/reset 的约束。
Focus、控制权与尺寸属于一期基础协议，不能只靠客户端本地约定。

建议消息语义如下，字段名和编码尚未冻结：

1. 前台活动终端的用户操作或真实焦点恢复产生 `terminal.focus`，携带 terminalRef、viewId、
   当前连接 generation、单调递增的 focusSeq，以及测量完成的有效 cols/rows。
2. Server 校验会话身份、操作权限、连接有效性和尺寸，再按服务端接收顺序串行接受请求。
   每个 terminal 只保留一个控制者；授予新的 controlEpoch，并确定有效尺寸。
3. Server 应答请求，并向订阅者发布控制者与尺寸状态。客户端收到有效 grant 后才发送输入，
   输入和后续 resize 均携带 controlEpoch；旧 epoch 的请求明确拒绝。
4. 相同网格尺寸只变更控制权，不执行多余 resize。尺寸不同则将 resize 纳入有序终端事件流，
   应用于 PTY 和所选终端状态模型；应答不承诺 TUI 已完成重绘。
5. `terminal.blur` 只释放匹配当前控制者及 epoch 的控制权。旧客户端迟到的 blur 不影响新操作者。
   断开连接同样只释放该连接持有的控制权；终端保留最后尺寸和进程，不自动选举观看者接管。

客户端和重连边界：

- 应用回到前台且当前 pane 是终端输入目标，或用户切入终端 pane 时自动发送 focus。
  搜索框、菜单等其他控件的焦点不应被解释为终端输入焦点。
- 组件重建、输出到达、后台连接、订阅恢复和控制权通知不能自行产生 focus。
  已失去控制权但仍保有本地焦点的视图，在用户重新点击或明确输入时可申请 focus；
  grant 到达前不向 PTY 提交该输入，也不自动重试先前不确定是否执行的输入。
- 前台终端重连完成身份协商和状态同步后，可以发送新的 focus；后台重连不争抢控制权。重连期间用户已登记、仍有效的 focus
  优先：它按自己请求的网格发送，重连不再另发 focus 取代它，暂存输入随它发送。
- 同一客户端活动焦点范围内的 focusSeq 用于淘汰迟到请求，连接 generation 隔离被替代连接。
  重复请求不产生新的控制权切换；旧 grant 也不能覆盖客户端已接受的较新控制状态。
- 不比较不同设备的本地时钟。跨客户端并发 focus 以 server 接受顺序为准，
  不声称能恢复现实世界中手势发生的绝对顺序。
- 未持有控制权的视图仍按服务端有效网格渲染，可缩放或滚动；本地 fit 不得修改逻辑列数。

控制权跨基线恢复（已实现）：基线吸收其 atSeq 之前的全部事实，包括控制事实，客户端无法从之后的增量得知
atSeq 时的控制者。因此基线描述符必须携带 atSeq 时的控制权 `{epoch, holder}`；epoch 0 表示从未授予，holder 为 null。
尺寸变化触发的基线恢复（resize-context）开始时，客户端把已接受的 grant（epoch E，atSeq A）或仍在等待结果的
focus 请求保留为恢复候选；其他原因的恢复不保留。基线 B 完成后按以下规则裁定 grant：

- B ≥ A 且 B 处为 (E, 本订阅)：恢复该 grant。epoch 单调递增，blur 在同一 epoch 内把 holder 置空且无法回到原持有者，
  所以 B 处为 (E, 本订阅) 即证明从 A 到 B 持续持有控制权。
- B < A 且 B 处 epoch 小于 E：grant 自身的控制事实仍在 B 之后的有序增量中，保留 grant，待该事实按常规应用。
- 其他情况（更新的 epoch、同 epoch 的其他持有者或 blur、或 B ≥ A 时 epoch 小于 E）：丢弃 grant。
- 恢复期间才到达结果的 focus 请求按同样规则处理：基线未完成时进入候选，基线完成后以基线权威校验；
  被排除时 focus 请求以失败返回（带已接受回执），不安装 grant。尚未得到结果的 focus 请求跨越后续的尺寸恢复继续保留，
  直到结果到达或被显式作废。
- 同一规则也用于普通控制事实：seq 小于 A 的更旧 epoch 事实不撤销 grant；只有更新的 epoch，或同 epoch 但持有者
  不是本订阅（含 blur）才撤销。

基线完成后，客户端公开的已应用控制权取自基线携带的权威（epoch 0 时为空）。恢复本身仍不发送 focus；
恢复开始时尚未交给连接的输入按下文的输入暂存规则处理。focus 请求若请求的网格不同于已应用网格，在 grant 可用于输入
（含覆盖其 atSeq 的 ACK 已交给上行）或丢失后才返回；该等待从接受结果起受恢复期限约束，到期报告超时，不无限挂起。
持有者的 resize 请求同理：请求网格不同于已应用网格时，在 grant 重新可用于输入或丢失后才返回，等待同样从接受结果起
受恢复期限约束；与已应用网格相同的 resize 仍在结果到达时返回。
这两种等待是结果的第二阶段：命令已被 server 接受、之后就绪失败（grant 丢失、超时或 dispose）时，失败结果带有已接受回执
（`accepted: { epoch, atSeq }`，见 terminal-architecture 4.4.7），以区别于命令本身未被接受。

恢复期间用户发起的 focus（例如其他客户端改变尺寸迫使本客户端取新基线）不被拒绝，而是延迟到恢复进入 ready 后再发送。
这仍是用户的请求，只是推迟发送；恢复本身不发送 focus。延迟从请求起受同一恢复期限约束；输入目标失焦、视图被替换、
订阅或连接变化时取消，恢复失败时以失败返回。恢复期间视图报告的失焦同样生效并取消它。被延迟的请求只在仍是最新意图时发送：
其后任何一次失去输入目标（即使随后又重新聚焦）或更新的 focus 请求都会取代它；这一核对一直持续到命令交给连接的那一刻（包括其间又开始的恢复），避免旧请求以更大的
focusSeq 跟在新请求之后。仍是最新意图、但在交给连接之前又遇到新一次恢复的 focus（无论恢复开始于它被唤醒之前，还是开始于它已
begin 之后、交出之前）被连接层证明从未交出，因此继续延迟到新的 ready，而不是跟在 recover 之后被 server 以 RESYNC_REQUIRED 拒绝；
期限仍从最初请求起算，并在交出前的最后核对中再次检查，到期以 timeout 返回且不发送。已交给连接（含 `socket.send()` 尚未返回时
同步收到应答）的 focus 绝不重发，其结果按上面携带 grant 的规则判定。

恢复期间的失焦：视图失焦、隐藏或 `setInputTarget` 失去输入目标时，客户端在登记的那一刻撤销本地输入许可（terminal-architecture 4.4.4），
不再有输入交给连接。远端的 blur 携带登记时本订阅持有或携带的 epoch E，与 focus 一样按登记顺序处理：恢复进行中时它等到 ready 再交出；
ready 时若基线裁定 E 仍属本订阅（恢复的或仍在等待自身控制事实的携带 grant），就发送 blur(E)；若裁定 E 已丢失，则无需释放，blur 不发送即完成。
排在其后的更新 focus 请求只有在自身至少已交给连接之后才取代它（server 会因此产生更新的 epoch）；若该 focus 被证明从未交出
（到期、计数耗尽、视图被替换等），仍发送 blur(E)。按 epoch 核对的 blur 即使晚于已被接受的更新 focus 也无害。blur 的期限从登记起算；恢复失败时，订阅随之结束，由 detach 释放。
可能已交出的 blur 绝不重发。

恢复期间的输入暂存（2026-10-10 用户决定，#83）：恢复期间（包括自身 focus/resize 引起的 resize-context 恢复、gap 恢复，以及首次 attach 与重新 attach 的恢复）
输入目标仍有效时，用户输入不再以 invalid-state 拒绝，而是在客户端有界暂存。控制器回到 ready、且本订阅持有可用 grant 后，按输入顺序发送。
可用 grant 指 `grantUsable` 成立：当前权威属于本订阅、没有未结算的 granted 控制、覆盖 `max(fenceSeq, grantAtSeq)` 的 ACK 已交给上行。
规则如下：

- 只暂存从未交给连接的输入。输入在 controller 登记时计费，并记录接受时刻（terminal-architecture 4.4.4）。尚未进入连接层的输入直接暂存；
  恢复开始时被取消、且连接层证明从未进入 `socket.send()` 的整条输入，按原顺序回到暂存队列头部。已交出（含结果不确定）的输入绝不重放；
  多块输入只要有一块已交出，其余部分就按前缀规则以未发送失败。
- 有界：暂存与在途输入共用现有的输入字节上限和条数上限，条数额度一直占用到结果通知被投递（terminal-architecture 4.4.3）。
  超限的输入在登记时立即以 capacity 拒绝，并按前缀规则关闭当前暂存世代。view 在发出前就拒绝的输入（renderer 的 `INPUT_REJECTED`，
  例如超长粘贴）同样表示用户输入的一段被丢弃，暂存世代打开时按登记顺序关闭它。
- 暂存世代：从第一条被暂存的输入开始一个暂存世代，它属于引起暂存的那次恢复，或自身 focus/resize 的 grant 等待。
  世代开始时，同一订阅中已交出但尚未结算的较早输入构成该世代的屏障。
- 前缀封闭（用户决定，2026-10-10；实现把这一策略集中在一个判定点）：
  - 暂存输入按接受顺序逐条、逐块发送，每块分配新的 inputSeq，每块交出前都核对期限与谓词。
  - 屏障中的较早输入全部完整成功之后，第一条暂存输入才可发送。例如 A=`echo sa` 在途、B=`fe\r` 被取消后暂存：B 只在 A 完整成功后发送。
  - 屏障中的输入或任一暂存输入只要没有被完整、成功地写入，后续暂存输入就全部停止，并以同一原因失败。未完整成功包括：交出前失败、
    明确拒绝（例如 not-accepted 的 BUSY）、部分写入、结果不确定、某块被拒绝、块与块之间到期。那条输入本身保留真实的 written/unknown 回执。
  - 失败后暂存世代关闭。在它结束前登记的新输入立即以锁存的原因失败，不分配 inputSeq，也不进入暂存。
  - 这样不会带着缺口发送后续输入，例如一个只发出一半的命令后面跟着回车。
- 暂存世代的结束分两种：
  - 成功结束：控制器 ready、grant 可用、没有进行中的恢复，且该世代的输入都已完整写入。
  - 失败结束：世代已关闭，它的每条输入（包括屏障中的较早输入）都已结算，且失败通知都已投递。失败结束不要求重新取得 grant。
  - 结束后登记的新输入走普通路径；需要暂存时开始新的世代，不再沿用旧世代的锁存原因。用户在失败结束后的再次点击或按键
    （view 在按键前宣告 focus）由此正常取得新的 focus 与暂存。
- grant 的裁定：暂存只在本订阅持有可用 grant 时发送。grant 可以是跨恢复保留的原 grant，也可以是恢复期间用户 focus 取得的新 grant；
  绝不在其他持有者、旧订阅或旧连接下发送。暂存跟随当前相关的 focus：该 focus 尚未交给连接时，即使携带的原 grant 可用，暂存也等待它交出，
  因为这次 focus 仍可能失败或被取代；它失败时暂存随之失败，被更新的 focus 取代时改随新的 focus。保留的 grant 按上文的基线规则裁定：B < A 时，基线处的其他持有者或 blur 不否定 grant，
  暂存继续等待 grant 自身的控制事实（受期限约束）。只有裁定证明 grant 已丢失，且没有仍有效的用户 focus 时，暂存才失败。
- focus 宣告：view 在每次用户输入前宣告 focus。只有在存在仍有效的延迟 focus，或本订阅持有或携带 grant 时，才做去重：
  宣告的网格与该 focus 或 grant 所请求的网格相同时，不产生新请求，不取代延迟 focus，也不使暂存失败。已应用网格只在该 grant
  没有已知的请求网格时（例如由基线恢复、本客户端从未请求过网格的 grant）才作为它的网格比较；相关 focus 或 grant 有已知且不同的请求网格时，
  与已应用网格相同不构成去重。例如先有延迟的 F80，基线随后安装 100×30，再宣告 F100：F100 取代 F80。
  网格不同的宣告作为更新的用户 focus，取代旧的延迟 focus，暂存改随新的 focus。既没有 grant 也没有延迟 focus 时（例如 gap 恢复），
  即使网格与已应用网格相同，这次宣告也是用户的 focus 请求，按上文延迟发送。恢复本身从不合成 focus。只有当前相关的 focus 失败时，暂存才失败。
- 可见失败：以下情况使暂存世代中尚未交出的输入全部失败，并按 terminal-architecture 4.4.3 逐条发布输入结果通知（已接受的输入总有自己的通知位）：
  - 恢复失败或超时；
  - grant 经裁定已丢失，且没有仍有效的用户 focus；
  - 当前相关的 focus 失败；
  - 失去输入目标（setInputTarget、视图失焦或隐藏、blur），在登记时立即生效；
  - 致命 view 失败（在登记时立即生效）；
  - 视图被替换；
  - detach、dispose、连接断开或订阅变化；
  - 每条暂存输入从登记起受恢复期限约束，到期以 timeout 失败。期限不因重新暂存、重新延迟或新的恢复而重置。
- 可见性的削弱：只有在接受时就被拒绝的输入（例如暂存世代关闭后的新输入或超限输入），在拒绝通知位用尽时才合并为拒绝聚合通知
  （terminal-architecture 4.4.3）。被合并的都是从未交出的输入，聚合保留按来源与错误分类的条数和字节数。
  已写入、不确定或部分写入的输入总是逐条报告完整回执。view 来源的输入只能通过 `onInputOutcome` 得知结果，这是对它唯一的削弱。
- 暂存只存在于内存中，不跨页面重载或连接重建保留，断线重连后也不补发（见 terminal-architecture 3.5）。

客户端的回调重入规则见 [terminal-architecture 4.4](terminal-architecture.md#44-回调通知与重入client-controller-与-view)：
观察者异步串行投递，意图同步登记并按序排水，外部代码之后的续体按操作谓词核对，连接层回调不重入连接层，
被取代的操作只对证明未交出的工作报告本地错误。上述延迟 focus、blur 与输入暂存的核对都按该规则执行。

不因普通尺寸切换引入额外确认、自动轮流抢占或复杂租约策略。输入、focus 和 resize 的权限边界
由 server 执行，客户端持有的 UI 焦点不能作为仍拥有控制权的证明。

### 9.2 终端查询回复（已确认）

终端查询由执行主机的权威终端模型唯一回复，回复权与客户端 focus、连接和可见性无关。
无客户端时仍可回复；客户端模拟器的自动回复不得作为键盘输入转发，恢复和历史回放不得重复向 PTY 回复。
服务端生成的查询回复不依赖客户端持有 controlEpoch；它不是用户输入，也不要求等待客户端网络往返。
客户端若提供颜色等显示属性，其更新必须验证当前控制权；旁观者和旧操作者不能覆盖权威属性。
会话能力必须与客户端实际能力一致，未知属性不编造答案。具体属性 schema 和客户端回复抑制机制仍需验证。

### 9.3 数据传输

已确认 relay 承载迁移所需数据。建议数据传输使用独立流身份、传输操作 ID、内容版本与进度，
不混入终端输出序号、终端输入确认或业务元数据游标。断点续传需要校验相同内容和接收端已确认范围。
成功应答区分已接收、已校验、已发布；workspace 交接是另一个操作。

首次发布前明确哪些传输能力属于协议基线；后续新增内容类型、帧或压缩方式需要能力协商，
同协议版本不能因为升级了传输实现而拒绝已有的终端核心能力。
控制、终端和数据流分别限流与调度；文件传输使用独立于终端 WebSocket 的 HTTP 通道，同样校验 server 身份和授权。
具体方法和帧格式在实施前冻结，行为边界见 [Server 数据传输](server-architecture.md#61-relay-承载数据传输)。

## 10. 发布门槛与验证

基础协议需要版本化的契约说明和固定参考客户端/relay，不能只测试同一源码构建出的两端。
每个仍受支持的协议保留参考实现或冻结测试产物；协议退役也要有明确 recovery 提示。
首次正式以版本号发布之前的实验构建不形成需维护的兼容支持线，也不为中间提交提供回补；
从首次正式版本号发布起，同版本兼容、受支持协议的冻结参考和退役提示按本节执行。
发布前历史实验读端的失败应保留为诊断负控，不冒充正式发行兼容失败，也不改变当前版本正确性或握手版本识别要求。

首次发布（任何形式，包括 alpha）之前，wire 形状变化（包括新增必需字段等不兼容变化）不提升 `protocolVersion`。
此阶段不支持混合构建：客户端与 server 必须来自同一构建，不同构建相遇时的失败不属于兼容缺陷。
第 1、5 节的同版本兼容保证从首次发布起生效。

核心验收：

1. 旧客户端 × 新 relay、新客户端 × 旧 relay：同协议版本基础能力双向通过。
2. 客户端升级后实例 ID、terminal ID 和原进程身份不变，既有 TUI 可继续输入输出。
3. 老 mobile 与新 desktop 同时连接，同版本可选能力按连接协商，不互相影响。
4. 新旧协议相遇，在业务请求前拒绝；原 PTY 保留，不自动 spawn/reset。
5. 稳定入口丢失、认证失败、网络中断、未知握手均不能触发替代实例创建。
6. 新实例 session-not-found 不清除旧实例归属，也不自动重启 agent。
7. Reset 的预期实例已经变化时拒绝操作，不影响新实例或其他 profile。
8. 客户端全部断开后，原 relay 和 PTY 仍可重新接入。
9. 重连回放不重复触发状态事件，输出缺口可见，不确定输入不重复执行。
10. Relay 意外崩溃与主机重启单独报告，不能把客户端更新时的存活承诺扩展为所有故障下存活。
11. Desktop 完全离线时，mobile 可以独立访问相同任务和原 PTY。
12. 内置 Tailscale 重连或网络入口切换不改变 server/relay instance/terminal 身份。
13. 桌面与手机交替获得终端 focus 时自动切换控制者和尺寸，无需确认；相同尺寸不执行 resize。
14. 旧 epoch 的输入、resize、blur，以及旧连接和重复 focus，不撤回较新状态或重复触发尺寸变化。
15. 后台重连和控制权通知不争抢 focus；前台恢复能够重新获得控制权，全部离线保留最后尺寸。

这些应作为 core 的发布验收，而非 UI 完成后的补充优化。

## 11. HTTP RPC 请求、操作与重试

已确认标准 JSON-RPC 2.0 over HTTP，由 Fastify 承载、Zod 校验、领域方法表分发。
保留独立 operationId、持久操作、去重与长操作恢复设计；具体领域字段、状态枚举与错误码分配仍为草案；保存期限已决定（§11.3）。
JSON-RPC 2.0 定义关联 ID、结果/错误、通知和 batch，不替代 Cove 的授权与恢复语义。
`jsonrpc: "2.0"` 只标识消息格式；Cove protocolVersion 继续独立标识业务兼容契约。
选择标准不要求引入额外 RPC 框架；实现库另定，必须通过标准格式和 Cove 行为两层契约测试。

### 11.1 入口、身份和版本

- 候选业务入口 `POST /rpc`，`Content-Type: application/json`。首期 Cove 客户端只发送单条、带 id 的调用。
  服务端按标准处理请求、notification 和有界 batch；batch 不保证执行顺序或事务原子性。
  notification 无论成功或失败都不返回 JSON-RPC response；其写方法仍需合法 operationId 和授权。
  Cove 客户端的重要写操作不得使用 notification，以便及时获取操作回执。
- 身份来自认证层，不信任 params 中的 deviceId/userId；凭据不放进 RPC payload 或诊断日志。
- loopback 入口（业务端口、终端 WS 与配对监听）的 Host 须为 loopback IP 字面量 `127.0.0.1:<端口>` 或 `[::1]:<端口>`，
  端口 1–65535，不要求等于 server 自己的端口；域名 Host（含 `localhost`）与格式错误的 Host 一律拒绝，Origin 规则不变
  （用户决定 2026-10-22，此前为恰等于绑定地址）。Host 校验只是认证前对 DNS rebinding 的防线，rebinding 请求必然带域名
  Host；server 本就无法区分本机流量与经 SSH `-L` 等本机隧道转发的流量，信任来自每个业务请求必需的 token 或本机秘密。
  请求目标须为 origin form（以 `/` 开头）：absolute form（如 `POST http://evil.example/bootstrap`）与 `*` 在准入前即为
  malformed（HTTP 400），因为路由只按其路径匹配；Host 头须恰有一个，重复（不论大小写与取值是否相同）即拒绝。
- 每次调用声明 `Cove-Protocol`；服务端先完成认证和协议检查，再解码并分发业务调用。
  握手结果不能成为后续 HTTP 请求跳过检查的理由。
- 版本不匹配通过稳定 bootstrap 错误格式返回，包含支持版本及 recovery 提示；不需要读懂当前业务 envelope。
  准入失败的 HTTP 状态：malformed 400（含 `BOOTSTRAP_UNSUPPORTED`）、unauthenticated 与 revoked 401、forbidden 403、
  协议或实例不符 409、过大 413、busy 429、unavailable 503（`ADMISSION_STATUS`）；首次正式发布前仍可调整。
- 业务响应复用请求中的 `Cove-Server-Id`、`Cove-Instance-Id` 和 `Cove-Protocol` 三个 header，
  分别携带 `serverId`、`relayInstanceId` 和 `protocolVersion`；header 名按 HTTP 规则不区分大小写。
  响应不回显 `Authorization`，也不给标准 JSON-RPC envelope 增加必需 meta 字段；客户端逐次验证原服务身份。
  网络地址改变不创建新的操作命名空间，服务重启也不改变持久 serverId。
- API 消息大小、并发、超时均有界；具体限额另行测定，文件内容不嵌入 RPC body。

### 11.2 只保留两个执行标识

| 字段                 | 生命周期                                     | 用途                                                                 |
| -------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| JSON-RPC `id`        | Cove 客户端每次网络尝试生成新的字符串 ID     | 关联这一次请求、响应与诊断；不是去重依据，服务端按标准回显           |
| `params.operationId` | 客户端在首次提交写操作前生成并保存；重试不变 | 持久业务操作身份，同时作为幂等键；响应丢失后客户端仍知道查询哪个操作 |

operationId 使用不可预测且碰撞概率可忽略的 ID；具体生成格式另定，所有客户端统一实现。
JSON-RPC 允许字符串、数字或 null 的 id；客户端使用字符串是 Cove 的生成约定，不改变标准解析规则。
无法识别请求 id 的解析/请求格式错误使用 `id: null`。各 Cove 方法定义具名对象 params。
读取方法不需要 operationId；所有有副作用的方法需要，包括取消、停止、配置修改和恢复命令。
客户端的未决操作记录只跟踪已明确提交的意图；不意味着离线期间可自动排队新执行性操作。

候选创建请求（仅展示 envelope；task.create 的领域参数尚未冻结）：

```json
{
  "jsonrpc": "2.0",
  "id": "req-101",
  "method": "task.create",
  "params": {
    "operationId": "op-201",
    "title": "调查终端重连",
    "mounts": []
  }
}
```

写操作的成功 RPC 响应统一返回操作记录；排队和执行完成使用同一结果结构：

```json
{
  "jsonrpc": "2.0",
  "id": "req-101",
  "result": {
    "operation": {
      "id": "op-201",
      "method": "task.create",
      "state": "accepted"
    }
  }
}
```

快速数据库操作可以直接返回 `state: succeeded` 以及方法专属 `result`。
创建 worktree、传输、迁移等返回 accepted/running，由 `operation.get` 或事件查看最终结果。
客户端在调用前就知道 operationId，因此无需另设“按丢失的 JSON-RPC id 找回操作”的接口。
读方法的 result 直接返回领域数据；operation.get 返回当前操作记录及其 revision。
JSON-RPC 响应有 result 表示调用成功并返回了记录，不表示记录中的操作已成功；
operation.get 和重复提交也可以成功返回 `state: failed` 的历史操作，不能重新执行它。

### 11.3 去重、并发与保存期限

服务端按 `(serverId, principalId, operationId)` 建立持久唯一记录，并保存发起设备用于审计。
同一用户的其他已授权设备可查询与跟踪；每次请求仍检查当前授权，撤销设备不能靠旧 operationId 继续访问。
RPC 方法注册输入/输出 schema、所需能力与权限、读写类别、资源并发规则及执行/恢复处理器。

1. 认证、版本、方法能力与参数检查通过后，构造稳定的操作指纹。
2. 在事务内竞争操作 ID。已存在且指纹相同则返回当前/最终记录，不再次执行；
   已存在但方法或有效参数不同则返回 `OPERATION_ID_CONFLICT`，保留原操作。
3. 指纹覆盖方法、已接受的参数、并发前提和目标 host/资源绑定，排除 JSON-RPC id 和网络连接信息。
   使用明确的 JSON 规范化规则；同版本默认值必须稳定，不能因部署更新改变相同重试的意义。
4. 对已存在的同一操作先去重，再检查用于新执行的资源 revision；
   已成功的操作重试不能因自身改变了资源 revision 而被误判为新冲突。
5. 纯数据库写入可以将操作记录、资源更新和事件发布记录一起提交。
   外部动作先持久化意图与目标，再开始执行；未持久接受之前不得启动副作用。
6. 同一操作只能有一个执行者；不同操作竞争同一资源仍需 revision 检查、状态机或资源锁。
   长操作执行前/关键步骤再次检查权限、资源归属和前提，不能仅依赖入队时检查。

保存期限（用户于 2026-10-21 决定，[m2](milestones/m2.md) D13，#97）：

1. 已结束（succeeded、failed、cancelled）的操作记录在结束后保存 30 天，然后清除完整记录，换成永久 tombstone。
   tombstone 约百字节，只有记录键、方法、终态、规范化意图 SHA-256 的前 16 字节与结束时间，
   不含参数、结果与秘密。tombstone 从不删除，所以同一 operationId 永不重新执行。
2. 未结束的记录（accepted、running、recovering、requires_attention）无论多旧都不自动清除。
3. 对 tombstone 的重发：
   - 同一意图的写方法重发返回 `OPERATION_HISTORY_EXPIRED`（acceptance `not-accepted`：这次请求没有被接受，什么也没执行），
     其他意图返回 `OPERATION_ID_CONFLICT`；
   - `operation.get` 返回 `OPERATION_HISTORY_EXPIRED`，不同于从未用过的 ID 的 `OPERATION_NOT_FOUND`。
   - 两种回答都不是成功，也不重新执行。数据库层的触发器还拒绝为已有 tombstone 的键写入新记录。
4. 记录仍被现存状态读取时暂不清除，到期后等这一状态消失再清除：
   - worktree 挂载当前 attempt 所属的操作，或认领该 attempt 的 abandon；挂载移除或重试换了当前 attempt 后才清除；
   - 有未确认结束的已记录进程的操作；
   - 记录了 run-N 编号上限（`runs.highestNumber`）的那几条记录，避免重启后重复分配 run 编号。
5. 清除在存储 worker 中分批进行，每批一个事务，最多 256 条。
   - 启动核实完成后立即执行一轮，之后每轮结束 1 小时后再执行一轮；批与批之间其他存储调用照常排队。
   - 一批要么整批提交、要么整批回滚，崩溃或答复丢失后下一轮继续清除仍到期的记录。
   - 定时器不使进程保持运行，server 停止时取消。
6. 时钟：按墙钟计算“结束时间 + 30 天 ≤ 现在”。
   - 时钟回拨只让记录显得更新，只会推迟清除，绝不提前；
   - 结束时间在当前时钟“未来”的记录要等时钟越过它加 30 天；
   - 时钟被调快会提前清除完整记录，但 tombstone 照样拒绝该 ID，所以不会重复执行。
7. CLI 本机待定记录同样在保存 30 天后过期：
   - 过期记录不再发送：`operation resend` 在本机拒绝且不发送，以同一 `--operation-id` 重用也拒绝；
   - 记录留在磁盘上，`operation get` 仍可向 server 查询。

不承诺在删除或重建 server 数据、回滚备份之后仍具备完整的去重证据。
完整恢复窗口是协议契约的一部分，客户端不得自行推断未公布的重试期限。

### 11.4 外部副作用与重启核实

SQLite 事务只能覆盖数据库，不能原子覆盖 Git、目录创建、文件发布或 PTY spawn。
因此本方案不承诺任意副作用的 exactly-once 执行，只承诺正常重试去重和不确定时不盲目重跑。

| 操作                  | 重启后的核实与处理                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 配置/标题等数据库更新 | 读取原事务中的操作结果，返回原记录                                                                                                |
| 创建 managed worktree | 意图内预先记录目标路径、仓库、ref 与所有权证据；核实 Git/目录状态，匹配才能继续或补记成功                                         |
| 删除 managed worktree | 删除前先记下删除与挂载原状态，其间拒绝使用该路径的新 run；重启后为 requires_attention，continue 观察 Git/目录状态后补记删除或再删 |
| 转换绑定              | 准备期间保留原绑定；目标核实后一个事务复查前提并切换；重启后按 managed worktree 创建核实                                          |
| 文件传输/迁移         | 按清单、块校验和发布记录恢复步骤；传输完成与 workspace 权威交接分开核实                                                           |
| 启动终端              | 绑定预分配 runId 和接受时的 relayInstanceId；不把旧操作在新实例中重新 spawn                                                       |

例如终端已启动但成功记录尚未提交时 server 崩溃：一期没有独立 PTY keeper，
恢复 tab 不等于恢复旧运行。核实实际进程状态；证据不足进入 requires_attention，
不声称成功、不因连接丢失断言 exited，也不自动创建第二个 agent。
即使旧启动操作已成功，当前 run 也可能已退出；历史操作成功与当前进程存活必须分开展示。
确实要重新打开时，用户提交新的操作 ID，创建新的 runId。

### 11.5 操作状态与取消

候选操作状态：`accepted`、`running`、`recovering`、`requires_attention`、`succeeded`、`failed`、`cancelled`。
这些是操作状态，不替代 tab、agent 活动、网络连接或进程的 live/unverifiable/exited 状态。
failed/cancelled 可以保留部分副作用，记录 completedSteps、remainingEffects 和可用恢复动作，不能暗示全部回滚。
准备托管 worktree 的写（task.create、mount.add、mount.retry、binding.convert）在结果的逐挂载结果中以可选的
`left`（`worktree`、`branch` 或 `both`）标出失败或被放弃的尝试留在原处的产物：删除它们可能丢失工作，
因此不删除（m1 D1 T3b）。它只是引用，路径与分支名在挂载记录（task.get）中，仓库路径在 repo 记录中。
例外是留下的分支：`left` 为 `branch` 或 `both` 时，单挂载结果另带 `branch` 给出留下的分支名（#132），因为转换的挂载
仍是 checkout，重试也可能已选了另一个分支，挂载记录里的分支不是留下的那个。
带 `left` 的结果不带 `targetOperationId`，只在恰有一个挂载时才可带 `sourceChanges` 或挂载的 `branch`（mount.retry 与
binding.convert 各只准备一个挂载，m1 T5；schema 约束），以保证最坏情况的操作记录仍在记录预算内。
requires_attention 保留已有进度；后续显式恢复处理器可以继续同一操作，不能用普通重复提交绕过暂停核实。

- HTTP 超时/断开只代表客户端不再等待；已持久接受的写操作继续，不随请求 AbortSignal 被隐式撤销。
- 查询可以在断线后取消；未接受的写操作可以拒绝，不能与已接受操作混用取消语义。
- `operation.cancel` 自身是一次带新 params.operationId 的写调用，另以 targetOperationId 指定要取消的操作；
  取消请求持久接受不等于目标已 cancelled。目标设置 cancelRequested，在安全边界停下并记录剩余影响。
- 已完成的目标保持原终态；已跨不可逆交接点或不支持取消时返回明确结果，不伪造回滚。
- CLI 默认等待最终结果，底层使用同一操作查询/订阅；显式提供不等待模式并打印 operationId。
  CLI 本地等待超时返回“结果未定”及查询方式，不替用户生成新 ID 再试。

### 11.6 错误与客户端后续动作

RPC 错误使用标准整数 error.code、供人阅读的 error.message 和可选 error.data。
标准解析/请求格式/未知方法/无效参数/内部错误分别使用 -32700/-32600/-32601/-32602/-32603。
领域错误在应用可用范围内统一分配整数码，error.data.kind 保存稳定领域名称，details/recovery 也放入 data。
客户端按 code/data.kind 决策，不解析 message 文本。错误详情不包含凭据或任意原始输入。
响应必须有 result 或 error 且二者互斥，不再使用自定义 ok 字段。
不使用笼统 `retryable: true`，因为“重新发送同一操作”和“新建操作重做”不是一回事。

| 错误/观察                                     | 后续行为                                                             |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `INVALID_ARGUMENT`                            | 展示字段问题，修改后以新的写操作意图提交                             |
| `UNAUTHENTICATED` / `FORBIDDEN`               | 修复授权；不执行重试风暴，不回放终端输入                             |
| `CAPABILITY_UNAVAILABLE` / `METHOD_NOT_FOUND` | 同版本未支持的可选能力提示不可用；基础方法缺失视为契约问题           |
| `REVISION_CONFLICT`                           | 获取当前资源，由客户端/用户重新决定，不默默覆盖                      |
| `OPERATION_ID_CONFLICT`                       | 同 ID 被用于不同意图；保留原操作，修复调用方，不自动生成新 ID 绕过   |
| `BUSY`                                        | 若已明确未接受，退避后以同 operationId 重试；响应不明仍先查询        |
| `OPERATION_HISTORY_EXPIRED`                   | 去重证据尚在但完整结果已清理；核对资源，禁止同 ID 重新执行           |
| `GIT_UNAVAILABLE`                             | Git 无回答（超时/超限/缺 git/git 早于 2.45）；未接受，路径状态未知   |
| `REPO_IN_USE`                                 | 仍有 task（含已归档）的挂载引用该 repo；未接受，先移除这些挂载       |
| `WORKSPACE_ENTRY_UNAVAILABLE`                 | workspace 根目录无法创建，或入口路径已被占用；未接受，不记录任何内容 |
| `DEVICE_REVOKED`                              | 设备 token 正确但设备已撤销；重新配对，不以旧 token 重试             |
| `INVITATION_UNAVAILABLE`                      | 邀请已兑换、已取消、已过期、不存在或秘密错误（不区分）；换新邀请     |
| `INVITATION_NOT_FOUND` / `DEVICE_NOT_FOUND`   | 已认证的管理请求指向不存在的邀请/设备；刷新列表                      |
| `SERVER_ID_MISMATCH`                          | 入口另一端的 serverId 不是登记的那个；未发送 token，人工核对         |
| `PEER_IDENTITY_MISMATCH`                      | SSH host key 或 tsnet 节点 ID 与登记不符；未发送 token，人工核对     |
| `ENTRY_UNAVAILABLE`                           | 所选入口无法到达或启动；未发送，客户端不自行改用其他入口             |
| 网络超时、连接断开、不可识别的 5xx            | 客户端本地状态为结果未知；按 operationId 查询，不能认定操作失败      |

错误示例（1001 仅为示意，领域错误整数码尚未冻结）：

```json
{
  "jsonrpc": "2.0",
  "id": "req-102",
  "error": {
    "code": 1001,
    "message": "Workspace changed since it was read",
    "data": {
      "kind": "REVISION_CONFLICT",
      "details": { "expectedRevision": "17", "currentRevision": "18" },
      "recovery": { "action": "refresh_resource" }
    }
  }
}
```

JSON-RPC 本身不规定 HTTP 状态映射。候选 HTTP binding：通过认证并进入 RPC 处理的调用，
HTTP 200 承载标准 result/error（包括 batch 中成功与失败混合的 response 数组）；
纯 notification 请求使用 HTTP 204 空 body，batch 中的 notification 也不产生 response 项。
HTTP 400/401/403/409/413/429/500/503 留给请求入口、认证、协议协商、大小限制和基础设施故障，
具体映射在 HTTP binding 实现前冻结，不根据 HTTP 200 推断 operation 已完成。
协议不匹配、过大请求、代理或连接层错误可能没有业务 envelope；客户端必须保留结果未知语义。
已接受操作的执行失败通过 operation 的终态/error 表达，不能仅留下一个 HTTP 500 后丢失操作记录。

查询得到 not-found 也不证明正在传输的旧请求不会稍后到达；
客户端可以在恢复窗口内、验证同一服务后，以相同 operationId 和相同参数重发，唯一约束确保只接受一次。
若操作已成功，重发只读回原结果；如果历史不可核实则进入恢复，不新建操作绕过去重。

### 11.7 事件同步与验证

HTTP 响应与 WS 事件谁先到都合法。操作 ID 关联结果与事件，资源/操作 revision 防止旧响应覆盖新状态。
一次操作可以产生多个事件；事件身份/游标负责事件去重，不能把 operationId 当成唯一事件 ID。
快照带原子一致的游标，事件按游标连续消费；不能拿 HTTP 响应中的较新 revision 跳过未消费的其他资源事件。
保留窗口外重新取快照；协议版本、事件 schema 和可选能力仍受第 5 节约束。

本草案的验收用例：

1. 同一操作并发提交/在提交成功后丢响应，只产生一次数据库变更和一条操作身份。
2. 同 operationId 不同参数、不同目标或不同 revision 被拒绝；不同 JSON-RPC id 不破坏去重。
3. 两客户端同时修改同 revision，仅一个成功；原成功操作的重试仍能读回结果。
4. 在意图提交、Git/PTY 副作用、结果提交各边界注入崩溃，能够核实或明确暂停，绝不盲目 spawn。
5. 已接受操作不随 HTTP 断线取消；取消请求与目标完成竞态有明确结果及残留影响。
6. 事件先于响应、响应先于事件、游标过期、操作历史清理、设备撤销均保持正确行为。
7. 同协议不同构建的请求/响应/错误契约兼容；版本不匹配不进入业务执行。
8. 标准 id 回显、result/error 互斥、解析错误、notification 无响应、空 batch/混合 batch 的行为符合 JSON-RPC 2.0。

参考：[JSON-RPC 2.0](https://www.jsonrpc.org/specification)。标准 envelope 已选；Cove 的方法、HTTP binding 与操作恢复细节按上述草案继续收敛。

### 11.8 M2 方法、凭据与秘密边界

M2 T0 定义下列契约（[m2 计划](milestones/m2.md)），T1–T5b 实现了全部处理器。协议仍处于首次发布前，`protocolVersion` 不变（m2 D12）。

| 方法                                                        | 类别  | 权限          | 秘密字段（输入 / 输出） |
| ----------------------------------------------------------- | ----- | ------------- | ----------------------- |
| `auth.invite.create`                                        | 写    | `owner`       | — / `invitation`        |
| `auth.invite.list`、`auth.device.list`                      | 读    | `owner`       | —                       |
| `auth.invite.cancel`、`auth.device.rename`/`revoke`         | 写    | `owner`       | —                       |
| `auth.device.rotate`（只轮换调用者自己的 token）            | 写    | `owner`       | — / `token`             |
| `entry.get` / `entry.set`（入口配置，端口与主机名重启生效） | 读/写 | `owner`       | —                       |
| `server.impact`（重启影响）、`server.tsnet.status`          | 读    | `owner`       | —                       |
| `server.tsnet.login`                                        | 写    | `local-owner` | `authKey` / `loginUrl`  |
| `server.tsnet.logout`                                       | 写    | `local-owner` | —                       |

- 权限：已认证的主体都是同一个 owner（m2 D7）。`local-owner` 方法只接受本机凭据，设备调用为 `FORBIDDEN`，
  理由是运维而非安全：远程登出 tsnet 可能切断调用者所用的入口，auth key 也不应经网络传给 server。
  配对兑换不是 RPC，走配对监听且不留操作记录（D6）。安装与启停服务是本机 CLI 动作，不是 RPC。
- 秘密只放在 params 或 result 的嵌套成员 `secrets` 中，方法表逐方法声明其键，模块加载时与 schema 核对。
  分派层在构造指纹、规范化参数与操作记录之前移除输入秘密，单独交给处理器。回答（含拒绝的 details）中
  顶层 `secrets` 之外任何解码后的字符串含有本次调用的秘密、更深处出现 `secrets` 成员、或顶层 `secrets`
  不恰好符合声明（多出的键、无效的值）时，都视为内部错误；HTTP 发送的是 schema 解析后的结果。
  回执事务在写入前检查即将保存的记录，含有秘密就整体回滚，不留回执；M2 写的记录只保存按方法固定的
  引用字段，不带 run。输出秘密在写入前按声明校验，只在真正提交该写操作的那次调用中返回，
  同 operationId 的重复提交与 `operation.get` 都读不到。CLI 先按方法 schema 校验请求（解析会去掉或改变字段
  即拒绝，不写盘也不发送），待定记录只保存被省略的秘密字段名，这样的记录不能重发：`operation resend`
  在本地拒绝且不发送，需重新执行原命令；同一 operationId 以不同的秘密字段重用时同样拒绝。
- 凭据：`Authorization: Bearer` 与终端 WS 的 `secret` 接受两种形式，二者互不重叠：
  本机秘密（43–256 个 base64url 字符，只出现在 rendezvous 文件中）与设备 token
  `cove_d1_<deviceId>.<43 个 base64url 字符>`。凭据正确但设备已撤销时为 `DEVICE_REVOKED`（HTTP 401，WS 以 policy 关闭），
  其余无法认证的情况都是 `UNAUTHENTICATED`，不区分设备不存在与秘密错误。
  `auth.device.rotate` 发出的新 token 首次使用时，server 先在存储中提交“新 token 成为当前 token、旧 token 失效”，
  提交后才受理并应答该请求；因此任何以新 token 得到认证成功应答的使用，重启后都不会让旧 token 恢复。
  存储暂时无法提交时，该请求以 `UNAVAILABLE`（HTTP 503，WS 发送失败后以 capacity 关闭）拒绝且不执行，
  两个 token 都保持原状，客户端稍后重试；有效 token 不会因此得到 `UNAUTHENTICATED`。
- 认证前身份 `cove-bootstrap-identity`：对合法 bootstrap 请求只返回 `bootstrapVersion`、`protocolVersion`、
  `buildVersion`、可选的 `sourceBuild`、`serverId` 与 `relayInstanceId`，供客户端在发送设备 token 前核对 serverId。
  `sourceBuild`（#175，首次发布前加入，`protocolVersion` 不变）与 `buildVersion` 同样公开、同样有界，是 server 的
  source build（见下文 `buildVersion` 一条）；server 不知道自己的 source build 时省略它。
  serverId 只用于识别 server，不能证明对端就是它：loopback 入口上，同一主机的其他进程（例如另一个系统用户）
  先占用业务端口或配对端口并回报相同的 serverId 时，客户端无法分辨。同主机端口抢占不在 T1 的防护范围内，
  这是已记录的残留限制（2026-10-21 用户决定）；跨主机入口的对端认证由 SSH（T2）与 tsnet（T4）提供。
- 配对监听（m2 T1）不是 RPC，只接受两个 POST（`PAIRING_PATHS`），请求与响应各不超过 4 KiB。
  - `/bootstrap` 返回同样的认证前身份。
  - `/pair` 接受 `cove-pairing-redeem`（`inviteId`、`secret`、`deviceName`）：成功时以 `cove-pairing-result`
    （`serverId`、`deviceId`、`token`、`businessPort`）应答，失败时以 `cove-pairing-error` 应答，其 `kind` 为
    `INVITATION_UNAVAILABLE`、`BUSY` 或 `INVALID_ARGUMENT`。
  - 应答是固定内容，不回显请求。`token` 是秘密，只出现在这一次应答中，不建操作记录。
  - 邀请字符串为 `cove-invite:v1:<payload JSON 的 base64url>`，编解码见 `encodeInvitation`/`decodeInvitation`。
- `buildVersion` 为 `<根 package 版本>+<16 位十六进制>`：运行时对 `apps/*/dist`、`packages/*/dist` 中的编译产物
  （不含 `.d.ts`、`.map`、`.tsbuildinfo`）、这些 package 的 `package.json` 与 `pnpm-lock.yaml` 按相对路径计算 SHA-256，
  取前 16 位，每个进程缓存一次。server 与 CLI 对同一构建得到同一值；找不到 workspace 根目录时为 `unidentified`。
  Node 本体、native addon 与其他二进制不在其中。这是开发时的后备：安装版（m2 T3、D1）在安装时为完整闭包写入标识，
  提供后优先于运行时计算。它只用于诊断与版本提示，不参与兼容判定；runtime 与 worker 之间的 pipe 仍报 `0.0.0`，
  因为二者总来自同一构建。安装版的 build ID 包含 Node、原生模块与 cove-tsnet，随平台不同，是安装身份。
- source build（#175）格式与 `buildVersion` 相同，覆盖开发 build ID 的全部文件加 cove-tsnet 的 Go 源码
  （`native/tailscale` 下非测试的 `.go`、`go.mod`、`go.sum`，不含 `dist/`），按相对路径计算，不含 Node、原生模块与任何路径，
  所以同一提交在任何机器、OS 与路径上都相同。开发构建在运行时计算；安装版取 stamp 的 `source`（组装闭包时对来源
  checkout 计算）。CLI 的 D12 提示在双方都有 source build 时比较它，否则比较 `buildVersion`；两者都只是提示。
- server 的 tsnet 节点（m2 D10、T5b）：
  - `server.tsnet.status` 的 `state` 为 `logged-out`（没有节点状态）、`stopped`、`starting`、`needs-login`、`running`
    （节点后端状态），或 `failed`（节点或 `cove-tsnet` 助手不可用，第一条警告说明原因）。
  - `hold` 为 `identity-changed`（一次登录以另一个节点结束，`nodeId` 是那个节点；只有登出能结束）、
    `login-uncertain`（登录没有完成且可能已经完成，或交互登录尚未完成；之后的 `status` 会核实）或 `null`；
    有 hold 时节点不监听任何端口。`ports` 是节点此刻在 Tailnet 上监听的端口（业务端口，有 `open` 邀请时加配对端口），
    最多 16 个。`warnings` 最多 4 条、每条最多 512 个字符、不含控制字符，其中可能有控制面给出的第三方文本，
    但不含 auth key 或登录 URL。
  - `server.tsnet.logout` 的记录只保存 `remoteLogoutConfirmed`：`false` 表示节点状态已在本机删除，但控制面没有确认，
    该节点可能仍列在 Tailnet 中，需在管理台移除。`server.tsnet.login` 的记录只保存 `secretDelivery`；
    登录 URL 只在提交该操作的那次应答的 `secrets.loginUrl` 中出现。
  - 登录 URL 的送达（顺序保守：先应答，后记录）：
    - 助手给出 URL 时，若应答预算（自请求到达起 25 秒）已用完，或传输层表明应答已无法发出（客户端超时、断开），
      URL 被丢弃，记录为 `TSNET_LOGIN_UNCERTAIN`。
    - 否则应答立即发出，带 `running` 记录与 `secrets.loginUrl`，决定与应答之间没有存储写入。
    - 传输层报告这次应答已完整交给操作系统后，记录才成为带 `secretDelivery: "first-response-only"` 的 `succeeded`；
      应答在此之前关闭、未发出或带的是错误时为 `TSNET_LOGIN_UNCERTAIN`。其间 server 停止则记录停在 `running`，
      下次启动成为 `requires_attention`（`RESULT_UNKNOWN`）。没有传输层可确认的调用（进程内分发）从不记为已送达。
    - 剩余窗口在交给操作系统之后：字节仍可能丢失，或在客户端停止等待后才到。CLI 的请求超时（30 秒）长于应答预算；
      没有收到 URL 的客户端看到 `secretDelivery` 而没有 URL，重新运行登录即可。
  - 登录失败的记录以固定消息的错误结束：`TSNET_LOGIN_FAILED`（被控制面拒绝、auth key 登录超时，或节点已登录；
    什么都没有改变，没有状态的节点的半成品状态已删除）、`TSNET_IDENTITY_CHANGED`、`TSNET_LOGIN_UNCERTAIN`（还包括
    交互登录在给出 URL 前超时：节点不回滚，已登记的节点保持 hold；以及上面 URL 未能送达的情形）。原因的说明在
    `server.tsnet.status` 的警告中，不进记录。登录进行中助手退出、或 server 重启，记录为 `requires_attention`
    与 `RESULT_UNKNOWN`；结果用 `server.tsnet.status` 查看。
