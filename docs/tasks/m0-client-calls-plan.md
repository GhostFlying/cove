# P3a：有界 instance-bound client calls 首切片（双通道一致性修订）

2026-09-27；Astra HIGH 规划，经独立复审批准。本文件转录原方案 `/tmp/cove-m0-p3a-controller-slice-plan-v2.md`（SHA-256 `8370138082768ba9ab7c989d0114c7a290902a0ecdacdbe012ddac7bbd028202`）；独立复审报告 SHA-256 `e5f75ec7cafb03ff0ef05ab7acfea73bd883287c6ca29f2e1cf9e38fa6404ea2`。方案起草时基线为 `0997ff584c65502c212f7d2adefb2a6fc4de1205`、N2 未接受；此状态已被下方实际派发记录覆盖。本文只细化既有 P3 第一原子切片，不重写整份 P3 或新增架构。

修订来源：独立计划审查 `/tmp/cove-m0-p3a-plan-review/report.md` SHA-256 `c913f751e5d25399052d8d9c29edc0b8399532db5b65a8f97ad6fd89138291cb` 的唯一 P1。原计划 `/tmp/cove-m0-p3a-controller-slice-plan.md` 保持原文及 SHA-256 `83deb63e5ebac08195b68d1e0182301cf1686a72c24117227d5283687446ca4b`；旧审查不自动成为本修订的通过结论。此次只补共同握手事实一致性、channel-specific ConnectionRef 和有限验收；不变更协议版本、产品选择或切片范围。

## 依据和本次交付

复用 `docs/tasks/m0-client-controller-plan.md` 的 Public API、Bootstrap/RPC、资源预算、atomic slice 1；以 `m0-routed-stable-recovery-contract-plan.md` 和现行 `packages/protocol` 公共导出覆盖其历史段。已读 AGENTS、handoff 当前接受段及 `/tmp/cove-m0-post-n2-next-allocation.md`。现行接受树尚无 `packages/client`。

交付真正可编译/调用的 `@cove/client`：注入端口，完成 authenticated HTTP bootstrap 与 terminal first-message bootstrap，维护 connection attempt 和 instance，提供六方法 typed RPC、显式 operation 查询、有限取消/退出和不可变诊断。P3a 不导出尚未实现的 controller/attach/recover/input/preview/view API，不创建占位 package 或伪造可用 terminal session。它是 P3 的 client foundation，不宣称完整 P3。

已决定且不得重开：external protocol2 / terminal revision2 / pipe2；显式 SubscriptionRef 路由；新 attach 新 ref，同一 live subscription recover 保持完整 ref；ordered recovery-result barrier + local attempt/view fence；baselineId 只管 baseline transfer，不能单独隔离普通事件；不自动重发 input/未知写操作。正式首次发布之前的历史实验 reader 不维护兼容线；仍要诚实报告 mismatch、正确处理当前 bootstrap 错误和同版本不同 build。P3a 不实现恢复，但不能留下与这些选择冲突的替换 ID 假设。

## 最小公共接口和端口

作者可微调命名，冻结时列出准确声明；以下行为和范围不变：

- `createClient(options): Client` 同步、不做 I/O；options 包含 expected server/instance、build/capability/profile offer、私有 credential supplier、UTF-8 encode/fatal decode、opaque ID supplier、scheduler、HTTP/terminal ports、有限正整数 deadline 配置。只绑定一个 instance，不能发现/启动/替换 server。
- `connect(): Promise<ConnectOutcome>` / `reconnect(): Promise<ConnectOutcome>`：一次有限双通道握手；并发 connect 不重复打开通道（同一 attempt 可共享结果），reconnect 先 fence/释放前次 owned handles。HTTP 成功不允许忽略 terminal 独立 bootstrap；两者只在下文共同事实一致性检查完成后原子进入 connected。HTTP success 不得带 ConnectionRef；terminal success 必须带 ConnectionRef，其 enclosing success 的 server/instance 必须符合预期，缺失或 pre-bootstrap business bytes 失败。没有后台重试/自动重连。
- `call<M extends RpcMethod>(method: M, params: ParamsFor<M>): Promise<CallOutcome<ResultFor<M>>>`：只支持 `server.status`、`terminal.list`、`terminal.get`、`terminal.create`、`terminal.stop`、`operation.get`。按方法关联输入/结果类型，不能统一暴露无约束 any。`getOperation(operationId)` 只是同 instance 的显式单次 operation.get，无轮询。
- `snapshot()` / `onState(listener)` 返回有限不可变状态/计数和可释放监听；`dispose(): void` 幂等，立即 fence、取消 timers/requests、关闭自有端口并 settle pending outcomes，不等待服务器 ACK、不 terminal.stop。listener reentry 不能双重完成或发起越权请求。
- `HttpPort.post({path,headers,body,maxResponseBytes}, callbacks) -> cancellation handle`：一次 bounded POST，回调明确 not-sent / handed-off / unknown 和 response/status/headers/bytes/error；端口须在读入/分配超 cap 前中止，不能先无限缓冲再交 client 检查。句柄用于本地取消，不承诺撤销服务器操作。
- `TerminalPort.open(callbacks) -> owned handle`：ordered text bootstrap / complete binary message、bounded send acceptance、close/dispose；attempt token 在 open 前建立，覆盖同步 callback/抛错及 late callback。没有实际 fetch/WebSocket/Node socket 实现。P3a 没有订阅或 terminal command producer，因此握手后的 unsolicited business traffic 不创建 route/无限缓冲；按协议异常关闭。P3b 再接合法 consumer，不提前造注册插件系统。
- UTF-8、时钟与 cancellable timer/yield 都由 host 注入。实现及公开声明 ES-only；禁用 Node/DOM 类型和 globals（Buffer/URL/AbortSignal/WebSocket/TextEncoder/global timers/process）、native/xterm/server 依赖。真实平台 bindings 属 H1。

## 现有协议消费与一项机械映射

只从 `@cove/protocol/{bootstrap,budgets,identity,profile,rpc,errors}` 导入当前公开验证器/常量/类型，必要的 terminal frame 验证用公共 terminal subpath；不复制 schemas，不跨包 src。利用 `BootstrapSuccessSchema`、`BootstrapFailureSchema`、`validateEffectiveBudgets`、`RPC_METHODS`、`validateRpcMethodParams`、`validateRpcResponse`、`validateRpcResultForCall`；这些验证器不能代替客户端的 expected instance、response ID、operation method 和所有返回 run 的完整绑定检查。

accepted bootstrap.ts 已固定 BUSINESS_HEADERS：Authorization、Cove-Protocol、Cove-Server-Id、Cove-Instance-Id；relay-protocol §11.1 的“响应 header 名另定”仍需机械落地。**本任务映射：响应复用后三个同名 identity/version header（大小写不敏感），不回显 Authorization；请求仍用既有名字。** 不添加 JSON-RPC 必需 meta，不改 wire version/schema。sole contract/docs registrar 在 `docs/relay-protocol.md` 对应行及 P3 allocation 登记此映射，H1/P2 后续按同一映射实现；不要各 consumer 自创别名。若已有未登记的其他 contract owner 冲突，由 root 协调，不静默覆盖。

凭据 supplier 提供端口所需的私有 Authorization 值和 terminal secret，P3a 不新选认证方案。secret 只在 terminal 首消息，HTTP credential 只在 headers；不得出现在 URL、snapshot、错误文本、日志或输入 fixture 的输出。HTTP bootstrap 先验 body identity；每个 business response 要核对同名 identity/version headers，之后才解释业务 envelope。稳定 bootstrap failure 可在匹配的安全解码路径报告，不能为业务成功省略身份校验。

## 同一 attempt 的双通道一致性（本次唯一规范补充）

- 发出握手前冻结一个共同 offer（expected IDs、protocol/build、capabilities、profiles、encodings）。HTTP 与 terminal 只在 transport 私有 credential 载体不同，不能在 await 之后读取变化的 options 形成两个 offer。
- 两个 success 各自通过既有 schema/预算/required capability/expected identity 校验后，再逐项比较共同事实：`bootstrapVersion`、`serverId`、`relayInstanceId`、`protocolVersion`、**服务器返回的** `buildVersion`、`profile`、`encoding` 相等；`capabilities` 按能力集合比较，顺序不构成差异、重复项不增加能力；`effectiveBudgets` 对公开 budget 字段逐项数值完全相等，不依赖 JSON 属性顺序。仍要求每个被选能力来自同一个 offer，不因集合相等就接纳未提供能力。
- 不选 HTTP 或 terminal 为可覆盖另一方的权威，不取两者交集/较小预算来掩盖冲突。两个有效且一致的结果才能形成一个 committed negotiated context。commit 前只允许既有固定 bootstrap 上限内的临时数据/handles，不开放 RPC、不发布 connected、不按某一结果分配业务队列；不能先发业务再撤回。
- `connection` 是唯一此处的通道身份差异：HTTP success 必须无此字段；terminal success 必须有合法 `ConnectionRef {connectionId,generation}`，只由 terminal 通道建立并与该 attempt 的 enclosing server/instance 绑定，不能由 HTTP 填补或继承旧 connection。不要给 ConnectionRef 臆加 serverId/relayInstanceId 字段。
- client 与 server build 不同仍可在同协议下成功；本规则只要求**同次握手中的两份 server success 对同一个 server build 的叙述一致**，并不恢复 build equality 作为客户端兼容门槛。
- 任意共同字段不一致或 connection 角色倒置，产生已有 typed local protocol/negotiation failure（诊断可标字段类别，不泄漏任意响应/secret），fence 当前 attempt，关闭两侧已取得的自有 handles、取消请求/timers并一次 settle。失败后迟到的第二个 success/close 无权提交 context。显式下一次 reconnect 才能重试；旧写请求仍按原 unknown 规则结算，不因此重放。

## 核心 invariants 与有限预算

1. HTTP/terminal bootstrap 分别 bounded fatal UTF-8/JSON；bootstrap <=8KiB、terminal first-message <=5s。required capability/profile/encoding/budgets/完整身份均验证；build 不作为同协议兼容拒绝理由。选定 offer 不接受服务器凭空新增协商结果。双通道共同事实与 ConnectionRef 角色按上述规范检查，一致后才 commit；connect失败清理两路已获得资源。
2. 每个 HTTP attempt 使用新字符串 request ID；调用前校验方法、参数、capability、current instance 和 frame/body byte cap。控制 admission 在 encode/copy/交给端口前完成；caller 可变对象/bytes 不得在发送后改变已记录意图。禁止 batch/notification。
3. RPC <= negotiated rpcInflight（最大32）；request <=64KiB、response <=256KiB，实际使用 effective 较小值；pending map/timers/payload均随完成释放。端口不得隐藏第二个无界 queue；credential supplier/port open/send 同样受有限 attempt deadline，并 fence迟到结果。作者在 allocation 固定 rpcTimeoutMs 的有限默认/上限或必填范围；它是本地工程选择，不冒充远端执行 deadline。
4. HTTP response 通过 validators 后仍核对 request ID、create/stop method、operationId、run/server/instance，以及列表每个 run。校验 `server.status` 的实际 version/profile/budgets/identity，不因 bootstrap曾成功就信任后续响应。畸形/超限/错误绑定不进入 success。
5. create/stop 的 caller-owned operationId 在 transport handoff 前固定。确定 not-sent 返回未发送；可能已送而 response lost/无效/超时/断开/取消 => operation RESULT_UNKNOWN，携带同一 operationId/instance 和 query-operation 指引。不得当作远端失败、自动重发或替换 ID。普通读失败不伪造成 operation receipt。显式 getOperation 只表示查询返回的状态；accepted/running 不是执行完成，只有 failed record 才证明该已接受操作失败。
6. connect/reconnect/dispose/响应/异常/timeout 都 exactly-once settle；前次 HTTP response/open/message/close/supplier/timer 不能改变当前状态。断线/instance mismatch 是 unverifiable/incompatible，不证明任何 run exited；保留 caller 手中原 refs/operation handles，不重新绑定。P3a 不保存永久 receipt ledger。

## 有限验收（compiled public path）

首个 slice 只登记两个真实 suite：`packages/client/tests/connection-rpc.test.mjs` 和 `compiled-client.test.mjs`，复用原计划最低8/3只是下限，实际 inventory 按最终用例登记；不预登记 P3b/c/d 空 suite。

- 双 bootstrap：same protocol/different build；缺 capability/profile/version、bad budget/身份、缺 ConnectionRef、8KiB+1/5s 边界、fatal UTF-8/JSON、pre-bootstrap binary；不产生 business traffic，已获 handle 清理。
- 同 attempt 双通道：两份 success 各自合法但 capability 集合不同、一个 effective budget 不同、server build 不同均失败；共同标量字段逐一差异受 schema 或跨结果检查拒绝。HTTP 带 ref / terminal 缺 ref 均失败；集合顺序不同及 budget 属性顺序不同但语义一致可以成功；client build 不同但两份 server build 一致可以成功。延迟第二个 success 之前零 business traffic/零 connected；冲突后两路释放且 late callback 无法提交，再次显式 connect 的新 attempt 不受旧回调影响。
- 六方法真实 public `call`：正确请求/headers/结果；错误 request ID、operation method/id、stop run、list 中 foreign run、response identity headers/大小写处理、missing capability，不能虚假 success。
- 写未知：not-sent 与可能送达分别验证；lost response、invalid bound response、timeout、dispose/reconnect 后到达均不重复写；只显式 operation.get 携原 operationId；同 ID 不同 canonical intent 不被悄悄改写。读失败与 failed/accepted/running operation record 含义分开。
- races：同步 port callback、open/credential抛错、旧 open/HTTP/close/timer在新 connect后、并发 connect、listener reentry、重复dispose；每个 promise一次完成，旧token不能更改新状态，所有 map/timer/listener/handle归零。
- limits：小合法 effective budgets、inflight cap+1、request/response cap+1、oversized backing buffer、不受控 port admission拒绝；credential及任意服务端错误文本不进入公开诊断；无需 RSS/SLO 或真实网络来证明计数。
- compiled独立 consumer 只 import已构建 `@cove/client` 与协议公共 subpaths；声明按现有 package-boundaries模式晋升为 ES-only source 验证；Node/DOM/native import 与 private src路径负例必须失败；使用当前 fixture manifest，拒绝未知 required variant、接受合法 optional field。没有历史实验 v1 parser兼容承诺。
- 独立 tester 先冻结策略再读实现：脚本化 peers + injected time，至少一个错误绑定仍返回success和一个写超时自动重发反事实必须被测试抓住；用单次受控负例/临时 mutant，不反复跑直到绿。fake transport通过仅是 P3a consumer证据，非 P2/H1真实网络或 C3 agents验收。

## Ownership、原子登记、依赖与分配

作者独占 `packages/client/src/{client,transport-ports,connection-session,rpc-calls}.ts` 与确有必要的局部types文件、`packages/client/tests/**`、`docs/tasks/m0-client-calls-{plan,results}.md`；不按清单硬造模块，不导出未实现功能。推荐 bounded 本地 warmpool TraeX5.6 Sol XHIGH 实施；若需要持续交互跨端口契约再由 root 分配 native Sol HIGH。独立 bounded source review 使用另一 TraeX5.6 Sol XHIGH，独立 tester 不与作者合并。

sole registrar独占 `packages/client/package.json`、package tsconfig、public export登记、root tsconfig references、pnpm-lock importer、`vitest.config.ts`、`scripts/ci-test-gate.mjs`、`tests/tooling/{ci-test-gate.test.mjs,package-boundaries.test.ts,project-references.test.ts}` 和上述响应头/父计划覆盖文档。依赖只加 `@cove/protocol: workspace:*`，ES-only tsc composite，当前精确 Node/pnpm/library pins不动。模块内公共类型由作者写，exports入口由registrar核对；没有双writer。

原子流程：root确认owner与checkout → 作者提交精确 registration request（export path、tsconfig deps、suite名/实际case、声明负例、最小importer变化）→ registrar在分配时隙把必要登记与真实source/tests组成同一可构建功能提交 → scoped build/tests+独立审查/测试 → full check/dual-OS exact-head CI → 串行rebase integration/final-main。不得先提交未登记源码或空package，再说下个提交补齐；没有登记前的草稿不称正式可构建验收。注册机械文件可由registrar在作者checkout获明确独占时写入，但不覆盖其未完成source。

可复用 checkout候选：`/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-recovery`，当前clean、旧R1 HEAD `b59bc9670b8f722c7812ba9189a6a6e04a311032`；root确认旧owner/process已释放后，从**届时已接受main**准备 `p/luchengxuan/m0-19-client-calls`，保留旧分支。clean不是空闲证明。该候选先前也建议给W1a，二者只能分配其一；另一可用候选为clean `m0-terminal-view` (`5d5473a977abd13a8cf462ae37c36dae04fae075`)，同样先确认释放。primary及m0-probes-verify当前N2占用，不抢占；不新建worker/worktree，仅建议。

DAG：`accepted R1 → P3a → P3b routed recovery → P3c/d control/input/lifecycle`，与 `N2 accepted final-main → W1a → W1b/c → W2 → P2` 并行；`P3 + P2 + V1 → H1 → C3` 不变。并行W1a的 `packages/terminal-worker/src/{run-session,ordered-run-pump,worker-execution,run-status}.ts`、worker tests、engine/protocol源只读，P3a不改；shared registration/lock/CI由root串行安排。若N2先合入只更新接受base/完整inventory，不把N2当P3a功能依赖。保留现有全部required suites，不照抄父计划历史22-suite总数。

无需新产品决定；响应header映射是原有身份验证要求的有限机械补齐。M0→M1仍用户门禁，devbox阻塞不重试。Orca依据复用原P3固定 `5534462b50c660888487a2108700d4cf284270db` 的 `src/relay/relay-handshake.ts`（build mismatch拒绝）与 `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts`（unknown work保留）比较：Cove按protocol兼容而非build equality，不复制其UI/host耦合。无未决方案需要本轮再审计Orca或改变refs。

## 实际预编码分配（2026-09-27）

N2 现已在 main `a4e50cb27b26db91a64c9711c5531e68f47c8c6c`（tree `a9ba760e6877989b48418aa5d953a53c1f58c456`）接受；独立 final-main 报告 SHA-256 `d244861e6a1e605f4fbe91002e4b79f439fe6ef24e26903e85e632b0cc64bbc8` 核验 macOS/Linux 各 42 套件、371 测试及十对线性映射。本分支 `p/luchengxuan/m0-19-client-calls` 从该精确 main 建立，checkout 为 `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-recovery`，原 R1 分支保留。本提交仅落方案与已审响应 header 机械映射；无 `packages/client` 源码、构建、测试或运行时资格结论。

Root 后续明确派发独立 TraeX GPT-5.6 Sol xhigh 作者，只独占 `packages/client/src/**`、`packages/client/tests/**` 及局部 fixture，先冻结真实公共 API、两个非空 suite 和 registration request。`/root/m0_t1_impl` 是本方案/结果、`docs/relay-protocol.md` 响应 header 及所有 manifest/lock/exports/tsconfig/root reference/Vitest/CI/tooling 的**唯一**登记者；作者源与登记在同一可构建原子功能提交汇合，不能预建空 package/export/suite。两者不得同时写同一文件或使用同一 mutable install/build。登记时仍须与并行 W1a 共享配置串行协调，保留已接受全部套件 floors。

任务范围限于本文件上述同步 `createClient`、双通道同次握手一致性、六方法类型化 RPC、显式 operation 查询、有限取消与不可变诊断。实际浏览器/Node transport、订阅/恢复/input/preview/controller、P2/H1/C3、devbox SSH 重试和 M1 都不在首切片。作者先做包内编译及两个真实 suite，注册后做完整 `pnpm check`；独立作者之外的源码审查、编译公共导出负例、exact-head 双 OS、rebase/final-main 证据全部是后续门禁。

## 登记纠正计划（2026-09-27）

首次完整门禁在用例发现阶段停止：`connection-rpc.test.mjs` 运行 27 个展开用例，但门禁发现器报告 22 个声明；三个 `test.each` 表格在该发现器中各占一个声明。此前把运行用例数 27 写成发现下限，导致实际非空套件被拒。保持作者六文件字节不变，仅把该 suite 的发现下限及直接 tooling 断言改为实测 22；运行阶段仍要求所有 27 个用例通过，`compiled-client` 下限 4 不变。随后先跑相关 tooling，再在新冻结提交上执行一次完整门禁；原失败日志保留为登记诊断。

第二次完整门禁确认 44 套件、405 个实际用例全部通过，却在报告核对阶段因旧门禁假定“发现数等于执行数”停止。为保留现有全局门禁契约，将三个 `test.each` 表格的 3、3、2 行改为八个显式具名 `test` 声明，公用各组原有断言逻辑；静态发现和实际执行均须为 27，恢复套件发现下限 27。先核对八个场景身份、真实发现和运行结果，再用原 405-pass JSON 验证报告核对；冻结后等待独立审查和新的完整门禁分配。登记纠正不得删除场景或放宽跳过/失败拒绝。
