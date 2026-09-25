# 独立 Server、接入与同步

状态：设计草案，尚无实现。独立持久服务、多客户端直连、内置 Tailscale/host 网络、
断开客户端后终端继续存活是已确认需求。数据同步与模块划分是建议方案。
首期 server 支持 macOS/Linux；单用户多设备、可撤销设备凭据、统一网络入口授权已确认。
远程连接已选择 SSH/Tailscale 安全通道，Cove 保留设备授权；首期不实现应用层 E2EE 或自建证书体系；二期 Web 入口建议委托 Tailscale 管理 HTTPS 证书。

## 1. Relay 的定位

本文用 Cove Server 指前文的 relay：每台执行主机上的独立持久服务。
它类似带业务 API 的终端会话服务，不依附于 macOS desktop、SSH channel 或某个 owning client。

```text
Desktop ──┐
Mobile  ──┼── SSH / system or embedded Tailscale ── Cove Server
Web/CLI ──┘                                         ├── repo 注册
                                                    ├── task / workspace / 操作记录
                                                    ├── 多端状态同步
                                                    └── 持久 PTY / terminal state
```

关闭 desktop 后，mobile 仍能读取任务、创建 task/worktree、打开终端并接入已有 PTY。
Desktop 不是目录、数据库、认证材料或终端数据的必经中转。
每个客户端可以直接连接多台 server 并汇总展示；一期不因此引入一个全局云控制面。

## 2. 状态归属

建议按 host server 管理其承载的业务与执行状态。

| 状态 | 权威位置 | 多端处理 |
| --- | --- | --- |
| 本机 repo 注册、task、workspace、挂载与迁移记录 | Server 持久存储 | 客户端订阅确认后的状态 |
| 逻辑 tab 清单、名称、启动配置与所属 task | Server 持久存储 | 各端可打开同一 tab；运行实例结束不删除记录 |
| PTY 运行实例、退出事实、尺寸和控制权 | 实际执行主机 | 缓存不能证明当前存活 |
| 输出、有限历史、终端快照 | Server 终端模块 | 按需订阅，独立于业务状态流 |
| 窗口位置、当前 tab、pane 布局、字体、滚动与选择 | 当前客户端 | 默认本地，不强迫手机复制桌面布局 |

逻辑终端清单不等于某客户端当前打开的 tab。
Task/workspace 清单只来自 Cove 管理记录；repo 注册不自动导入其他 worktree，
Git 枚举仅用于必要校验/诊断。显式引用外部 checkout 不改变其目录所有权。
关闭本地视图不删除服务端逻辑终端；停止会话是显式服务端命令，并向所有订阅者发布结果。
同样，其他客户端切换页面，不应该抢走本机用户的当前页面。

## 3. 同步：命令提交给 server，server 发布事实

建议最初使用单 server 仲裁，不做客户端之间的对等合并或通用 CRDT。

1. 客户端取带 revision/cursor 的快照，并无缝订阅快照之后的事件。
2. 修改通过命令提交；重要修改携带资源的 expected revision。
3. Server 校验身份和条件，执行操作，持久化确认结果，再发布对应变化。
4. 各客户端应用相同事实；乐观 UI 必须能确认或撤销，不能成为另一份权威数据。
5. 重连时补发缺失事件；保留窗口以外重新取快照，不能以过期本地快照覆盖 server。

需要处理的边界：

- 事件 cursor 与数据快照必须对应，避免取快照和订阅之间漏事件。
- 持久化与发布之间失败时可以重放已确认变化；具体使用持久事件表或 outbox 待实现决定。
- 并发修改挂载、归档或迁移时，使用资源 revision 检测冲突，拒绝陈旧写入。
- 创建 worktree、启动终端等非幂等动作有操作 ID；响应丢失时查询已有操作，不能重复执行。
- 长操作发布 pending/成功/失败及逐步结果，不伪装成一次原子数据库提交。
- 删除或移除资源要可同步；事件保留窗口外依靠完整快照清除陈旧条目。
- 重复、旧连接或乱序事件不能撤回较新状态；PTY 高频字节不混入业务元数据事件流。

请求/操作 ID、去重、长操作、取消与结果未知的具体候选语义见
[HTTP RPC 草案](relay-protocol.md#11-http-rpc-请求操作与重试)。
该草案区分数据库事务与 Git/文件系统/PTY 外部副作用，不承诺通用 exactly-once 执行。

一期建议离线允许查看带离线标记的缓存；不自动排队并重放执行性操作。
终端输入不套用普通元数据命令重试，需要遵守终端协议自身的去重和不确定输入规则。
多客户端已确定由当前操作者控制输入和 resize：server 接受有效终端 focus 后自动切换控制权，
按该客户端尺寸调整终端，无需接管或恢复尺寸弹窗。控制权变化作为服务端事实同步，
不改变其他客户端的当前页面，也不要求其反向触发 focus。
具体仲裁与旧请求隔离见 [Focus 协议](relay-protocol.md#91-focus控制权与自动-resize)。

## 4. Host 网络和内置 Tailscale

两个接入方式指向同一个 serverId、数据库、relay 实例和终端集。

### Host 网络

本机使用 Unix socket 或 loopback；远端经 SSH 转发到执行主机本地入口。
Host 若已有系统 Tailscale，可通过受限的 Tailnet 入口接入，不必再注册一个内置节点。
首期不提供裸 LAN/公网明文直连；配对入口同样只在上述安全边界内开放。
已选择 HTTP + WebSocket；提供一致的认证、协议握手和状态同步，具体分工见 [通信载体](relay-protocol.md#41-通信载体已选择-http--websocket)。
监听范围需要显式配置，不因网络故障自动扩大到公网或其他接口。

### 内置 Tailscale

Server 可自行加入 Tailnet，作为独立节点提供入口，不要求另行部署系统 tailscaled。
内置节点使用 Go tsnet 组件；业务 server 使用已选定的 TypeScript/Node.js。

- 内置节点身份和状态使用持久目录，普通更新不重建节点。
- 内置节点与系统 Tailscale 的状态分开，不覆盖 host 已有的节点配置。
- Tailnet 可达性与 Cove 业务访问权限分层；两个入口遵守相同的配对和授权原则。
- 初版 mobile 不内嵌 Tailscale，使用手机系统提供的 Tailnet 路径；server 内置节点不自动赋予手机可达性。移动端 SSH 接入留待后续评估。
- Tailscale 暂不可用时，终端继续运行；已启用且可达的 SSH 入口仍可独立服务，不降级到裸网络连接。

可以单独启用一种入口，也可同时提供两种；这是配置能力，不是两套 server。
自动选路是否进入一期待定。切换入口必须验证持久 server 身份，重新握手并恢复订阅，
不能只凭同名 host 认定同一服务，不能创建重复 task 或 relay。

网络 listener 的关闭、重新登录或重建不能顺带 dispose PTY。
网络层依赖升级如何与 PTY 持有进程隔离，属于后续进程划分评估。

## 5. 持久服务与 PTY 的存活边界

已选择方案 B：Electron Desktop 与本地 Cove server 独立运行；本地与远端使用相同的服务结构。
Server 内部由 runtime 处理业务与连接，有界 terminal worker 子进程池处理终端。
一期不再增加可跨 runtime 重启存活并被重新接管的 PTY daemon；worker 的进程隔离不等于 keeper 承诺。
Desktop 退出、崩溃或更新不能隐式重启 server。服务入口与运行文件需要稳定存放，不能依赖
Desktop 更新时会被替换的临时路径或开发 checkout；具体安装和服务管理方式后续选型。
Desktop 更新后先协商协议，兼容则重新连接，不兼容则明确提示升级与会话影响，不自动替换活跃 server。

Server 独立启动，可按目标 OS 集成为后台服务。即使没有客户端或没有 PTY，也不因空闲退出。
有活跃 PTY 时，没有基于“最后一个客户端断开多久”的默认终止计时器。
Server 服务需要脱离启动 SSH 会话和 UI 生命周期；服务管理器的进程组清理行为必须在部署验证中覆盖。

| 事件 | 一期要求或边界 |
| --- | --- |
| Desktop 退出、mobile 后台、全部客户端断线 | Server 与 PTY 继续运行 |
| SSH 启动连接断开或网络入口不可用 | Server 与 PTY 继续运行 |
| 客户端同协议升级 | 接回原实例与 PTY |
| 用户明确结束终端或 reset | 执行主机按准确身份停止对应进程，发布结果 |
| Server 自身重启、升级或崩溃 | 初版没有独立 PTY keeper，不承诺 PTY 存活；计划重启前明确提示会话影响，保留 tab 记录 |
| 主机重启 | 恢复业务元数据与运行记录，不恢复终端画面，不把旧进程标记为仍存活 |

持久化 terminal ID、PID 或画面，不等于持久化活进程。
已确认一期不提供独立 PTY keeper。服务管理器重新拉起 server 只恢复业务记录，不能将旧运行实例标为 live。
终端快照持久化已选 A：只保存 tab 配置和运行记录，画面、恢复基线与 scrollback 只保留在内存中，首期不落盘。
最后的 agent 业务状态后续通过 agent hook 实现，不能由旧 PID、最后画面或终端安静推断任务已完成。
未来如需 server 重启后保留 PTY，再单独评估 keeper；不以网络/模块拆分承诺初版具有此能力。

活跃会话期间不得因 desktop 自动更新而替换 server。
用户进行 server 维护时，要明确维护范围和 PTY 影响。

已认可在计划重启前导出带时间和版本的 tab 清单，供事后查看与手动重开；不要求自动恢复。
导出范围覆盖所有存活会话，包括长期闲置的 shell，而不是只筛 active 展示标签；不可验证的条目单独标明。
逻辑 tab 记录应日常持久化，不只依靠关闭前导出，否则崩溃时会丢失恢复线索。
清单与重开语义见 [Tab 状态与重开](terminal-architecture.md#12-tab-状态与-server-重启后的重开)。
异常退出留下的子进程需要单独核实；没有可接入 PTY 不等于已证明所有派生进程退出，不能据此自动重放任务命令。


终端运行时已选 node-pty + @xterm/headless + @xterm/addon-serialize，通过 Cove 适配层补充恢复状态。
PTY 与唯一服务端权威模型同 worker；恢复优先补增量，有缺口时安装 VT 基线，历史有限。
具体版本、恢复兼容性、IPC 与流控仍需验证，见 [终端链路设计](terminal-architecture.md#33-首个运行时方案已选待原型验证)。

## 6. 跨 Server 迁移

当前承载 workspace 的 server 管理其执行事实。目标 server 必须已有对应 repo 注册。
已确认跨主机迁移前由用户结束相关活跃终端并停止写入；失联不能替代停止确认。
迁移先准备目标，显式交接后转换当前承载关系；不能由某个客户端悄悄复制一份活动 task。
保留稳定 task ID、来源/目标 server ID 和迁移操作记录。

跨 server 的交接确认、旧位置只读历史和失联时的冲突处理仍需细化。
一期不采用多主同时写同一 workspace，也不宣称跨主机迁移是一个数据库事务。
协调过程不得依赖某台指定 desktop 持续在线；发起客户端断开后，能从持久操作记录查看结果或继续处理。

### 6.1 Relay 承载数据传输

已确认：server 除终端和元数据外，还提供数据传输能力，支撑任务迁移。
建议覆盖 client-server 与迁移时的 server-server 传输，复用身份、授权、版本协商和操作记录，
不要求经由 macOS desktop。文件传输已选择 HTTP，与终端 WebSocket 分开；首发文件类型尚未确定。

- 迁移控制操作和内容传输分开：传输完成不等于 workspace 已交接，更不等于 agent session 已恢复。
- 每次传输有 transferId、来源与目标、内容清单和状态；分块、完整性校验、可查询进度、取消及断点续传。
- 续传绑定相同内容版本；源文件变化时重新准备，不能将前后两个版本拼接后当成成功。
- 接收端写入操作专属暂存区，检查内容和目标冲突后再发布；不直接覆盖正在使用的 checkout。
  多文件、多仓发布不宣称为一个原子文件系统事务；失败产物可辨认、可恢复或清理。
- 数据流使用独立队列、背压和并发预算；大文件传输不能饿死终端输入、focus 或控制消息。
  文件传输与终端使用分离通道，仍需带宽调度和并发延迟验证；分离通道不等于网络带宽完全隔离。
- 传输授权绑定具体操作、来源和目标范围，接收端验证相对路径及链接目标，不提供任意路径写入入口。
- Git 本地提交、选定未提交改动、普通目录以及可选 rollout 是不同内容类型。
  Git 对象不自动包含工作区改动，数据传输本身不替代迁移范围规划与目标仓库检查。
- 优先 server 直连传输；两端不可达时明确等待或失败。一期不暗中依赖发起 desktop 持续中转，
  也不预先引入云中转服务。网络可达性在迁移准备前检查。

分块大小、编码、配额和暂存保留期限由原型测试决定；这是一套传输能力，不是双向目录同步系统。

### 6.2 迁移的权威交接：待确认建议

没有全局协调服务时，建议使用来源授权的单向交接记录：目标先准备内容，来源确认后持久记录
新的 owner epoch、目标 serverId 和冻结状态，再允许目标激活。来源保留转交指向和旧 session 历史。
两端按 migrationId 查询并幂等继续；客户端断线不取消已授权交接。

来源冻结后即使确认响应丢失，也不因超时自行恢复写入；目标激活结果不明时等待核实。
旧客户端携带的旧 owner epoch 不能继续修改来源 task。这里冻结的是 Cove 的任务操作，
不能冻结外部编辑器或已有进程，文件写入停止仍遵循整体设计中的迁移前置条件。
完整故障状态机在实现迁移前确定，不在一期加入失联强制接管。

## 7. 定时任务的承载边界

定时任务已明确不首发，纳入后续范围。建议 scheduler 属于执行 server，
复用任务创建、工作位置准备和 CLI 启动操作，不把 desktop 定时器作为执行者。
Schedule/Run 持久化，操作记录用于重启后核实；具体补跑、并发、完成判定与迁移规则见
[定时任务设计](design.md#12-定时任务后续范围不首发)。

## 8. 核心验收

- Server 可在未运行 desktop 的 host 上独立启动和使用。
- Desktop 完全退出后，mobile 可直接创建 task、读取多仓状态并操作原终端。
- 两个客户端同时修改同一个挂载，冲突可见且没有丢失更新。
- 命令已成功但响应丢失，重试不重复创建 worktree 或 PTY。
- 一个客户端离线期间另一端修改/删除资源，前者重连后正确收敛。
- 所有客户端断开后，终端继续产出；重新接入仍是同一个运行实例。
- Host 网络与内置 Tailscale 访问同一份任务和终端，切换入口不重复启动服务。
- Tailscale 节点状态在普通重启后可复用，不通过重置 Cove 数据修复网络登录。
- 模拟网络故障时不退出 PTY，不把缓存状态当成执行事实。
- 验证服务管理器实际配置，区分客户端断开、listener 重启和 PTY 持有进程退出。
- 传输大文件时终端输入和 focus 仍可响应；断线续传不会发布混合版本或半成品到活动目录。
- 迁移交接响应丢失后，两端不会同时恢复为活动 owner；发起客户端离线不丢操作结果。

参考：[Tailscale tsnet 官方文档](https://tailscale.com/docs/features/tsnet)。

## 9. 配置与设备授权

已确认：CLI 是完整 operator，按领域提供全部操作与配置；agent 可通过 CLI 操作，初期无通用配置 GUI。
不依赖用户维护配置文件；支持 CLI/client 远程更改 server 设置，配对/授权等必要交互可保留 GUI。
命令名与内部存储尚未冻结，下面是候选契约而非已实现的 CLI。

### 9.1 按作用域保存配置

| 作用域 | 示例 | 权威位置 |
| --- | --- | --- |
| Client | 字体、本地显示偏好、连接别名 | 当前客户端 |
| Server | workspaceRoot、监听入口、终端历史预算、传输并发 | 对应 server |
| 凭据 | 设备 token、SSH 凭据、配对记录、Tailscale 节点状态 | 专用凭据/状态存储，不作为普通配置返回 |

普通配置保存在所属组件的权威存储中，带 schemaVersion；存储格式属于实现细节。
Server 报告 desired/effective 配置及 revision，所有正常修改经过操作接口；不支持靠编辑内部文件旁路更新。
Repo 注册、task 和迁移记录仍是业务资源，通过各自领域命令操作，不把它们塞进通用配置对象。

### 9.2 CLI 与远端客户端共用配置契约

建议按领域提供配置 schema/get/validate/update/reset/status 能力：

- CLI 显式指定目标 server；请求和响应都带 server 身份。路径在目标 server 解释并校验。
- 修改携带 expectedRevision、operationId 和字段级 patch；旧客户端不得整体覆盖未知的新字段。
- Server 在统一写入边界内检查 revision，校验整个候选配置后原子持久化；并发操作冲突需明确返回。
- 无效更新不破坏上一次有效配置；CLI 和 GUI 走相同校验，不依赖 GUI 补全缺失字段。
- 导入/导出若提供，也经过同一 schema 和更新接口；不引入必须手工编辑及 reload 的配置文件流程。
- 返回每项变更的应用结果：已生效、等待重启或应用失败；不把“写入文件”冒充“运行时已切换”。
- 变更 workspaceRoot 默认仅影响新 workspace；既有绑定和进程 cwd 不随设置改写。
- 尽量热应用资源预算等参数；监听或身份变更需处理当前连接断开和按 operationId 核实结果。
  新入口启用失败不报告成功，保留明确可用的恢复路径；需要停止 PTY 持有进程的变更留待显式维护。
- 远程修改须有对应管理权限，撤销的设备不能继续写配置。业务授权在 host/Tailscale 入口保持一致。

配置 schema 版本与通信协议版本分开；配置 schema 更新不能使同协议客户端的原有基础操作失效。
默认值、合法范围、说明和应用方式通过 schema 提供给 CLI/agent；无需先建设配置页面。
初次初始化提供本机 CLI 入口；运行中写入必须经过服务接口，不允许离线存储工具和在线 server 并发改写。
CLI 的完整能力约束见 [CLI 设计](design.md#14-cli-是完整操作入口)。

### 9.3 单用户设备配对

已确认：server 使用固定、持久的 serverId，不随重启、IP、域名或 host/Tailscale 入口变化。
每个设备获得独立可撤销的长期凭据；撤销同时失效其活跃业务连接及关联数据传输权限，不能只禁止下次登录。
Server 身份与设备身份分开；serverId 是标识，不是身份的密码学证明，不能仅凭对方声明同一 ID 就信任新入口。

已确认的配对流程：

- 每次配对新设备都创建一次性邀请；已配对设备的日常重连使用长期凭据，无需重新邀请。
- Server CLI 可以创建邀请，并开放认证端口等待配对；支持复制 token，二维码不是必要条件。
- 已配对 macOS desktop 可以通过已认证连接向 server 申请并展示新的邀请，供 mobile 配对。
  邀请由 server 签发和核销，不能用 desktop 自己的长期凭据代替。
- Mobile 配对后使用自己的凭据直接连接 server，不依赖 desktop 继续在线。

已确认的配对约束，具体字段、端口和重试机制尚未冻结：

- 邀请有短期有效期、单次兑换约束及取消能力。仅存在有效邀请时开放配对监听；
  最后一个邀请已兑换、过期或取消后关闭监听，不影响业务端口、已连接设备和 PTY。
  监听地址、端口和入口通过 CLI 管理，不自动修改系统防火墙。
- 邀请编码成可复制字符串，包含安全通道入口、serverId、高熵一次性 secret 及有效期。
  客户端先验证 SSH/Tailscale 通道对端再提交 secret；首期不引入 Cove 自有加密公钥。
  兑换后使用独立长期设备 token，邀请 secret 不能继续充当设备凭据。
  若未来提供短数字码，需要单独设计抗猜测和首次信任流程，不将其等同于高熵 token。
- 实现建议：邀请核销与设备注册原子完成；配对响应丢失后的重试需绑定同一申请设备，不能让第二台设备复用邀请。
- 创建邀请需要配对管理权限；设备撤销后不能继续签发邀请。由 desktop 邀请的 mobile 是独立设备，
  撤销 desktop 不隐式撤销 mobile；未兑换邀请的撤销关联规则另定。
- serverId 与 SSH/Tailscale 通道身份分开建模；通道凭据轮换不改变 serverId。
  客户端将 serverId 关联到经过验证的通道入口；新增入口或对端身份变化必须验证信任关系，
  不能凭同名 ID 静默接受。通道身份重置后重新建立信任，不自动删除 Cove 的 task 或设备记录。

在 Tailnet 可达并不自动成为 Cove 管理设备，host 网络也不因是局域网而省略授权。
Server 间迁移单独授予操作范围内的传输/交接权限，不复制发起客户端的长期密钥。

### 9.4 安全通道与设备授权（已选择 SSH/Tailscale）

首期由 SSH/Tailscale 提供传输加密、通道对端验证和网络准入；Cove 提供一次性邀请、
每设备长期 token、业务授权及撤销。Cove 不实现应用层 E2EE，不要求用户管理 Cove TLS 证书。
HTTP JSON-RPC、业务事件 WS、终端 WS 和 HTTP 文件传输保持原有契约，全部置于安全通道内。

| 场景 | 已选择的接入边界 |
| --- | --- |
| 本机 | Unix socket 或 loopback，保留相应本机/设备授权 |
| SSH | 转发到运行 Cove 的主机本地入口，验证 SSH host key |
| 内嵌 Tailscale | tsnet listener 接收 Tailnet 流量，再经同机受控 IPC 转交 Node |
| 系统 Tailscale | 限定 Tailnet 入口，执行网络访问策略和 Cove 设备授权 |
| Mobile | 首期依赖手机系统 Tailscale，独立连接 server；移动端 SSH 后续评估 |
| Web App（二期） | 当前只考虑经 Tailscale；建议同源 HTTPS/WSS 入口，证书由 Tailscale 集成管理 |
| Server 间迁移 | 经 SSH/Tailscale，使用操作范围内的传输授权 |

配对监听仅在有效邀请期间开放，并遵守同样的通道边界。通道中断或不可用时不退回裸 LAN/公网地址，
也不扩大监听范围；持久 server 与 PTY 继续运行。首期不提供无安全通道的远程直连。

普通 SSH 端口转发后的 HTTP 请求不自动携带原始 SSH 用户身份；Tailscale 节点身份也不等同于
Cove 应用设备身份。因此业务请求仍校验 Cove 设备 token，撤销同时失效活跃连接和传输权限。
设备 token 的生成、存储、重试兑换和失效传播细节在实现设计中确定；不为首期引入 JWT 或客户端证书。

通道必须保护到 Cove 所在主机；经 subnet router 或 SSH 跳板后再明文跨主机转发，不自动满足这个条件。
系统 Tailscale 模式不能仅根据来源属于 100.64.0.0/10 判断可信；代理提供的身份信息只能来自受控入口，
不能接受普通请求自行声明的身份 header。Cove 撤销不等同于撤销 SSH 账号或 Tailscale 节点权限。

客户端持久记录 serverId 及其已验证入口，换入口前验证通道对端，再发送设备凭据。
Mobile 仍需验证 iOS/Android 对 HTTP/WS 的平台网络策略、重连和文件续传；系统 VPN 加密不会改变 URL scheme。
是否由 RN 网络层或 WebView 承载终端连接，依接入和性能验证确定，不因本次决策锁定数据桥接方案。

Cove 自建公共 CA 签发流程、自签名证书固定信任、应用层 E2EE 均不作为首期要求。
二期 Web App 的浏览器 HTTPS 适配见 §9.5，由 Tailscale 集成提供；它不增加公网入口，也不阻塞一期交付。
未来如需直接公网 HTTPS 或不可信应用中转，可增加传输适配，不改变 serverId、设备授权和业务协议。

依据：[OpenSSH 转发](https://man.openbsd.org/ssh.1)、
[Tailscale 加密](https://tailscale.com/docs/concepts/tailscale-encryption)、
[tsnet 身份与监听接口](https://tailscale.com/docs/reference/tsnet-server-api)、
[React Native 网络限制](https://reactnative.dev/docs/network)。以上为已选设计，尚无 Cove 接入实现验证。

### 9.5 Web App 与 Electron 共享边界

已确认：macOS desktop 使用 Electron；Web App 纳入二期，当前仅考虑经 Tailscale 访问。
Web 不要求 desktop 在线，不在浏览器内嵌 Tailscale 或提供 SSH 客户端。
浏览器所在设备须有可用的系统 Tailnet 路径，且满足访问策略。
一期保持共享 UI/client 与宿主能力分离；Web 静态资源部署、浏览器会话和 HTTPS 集成在二期实现。

以下是接入建议，具体部署、浏览器会话和发布方案尚未冻结：

- 每台 Cove server 提供自己的 Web 静态资源与同源 API 入口，例如 `https://cove-host.<tailnet>.ts.net`。
  WebSocket 使用同源 WSS，文件传输使用 HTTPS；静态资源随 server 发布，无需公共云站点。
  第一条验证路径是页面访问其所属 server；跨 server 聚合不能默认为浏览器跨域直接共享凭据，方案另定。
- Tailnet 加密不会使普通 HTTP 页面自动成为浏览器安全上下文。因此建议 Web 入口要求 HTTPS/WSS，
  由 Tailscale 的证书机制提供受浏览器信任的完整域名证书，不引入自签名证书信任交互。
- 系统 Tailscale 路径可使用 Tailscale Serve 反向代理同机 Cove；内嵌路径可用 Go tsnet 的 TLS listener
  终止 HTTPS/WSS，再经同机受控连接进入 Node。两条路径使用相同业务授权和协议协商。
  使用 Serve 的 Tailnet 内访问能力，不启用 Funnel 公网发布。
- Web HTTPS 需要 Tailnet 的 MagicDNS/HTTPS 能力可用；CLI 应诊断前置条件和证书状态。
  证书签发/续期交给对应集成，不让用户手工搬运 `tailscale cert` 导出的文件。
  前置条件未满足时报告 Web 入口不可用，不静默降级为 HTTP。签发的完整域名进入公开 CT 日志，
  这不改变服务的 Tailnet-only 可达范围。
- 浏览器仍通过一次性 Cove 邀请登记为可单独撤销的客户端；Tailnet 可达或 Tailscale 用户身份
  不自动免除 Cove 配对。建议使用 server 管理的浏览器会话和 Secure/HttpOnly cookie，
  配合 SameSite、请求防伪与 WS Origin 校验；不将长期设备 token 放进 URL。
  每个浏览器 profile 的登记/存储限制与过期策略另定，不声称能稳定识别物理设备。
- 配对遵守临时开放认证入口的已有决定；建议同源 HTTPS 路由仅在配对窗口内转发至临时认证 listener，
  邀请耗尽、过期或取消后关闭该入口。Web 页面和已认证业务连接保持运行。
- 共享 Web UI、Cove client 和终端适配器不依赖 Electron/Node API。Electron main 通过窄宿主接口
  提供 SSH、本机服务管理、系统凭据存储和原生文件操作；Web 提供浏览器能力适配。
  浏览器上传/下载与原生路径选择分别实现，远端仓库与 workspace 的路径始终由 server 解释。
- 浏览器受相同 focus/control epoch、恢复与背压规则约束；页面关闭或后台挂起不会退出 server/PTY。
  原型验证页面重载、后台恢复、配对与撤销、证书续期、WSS 代理和文件续传。

依据：[Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)、
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)、
[tsnet API](https://tailscale.com/docs/reference/tsnet-server-api)、
[浏览器 WebSocket 安全要求](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications)。

## 10. Server 主语言比较与决策（已选择 Node）

客户端首版终端已选 xterm.js；用户已确认 Server/CLI 使用 TypeScript/Node.js。
本节保留 Go、Rust、TypeScript/Node.js 的比较依据；采用 Node 控制进程、终端子进程池和 Go tsnet 组件的方案。
以下是基于官方接口的工程判断，尚无 Cove 集成测试或性能测量。

| 维度 | Go | Rust | TypeScript / Node.js |
| --- | --- | --- | --- |
| 独立服务与 CLI 发布 | 原生可执行文件，CLI/server 可共用领域层；引入 C 库后需额外处理本地依赖 | 原生可执行文件；同样需要检查系统库与目标平台构建 | 可随包携带 Node，无需用户安装；需要维护运行时与 node-pty 原生模块构建 |
| 内置 Tailscale | 直接使用官方 tsnet | 可用 Go helper / libtailscale FFI；原生 tailscale-rs 仍在快速演进 | 可用 Go helper / libtailscale FFI；增加组件生命周期和发布协调 |
| PTY | creack/pty | portable-pty 等 | node-pty |
| 服务端终端状态 | 有 charmbracelet/x/vt 等候选，需验证终端能力；也可桥接其他引擎 | 有 alacritty_terminal、vt100 等候选，需验证恢复与前端兼容 | 可直接使用 @xterm/headless，接入同族前端更直接 |
| CPU 密集工作隔离 | goroutine 调度方便，但仍需有界队列、预算和背压 | 原生线程与显式资源管理，异步任务仍不能阻塞 executor | 主事件循环要隔离解析、压缩等重任务；worker/process 划分需设计 |
| 与 RN/Web 客户端契约共享 | 通过 schema/codegen | 通过 schema/codegen | 可直接共享 TS 包；仍需运行时校验和协议兼容测试 |
| 主要维护成本 | 终端引擎适配；若桥接 JS，则维护终端热路径上的跨进程协议 | 终端适配、异步生命周期、Tailscale 集成与构建 | 原生 addon/运行时发布、Tailscale helper、事件循环负载隔离 |

PTY 库只负责进程与字节流，不等于 VT 状态引擎。现有原生终端核心也不等于已经具备
Cove 所需的跨客户端快照、历史恢复、reflow 和查询响应契约，三种方案都需要验证。
采用同族前后端终端引擎可以减少行为差异，但不能代替兼容性测试。

### 10.1 两个主要集成边界

- Go 主体若采用 JS headless 引擎，需要在 PTY 输出、resize、快照和查询响应的热路径上
  设计跨进程顺序、背压及 worker 故障处理。若原生引擎满足需求，可消除这一边界。
- Node 主体可将 Go tsnet helper 限定为网络适配器，领域状态、授权和 PTY 仍归 Node server。
  这不是 PTY keeper。Helper 故障影响 Tailnet 连接，不应退出 PTY；需要同包发布和健康状态。
  Tailnet 流量经过额外转发，其吞吐和延迟也需要实测。
- Rust 可组合原生 PTY/终端核心与 Go 网络适配器；通过 libtailscale FFI 也可减少进程数量，
  但会引入 Go 工具链、运行时和 ABI 集成，并非纯 Rust 部署。

官方 tailscale-rs 当前支持部分直接连接，但 NAT 穿透仍在完善，可能更频繁回落 DERP；
项目尚无强兼容承诺，且缺少 MagicDNS、peer relay 等能力。不能把它当作 Go tsnet 的等价替换，
也不能再笼统说 Rust 没有原生 Tailscale 库。

### 10.2 xterm 已选后的组合比较（已选择 A 的分片变体）

客户端首版已选 xterm.js。服务端已选择同族 @xterm/headless，降低终端语义和恢复适配成本；
这不意味着前端选库强制决定后端语言，也不意味着 serialize 已满足 Cove 的恢复契约。
以下保留的方案比较均以采用 headless 为前提，主语言和进程结构已选定。

| 方案 | 进程与职责 | 主要取舍 |
| --- | --- | --- |
| A：TypeScript/Node server + CLI，Go tsnet 网络组件 | Node 管理领域状态、PTY 和 headless；Go 只提供 Tailnet 接入 | 少一道终端跨语言边界；须维护 Node/native addon 与 Go 组件发布，并隔离 CPU 重任务 |
| B：Go server + CLI，Node 终端组件 | Go 管理领域与网络；Node 管理 PTY/headless | 原生 CLI、直接 tsnet；领域控制、终端事件、背压与故障处理都跨组件，且仍需携带 Node |
| C：Rust server + CLI，Node 终端组件与 Tailscale 适配 | Rust 管理领域；Node 管理 PTY/headless；Go helper 或 FFI 提供 Tailnet | 主体资源控制精细，但终端热点仍在 Node，增加语言/构建/运行组件 |

方案 B/C 的终端组件是 server 的组成部分，不是独立 PTY keeper；首版不承诺 server 重启后继续持有 PTY。
若将 PTY 改由 Go/Rust 持有，还需额外设计字节流、resize、查询回复与 headless 的顺序边界。

客户端协议已确认使用 VT 字节流，不考虑传网格快照。更换客户端解析/渲染实现不要求
更换 server 的 headless 引擎或主语言，只需实现兼容的 terminal profile 与 VT 恢复基线。
因此不因“客户端可替换”本身提高 Go 主体方案的优先级；整体更换服务端状态引擎是另一个议题。
新增规模要求：至少 100 个 agent TTY 经常同时输出。已选择 A 的分片变体（控制进程与终端子进程池隔离），
不推荐将全部 headless 解析置于业务主事件循环；依据与 devbox 实测见第 10.4 节。Node 已确认；子进程数量、IPC、依赖版本与恢复细节另行设计。
建议 CLI 与 server 共用领域 schema/client 库，CLI 正常操作经过 server API，
GUI 使用同一接口；终端引擎与 server 启动逻辑不应在普通 CLI 调用时加载。
Go 网络组件同包安装、生命周期可观察，Tailnet 故障不退出 PTY，host 与 Tailnet 入口保持同一业务授权。
Node 运行时随发行包提供，不要求用户安装 npm/Node；具体打包、IPC 与 headless worker 布局另行选型。

语言本身不能保证更低端到端延迟。后续验证需覆盖交互 TUI、持续大量输出、多 tab 长历史、
客户端重连/resize 与并发文件传输，并测输入到画面延迟、CPU、总 RSS、恢复时间和功能正确性。
CLI first-class 是能力与契约要求，三种语言都能实现；不应将其误等同于某种语言。

### 10.3 官方依据

- [tsnet](https://tailscale.com/docs/features/tsnet)、[libtailscale](https://github.com/tailscale/libtailscale)、[tailscale-rs](https://github.com/tailscale/tailscale-rs)。
- [node-pty](https://github.com/microsoft/node-pty)、[creack/pty](https://github.com/creack/pty)、[portable-pty](https://docs.rs/portable-pty/latest/portable_pty/)。
- [xterm.js Node.js 支持](https://github.com/xtermjs/xterm.js#nodejs-support)、[Charm 实验性库](https://github.com/charmbracelet/x)、[alacritty_terminal](https://docs.rs/alacritty_terminal/latest/alacritty_terminal/)、[vt100](https://docs.rs/vt100/latest/vt100/)。
- [Node 单可执行文件](https://nodejs.org/api/single-executable-applications.html)：原生 addon 可作为资源携带，但需落盘后加载，不能将“可打包”理解为消除了本地依赖构建。

### 10.4 至少 100 个并发输出终端（Node 分片方案已确认，容量验收未完成）

用户明确要求支持至少 100 个 agent TTY 经常同时输出。典型执行主机为 ssh devbox。
[2026-09-25 devbox 基准](benchmarks/2026-09-25-xterm/RESULTS.md) 已测 100 个 headless 模型，
不是 100 个真实 PTY/agent 的端到端容量证明。

100 路合计约 25 MiB/s 时，4 个解析进程的 write-to-callback p95 约 15–17 ms，
单进程约 46–58 ms。100 路总计约 500 MiB 压力输入，单进程用了 16.8 s，4 进程用了 5.14 s。
5,000 行历史的具体测试占用约 1.42 GiB 的进程峰值 RSS 之和，单终端序列化 p95 约 252 ms；
因此历史预算、恢复风暴、背压和控制隔离都是必要设计，不能只按 TTY 数量估算。

已选择的 A 变体：TS/Node 控制 server + 有界 Node 终端子进程池 + Go tsnet 组件。
终端子进程各自持有一组 PTY/headless，初步以 4 个进程作为 devbox 验证起点，具体默认数待定。
不为每个 TTY 单独创建 Node 进程，不在业务控制线程执行大批同步 serialize。
runtime/worker IPC 已选统一 pipe 帧协议承载控制与数据，不使用独立 Node send 控制通道。
业务事件低频发送，VT 输出采用二进制批量、有界队列；网络与 IPC 成本仍需集成测试。
runtime 周期性刷新全部终端状态与最近快照以维护列表缓存，不限于有实时订阅的终端。
慢客户端独立 resync；host 过载对对应生产者施加有界背压，不静默丢 VT 数据。
分片故障影响其持有的运行实例，不能当成普通客户端断线；保留逻辑 tab 并明确运行状态。
子进程属于 server 生命周期，首版仍不引入独立 PTY keeper 或保证 server 重启后 PTY 存活。

Go 业务主体配合同一终端池不会自动降低 xterm 解析成本。主语言选择与分片、内存预算分开决策；
只有完成真实 PTY、网络、恢复/resize、长时运行和 agent 自身资源核算后，才能给出支持容量承诺。

## 11. 业务持久化选型（已选择 SQLite）

已确认每个 host 的 server 使用本地 SQLite 保存业务元数据与配置，通过统一写入入口执行短事务。
Node 驱动已选择 better-sqlite3；候选 WAL 模式，数据库执行线程、durability 设置、迁移与备份机制后续细化。
客户端、CLI 和终端子进程通过 server 接口操作，不直接并发改写数据库。

| 方案 | 收益 | 对 Cove 的代价 |
| --- | --- | --- |
| SQLite | 嵌入式，无独立数据库服务；事务、索引及 schema migration 适合有关联的业务状态 | 同一数据库同时只有一个 writer；要控制事务时长与 checkpoint，不在网络文件系统共享活动库 |
| JSON/独立文件 | 简单设置与导出易读 | 多资源原子更新、并发控制、崩溃恢复和检索需要自行实现，规模扩大后难维护 |
| PostgreSQL 等外部数据库 | 适合独立数据库服务和更多并发写入 | 增加安装、凭据、升级、备份及运维，与首版单用户、各 host 独立运行的目标不匹配 |

建议入库：repo 注册、task/workspace/mount、逻辑 tab 与运行记录、设备授权元数据、设置 revision、
操作幂等记录、迁移状态及未来 schedule/run。私钥和敏感凭据仍走专用存储边界。
原始 VT 输出不逐 chunk 写入业务事务；运行时 headless 与有界 replay 保存在终端模块，
首期终端画面、恢复基线与 scrollback 不落盘；迁移大文件使用独立暂存及保留策略，具体方案另行细化。
因此 100 路高频终端输出不等于 100 路同速率数据库写入；活动时间等遥测可合并更新。
跨主机迁移使用领域导出/导入和状态机，不复制整份活动数据库覆盖目标 host。
SQLite 是 server 内部存储，不要求用户手工编辑配置文件；所有设置仍由 CLI/API 提供完整操作。

依据：[SQLite 适用场景](https://www.sqlite.org/whentouse.html)、[WAL](https://www.sqlite.org/wal.html)。

### 11.1 Node 驱动与执行位置（已选择 better-sqlite3，执行位置待定）

| 方案 | 收益 | 代价 |
| --- | --- | --- |
| Node 内置 `node:sqlite` | 无额外 SQLite addon 打包步骤；基础 SQL、预编译语句与事务可满足业务需要 | 当前 Node v24.x 文档仍标为 Release candidate；SQLite 和绑定的更新跟随 Node 运行时 |
| `better-sqlite3` | 成熟的同步接口、事务封装及 worker thread 支持；驱动可独立于 Node 升级 | 增加一个原生 addon，需验证各发行平台的预编译包或自行构建 |

已确认使用 `better-sqlite3`；建议配一个专用数据库 worker thread，执行位置尚未确认。
选择依据是接口成熟度与依赖维护取舍，不代表已实测其比 `node:sqlite` 更快。
两者核心数据库调用都是同步的；专用 worker 用于避免数据库查询、锁等待或磁盘提交阻塞控制进程主事件循环。
worker 内独占连接，按完整业务操作执行短事务；不将 BEGIN、各条 SQL 和 COMMIT 拆成可交错的跨线程请求。
队列有界，提交成功后才确认持久化操作；一期不需要按 TTY 分配数据库连接或创建读连接池。
数据库 worker 与承载 PTY 的终端子进程池是两个边界，不能据此把 node-pty 放入 worker threads。
WAL、durability、备份、schema migration 与 ORM/查询构建器仍待后续细化。

依据（2026-09-25）：[Node v24.x SQLite 文档](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md)
（自 v24.15.0 标为 Release candidate）、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)。

## 12. HTTP/WebSocket 框架（已选择 Fastify + @fastify/websocket）

通信结构已选 HTTP + WebSocket，网络框架已确认 Fastify + @fastify/websocket（基于 ws）。
HTTP 业务 API 已确认采用 JSON-RPC 2.0 over HTTP，按领域方法分发，schema 工具已选 Zod；RPC 实现库和依赖版本尚未确认。

| 方案 | 对 Cove 的收益 | 取舍 |
| --- | --- | --- |
| Node 原生 HTTP + ws | 少量 HTTP 入口、统一业务 dispatcher 即可承载首期领域操作；依赖少 | 需集中实现请求体限制、认证、参数校验、错误映射、超时及连接关闭，不能分散复制到各方法 |
| Fastify + @fastify/websocket | HTTP schema 校验/序列化、插件封装和请求 hooks；WS upgrade 可复用认证 hooks | 需要理解插件作用域与生命周期；升级后的 WS 消息仍需独立校验和错误处理 |
| Hono + @hono/node-server + ws | Fetch 风格接口轻量，可适配不同运行时；Node 适配器提供 WS 接入 | Cove 已选 Node，跨运行时收益有限；schema、日志及领域模块约定需自行组合 |
| Express + ws | 中间件模型直接，生态成熟，HTTP/WS 可分别接入 | schema、序列化和 HTTP/WS 升级认证的统一约定需自行组合 |

选择依据是集中组织认证接入、请求限制、日志、校验、错误响应、生命周期及测试入口。
即使采用少量 HTTP RPC 入口，这些基础设施仍需一致的组织方式；路由数量不是唯一判断依据。
框架与 HTTP RPC 可以组合，不要求为每个业务方法创建独立 REST 路由。
Fastify 不减少领域状态机的复杂度，也不替代 wire schema 或运行时校验。
没有进行这些方案在 Cove 负载下的性能对比，选择不基于吞吐优劣结论。
HTTP 路由性能不等于持续终端吞吐；VT 热路径采用二进制帧，不经过业务 JSON 序列化。
领域逻辑与终端协议独立于框架对象；流控、恢复、协议协商和兼容验收由 Cove 实现，框架不会自动提供。
FastifyRequest/FastifyReply 不传入领域服务；RPC 参数校验与操作权限由独立方法注册表/dispatcher 组织。
WS upgrade 可复用认证 hooks，建连后的消息校验、设备凭据撤销和终端授权仍由 Cove 处理。

依据（2026-09-25）：[Fastify 校验与序列化](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、
[@fastify/websocket](https://github.com/fastify/fastify-websocket)、
[Hono Node 接入](https://hono.dev/docs/getting-started/nodejs)、
[Express 中间件](https://expressjs.com/en/guide/using-middleware/)。

### 12.1 首期接口范围与 Orca 对照

首期需要覆盖主机/协议发现与设备配对、repo 注册、task/workspace/mount、tab/run、
设置、状态同步/操作查询，以及迁移/传输领域。定时任务按交付期次加入，chat 与 Shepherd 不进入首期。
这些领域有数十个潜在业务方法，但不要求数十条独立 HTTP 路由；确切方法表仍需设计。
输入、输出、focus、resize、流控与终端恢复走终端 WS，不为每种操作重复创建 HTTP API。

候选入口：稳定 bootstrap、配对入口、已认证 HTTP RPC、业务事件 WS、终端 WS、
文件分块 HTTP。路径仅为后续设计项，当前不冻结；配对与版本不兼容诊断不能依赖普通业务解码器。
RPC 内通过领域方法注册 schema、权限和 handler，CLI 与 GUI 共用契约；
创建 task/workspace/mount 可作为一次语义操作，减少客户端往返，但不宣称 Git/文件系统动作具备数据库原子性。

核对本地 Orca fork 提交 322c18398：`orca serve` 和 Node `orcad` 复用 `OrcaRuntimeRpcServer`，
核心领域操作走自建 WS RPC，底层为 Node HTTP/HTTPS + ws；方法参数通过 Zod 校验。
Orca 存在 HTTP API：agent hook POST、Claude statusline、CDP discovery；另有 OAuth callback、
更新文件 feed 和静态 Web 资源。不能将“主业务不走 HTTP API”概括成“Orca 没有 HTTP API”。
证据路径为 Orca 仓库的 `src/main/runtime/rpc/ws-transport.ts`、`src/main/runtime/rpc/methods/index.ts`、
`src/main/agent-hooks/server.ts`、`src/main/browser/cdp-target-discovery.ts`；这是本地源码调查，不代表上游最新版本审计。

## 13. 接口 schema 工具（已选择 Zod）

已确认使用 Zod 定义共享业务契约与运行时校验 schema，设置描述通过 JSON Schema 导出供 CLI/agent 使用。
wire schema 限于可导出的 JSON 子集，避免不可表达的类型或隐式转换；具体 Zod 与 Fastify adapter 版本在实施时验证并固定。
TypeBox 的 JSON Schema 路线与社区比较保留在下节作为选型依据，不是当前实施方案。
不以未实测的性能差异作选择依据；高频 VT payload 不经过业务对象 schema 校验。
只用 JSON 可表达的数据定义 wire 类型；跨字段/领域规则仍由明确的业务校验执行。
HTTP RPC envelope 与每个方法的 params/result 分开定义，dispatcher 按方法选择校验器；
WS 业务事件也复用契约定义，不能误以为 HTTP route schema 会自动校验 WS 消息。
同协议版本的可选扩展字段、未知字段处理和错误语义须明确并测试；使用 schema 库不自动保证跨版本兼容。
schema 包不依赖 Fastify、数据库或 PTY，供 server、CLI、desktop、mobile 共用。

依据：[Fastify Type Providers](https://fastify.dev/docs/latest/Reference/Type-Providers/)、
[TypeBox](https://github.com/sinclairzx81/typebox)、[Zod JSON Schema](https://zod.dev/json-schema)。

### 13.1 社区与集成调查（2026-09-25，选型依据）

GitHub API 当次读数：Zod 44,006 stars，TypeBox 6,969 stars；两者均有近期代码活动。
npm 下载统计窗口 2026-09-15 至 2026-09-21：zod 211,933,203，typebox 8,186,082，
旧包 @sinclair/typebox 81,212,632。下载包含间接依赖与 CI，不能换算为独立用户数，
新旧 TypeBox 包不能直接相加后宣称用户量。TypeBox 社区小于 Zod，但并非缺少使用反馈的早期库。

- TypeBox [#1694](https://github.com/sinclairzx81/typebox/issues/1694)：用户报告 JSON Pointer 错误路径未转义，
  维护者当天回复已在 1.3.34 发布修复，说明有真实使用与及时处理的样本，不能外推为所有问题的响应保证。
- TypeBox [#1477](https://github.com/sinclairzx81/typebox/issues/1477)：Union/Codec 讨论持续较长，
  提问者纠正了最初对旧代码的判断，后续认可方案，同时报告 1.x 在其项目中的类型推导卡顿。
  这属于复杂 schema 用户体验，未在 Cove 复现，不能把早期描述当作当前版本已确认缺陷。
- [TypeBox 1.0 迁移指南](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.0.0-migration.md)
  明确 ESM-only、包名及多个高级 API 的变化；Fastify provider 的
  [transform 支持请求 #125](https://github.com/fastify/fastify-type-provider-typebox/issues/125)仍开放。
  JSON Schema 契约与 TypeBox 自定义 Codec/Refine 等运行时语义不能混为一谈。
- Zod 已有 [Fastify 官方 provider](https://github.com/fastify/fastify-type-provider-zod)，
  不能再用“只有第三方集成”作为 TypeBox 的独占优势。旧社区 provider 与官方包并存，
  [#251](https://github.com/turkerdev/fastify-type-provider-zod/issues/251)记录用户对后续维护方向的疑问。
- 官方 Zod provider 的 [#28](https://github.com/fastify/fastify-type-provider-zod/issues/28)
  提出将 schema 解析提前到启动时，后由 [#29](https://github.com/fastify/fastify-type-provider-zod/pull/29)处理；
  [#26](https://github.com/fastify/fastify-type-provider-zod/pull/26)修复响应 Codec schema。
  这些反映集成边界和维护活动，不能概括为 Zod 不稳定。
- Zod 4 改进类型实例化与解析，并提供 [schema 编译](https://zod.dev/compile)；
  旧 Zod 3 性能抱怨不足以评价当前版本。未做 Cove 实测，不引用不同测试条件的倍数作为容量结论。

两者都能满足普通 JSON RPC 数据；用户最终选择 Zod，其更广生态与 TS 校验表达适合项目需要。
wire schema 限于可移植 JSON 子集，数据转换与业务规则显式放在边界外；
避免在客户端假设服务端动态编译器可直接运行，多端共享 schema 不等于必须共享同一种校验执行方式。
库升级、Fastify adapter 版本和 wire 协议版本独立管理；冻结契约样本验证字段容忍与默认值行为。
