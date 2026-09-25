# Relay 与终端 tab 架构讨论

状态：候选方案，供讨论；除已在整体设计中确认的要求外，本文不代表技术选型已定。
本文遵循 [relay 协议与生命周期](relay-protocol.md) 的兼容性与实例归属约束。

已确认的客户端方向：desktop 使用 Electron，初版 mobile 使用 React Native + WebView，
首个终端后端为 xterm.js；Web App 二期仅经 Tailscale，后续评估 Lynx + WebGL / WebGPU。
原生 RN Canvas 调研保留作参考，不作为首期原型或交付的前置条件。

## 1. 独立 Server 与终端的分工

```text
执行主机（本机与 remote 使用相同边界）
  Cove Server（relay，独立持久服务）
    本机 repo 注册、task/workspace、状态同步
    PTY / shell / agent CLI
    终端运行身份、当前尺寸、控制权
    输出序列、有限回放窗口、可恢复的终端状态
       ↕ 稳定协议 / transport adapter
多个客户端各自直连，不经过 desktop 中转
  Connection：连接、鉴权、协议协商和重连
  Terminal controller：订阅、顺序、回放、输入和尺寸
  Terminal view：终端模拟器、字体、绘制、选择和滚动
  Task / tab UI：导航、布局和用户操作
```

本机终端也由独立 relay 持有，不由 UI renderer 持有进程。
关闭窗口、刷新页面、移动 tab、释放 GPU 资源，都不隐式停止 PTY。

Server 是本机执行和业务状态的权威端，不要求 desktop 在线。
内部区分 task/repo 状态模块与终端模块，不让耗时 Git 操作或文件扫描阻塞终端输入输出；chat UI 属于二期。
Server/CLI 已选 TypeScript/Node.js，终端处理放入有界子进程池；不做 managed agent。
已选部署方案 B：本地 server 独立于 Electron，runtime 与 terminal workers 共同组成该服务；
不支持 runtime 重启后重新接管存活 worker 的一期保证。详见 [服务存活边界](server-architecture.md#5-持久服务与-pty-的存活边界)。

## 2. Transport 与协议分开

- Server 提供 host 网络和内置 Tailscale 接入；两者进入同一协议和业务服务。
- 本机还可通过本地 IPC 连接；远程连接经 SSH 隧道或 Tailscale，由通道负责加密和对端验证，Cove 保留设备授权。
- 桌面和 mobile 使用相同会话身份、方法语义和恢复规则。
- 不让 relay 的存活依赖 SSH channel 或某个客户端连接的存活。
- 批量输出按 terminal 独立调度和限流，输入、控制请求及其他 terminal 不能被单个输出洪峰长期饿死。
- 控制消息可以使用易调试的结构化编码，输出使用保留字节语义的二进制帧；载体已选独立终端 WebSocket，帧编码尚未冻结。

Mobile 通过系统 Tailnet 连接执行主机，不内嵌 Tailscale；移动端 SSH 后续评估。
接入与状态同步详见 [Server 架构](server-architecture.md)。

## 3. 恢复路线：已选 host 持续维护终端状态

以下保留两条路线的取舍，已选择第二条：

| 路线                                            | 收益                                          | 代价                                      |
| ----------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| Relay 只转发字节并保留有限尾部                  | 实现较少                                      | 不能保证新客户端仅靠任意尾部重建 TUI 状态 |
| Host 持续维护 headless 终端状态，提供快照和增量 | 无客户端时仍能建立恢复起点，支持后台 tab 释放 | 增加 host 解析成本与快照兼容性责任        |

已确认传输路线为 VT 字节流，不传字符网格快照或 cell 增量；两条路线的区别是服务端是否维护状态，并非输出编码不同。
已选择第二条：服务端持续解析所有存活终端的输出，恢复时提供可重放的 VT 基线与必要元数据。PTY 输出是有状态控制流：颜色、光标、alternate screen、输入模式、
滚动区域等可能由更早的数据决定。仅保留最后若干 KB 不能作为完整恢复保证。

每个终端维护一个服务端权威状态模型、有限 scrollback 和有界短期增量窗口。
“恢复当前 TUI”和“永久保存全部终端历史”分开；一期不默认承诺无限历史。

### 3.1 增量与快照的衔接

- 保留原本地模拟器且游标仍在回放窗口内：补发缺少的有序事件。
- 新客户端、tab 已释放或回放有缺口：先装载快照，再接快照之后的增量。
- 输出和 resize 必须共享可比较的事件顺序；不能用当前尺寸随意重放旧尺寸下的输出。
- 快照携带实例、流身份、尺寸、终端能力描述和准确的事件边界。
- Host 异步解析推进到边界后才能生成相应快照；不能把收到的最新字节位置当成已完成解析的位置。
- 快照安装期间有界缓冲后续事件；无法追上时重取快照，不无限堆积。
- 客户端已确认应用的事件不重复应用，旧订阅回调不能污染新订阅。

### 3.2 快照不是几个屏幕字符串

需要验证 normal/alternate buffer、光标、输入模式、滚动区域、字符宽度以及控制序列解析状态。
序列恰好被网络 chunk 截断时也要正确处理。
不能假定一个库的 serialize API 已经覆盖所有状态；需要明确支持的终端 profile 和恢复用例。

快照格式属于协议契约，不能直接传递某个 xterm 版本的私有对象。
恢复采用 VT 序列与显式元数据组合，仍需验证同协议新旧客户端都能恢复；
库升级不得绕过已经确认的 wire 兼容要求。

Terminal 查询回复也是难点：headless 和多个客户端模拟器可能同时产生对程序的回复。
已确认由 host 侧权威模型唯一负责受支持的查询；客户端实时解析、恢复和回放产生的自动回复均不能写入 PTY。
必须验证所选库能区分用户输入和模拟器回复，否则不能声称已具备正确多客户端恢复能力。

已确认快照内容分层与历史边界（具体接口待定）：

- 列表预览：当前屏幕的 VT 显示内容、尺寸、生成时间和运行/事件身份，不携带全部 scrollback，
  不声称包含可继续执行所需的完整模拟器状态。
- 恢复基线：重建当前终端所需的画面与状态，包括 normal/alternate buffer 的必要内容、光标及保存光标、
  模式、滚动区、wrap 状态、解析器尾部和准确事件边界；scrollback 是可选且有预算的附加内容。
  “全量恢复”指替换客户端模型并安装完整恢复基线，不等于发送全部历史输出。
- 历史回看：按需取得服务端仍保留的历史，不默认永久日志或无限回溯。普通 scrollback 是处理过的终端历史，
  不是全部原始 PTY 字节，也不是 agent rollout。

已确认恢复基线必须携带 normal/alternate buffer 的必要内容及状态，不能将隐藏的普通屏幕视为可随意删除的历史。
历史可以裁剪，恢复元数据须明确覆盖范围及 reflow 上下文是否足够；不保证任意截取的若干行能独立完成后续 resize。
一期不以精确计算最小历史依赖为前提。上下文不足时，由服务端权威模型完成 resize，再提供新尺寸下的轻量基线，
客户端安装后接续对应边界后的增量；新基线不必附带服务端计算 reflow 时使用的全部 scrollback。
判定覆盖普通/备用两份缓冲区，不能因当前 TUI 会重绘就忽略隐藏普通屏幕的尺寸一致性。
恢复目标是服务端当前保留的权威状态；已淘汰的历史或未记录的中间画面不承诺找回，基线不能掩盖源模型状态丢失。
历史不直接作为迟到的 VT 插入正在更新的终端，否则会移动光标/改变状态；单独历史视图或受控重建方式待选。

### 3.3 首个运行时方案（已选，待原型验证）

已选择 node-pty + @xterm/headless + @xterm/addon-serialize，客户端沿用已选 xterm.js。
库组合、单一权威模型、PTY 与模型同 worker、增量优先恢复及有限历史已确认。
具体库版本、恢复字段、IPC、流控参数与兼容性仍待实现和原型验证；选型确定不代表实现已验证。

| 部件           | 已选方案                                                      | 选择理由与限制                                                                                      |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PTY            | node-pty                                                      | 支持 macOS/Linux，已有 spawn/read/write/resize/pause/resume；原生模块需随 server runtime 构建和发布 |
| 服务端终端模型 | @xterm/headless                                               | 与第一代客户端同族，便于验证；仍经适配器隔离，不把库版本或私有状态作为 wire 契约                    |
| VT 恢复生成    | addon-serialize 作为基础，补足 profile 内所需状态             | 可输出 VT、有限历史与部分模式；不是完整进程或任意解析器状态的序列化保证                             |
| 进程归属       | 一个运行实例固定归属某个终端子进程，其 PTY 和 headless 同进程 | 避免全部原始输出先经主进程；新实例按负载分配，不在一期迁移存活 PTY                                  |

```text
Shell / agent
    ↕ PTY
终端子进程：node-pty → 有序事件 → headless / 有界回放窗口
    ↕ 有界 IPC（已订阅数据、恢复基线、控制消息）
Node 控制进程：认证、连接、授权及转发
    ↕ 终端 WebSocket，经 SSH / Tailscale
客户端 controller → xterm adapter → Electron / RN WebView
```

已选 runtime 与每个 worker 统一使用 pipe 帧协议承载控制、输入、输出及快照，不另设 Node send 控制通道。
实现可由两根单向 pipe 构成双向链路；每个方向只有一个有序发送队列，不把全双工误认为跨方向全局有序。
worker 仍是输出/resize 等终端事件顺序的仲裁方，命令执行结果通过带关联身份的应答确认。
帧编码待定：需带类型、运行/订阅身份、长度和适用的序号，限制单帧及排队字节；快照和大段输入分块。
当前操作者相关工作优先，优先级只调整不同终端/请求间尚未发送的工作，不打乱同一终端事件顺序。

进程池可从 devbox 已测的 4 个子进程起步，作为配置与验证起点，不是固定容量承诺。
node-pty 官方明确不保证 worker_threads 安全，PTY 并行采用子进程。
未观看终端仍更新服务端模型，但不向客户端发送全部输出；列表活动状态走低频事件。
子进程退出影响其持有的终端；不自动重跑 agent。失联先标记不可验证，退出与残留子进程需执行主机核实。
这不是独立 PTY keeper，server 重启边界仍按既定设计处理。

### 3.4 每个 run 的有序事件与重连

建议输出、尺寸及退出事件使用每个 run 的单调 seq，由同一个终端子进程串行仲裁。
输出保留原始字节（node-pty 的 raw bytes 模式），UTF-8 解码跨 chunk 连续；不逐 chunk 转 string 再编码。
写入 headless 采用有界流水线，记录已接收与已解析的位置；写入 callback 才能推进解析完成边界。

- 增量恢复必须满足 runId/relayInstanceId、客户端保留的模拟器状态及已应用 seq 匹配，且回放窗口连续。
  确认游标只在客户端解析完对应事件后推进，不在收到网络包时推进。
- 新视图或回放缺口：取得标记为 seq=N 的 VT 基线，客户端按基线尺寸初始化，安装完成后接收 N+1 起的事件。
  基线内容、尺寸、terminal profile 和 N 必须是同一状态；服务端不得在生成基线时混入 N 之后的变更。
- 建立恢复订阅和固定事件边界是同一串行步骤；生成/传输基线期间的后续事件保持有界，过期则明确重试恢复。
  不把这个临时缺口伪装成可继续的完整流。重复追不上时降频/缩减允许的历史并报告状态，避免恢复风暴。
- 网络读取结束或 write callback 不代表 VT 解析器处于完整控制序列边界。半个 UTF-8 字符、CSI、OSC、DCS
  必须专项验证。候选方案是可恢复检查点加有界原始尾部，或引擎适配提供 profile 内完整恢复；
  不能直接导出任意 chunk 边界的屏幕内容后声称可接任意后缀，也不能通过向 PTY 注入重置序列来补救。
  checkpoint 可用性、长期未闭合序列的资源限制和恢复失败行为是实现前验证项。
- 引擎不支持某 profile 状态时显式报告，不能静默掉模式；正常/alternate buffer、wrap、光标、保存光标、
  滚动区、输入模式、Unicode 宽度等列入兼容矩阵，后续后端须通过相同用例。

### 3.5 Focus、resize 与输入

沿用已定的最后一个有效操作者控制尺寸与输入。Focus 请求携带目标 run 与建议尺寸，server 仲裁后产生新的
controlEpoch；对应子进程验证 epoch，排入尺寸事件，更新 headless 和 PTY，随后广播权威尺寸及顺序边界。
已有输出、resize 和之后读到的输出按实际处理顺序记录；不声称 SIGWINCH 能精确标记应用内部重绘的时刻。
客户端依事件顺序 resize，不独立 fit 到各自窗口宽度；观察者按同一逻辑网格裁剪/平移。

输入携带 epoch 和会话内序号；过期操作者的排队输入在执行侧丢弃并报告，不延续到新的控制权。
控制切换前已写入 PTY 的输入不能撤回。客户端断线不缓存并在重连后自动补发键盘输入或粘贴；
输入已送达但 ACK 丢失时报告结果不确定，不能用重放用户输入解决。
后台重连不自动抢占；有效前台 focus 按既有约定自动接管，输入等待控制权与恢复状态就绪。

已确认：服务端权威终端模型是受支持终端查询的唯一回复方，在解析实时查询时由执行侧写回 PTY。
回复方不随客户端连接、断开、focus 或可见性变化；无客户端时仍正常回复。该决策不等于具体引擎与适配实现已通过验证。
客户端适配器区分用户键盘/粘贴/鼠标事件与模拟器查询回复；公开 onData 只提供字符串，不能直接认定全是用户输入。
验证 parser hook 或小范围引擎适配能持续抑制客户端查询回复，同时保留真实用户输入；不能只在快照回放时抑制，
也不能在异步 write 期间简单丢掉全部 onData。若需要库补丁，应局限在 adapter 并明确维护成本。

光标、模式和行列等模型固有信息来自权威模型，稳定能力按会话 terminal profile 定义。
颜色等可变显示属性由当前操作者提供，旁观者不能覆盖；属性更新需校验控制权，不能被旧操作者的迟到消息覆盖。
具体字段、更新顺序与无操作者时的缺省策略仍需细化；未知属性不编造答案或宣称支持。
客户端适配器必须满足会话所声明的能力，不能因服务端能解析某扩展就假定所有客户端都能正确呈现或编码输入。
查询回复只针对实时输出产生；恢复基线及历史回放不得重复向 PTY 回复。

Reflow 验证必须区分普通缓冲区的软换行重排与 TUI 收到尺寸变化后的主动重绘。
addon-serialize 会尝试保留软换行，不能概括为所有 VT 基线必然丢失 wrap；但当前画面一致不证明后续 resize 一致。
已确认正常 resize 先走有序尺寸事件，不默认每次重发历史。客户端历史被裁剪、重排上下文不足或无法保证 resize 一致时，
必须从服务端取得新尺寸下的恢复基线，再按该基线边界接续增量；不能继续将缺少上下文的本地 reflow 视为权威结果。
覆盖范围标记、基线请求与尺寸事件的具体握手仍待设计，所有路径均需验证 normal/alternate 两份状态。
完整验证覆盖宽变窄再变宽、normal/alternate 切换、Unicode 宽度与 wrap-pending。

### 3.6 两层背压与资源预算

已确认客户端按可见范围选择实时订阅：desktop 的可见终端（包括列表内可见预览）可以实时更新，
mobile 首期默认只实时订阅当前活跃终端；其他终端通过列表接口获取最近快照，不持续订阅完整输出。
实时订阅不等于 focus，不授予输入或尺寸控制权。离开可见范围后释放实时订阅，执行侧仍持续解析全部存活 PTY。
多个客户端的订阅独立，某客户端取消订阅不能影响其他客户端。

已确认 runtime 周期性向全部终端刷新状态与最近快照，包括无人订阅和不活动的终端，维护列表缓存，
不能仅在有人观看时更新。已确认分批错峰执行；无变化时校验版本/存活状态并复用画面，避免重复序列化。
刷新失败保留最后已知快照并标明陈旧/不可验证，不能把失联当退出或清空旧画面。
runtime 缓存不是第二份 headless 模型。已选持久化方案 A：首期不落盘终端画面、恢复基线或 scrollback，
周期快照仅作在线列表与连接恢复的内存缓存，不承诺 server 重启或崩溃后保留画面。
持久化 tab 配置、运行身份及已确认的生命周期记录；agent 的最后业务状态后续通过 agent hook 接入，不以终端快照替代。

列表最近快照的具体格式和刷新周期待定。已确认使用有限画面和有界缓存，不为列表生成完整历史；携带生成时间、run 身份及输出位置。
不要在每次列表请求中同步 serialize 所有终端的完整历史。列表显示快照与可接续增量的恢复基线是不同契约，
前者可以明确陈旧，缺少完整恢复状态时不能用于接续实时输出。该预览/恢复分工仍为具体实现建议。

- PTY → headless：解析队列达到高水位时 pause 该 PTY 的读取，降至低水位后 resume。
  真实背压可能使 agent 的输出写入阻塞；不通过丢失原始字节使权威模型跟不上真实状态。
  使用 API 流控，不占用用户的 Ctrl-S/Ctrl-Q；不能每个小 chunk 都 pause/resume。
- Server → 客户端：每个订阅按解析完成 ACK 归还字节额度，网络队列、IPC 和恢复缓存各有上限。
  慢客户端暂停发送；严重落后或超出保留窗口时，server 可主动终止该订阅并报告必须全量恢复的错误。
  旧订阅失效后不允许继续接其增量；客户端重新取得恢复基线，再用新的订阅身份接续对应边界后的事件。
  恢复基线与新订阅间必须预留有界回放或建立恢复令牌，避免两步之间漏输出；具体握手待定。
  优先只终止受影响订阅；连接整体不再排空时可断开连接，错误无法送达时重连仍需按服务端状态恢复。
  不因为某个观察者变慢就暂停所有 agent，也不能静默丢一段 VT 后继续同一订阅。
- 单客户端终端连接建议复用多个订阅，并按终端公平分批发送；控制消息保留额度。
  已确认优先服务当前操作终端；其他订阅和周期列表刷新仍需获得有界等待内的调度机会。
  大文件走独立 HTTP 通道，带宽仍需统一预算；终端二进制数据不进入 JSON-RPC 或 UI 全局状态树。
- 每个 terminal 限制尺寸、历史行数、解析积压与回放字节，同时设置整个 server 的内存预算；
  仅限制 scrollback 行数不足以限制超宽终端或可变内容的内存。
- 原型先使用每终端 1,000 行历史，对总预算及可配置上限继续测量；这不是冻结的产品默认值。
  恢复按需生成、合并重复请求并限流。同步 serialize 可能阻塞同子进程其他终端，
  必须测量恢复期间的输入延迟，必要时约束历史规模或调整实现，不能只靠增加子进程掩盖长暂停。

已确认每个 worker 内调度快照生成任务，任务之间让出事件循环，当前操作终端优先，限制连续生成工作量。
排队及优先级不能抢占单次同步 serialize；需要以尺寸、历史和内容预算约束单次工作，并测量实际阻塞时间。
若单次调用仍影响其他终端交互，调整快照生成实现，而不是仅增加队列或进程数量。

现有 devbox 探针中 5,000 行历史用例的 serialize p95 约 252 ms，100 个模型总峰值 RSS 约 1.42 GiB；
该用例还使用了较高输出负载，不能将所有内存差异归因于历史行数。
原探针不含真实 PTY、网络或客户端渲染，不代表完整链路验收，详见 [探针结果](benchmarks/2026-09-25-xterm/RESULTS.md)。

### 3.7 首个原型的验收门槛

1. 真实 PTY + 两个独立客户端：切尺寸、切操作者、断线与新视图恢复后，画面和后续控制行为一致。
2. normal/alternate buffer、保存光标、滚动区、宽字符/组合字符和跨 chunk 控制序列，不能只比较静态截图。
3. 无客户端时查询仍得到一次正确回复；多客户端与回放不增加回复，不吞键盘、粘贴或鼠标输入。
4. devbox 上 100 个持续输出 PTY，另测真实 agent/TUI；分别测服务器解析、输入到画面延迟和 mobile 渲染。
5. 一个慢客户端、反复恢复、突发输出和历史已满的组合下，内存有界，其他连接仍可操作。
6. 杀掉一个终端子进程或重启 server，准确报告影响，保留 tab，不自动重新启动 agent。

架构与首选库已确认；上述原型尚未执行，也未完成包含真实 PTY、网络与客户端的 devbox 端到端压测。
参考：[node-pty](https://github.com/microsoft/node-pty)、
[xterm 流控](https://xtermjs.org/docs/guides/flowcontrol/)、
[headless 接口](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm-headless.d.ts)、
[serialize 接口](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-serialize/typings/addon-serialize.d.ts)。

## 4. 可插拔终端后端：按引擎与绘制分别选型

已确认：终端实现必须可替换，不将 WebView、xterm 或某个 GPU API 作为产品的永久前提。
这包括只替换绘制后端，也包括整体替换终端解析/显示组件；不要求首期同时实现所有方案。

已确认首版终端使用 xterm.js，mobile 使用 RN + WebView，桌面容器为 Electron。
建议服务端配套使用 @xterm/headless，以减少两端终端行为差异，但不将其私有状态定义为 wire 契约。
建议支持 WebGL2 加速与 DOM 降级；具体设备默认 renderer、移动输入/选区方案和依赖版本待验证。
Server/CLI 已选 TypeScript/Node.js，终端处理使用有界子进程池；恢复格式尚未确定。
第 11 节保留选型研究，终端选择见第 11.10 节。

结构上分开三层：

- Tab UI：标题、布局、激活与用户操作，读取低频状态。
- Terminal controller：拥有连接、实例引用、订阅游标、写入队列和恢复状态。
- Terminal view：拥有模拟器及绘制资源，可以重新创建。

输出字节直接进入 controller 的有界队列，不逐 chunk 进入 React/全局 UI store。
如采用 React，组件重渲染不创建新 PTY，也不重建已有终端实例。
会话身份独立于 DOM、tab 数组下标和组件挂载次数。

### 4.1 稳定的产品边界与可替换实现

建议产品侧依赖 Cove 自己的 TerminalBackend 契约，接口名称和字段仍待原型验证。

| 层                 | 负责内容                                                          | 替换要求                                               |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------ |
| Session controller | 会话身份、协议、顺序、恢复、focus/controlEpoch、输入权限          | 不引用 xterm/DOM/Lynx 私有对象                         |
| Terminal backend   | 安装协商后的快照、应用有序输出/resize、测量可用网格、报告解析进度 | 可封装完整 xterm 组件，也可组合独立终端引擎和 GPU 视图 |
| 状态引擎           | VT 解析、字符与属性、模式、光标及有限历史                         | 后端内部可替换；server 的状态模块同样通过适配器接入    |
| 画面与平台交互     | 绘制、字形、选区、输入法、粘贴、键盘、无障碍及资源生命周期        | 可由 WebView、Lynx 原生 GPU 等实现，不直接控制 PTY     |

TerminalBackend 最小职责建议为 attach/detach、restore、applyEvents、measureGrid、
setAppearance、setVisibility、dispose，并向 controller 报告 inputIntent、focusIntent、
已解析游标和恢复错误。查询回复与用户输入分开，不把所有组件回调直接转发给 PTY。
这些是能力边界，不要求直接以 JS 对象调用；跨 WebView/native 的实现可通过有序消息桥适配。
测量出的本地网格只是请求尺寸，最终逻辑尺寸仍由 server 控制；后端不得自行 fit 并改变协议状态。

不强行把现成 xterm 拆成引擎和画家，也不围绕其私有 cell/buffer 对象设计公共 API。
原生 GPU 后端可以在适配器内部使用自己的状态模型；与其他后端共享的是协议语义和行为验收。
首期只需要一个可工作的实现和契约验证，不建设动态下载插件、插件市场或全面渲染框架。

### 4.2 替换不影响执行身份

- 替换客户端后端不改变 task、terminal、relay instance 或原 PTY；销毁 view 不是停止 session。
- 新后端从已协商快照恢复，再接有序增量；不要求旧后端将私有内存结构直接交给新后端。
- 旧后端的异步输出确认、focus 或输入回调通过 view generation 失效；新视图先同步再允许输入。
- “可替换”不默认承诺无闪烁运行时热切换；首期允许重建视图或在下一次 attach 使用新后端。
- 同协议的旧客户端仍需工作；后端新增能力通过协商启用，不能以 renderer 名称要求重置 server。
- server 状态引擎替换是单独的维护/兼容性议题，不能借客户端可插拔承诺其运行时无损更换。

### 4.3 防止恢复格式锁死实现

快照使用 Cove 定义的格式版本、terminal profile 与事件边界，不采用 xterm 对象或库版本作为协议身份。
候选基线是受约束的 VT 恢复序列加显式状态元数据；必须验证哪些模式/历史可以完整表达。
解析中的不完整序列要有明确的快照边界或重放规则，不能随意切断后声称状态完整。
使用其他引擎的客户端需要实现同一 profile；CJK/emoji 列宽、alternate screen、查询回复和 reflow 语义要一致。

客户端后端统一消费 VT 字节流，本地完成终端解析与绘制；不设计服务端网格快照/cell 增量路线。
未来原生客户端同样集成本地 VT 引擎与绘制实现，仅提供 GPU 绘制 API 并不足以替代完整终端后端。
恢复基线可称为终端快照，但其传输载荷是 VT 恢复序列与元数据，不是绘图指令或私有引擎内存。
这一边界不要求 Server 业务主体改变语言，也不要求客户端和服务端同时更换终端引擎。

## 5. 前后台资源管理

| 状态          | 客户端行为                                          | Host 行为                    |
| ------------- | --------------------------------------------------- | ---------------------------- |
| 可见 tab/pane | 实时输出，优先调度输入与绘制                        | 正常维护状态并发送订阅增量   |
| 短期隐藏      | 有界保留本地状态，降低处理频率或暂停增量订阅        | 继续维护状态                 |
| 长期隐藏      | 释放 view/模拟器及 GPU 资源，只保留身份与 UI 元数据 | 继续维护状态，激活时提供快照 |

这些是内部资源状态，不要求用户理解或手动管理。
多个可见 split 各自拥有 view；资源预算按可见 pane 数及 host 实测容量制定，暂不写死数量。
Host 的终端状态同样要有预算，不能将客户端的无限内存问题搬到服务端。

切换 tab 不执行自动 spawn；拿不到快照时明确显示恢复状态。
释放本地 view 后，本地游标不足以用于 delta-only 恢复，需要重新建立快照基线。

WebGL 是可替换的绘制后端。上下文丢失时应尝试恢复或切到该版本支持的非 WebGL 后端，
必要时只重建 view 并取快照，不重新创建 PTY。具体降级能力需要用所选版本验证。
纯绘制故障也不能通过向 PTY 伪造 resize 或输入来碰运气恢复。

## 6. 背压必须区分慢客户端与 host 过载

- 客户端 `write` 返回不等于数据已解析，流控确认应在解析完成后累计发送。
- 解析完成也不等于已绘制到屏幕；输入、解析、绘制进度分别可观察。
- 每个订阅有独立信用窗口、队列预算和 generation，不能跨重连归还旧订阅的信用。
- 某个手机或后台 tab 太慢时，暂停其增量订阅并标记需重新同步；不因它卡住其他客户端或远端任务。
- Host 自己解析/存储跟不上时，需要有限背压或明确过载策略。不能同时承诺有限资源、无限吞吐和绝不阻塞。
- 控制面和其他终端仍需有调度机会；输出洪峰下 Ctrl-C 必须能及时到达目标 PTY。

不无限积累待 `write` 数据，也不直接丢掉控制流后继续当作状态完整。
过载导致的恢复和历史缺口必须可见。

## 7. 多客户端的尺寸与输入：跟随当前操作者

一个 PTY 在同一时刻只有一组 rows/cols。多个客户端不能各自 fit 后轮流改它。

已确认：每个 terminal 的输入和尺寸跟随当前操作者；获得有效 focus 时自动切换并 resize，
不引入接管或恢复尺寸确认弹窗。以 server 最后接受的有效 focus 为准。

- 用户切入终端 tab/pane，或应用回到前台且该终端仍是输入焦点时，提交显式 focus 请求和网格尺寸。
- Server 授予控制权后，控制者可以输入并更新 PTY 尺寸；其他客户端继续观看输出。
- 单纯连接、后台订阅、组件重建和服务端控制权通知不触发 focus，不互相争抢。
- 主动重新操作观看中的终端也要能触发 focus；不能仅依赖 DOM focus 事件，因为旧视图可能仍有本地焦点。
- 观看者遵循 host 发布的终端网格，以缩放或滚动适配显示，不自行改变逻辑列数。
- 无操作者或全部断线时保留最后有效尺寸，不缩成 0×0，不自动改用其他观看者的尺寸。
- 前台且仍有终端焦点的客户端重连后可重新申请控制权；后台重连只恢复订阅。

已确认的观看行为：B 获得 focus 并改变尺寸后，A 的模拟器也应用相同的服务端网格，
A 的本地窗口无需跟随改变。网格小于视口时保持字号并留白；大于视口时裁切并允许横向、纵向移动查看。
查看网格与浏览历史 scrollback 是不同操作；默认不自动缩小字号，缩放适配可后续提供。
选择复制、滚动查看不申请控制权；重新点击输入区域或开始输入可以自动申请。
可用轻量状态展示当前控制设备与网格尺寸，不弹确认。各端不能用不同逻辑列数解释同一输出流。

建议通过 server 授予的 controlEpoch 隔离旧输入、resize 和 blur；字段及消息草案见
[Focus 协议](relay-protocol.md#91-focus控制权与自动-resize)。
Focus 是 Cove 控制协议语义，不等同于某个终端模拟器或 TUI 自带的焦点报告序列。
布局测量需等待字体和容器就绪，合并重复变化；相同网格尺寸下切换操作者不触发实际 resize。
尺寸变化按序作用于终端模型和 PTY，TUI 随后自行重排重绘；resize 应答不表示程序已经完成重绘。

## 8. 优先验证的交互

- desktop 关闭后，mobile 独立直连 server，能使用相同终端及任务清单。
- 所有客户端离线后，server 仍然读写和持有 PTY，不启动空闲退出计时器。
- 切换 Tailscale/host endpoint 后实例和订阅恢复正确，不重复创建终端。
- 同版本客户端升级后接回原 TUI，实例和进程身份不变。
- 50 个后台终端作为初始测试场景，不是产品上限；一个前台输入仍可响应。
- 某个终端持续刷屏时，另一个终端可以输入，原终端的 Ctrl-C 仍能送达。
- 长期隐藏后恢复 alternate-screen TUI，快照与后续增量之间不重复、不漏掉状态。
- 桌面→手机→桌面获得 focus 时自动使用当前端尺寸，不弹确认；后台观看不改变尺寸。
- 相同尺寸的 focus 不执行多余 resize；失去控制权的客户端不能用旧请求输入、resize 或释放新控制权。
- 控制权通知不会造成 focus 循环；旧端仍有本地焦点时，主动操作可以重新申请控制权。
- A 停留原页面时，B 改变尺寸后 A 使用相同网格，留白或裁切可查看，选择和滚动不抢控制权。
- 中文输入法、组合键、粘贴、CJK/emoji 宽度、选择和滚动在实际目标平台验证。
- WebGL context loss 只恢复 view，不影响原 PTY。
- 快照回放不把查询回复、铃声或其他客户端副作用重复发送到程序或操作系统。

## 9. 参考与证据边界

- [xterm.js 项目说明](https://github.com/xtermjs/xterm.js)：前端模拟器、headless 和可选 addons。
- [Flow control](https://xtermjs.org/docs/guides/flowcontrol/)：异步 write、解析回调与应用层流控。
- [Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/)：write 回调与终端生命周期接口。

参考 Orca 时查看了本地 checkout 的 output scheduler、attach replay 测试和 viewport claim 代码。
这只用于识别待设计的边界，不据此断言当前安装版本存在某个渲染根因。

## 10. 移动端容器与恢复选型调研

调研日期：2026-09-24。以下已检查公开官方文档、上游源码以及本地 Orca checkout，
尚未构建 Cove 原型或完成设备验证。平台已确定为 macOS desktop、macOS/Linux server、iOS/Android mobile。

### 10.1 WebGL 可选，xterm 的浏览器环境不可省略

xterm 的浏览器端实现创建 DOM 节点与 textarea，处理输入法组合事件，并提供默认 DOM renderer。
WebGL addon 是可选 WebGL2 渲染后端，官方给出了 context loss 时卸载 addon 的处理方式。
因此“使用 xterm”不等于“必须使用 WebGL”；仅提供原生 Canvas/WebGL 也不足以直接运行浏览器版 xterm。
依据：[浏览器端源码](https://github.com/xtermjs/xterm.js/blob/master/src/browser/CoreBrowserTerminal.ts)、
[WebGL addon](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md)。

网页终端是首个候选后端，可建立 DOM 渲染基线，再验证 WebGL2 加速及 context loss 降级。
此结论限于直接使用现成浏览器版 xterm，不要求 Cove 的所有后端使用 WebView。
后续评估 Lynx + WebGL / WebGPU，研究在 WebView 外承载终端绘制。
具体图形 API、目标运行时版本和性能尚未现场验证，不将候选路线视为已验证的发行包能力。

### 10.2 RN 与 Lynx 都有 WebView 路线

| 路线                              | 已核实依据                                                                        | 尚需验证                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| RN + react-native-webview + xterm | 组件支持 iOS/Android，提供消息桥及内容进程退出通知                                | 真机输入法、键盘避让、选区、后台恢复、桥接吞吐与依赖版本                   |
| Lynx + WebView XElement + xterm   | 官方 next 文档有 webview；上游 develop 已有 iOS WKWebView 与 Android WebView 实现 | 锁定发行包的接入/注册、平台 API 差异、进程退出恢复和同样的终端交互         |
| Lynx + WebGL / WebGPU + 终端引擎  | 后续候选路线，目标运行时能力待验证                                                | 具体图形接口、字形栅格化、输入法/选区、终端状态引擎、协议恢复与真机性能    |
| RN/Lynx 原生终端视图              | 可作为独立实现路线研究                                                            | 需要另选/适配终端引擎及输入、字体、选择和无障碍，不是加一个 WebGL 组件即可 |

RN 依据：[组件仓库](https://github.com/react-native-webview/react-native-webview)、
[生命周期和消息 API](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)。
Lynx 依据：[WebView API](https://lynxjs.org/next/api/elements/built-in/webview.html)、
[iOS 默认 loader](https://github.com/lynx-family/lynx/blob/develop/platform/darwin/ios/lynx_xelement/webview/LynxWebViewDefaultLoader.m)、
[Android 默认实现](https://github.com/lynx-family/lynx/blob/develop/platform/android/lynx_xelement/lynx_xelement_webview/src/main/java/com/lynx/xelement/webview/DefaultWebViewServiceImpl.java)。
开发分支源码存在不等于选定发行包已完成可用性验证，也不构成性能比较结果。

已确认初版 mobile 采用 RN + WebView + xterm；具体输入、渲染降级与恢复按第 11 节验证。
后续 Lynx + WebGL / WebGPU 可复用行为测试和协议客户端，不必复用网页终端本身。
图形 API 已有并不证明现成 xterm WebGL addon 可以直接运行：其上游实现还引用 HTMLCanvasElement、
document、DOM 事件和内部浏览器服务。适配现成 addon 与独立实现 GPU renderer 是不同方案。
依据：[xterm WebglRenderer 源码](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/src/WebglRenderer.ts)。

Session controller 可以按容器部署在 WebView 或 native 一侧，避免无意义的多次桥接；
其逻辑边界与测试保持相同，认证、网络和实测吞吐决定物理放置，不允许后端绕过 controller 输入权限。
渲染适配层作为可选集成边界；Cove 核心协议与领域接口不依赖具体图形 SDK 的头文件、包路径或私有对象。

### 10.3 Orca mobile 的实际实现参考

本地 checkout：`/Users/luchengxuan/orca/orca`，HEAD `322c18398`；相关文件没有本地修改。
这代表所读源码，不证明当前安装的 mobile 与其版本一致。

- `mobile/package.json`：Expo/React Native、react-native-webview、xterm、WebGL 和 Unicode addon。
- `mobile/scripts/build-terminal-webview-engine.mjs`：esbuild 将终端 JS/CSS 打包内嵌，不依赖运行时 CDN。
- `mobile/src/terminal/TerminalWebView.tsx`：RN 承载 WebView，用 postMessage 发送 init/write/resize 等消息，
  收到 web-ready 前排队；iOS 内容进程结束时清理旧队列并 reload，等待重新就绪。
- `mobile/src/terminal/terminal-webview-html.ts`：网页内创建 Terminal、open 后尝试加载 WebGL，
  处理快照/增量写入；session 页面接收服务端输出后调用该组件的 write。
- `mobile/src/terminal/terminal-webview-webgl-recovery-injected.ts`：context loss 先卸载 addon 并重绘，
  延迟重试一次，再次丢失则留在 DOM renderer；恢复可见时刷新纹理与画面。
- `mobile/src/terminal/terminal-write-coalescer.ts`：忙时按 48ms 窗口合并发送，空闲后的首段立即发送，
  减少 RN→WebView 的消息次数；此处只说明算法，不引用注释作为性能实测。
- `mobile/app/h/[hostId]/session/[worktreeId].tsx`：终端输入使用原生 TextInput 处理，
  WebView 还承担终端查询回复、触摸等交互；不是所有键盘输入都直接依赖 xterm 的 textarea。

可借鉴的是容器分层和恢复边界。Cove 的 focus/控制权、快照及兼容协议仍按自身设计实现。

### 10.4 “恢复方案与技术栈”的含义

此处恢复的是客户端终端画面与交互状态，不是 agent 原生 session，也不代表 server 崩溃后活进程恢复。
客户端可被彻底销毁，server 的原 PTY 仍在运行。重连需要能恢复字符网格、光标、模式、有限历史，
并从准确序号继续接收输出，而不是重启 agent 或只回放任意尾部文本。

建议 server 保有不绘图的终端模型，提供快照与有序增量。xterm 官方将 headless + serialize
列为这种重连的使用方式，但 Cove 必须验证自身 profile 和快照边界，不能假定任意库版本都能完整互通。
依据：[xterm headless 说明](https://github.com/xtermjs/xterm.js#nodejs-support)。

这会影响服务端语言与进程拆分：`@xterm/headless` 的官方使用环境是 Node.js，
内嵌 Tailscale 的 tsnet 则是 Go 库。可选 Node 终端核心 + Go 网络进程，或 Go 核心 + 单独终端状态模块，
也可评估其他终端库；不能要求 desktop/mobile 的框架决定整个 server 的语言。
依据：[tsnet](https://tailscale.com/docs/features/tsnet)。
初版明确不做独立 PTY keeper；即使因语言选择拆出网络模块，也不承诺 server 重启后 PTY 存活。

### 10.5 选择容器与引擎前的原型验收

- WebView 后端在 iOS/Android 验证所选 renderer 及降级路径；未来 Lynx + WebGL / WebGPU 后端沿用同一协议行为用例。
- 中英文输入法、组合输入、退格、粘贴、Ctrl/Alt/Esc/Tab、外接键盘和选区复制。
- 键盘弹出/收回、横竖屏和可见视口测量；观看者不得因本地布局变化擅自修改服务端网格。
- 锁屏/后台/内容进程重建/context loss 后恢复原 PTY，旧桥接消息不污染新视图。
- 实际常用 agent TUI、alternate screen、CJK/emoji 宽度、查询回复只由正确一方发送。
- 高频输出和文件传输并行时测输入延迟、内存及设备发热；不把“支持 WebGL”当作性能保证。
- 替换后端后仍接入原 PTY，无 renderer 专属业务字段；旧异步回调不污染新 view。
- 对比候选后端的发行构建、离线资源、集成代码量、行为覆盖与实测成本，再确定首个实现及依赖版本。

## 11. 六种终端方案与 RN/Expo 原生绘制比较

调研日期：2026-09-24。依据为各项目官方仓库、文档、当前开发分支源码和 npm registry。
这是源码级可行性判断，未构建这些库的 Cove 集成，未进行 iOS/Android 真机性能比较。
下表包版本是当日 registry 的 latest 标签；所述开发分支能力不保证都已进入该发行包，
原型必须锁定版本并复核。Omni 指 `omnidotdev/terminal`，版本来自 Cargo workspace，非最新 Release 证明。

### 11.1 按层比较，不把 GPU 标签当作完整终端能力

| 方案                                                                            | 引擎与现有绘制                                                  | 对 Cove 的价值                                                        | 首期主要代价 / 判断                                                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [xterm.js](https://github.com/xtermjs/xterm.js)，6.0.0，MIT                     | TS/JS 模拟器；浏览器默认 DOM、可选 WebGL2；Node headless        | 现成浏览器终端集成基线，headless 可用于 server 对照                   | 浏览器组件和 WebGL addon 依赖 DOM；原生 RN 需要另一套 view，headless 在 Hermes 未验证                   |
| [ghostty-web](https://github.com/coder/ghostty-web)，0.4.0，MIT                 | Ghostty WASM；Canvas2D 文字与绘制                               | 相对直接的 Ghostty + Canvas 接入，导出低层 GhosttyTerminal 与渲染接口 | 不是桌面 Ghostty 的 GPU renderer；浏览器输入/字体接口和 WASM 运行时需适配；不能默认已有完整恢复契约     |
| [Vercel wterm](https://github.com/vercel-labs/wterm)，0.5.0，Apache-2.0         | Zig WASM 轻量核心，另有 Ghostty 核心；DOM renderer              | TerminalCore 分层清楚，浏览器原生选区/查找/无障碍值得参考             | 官方标为 Labs experiment；RN 原生路径无法直接保留 DOM 优势，需自建 renderer；两种核心需分别验证         |
| [restty](https://github.com/wiedymi/restty)，0.3.0，MIT                         | Ghostty WASM；WebGPU / WebGL2；text-shaper 处理文字             | 现有 GPU renderer 移植的优先候选，有 DOM-free headless                | early release，内部渲染 API 不稳定；仍有 DOM 和 Canvas2D 彩色字形依赖；恢复日志有上限                   |
| [gespenst](https://github.com/tobilg/gespenst)，0.1.2，MIT                      | Ghostty WASM；GPU 背景 + Canvas2D 文字，可全 Canvas2D           | headless 的 cells、changed rows、历史、输入编码与状态快照很贴近 Cove  | 很早期；现有 renderer 不等于原生 GPU 文字；serialize addon 校验引擎构建身份，不能直接作为稳定 wire 格式 |
| [Omni Terminal](https://github.com/omnidotdev/terminal)，源码 0.4.2，Apache-2.0 | Rio 衍生 Rust 应用；独立终端 backend、Sugarloaf / wgpu renderer | 完整原生终端架构参考，有 Web/WASM 和 Android frontend                 | 属于应用/组件群，非即插即用 RN 组件；各平台标 experimental，未列出 iOS frontend；接入范围最大           |

上述许可为项目声明；真正采用时还需核对分发的字体、WASM 和其他依赖许可。
此处不以 README 性能数字或 GPU API 新旧排序；Cove 更看重实际 agent TUI、恢复、输入与维护边界。

### 11.2 会影响选型的具体源码边界

**xterm.js：成熟的使用基础不等于任意快照都可靠。** 官方 headless 面向 Node，
serialize addon 文档仍标为实验性；需要对 Cove 的 profile 验证完整恢复和跨版本行为。
它的纯 JS 核心值得在 Hermes 做兼容性验证，但不能把 Node 支持当作 RN 官方支持。
依据：[headless 说明](https://github.com/xtermjs/xterm.js#nodejs-support)、
[serialize 说明](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-serialize/README.md)。

**ghostty-web：可以复用低层核心，但不能把浏览器组件整体当成 headless。**
所查 `coder/ghostty-web` 导出 Ghostty、GhosttyTerminal、CanvasRenderer 等，
renderer 使用 `measureText`、`fillText` 和创建 canvas 的浏览器接口；Terminal 还管理 textarea 与 DOM。
适配 Canvas2D 的实际使用子集是一条可行路线，但需要连同字体与输入一起估算，不能只替换 canvas 节点。
依据：[导出接口](https://github.com/coder/ghostty-web/blob/main/lib/index.ts)、
[renderer](https://github.com/coder/ghostty-web/blob/main/lib/renderer.ts)。

**wterm：核心接口可借鉴，DOM 收益无法自然带到 RN。**
TerminalCore 包含写入、cell、dirty rows、光标/模式、历史和回复等接口，未将完整 snapshot/restore 定义为统一契约。
评估真实 agent TUI 时，应将内置轻量核心与 `@wterm/ghostty` 分开运行，不能从体积或名称推导相同兼容性。
依据：[TerminalCore](https://github.com/vercel-labs/wterm/blob/main/packages/@wterm/core/src/terminal-core.ts)。

**restty：渲染快照与解析器 checkpoint 是两件事。** `snapshot()` 复制的是 RenderState；
`createReplay()` 保存有界 write/resize 日志，默认上限 10,000,000 bytes，截断会标记 `truncated`。
任意截断后的日志不能保证恢复终端全部状态。Cove 需要额外恢复基线，而不是加大日志后声称问题消失。
其文字路径减少了对浏览器文字绘制的依赖，但彩色字形 fallback 仍使用 Canvas2D。
依据：[headless](https://github.com/wiedymi/restty/blob/main/src/headless.ts)、
[彩色字形 atlas](https://github.com/wiedymi/restty/blob/main/src/runtime/create-runtime/font-runtime/color-glyph-atlas.ts)。

**gespenst：headless 很合适研究，二进制快照不能直接定义 Cove 协议。**
`@gespenst/core/headless` 提供变化行、viewport、buffer、输入编码及快照；适合 server 状态或独立 view。
但 serialize addon 在恢复时要求 `abiSchema` 和 Ghostty `sha256` 匹配。
若将其当作唯一 wire 快照，客户端升级引擎就可能无法读取 server 快照，违背同协议兼容要求。
可考虑作为 server 内部 checkpoint，或有稳定基线兜底的协商格式；还需验证引擎升级时的恢复策略。
其 hybrid renderer 的 GPU 主要处理背景，文字依赖 Canvas2D，不能只看 WebGPU 标签。
依据：[headless](https://github.com/tobilg/gespenst/blob/main/docs/core/headless-runtime.md)、
[serialize 校验](https://github.com/tobilg/gespenst/blob/main/packages/serialize/src/index.ts)、
[hybrid renderer](https://github.com/tobilg/gespenst/blob/main/packages/core/src/renderers/hybrid.ts)。

**Omni：原生能力真实存在，但集成粒度不同。** Android frontend 已处理 JNI/原生 surface；
将 Rust backend 与 Sugarloaf 包成 RN view，并补齐 iOS 宿主，是原生组件工程，不能估成替换一个 npm 包。
依据：[workspace](https://github.com/omnidotdev/terminal/blob/master/Cargo.toml)、
[Android frontend](https://github.com/omnidotdev/terminal/tree/master/frontends/android-lib)。

### 11.3 RN/Expo 不依赖 WebView 的实际选项

| 图形基础                                                                                                  | 已核实能力                                                          | 对终端的边界                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Expo GL](https://docs.expo.dev/versions/latest/sdk/gl-view/)                                             | iOS/Android 原生 GL surface，WebGL 风格 API；包含于 Expo Go         | 需验证所用 WebGL2 API 子集与资源生命周期；不提供 DOM、Canvas2D 文字或终端输入              |
| [react-native-webgpu](https://wcandillon.github.io/react-native-webgpu/docs/getting-started/installation) | Dawn 原生 WebGPU；文档支持 iOS/Android 等，当前要求 RN 0.81+ 新架构 | 可复用相应 GPU 算法/着色器，但需适配 surface、present、字体及 runtime；Expo 用原生开发构建 |
| [React Native Skia](https://shopify.github.io/react-native-skia/docs/text/paragraph/)                     | 原生 2D、文字、字体 fallback、Paragraph 能力                        | 可直接实现终端网格绘制；不是浏览器 CanvasRenderingContext2D 的原样替代品                   |
| [react-native-canvas](https://github.com/iddan/react-native-canvas/blob/master/src/Canvas.js)             | Canvas API 的 RN 包装                                               | 源码使用 WebView，不满足这次无 WebView 路线                                                |

RN WebGPU 的 Expo 接入和呈现方式见 [Expo 文档](https://wcandillon.github.io/react-native-webgpu/docs/getting-started/expo)、
[Canvas 文档](https://wcandillon.github.io/react-native-webgpu/docs/getting-started/canvas)。
“支持 Expo”不等于“无需原生构建即可在 Expo Go 使用”。

原生 GPU 足以做终端绘制，但不提供完整浏览器运行环境。需要分别处理：

- 引擎：Ghostty WASM 的加载、内存和调用边界；或改用原生编译核心 / 兼容的 JS 核心。
- 文字：字形、字体 fallback、彩色 emoji、组合字符；字形像素宽度不能覆盖引擎定义的占列数。
- 平台：原生 TextInput 的组合输入/键盘事件、触摸选择、复制、外接键盘、无障碍和前后台资源恢复。
- 执行：批量更新与增量绘制，不把每个 cell 变成 React 组件，也不逐字跨 JS/native 调用。

不能笼统断言 Hermes 永不支持 WASM：2026-02 已有维护者发布实验性实现介绍。
但这不证明选定 Expo/RN 随附的 Hermes 支持这些库需要的 ABI；必须用实际发行构建验证。
依据：[Hermes WASM 介绍](https://tmikov.blogspot.com/2026/02/webassembly-comes-to-hermes_01829874520.html)、
[RN 的 Hermes 说明](https://reactnative.dev/docs/hermes)。

以下为原生路线研究建议，初版已选择 RN + WebView，不要求首期实施这些移植。
若将来移植已有 GPU renderer，可研究 restty + 原生 GPU，并替换必要的输入/彩色字形/平台适配。
若目标是首个可用原生终端，优先评估 Skia 直接绘制 cells，避免一开始同时维护 GL、WebGPU 与 2D 三条路径。
Skia 可以承担文字与背景，不必先额外引入 WebGPU；只有数据证明瓶颈后再决定独立 GPU renderer。
将两套绘图系统拼接还可能产生纹理上传/复制成本，不能假定提供 API 后性能自然更好。

### 11.4 已确认的 VT 字节流路线

客户端接收有序 VT 输出及 resize 等控制事件，本地完成解析、reflow 和绘制。
服务端不向客户端传字符网格快照或 cell 增量；此前提出的网格协议不纳入设计路线。
客户端更换 xterm、原生 VT 引擎或绘制实现，均须遵守同一 terminal profile 和恢复契约。

断线重连分两种：保留本地状态且补发窗口足够时续传；全新客户端或存在缺口时先加载
VT 恢复基线，再接后续输出。恢复包可附尺寸、模式约定与事件序号，具体 schema 待设计。
采用 VT 不等于 server 只做无状态转发；已选 headless 维护状态以生成有限历史与恢复基线，
不能从任意输出尾部宣称完整恢复。查询回复保持 server 单点负责，客户端回放不得重复回复。

未来 Lynx + WebGL / WebGPU 后端需要本地 VT 引擎、字体、输入和选择实现，不新增网格协议。

### 11.5 当前建议与最小验证范围

用户进一步明确：目标是性能最好且功能相对完备，不以去除 WebView 为目标。
已确认初版 mobile 使用 RN + WebView + xterm；具体依赖版本尚未冻结。
后续评估 Lynx + WebGL / WebGPU 时沿用相同功能和性能标准，比较方式见第 11.6 节。

- 状态层已选 `@xterm/headless`；具体恢复契约仍需独立设计和验证。
- 首期验证 xterm 的 WebGL2/DOM 路径，移动端输入、选区和恢复列为必要验收。
- restty、gespenst 等研究保留为未来替换参考，不要求首版先完成多库竞赛。
- 优先验证现成网页终端的 VT 恢复基线；不将某个 Ghostty build 的快照直接提升为 Cove 兼容契约。

第一个原型无需完成整个 app：复用同一组实际 agent TUI 录制、CJK/emoji、alternate screen、resize/reflow 流，
先验证 xterm 导出的状态和恢复；再在 iOS/Android 真机验证 view。
测试重新 attach 原 PTY、两客户端 focus 切换、观察者固定逻辑尺寸、IME/外接键盘、选区/历史，
并测发行构建输入延迟、持续输出、内存和前后台恢复。分别记录正确性与性能，不以模拟器帧率代替真机结论。
后续原生替代方案必须证明其性能收益，并通过相同功能验收；首期不等待原生方案的对照结果。

### 11.6 性能优先：WebView 与原生需要公平对照

去掉 WebView 只改变部分成本，不自动提高终端整体性能。当前没有 Cove 真机对照数据，
不能将“原生性能上限更可控”“Skia 比较容易接入”或上游自己的 benchmark 当作选型结论。

xterm 的 WebGL2 renderer 已有字形纹理与 instanced drawing，并非逐 cell DOM 绘制。
把它换成每帧重新布局整屏文字的 Skia view，可能反而增加 CPU 开销。
依据：[GlyphRenderer](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/src/GlyphRenderer.ts)。
RN WebGPU 默认绘制逻辑仍运行于 React 所在 JS 线程；可以改用 worklet runtime，但需明确资源所有权与跨线程成本。
原生 GPU API 不会自动提供线程隔离，也不会消除解析、分配或 GC。
依据：[RN WebGPU worklets](https://wcandillon.github.io/react-native-webgpu/docs/integrations/worklets)、
[RN performance](https://reactnative.dev/docs/performance)。

| 成本       | 去掉 WebView 的潜在收益                    | 不能默认的结论                                                             |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| 数据传输   | 减少 RN 与网页之间的序列化、复制和消息排队 | WebView 不必经 RN 转发全部终端流；可达且授权条件允许时可直接建立 WebSocket |
| 绘制       | 更直接控制资源、提交、批处理及生命周期     | 浏览器 GPU renderer 本身已做优化，原生或 WebGPU 标签不保证更快             |
| 线程       | 将热点放在独立 runtime/原生线程            | 全部搬入 RN JS 线程可能与 app UI 争抢 CPU；UI 线程也不能承载无界解析       |
| 内存与启动 | 可能减少网页容器和独立运行环境成本         | 原生引擎、字体/GPU 缓存及模块同样有成本；测量须覆盖 app 相关进程           |
| 输入       | 更直接整合原生 IME、键盘与手势             | 完整输入语义不会自动获得；远端回显还受网络和 PTY 程序影响                  |

直接连接能力依据：[WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)。
若内嵌 Tailscale 等要求连接留在 native 侧，保留必要桥接并测实际成本，不能为了实验绕过真实产品网络路径。
对照实验沿用已确认的 VT 字节流协议，不通过改成网格协议制造不可比的性能结果。

首期与后续评估分开：

1. 在 WebView 中验证已选 xterm 的 WebGL2 与 DOM 路径，测量并完善真实目标设备的功能与性能。
2. 后续评估 Lynx + WebGL / WebGPU 时再做最小原生对照，尽量固定引擎、网格、字体、输入内容和数据路径，区分容器收益与更换算法的收益；不阻塞首期。

不要用带额外 RN 消息中转的网页实现，对比修改了引擎、协议和绘制算法的原生实现，然后将总差异归因于 WebView。
两条路线均需合理优化；从完整产品角度最终比较时，再计入原生必须补齐的输入、选择、历史和恢复功能。

功能门槛为常用 agent TUI、中英文 IME、emoji/CJK 占列、选区复制、滚动历史、外接键盘、reflow、断线与后台恢复。
性能指标至少包含输入到回显的 p50/p95/p99、收到输出到可见的延迟、持续输出积压、滚动掉帧、
冷启动/重新 attach 耗时、全应用内存、持续负载下功耗/温升及多 tab 的资源回收。
固定设备、发行构建、字体、网格、历史量与输出录制；先用可控网络分解客户端成本，再测真实 remote 链路。
记录冷/热字形缓存、Latin 与 CJK/emoji 场景，避免仅测吞吐或平均 FPS。
没有可重复且产品相关的收益，就没有为性能而替换 WebView 的依据。

### 11.7 RN 中类似 Canvas2D + WebGL 运行环境的现成方案

补充调研日期：2026-09-24。之前只列 Expo GL、Skia 和 RN WebGPU 的清单不完整；
社区已有同时覆盖浏览器风格 2D 与 WebGL 的路线，不能从清单遗漏推断不存在。
以下仅核实公开文档与接口，不宣称与 Lynx + WebGL / WebGPU 候选路线有相同 API 覆盖或性能。

| 方案                                                | 与统一绘图环境的关系                                                                | 已核实限制                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Alibaba GCanvas / `@flyskywhy/react-native-gcanvas` | C++ / OpenGL ES 原生 Canvas2D 与 WebGL，提供 browser-like API；最接近所问的现成路线 | 原仓库明确停止 RN/JS bridge 支持；社区 fork README 记录 RN 新架构 Bridgeless 下 WebGL 纹理显示黑色          |
| `expo-gl` + `expo-2d-context`                       | 在 GL context 上以 JS 实现 Canvas2D API，无需 WebView                               | README 明示其实现比原生 2D context 慢，性能优先时建议 WebView；需要显式 flush；不能将旧文档当成当前设备实测 |
| RN Skia Graphite + RN WebGPU                        | 原生 2D 与 WebGPU 可以共享 Dawn、设备和纹理                                         | 2D 是 Skia API，不是完整 HTML Canvas2D 兼容层；Graphite 位于实验性 `@next` 通道，必须匹配 Dawn 版本         |
| Redraw + RN WebGPU                                  | 已有基于 WebGPU 的 RN 2D 绘制库                                                     | 目前为面向订阅者的技术预览，API 不稳定；不是已证明完整的 CanvasRenderingContext2D 替代品                    |

依据：[GCanvas](https://github.com/alibaba/GCanvas)、
[RN fork 与新架构限制](https://github.com/flyskywhy/react-native-gcanvas)、
[expo-2d-context](https://github.com/expo/expo-2d-context)、
[Skia Graphite](https://shopify.github.io/react-native-skia/docs/getting-started/installation/)、
[Skia/WebGPU interop](https://wcandillon.github.io/react-native-webgpu/docs/integrations/react-native-skia)、
[Redraw](https://redraw.dev/docs/intro/)。

因此，“绘图能力已具备”和“提供标准 Canvas2D + WebGL、可直接承载现成库的兼容层”应分别判断。
GCanvas 的 WebGL 声明也不能替代 xterm/restty 所需 WebGL2 API 的逐项验证。
GCanvas 可列入兼容性研究，但已知的新架构纹理问题使它不能直接成为现代 RN/Expo 首期已验证基础。

第 11.3 节提到的两套绘图系统复制成本并非必然：Graphite 与 RN WebGPU 已有共享设备与纹理互操作接口，
可以避免某些 CPU 读回和重复上传；实际路径仍取决于图像来源、资源所有权与同步。
需要使用文档指定的版本组合，而非默认假定任意稳定版 Skia 均具备此能力。

未来 Lynx + WebGL / WebGPU 评估可考虑“有限 Canvas 兼容层”：先清点所选终端 renderer 的 2D/GPU 实际调用，
再判断适配现成原生图形库是否比另写终端 renderer 更小。不会因为没有完整浏览器环境就直接要求重写 renderer，
也不为一个终端实现整套浏览器 DOM。是否适配成功与是否比 WebView 更快，仍是两个独立验收项。

### 11.8 RN + WebView 前提下的候选收敛（决策前调研）

本节保留选择前的比较依据，首版选择已在第 11.10 节确认。
调研时终端库尚未决定，因此不先假定使用 xterm/headless 再据此选择 Node server。
本轮重新核对官方开发分支 README 与相关源码；以下是原型优先级，不是实测性能排名，
也不保证开发分支接口已进入所选发行版。

| 方案              | 作为首版客户端的理由                                                    | 对持久 server 的实际边界                                                                       | 原型定位                                                               |
| ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| xterm.js + WebGL2 | 输入、选区、无障碍及插件生态可作为完整性基准                            | headless + VT serialize 有现成路径，serialize 仍标实验性；不保证任意解析中间态和跨版本完整恢复 | 功能与集成成本基准，未预定胜出                                         |
| restty            | Ghostty WASM + WebGPU/WebGL2 与文字 shaping，值得测试高频 TUI 绘制      | headless 有 render snapshot 和有界 replay，不能当完整 parser checkpoint                        | 优先性能挑战者，补恢复方案的成本需计入                                 |
| gespenst          | 默认 worker 解析/绘制、headless、输入编码和多后端降级，结构贴近远程终端 | serialize 校验 ABI schema 与 Ghostty build hash；需设计稳定恢复基线，不能依赖客户同时升级      | 优先架构候选；GPU 加速背景、Canvas2D 绘字，不能据 GPU 标签宣称性能胜出 |
| ghostty-web       | 相对直接的 Ghostty WASM + Canvas2D 浏览器接入                           | 低层核心可用，不等于已完成 Cove 的同步恢复契约                                                 | Canvas2D 对照与备选；不能直接继承桌面 Ghostty renderer 的性能结论      |
| wterm             | DOM 原生文字选择、查找、无障碍；核心可替换                              | 默认核心与 Ghostty 核心分别验收；新 snapshot 实验不属于已发布稳定契约                          | 重视浏览器文字交互时提升优先级；Labs 状态需计入维护成本                |
| Omni Terminal     | 原生终端 backend 与 renderer 架构可参考，另提供可嵌入 WASM Web 包       | Web 包可作为接入入口，但仍需验证 WebView、Cove transport 与恢复契约；原生 RN 接入是另一项工程  | 首轮不作为主要实现候选，依据是接入与社区验证不足，而非不存在 Web 组件  |

新核对的 [wterm libghostty 实验](https://github.com/vercel-labs/wterm/tree/main/experiments/libghostty)
已覆盖部分屏幕、历史及解析中间态恢复，但明确不改变发布包，并说明上游快照格式没有二进制兼容保证。
因此不能说它完全没有恢复研究，也不能将实验结果视为发布能力。

决策前曾建议首轮同时保留 xterm、restty、gespenst 三个候选，使用相同真实 agent 工作负载，先检查正确性，
再比较输入到画面延迟、持续输出、长历史滚动、总内存及后台恢复。
RN + WebView 不等于移动输入已经完成；中文 IME、软键盘、外接键盘、选择复制、
横竖屏和 WebView 内容进程重建都要验证。WebGPU 不作为首版必要条件，按实际能力选择降级后端。

Server 语言比较应在这些候选的 headless/恢复路线明确后继续。选择 Ghostty 家族也不自动决定 Rust，
选择网页 JS API 也不自动决定 Node；实际 WASM/原生 ABI 和宿主适配成本才是依据。

### 11.9 社区反馈复核（2026-09-24）

范围：六个项目近期 GitHub issue/评论、相关 PR、HN 一手讨论及下游产品记录。
未在 Cove 复现用户报告；issue 关闭、修复合入与稳定版发布分别记录。
不按 issue 总数判断质量，也不把原生 Ghostty 的口碑直接归给各 Web 封装。

**xterm.js：下游经验最充分，但移动端需要我们投入。**
[Android 输入 #3600](https://github.com/xtermjs/xterm.js/issues/3600) 最初由 Replit 接入者报告，
2026 年仍有 6.0.0 用户报告重复/错乱输入，issue 当前 open。
[触摸复制 #3727](https://github.com/xtermjs/xterm.js/issues/3727) 中 CoCalc 开发者说明实际使用障碍；
[修复 PR #5961](https://github.com/xtermjs/xterm.js/pull/5961) 当前未合入，方案针对 DOM 原生选区，
不能推导为 WebGL 触摸选择已解决。
[IME #5887](https://github.com/xtermjs/xterm.js/issues/5887) 包含 macOS/WKWebView 输入丢字报告；
[serialize #6165](https://github.com/xtermjs/xterm.js/issues/6165) 报告满行恢复光标偏移，均 open。
因此成熟度可作为基准，不能承诺 mobile 或恢复开箱即用。

**ghostty-web：有真实采用与正面反馈，稳定版交付是显著风险。**
[Zellij 讨论](https://github.com/zellij-org/zellij/discussions/5435) 有接入者报告完整 TUI 可显示，
也指出插件、包体和发布成熟度的代价。
[输入回显 #161](https://github.com/coder/ghostty-web/issues/161) 中 superterm 开发者报告替换后明显延迟；
该 issue 已关闭，不能当作当前 main 必然存在的缺陷。
[发布请求 #137](https://github.com/coder/ghostty-web/issues/137) 则持续有下游反映修复未发布，
包括 Android、mouse tracking、resize 和 WASM 错误；本轮直接查询 npm registry，
latest 仍为 2025-12-09 的 0.4.0，另有 next 预发布。
对希望减少 fork 维护的 Cove，应降低其直接作为首选依赖的优先级。

**restty：存在与 Cove 很接近的 agent 产品接入反馈，修复响应可观察。**
[#17](https://github.com/wiedymi/restty/issues/17) 的 VS Code agent 扩展作者报告它改善了自己遇到的
xterm/Codex 输出缺行，同时需要自行补快捷键与恢复，不能视作通用性能证明。
[#12](https://github.com/wiedymi/restty/issues/12) 的 IME 提交问题已关闭，维护者提供 main 修复提交；
[#24](https://github.com/wiedymi/restty/issues/24) 的 CJK 字体问题明确记录 0.2.1–0.2.4 多轮发布修复。
[#1](https://github.com/wiedymi/restty/issues/1) 触摸滚动关闭后仍有用户反馈默认体验，作者在 2 月表示当时移动端非优先，
不能将关闭状态当作完整 mobile 验收。Worker 提案 [#10](https://github.com/wiedymi/restty/issues/10) 当前 open。
判断：保留强候选，但 mobile、中文字体和恢复需独立验收。

**gespenst：有下游采用信号，社区样本仍少。**
[Linea changelog](https://runlinea.com/changelog) 记录 2026-09-03 将其设为默认终端，
并称整屏输出及拖动分隔条约比 ghostty-web Canvas 快 2.5 倍；这是下游自述，未提供足以复现的完整基准，
不外推到 xterm、restty 或手机。9 月 12 日该产品又修正 Gespenst canvas 的 Retina 字号缩放，
这是集成问题记录，未证明库本身根因。本轮仓库 issue/PR 列表 API 返回空，不能解释成零 bug。
判断：值得原型，成熟度置信度低于接口和 demo 给人的印象。

**wterm：有明确的替换回退案例，但旧缺陷正在变化。**
Agent of Empires [RFC #1010](https://github.com/agent-of-empires/agent-of-empires/issues/1010)
列出旧版 wterm 的 tmux、CJK、同步输出、滚动与移动输入补丁成本；
[迁回 xterm 的 PR #1275](https://github.com/agent-of-empires/agent-of-empires/pull/1275) 已于 2026-05-20 合入。
不能将该案例当作当前版本全面结论：本轮看到 9 月仍有修复合入，
包括 [DEC 线框 #148](https://github.com/vercel-labs/wterm/pull/148) 和
[宽字符编辑 #147](https://github.com/vercel-labs/wterm/pull/147)。
判断：早期产品曾承担较多兼容补丁，Cove 首轮优先级低于上述三个主要候选。

**Omni：缺乏足够的一手下游反馈。**
本轮仓库所有 issue/PR 列表共返回 69 项，其中仅两条非 PR issue，均为 Renovate 机器人记录；
检索未找到足够的独立长期使用或 RN/WebView 验证。
官方确实提供 [可嵌入 Web 包](https://docs.omni.dev/products/omni-terminal/web)，
因此纠正“只能抽取完整应用”的过强表述；降低优先级的依据是外部验证不足。

社区证据没有证明任何一个同时具有最佳性能与完整移动体验；结合维护成本，最终选择见第 11.10 节。
选择时把下游补丁量、稳定版发布是否包含修复、维护者响应和可替换成本一起计入。

### 11.10 首版终端决策（已确认）

用户选择 xterm.js 作为首版终端实现。主要取舍是依赖已有生态与下游经验，减少成为早期用户及长期维护 fork 的成本；
不宣称 xterm 性能最佳，也不忽略移动输入、触摸选择及 serialize 边界。

- 客户端采用 xterm.js；mobile 容器保持 RN + WebView。
- 保持 Terminal backend 可替换，统一接收 VT 字节流，Cove 协议与业务对象不暴露 xterm 私有对象。
- 建议配套 @xterm/headless 作为服务端状态引擎；具体恢复格式和跨版本兼容仍需验证。
- Server/CLI 已选 TypeScript/Node.js；WebGL2/DOM 默认策略、输入/选区适配和依赖版本尚未冻结。
- 不再将其他终端库的性能对照作为首版前置条件；后续替换须证明收益及功能兼容。

## 12. Tab 状态与 server 重启后的重开

已确认：一个 task 支持多个 tab；初版没有独立 PTY keeper，server 重启必须明确提示会话影响。
已选快照持久化方案 A：重启后保留 tab/运行记录，不恢复旧终端画面，不录制完整输出；手动重开创建新 run。
agent 最后业务状态后续由 hook 提供，该能力不作为首期终端持久化的前置要求。
用户要求区分最近有命令的 terminal 与长期无活动的 terminal，并认可保留清单供手动重开。
已确认展示不限制为 agent active / terminal active / inactive 三类，可按真实语义细分。
以下字段是细化建议：活动、会话存活和视图焦点分开，不能用一个 active 布尔值兼任。

### 12.1 逻辑 tab 与运行实例分开

逻辑 tab 保存稳定 ID、task/workspace、名称、启动配置、历史运行实例及用户可见状态。
一个 tab 可以尚未启动、正在运行或只有历史；客户端关闭视图不删除 tab，也不停止它的 PTY。
手动重开可沿用 tab ID，但必须产生新的运行实例身份，不能覆盖旧实例或复用它的输入/输出序号。
当前选中、是否可见、focus/controlEpoch 与以下状态正交；未选中的 tab 仍可能持有活跃 agent。

状态按独立维度保存，CLI 返回结构化事实，GUI 根据事实组合展示：

| 维度           | 建议表达                                   | 作用                                                           |
| -------------- | ------------------------------------------ | -------------------------------------------------------------- |
| 运行生命周期   | 未启动、启动中、运行中、已结束、会话中断   | 描述当前运行实例，不把逻辑 tab 删除与进程退出混为一谈          |
| 观测可验证性   | live / exited / unverifiable，以及观测时间 | 失联和陈旧缓存不能证明进程退出；中断也不证明所有派生进程已结束 |
| 程序类型       | shell / agent / other / unknown            | 不将识别失败解释为没有进程                                     |
| 普通终端活动   | 命令执行中、近期活动、闲置、未知           | 区分命令仍在执行与回到提示符后经过的时间                       |
| Agent 工作状态 | 工作中、等待输入、等待批准、未知           | 仅对具备可靠信号的 adapter 展示，不引入 managed agent          |
| 客户端交互     | 可见性、选中、焦点、控制权                 | 当前页面状态，不定义 server 进程的生命周期                     |

可展示“命令执行中”“最近执行于 2 分钟前”“闲置 30 分钟”“Agent 等待输入”“已退出”“会话中断”等，
不再把它们压成三类。最终字段名和组合规则在协议设计中确定，避免枚举所有维度的笛卡尔积。
CLI 与 GUI 使用相同语义；脚本读取结构化字段，不解析徽标文案。

持续执行但无输出的编译/sleep、等待按键的普通 TUI 保持执行中，不因时间阈值变闲置。
Shell 回到提示符后先显示近期活动，超过阈值再显示闲置；PTY 和后台作业并不因此被清理。
Agent 退出回到 shell 后遵循普通终端规则；等待输入不是会话结束。
没有可靠活动观测时显示活动未知，不根据输出静默、CPU 低、tab 未选中或客户端离线猜测闲置。
后续细分状态仍遵守协议兼容契约；扩展通过可选字段/能力协商表达，旧客户端保留未知信息并安全降级。

### 12.2 可验证性与 agent 工作状态分开

Server 是执行状态来源，客户端只缓存带实例身份和 observation revision 的观测。
失联时标记 `unverifiable`，可附最后观测到的状态；不能用本地计时将最后状态转换成已确认的闲置或退出。
确认可用实例为 `live`，确认进程退出为 `exited`；会话丢失但派生进程存活性未知时不伪造 exited。
Server 重启后不自动采信数据库中的旧 PID 或 last-known active；先确认新实例清单与旧会话的边界。

识别 agent 优先使用 Cove 已知的启动配置与当前运行证据；手动在 shell 启动的 agent 可通过执行主机检测补充。
检测不到或检测不可靠时保留普通终端能力；进程名字、历史标题或旧启动配置不能永久证明 agent 仍存在。
嵌套 SSH/tmux 等不具备可靠识别条件时显示识别未知，不猜测内部 agent 状态。
已识别的 agent 可以额外展示 working / waiting-input / waiting-approval / unknown，
仅使用对应 adapter 的可信信号；不要求初版为任意 agent 实现忙闲识别，也不因此引入 managed agent。

Orca 参考：本地 checkout `322c18398` 的 `src/main/runtime/orca-runtime.ts` 中，
`getDetectedWorktreeStatus` 用 hasPty 区分 active/inactive，并叠加 working/permission；
该处属于 worktree 聚合路径之一，不代表 Orca 的完整 tab 生命周期定义。
Cove 借鉴分类边界，不复制标题启发式作为进程存活判据。

### 12.3 普通终端的命令与近期活动

建议在运行实例上分别记录 execution、时间戳和观测来源，不由每个客户端独立猜测：

| 信息                                             | 用途                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `execution = running / prompt / unknown`         | 区分仍在执行与已回到 shell 提示符；unknown 不等于已完成 |
| `lastCommandStartedAt` / `lastCommandFinishedAt` | 展示真实命令边界，长命令结束后开始近期活动窗口          |
| `lastUserInputAt`                                | 识别实际提交给当前实例的用户交互，输入不自动等于新命令  |
| `lastOutputAt`                                   | 独立展示输出活动；后台日志不伪造成用户最近执行了命令    |
| `observedAt` / 来源 / 实例身份                   | 识别陈旧、缺失或属于旧实例的状态                        |

初版可为 Cove 启动的受支持 shell 提供命令开始/结束及提示符 integration，结合执行主机的进程观测。
直接启动的程序可按进程生命周期判断执行；嵌套 SSH/tmux、未支持 shell 或钩子失效时按观测能力降级。
只收到键盘输入不能证明开始了一条命令，Enter 也不能可靠证明命令提交；PTY 输出安静不能证明命令完成。
普通 shell 的提示符观测不保证没有后台作业；已知后台任务/输出活动单独展示，闲置不得用于自动终止或迁移放行。
命令事件只接受当前实例及正确事件顺序，陈旧结束事件不能覆盖新命令的 running；钩子状态不作为授权依据。

建议初始闲置阈值为 10 分钟，作为待验证默认值，通过 `cove <目标选项> terminal config` 完整配置。
已知 running 时忽略闲置阈值；已知 prompt 时，从最近命令完成或实际用户输入开始计时。
新 shell 尚未执行命令时以首次提示符时间作为闲置起点，不虚构一条命令记录。
Server 负责分类并提供时间/持续时长语义；同一配置下各端一致，时间推进导致的状态变化也应同步。
仅 focus、resize、打开 tab、attach、重连或恢复画面不重置命令活动时间；初始化内部输入也不计作用户操作。
时长判断避免受系统时钟跳变影响；server 重启后旧实例的时间戳只作历史，不产生新的活跃状态。

### 12.4 存活 tab 清单与手动重开

已认可保留 tab 记录及重启前导出供事后手动重开；以下是清单字段建议：

- 清单格式版本、导出时间、serverId、旧 relayInstanceId 与观测 revision。
- Task/workspace/tab 身份、名称、workspace revision 和当时的挂载映射。
- 启动 cwd，以及能可靠获取时的最近 cwd，分别标明来源与观测时间。
- Shell/已配置 agent 的启动配方引用、已识别 agent 类型和最后状态；可记录已知原生 session ID 作为参考。

清单按存活实例而非 active 展示标签筛选，包含 agent、近期 terminal 和长期闲置但仍有 PTY 的 shell。
无法核实的条目另行明确列出不确定性，不能在导出时静默漏掉；未运行的历史 tab 仍保留在持久清单中。
初版不要求自动恢复，也不通过打开旧 tab 自动 spawn。用户可以选择 tab，在核实目录后重开 shell，
或明确选择已配置的 agent 启动配方；不自动重放最后执行的任意命令。
启动参数以可审阅的配置为准，不导出整个环境变量或把任意进程命令行作为恢复脚本。
原生 agent resume、rollout、shell 环境变量、后台作业和进程内状态不因这份清单而获得恢复保证。
画面快照可作为独立的最佳努力历史记录；有画面不表示旧进程仍存活。

计划重启前展示受影响条目和导出结果；意外崩溃只能使用最近持久化记录，可能不包含最后的 cwd/状态变化。
恢复清单是导航和重开材料，不是 checkpoint；失联或会话身份不明时，仍不得据此悄悄创建替代实例。
