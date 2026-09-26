# P3 订阅身份与原地恢复：最小契约澄清

状态：仅设计建议；2026-09-26。用户已认可“新订阅新 ID、原订阅恢复保留 ID、外部投递显式订阅身份”的方向。
本文件不批准实现、不替代现有计划、不报告测试通过。W1 窄补丁为另一项已接受决定。
只读检查 Cove 当前 checkout HEAD 25be370091a8599e1a4e4c68098a8c84bf23cf49（根协调者报告其为 main 489f346 上的 W1 文档提交）；未改仓库。

## 推荐组合

1. 新 attach/new view/reconnect 后的新订阅分配新 subscriptionId；连接身份仍由 ConnectionRef 限定。
2. 同一存活订阅的 recover 保持整个 SubscriptionRef 不变；恢复是此订阅的一次有序状态转换。
3. 外部普通事件用 `{subscription, event: RunEvent}` 投递；不再只靠 run+seq 路由，也不新增并行的 numeric streamId。
4. baselineId 只识别一次 baseline 转移；本地 recoveryAttempt token 和 viewGeneration 隔离旧异步工作。
5. 推荐不额外增加 wire recoveryGeneration，前提是把下面的双向串行屏障写成强制契约并验证。
   这不是 baselineId 单独解决问题：ordinary output、applied-ack、纯 replay 都没有 baselineId。

## 必须明确的屏障与预算不变量

- 每订阅最多一个 recover；同订阅命令按发送顺序推进到其有效状态边界，异步实现不得让后发 ACK 越过 recover 或反之。
- 客户端开始 recover 时同步进入 non-admitting，增加本地 attempt token，停止旧 drain/ACK timer/input staging；已交给 transport 的旧命令保序留在 recover 之前，尚未发送的旧 ACK 被取消。
- 所有解析完成/计时器/异步结果发送 ACK 前重新检查 connection、subscription、attempt token 和适用的 viewGeneration；ID 未变不能当作当前 attempt 的证明。
- 对已有 in-flight parse，若不能证明模型与 appliedSeq 一致，则失去 replay 资格，走新 backend 的 baseline；不能把旧 parser 写入同一个新 backend。
- 服务器处理 recover 是上行屏障：先结清在它之前已到达的 ACK，暂停旧投递生产者，废弃旧 attempt 的待发送 output、baseline、ACK-credit ledger；旧异步 producer 回调失效。
- “废弃”不等于称已交付或释放仍真实保留的内存。旧下行帧已进入 socket/adapter 的，仍计入实际连接队列预算，直至出队；不能重置计数后叠加第二份无界窗口。
- `recover-result` 是同订阅下行切换标记，必须与该订阅所有 output/baseline/replay 共用有序发送通道：旧已发送帧在它之前；旧排队工作要取消或先排完；它之后不得出现旧 attempt 的帧。
- 客户端从本地开始 recover 到收到匹配 requestId 的 recover-result 之间，旧投递只丢弃并释放本地保留，不 apply、不生成 applied ACK；服务器通过 recover 退休旧 ledger，不等这些帧的 ACK。
- 标记之后才开始新 ledger/new recovery 数据。Baseline 的 start/chunk/end 连续，不夹同订阅 live；用唯一 baselineId 校验并只在 chunk 解析后发 progress。
- Baseline 完成并 finishBaseline 在当前 attempt 解决后，才 ACK atSeq。Replay 则只从已验证 appliedSeq+1 到 result.atSeq，再进入 live；empty replay 也通过 result 屏障完成。
- 一个 baseline atSeq 不得低于此前已确认的 applied cursor；没有 checkpoint 可覆盖需要边界时应等待/失败，不能回滚游标。相同 appliedSeq 的新确认也要按新 ledger 正确处理。
- ACK 是累计位置而非“收到一个就加 credit”。新 ledger 仅释放本 attempt 实际保留且已证明解析的范围；重复/超前 ACK 不得重复授信。
- 保留 subscription 时 inputSeq/focusSeq 不能重置；recover 不自动取得控制权、不提升 epoch、不重发未知输入。旧 focus/input 结果可结算其原请求，但不能使新 attempt 获得 admission。
- 恢复超时或传输/屏障状态不明时，将该订阅 retired 并用新订阅重新 attach；不要在未知旧恢复仍可能输出时同 ID 发第二个无屏障恢复。正常完成后的下一次 recover 可以继续该 ID。
- 两个同-run订阅各自有 ledger/屏障，互不阻塞；connection 的共享发送预算仍统一有界。
- Worker→server 的异步结果/事件也必须受相同屏障约束；只在 WS 层排好顺序不能拦住稍后才从旧 pipe callback 进入队列的数据。

这些条件能在当前单条有序 terminal WS、每订阅串行处理、同一有序 worker pipe 下实现，无须为每个 ordinary event 增加恢复 generation。
若未来允许同订阅跨无序通道、多个并发恢复，或实现不能保证 producer→pipe→WS 的切换屏障，就需显式 delivery generation；当前不为假设中的扩展增加字段。
这里保证的是投递归属、ACK 信用与生命周期，不声称同 run+seq 的迟到相同字节必然导致显示错误。

## 当前源代码确实需要修正的范围

- `docs/tasks/m0-client-controller-plan.md:62,87,98–101`：改掉 recover 必得新 subscription 的表述；增加本地 attempt fence、串行屏障、失败后退休重订阅规则。
- `packages/protocol/src/terminal-events.ts`、`terminal.ts`：外部投递 envelope、绑定/有效载荷校验；内部 RunEvent 与 renderer applyEvent 保持原义。
- `packages/protocol/src/terminal-command.ts:83–90`：recover-result 只保留当前 subscription、mode、atSeq、requestId/run，移除 `replacement`。不保留一个必须等于自身的别名。
- `packages/protocol/src/terminal.ts:89–90,156–162`：移除 replacement 绑定与“必须不同 ID”校验，按原 subscription/request 关联；加契约测试与 fixtures。
- **内部 pipe 不能宣称不变**：`pipe-command.ts:90–94` 的 recover 也要求 replacement；`pipe.ts:62–68` 明确拒绝同 ID。推荐同样移除 replacement，定义 worker recovery-result 屏障/ledger退休语义。
- `runtime.ts` 的 openSubscription 复用 PipeCommand 类型，因此重编译受影响；无需新增泛化 runtime 接口或双层 ID 映射。
- 外部 envelope + recover-result 形状随已提议 external protocol v2 / terminal revision2 一次纠正；bootstrap version1、profile/encoding 不变。
- pipe recover 必填字段删除/语义改变也需明确内部兼容边界：推荐 PIPE_REVISION 从1到2并更新匹配协商/fixtures，不能沿用原计划“pipe version 不变”。具体 hello 字段对应由 sole protocol writer确认，禁止新旧混用。
- P2 分配/包装订阅、串行屏障和预算 ledger；P3 解包路由与本地回调隔离；worker执行 pipe屏障。无需 PTY/backend、renderer TerminalView 签名或 RunEvent seq 体系重做。

## Orca 比较边界

只读 Git 对象 stable v1.4.211 `5534462b50c660888487a2108700d4cf284270db`，不是用户运行版本或当前线上最新的断言。

- 新订阅分配ID：`src/renderer/src/runtime/remote-runtime-terminal-multiplexer-implementation.ts:28,82`；分配器 `remote-runtime-terminal-multiplexer-base.ts:54–63`。
- 同ID恢复：`src/renderer/src/runtime/remote-runtime-terminal-snapshot-controller.ts:45–81`。
- 恢复期间丢live、snapshot highwater去重：`src/renderer/src/runtime/remote-runtime-terminal-binary-controller.ts:92–109`。
- server先buffering、await后查对象身份、snapshot后发未覆盖尾部：`src/main/runtime/rpc/methods/terminal/terminal-multiplex-slot-frames.ts:174–269`。
  这是支持“订阅身份稳定 + 恢复屏障”的比较证据，不证明Orca具备上述全部Cove契约，也不是复现Orca bug。

## 尚属实施机制而非需要用户再选的架构方向

屏障由哪个现有 per-subscription queue 状态字段实现、旧已编码帧如何取消/排空、ledger如何保留实际字节计数、runtime/pipe结果怎样串行发布，可由限定实现计划细化。
最低验证反例包括旧parse晚完成、旧ACK跨屏障、producer晚回调、baseline credit重复归还、同run双view隔离、恢复超时后旧数据抵达；本次没有执行测试。
结论：接受方向可组合，建议“显式SubscriptionRef + 同ID串行recover + 现有baselineId + 本地attempt/view fences”；修改现有契约中的replacement语义后再实施，不额外增加wire generation或协议框架。
