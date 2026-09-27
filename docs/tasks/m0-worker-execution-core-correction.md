# W1a 首切片：公共所有权、有限 disposal 回执与同步 observer 修正

2026-09-27；Astra HIGH corrective PLAN ONLY。仅后续由 root 分配作者实施；本轮不实现、不运行代码/测试、不改变仓库/refs，也不启动 workers。先修首切片，不能顺带启动 W1a commands/registry、W1b 或 W2。

## 精确依据与已关闭部分

- accepted base `a4e50cb27b26db91a64c9711c5531e68f47c8c6c`；原审查 source `26b9276e549eb60f468d6d1079f553dad7bebd71` / tree `7a479bea3bd9869558e3f76e6a785fc5f593b9de`。
- 当前只读修正 source `1793ce7b3252a7be6b3796577e4ae90c155f1231` / tree `55d510b97e5499827b89ac9b378ffc71777ad459`：仅已补 sync consumer throw 的 `consumerFenced`/diagnostic surface，未关闭 thenable/F1/F2/F4。
- 正式 review `/tmp/cove-m0-w1a-first-source-review/report.md` SHA-256 `e15120fd1f41e3e435e9baf463577d7ea9b1868bf3ae2c511d1326b5deb39096`；独立 finite `/tmp/cove-m0-w1a-first-verify/finite-1793-report.md` SHA-256 `cf4b815a849f60ba05336538846b33926598778c452a136d47b594440f8b636b`。1793 的 compiled fake/real 有限检查通过，不是完整接受；26b 的 author 44/384 仅历史证据。
- 复用 `docs/tasks/m0-worker-execution-core-plan.md`、parent W1 execution、accepted N2 stop/owner 合同。N2 `native-pty.ts` 公共 `stop()` 缓存 receipt、2s grace+1s force；`writerCompletion` 独立于 leader；成功 owner 释放需要实际 leader exit AND writer closed。helper uncertainty 单独不留 owner；writer close-uncertain/invalid 仍由 N2 保留 tombstone。

## F1：只公开可拥有的 session facade

1. `@cove/terminal-worker/execution` 仅提供 `createRunSession`、必要 public types，以及返回的 `RunSession` **interface**：`barrier()`、`snapshot()`、`dispose(): Promise<RunSessionDisposalReceipt>`。不再导出可构造 runtime class；返回对象不能经 prototype/constructor 再获得内部类。
2. 构造/model、one-time native attachment、`onData/onExit/onFault` 放 module-private instance/closure，facade 不带 native ingress、attach、native/model getters；调用者不能把第二 PTY 填进去或伪造事实。每组 observer closure 永久绑定一个 spawn generation；不复用 session 给另一个 run/PTY。
3. factory.spawn 期间 early data/fault/exit 仍按现有 bounded queue 和 lifecycle 处理。fault 先到则记录 stop requested，成功返回 owner 后立即接入其完成观察并停止，不丢失该 owner；不能在尚未知道 spawn 结果前用“无 native”提前完成 clean disposal。失败/throw路径释放模型与已有 pending copies，原样保留 N2 的 confirmed-clean/pending/uncertain/unclassified result，不自造干净 rollback。
4. facade 可冻结，public方法用绑定 closure；仅 TS private 不够。注入 factory 是受信任 port，不是安全沙箱；独立测试可持有自己提供的 fake observer，但真实 package consumer 不能从 session 获取它。

## F2：一个 stable receipt，分开有限观察与真实生命周期

公共 receipt 的确切类型名可微调，语义必须包含：

- `stop`: 已观察的完整 `NativeStopResult`（保留 cleanup/signalFailure），或本地 `pending-at-deadline` / `failed-to-observe`；不能把后两者伪造成 N2 `unverifiable` 返回。
- `leader`: `exit-observed` + 实际 NativeExit，或 `not-observed`；onExit 和 N2 exited result 都可提供真实 exit，普通 timeout/ps/connection错误不行。
- `writer`: `closed` / `close-uncertain`（保留有限错误类别）/ `invalid` / `pending-at-deadline`。fulfilled 不是 closed；rejection/畸形值不能转成 closed，不制造新的 N2 completion。
- `ownershipEvidence`: `closure-proven` 只在已观察 leader exit + writer closed；`retained-uncertain` 对已知 writer close-uncertain/invalid；其余 `unresolved`。这是本 session 的事实证据，不直接修改/代替 N2 reservation，也不承诺 helper 全消失。无须另造 scheduler/accounting manager。

时序：

1. 第一次 `dispose()` **非 async wrapper**，在任何 native/model/observer 可重入操作前发布同一个 deferred Promise 并设置 disposed/publication fence；所有后续/同步重入调用返回 `===` 同一 Promise，不返回 undefined 或新包装 Promise。
2. 立即停止新 data/automatic writes/fact publication、取消可取消的 scheduled drain、dispose T2、释放未开始队列；queued/in-flight barrier 通过现有 T2 disposed settlement 有限完成，不能等待 consumer Promise。retire/stop 所需步骤独立尝试，某一步同步异常不跳过其他完成观察；stop最多调用一次（fault path也复用同一 owned stop helper/已取得 receipt）。
3. private attachment 时即挂一个 writerCompletion observer和本 generation lifecycle observation；dispose只启动/复用 stop并读取这些事实，不重复挂观察。这里的 late exit/native fault/writer result **必须仍可更新 owned lifecycle state**，但不得发布新的 RunEvent/onFact、重启模型、写入或恢复读流。避免用一个 disposed guard 同时丢弃数据和完成事实。
4. 有界观察默认复用 N2 的 **3000ms 单一 elapsed deadline**，从第一次dispose开始，stop和writer并行观察；不是再串行等待额外3秒。二者已有终态时可提前 settle，否则截止时冻结现有事实并 resolve typed receipt。挂timer之前先缓存receipt、使用monotonic clock；同步已知终态可不用timer。N2 stop自己的timer/result不被取消或改写。同刻边界按实际已观察事件快照，稍后到达只能记为late fact，不追改receipt。
5. receipt一旦settle，其对象及各嵌套已返回值保持不可变，timer/resolve closure释放；不能把可变内部 snapshot 引用交出去。snapshot每次返回新的只读事实值，保留 disposed、exited、writer state、consumer/diagnostic fence及有限stop observation状态。迟到的真实exit或writer closed可单调完善 snapshot，即使 receipt曾 pending；receipt仍记录当时未证，不重新resolve/emit用户callback。明确“receipt是截止时结果，snapshot是截至调用时的事实”，不能把 snapshot称永不改变的最终回执。
6. 观察结束不是杀死原生任务或释放 owner。未知leader / pending writer继续由 N2 bounded owners cap限制；已确认writer不确定继续charged；单纯helper unknown在exit+closed时不妨碍closure-proven。不得调用raw PID/private字段/人工decrement。N2随后真实释放可在独立factory snapshot验收，但session不根据aggregate owners猜某一个owner已释放。
7. pending underlying Promise不可能由本层取消；只保留一个最小lifecycle cell/完成handler，不捕获模型、payload队列或外部listeners。已清理字节/observer引用及时释放。不是进程终止的硬实时保证：JS event loop被用户同步代码阻塞时timer无法抢占；deadline是现有异步执行约定，不能宣称原生write已完成。

## F3：operationally synchronous observer 边界

- 保留1793的sync throw surface：fence parsed consumer once，snapshot可见、有限consumer diagnostic；authoritative parse/query继续，不把consumer failure变成native/model fault。
- 调用onFact后捕获返回值，不await。检查返回对象/function的then属性须防accessor throw；thenable（resolved/rejected/永久pending均包括）立即作为“同步callback合同违例”fence，不等Promise结果再决定。声明允许作者返回void并不能替代此运行时检查。
- 用一个局部安全assimilation/rejection-consumption路径处理返回的Promise/thenable，及时安装 rejection handler；then getter/invocation throw同样捕获。handler不得再调用用户代码来报告自己、不得产生无人处理的新rejection；不保持session/payload引用。无需发明支持任意恶意thenable的通用执行引擎。
- diagnostic onFault同样捕获return/throw/thenable。它失败后设置独立 `diagnosticFenced`（或等价只读字段），不再调用该observer、不递归onFault；native/model/consumer事实仍在snapshot可见。pending/rejected diagnostic不能拖住pump/dispose或制造unhandledRejection。
- callbacks结束后重新读取disposed/faulted/generation；consumer已自行dispose时，不再为了报告其thenable/throw而调用另一个post-disposal用户callback，只记录snapshot。一个consumer与一个diagnostic最多各产生一次fence，不建无限错误数组。

## F4：reentry之后不得恢复native读流

在parse finally的low-water resume分支重新检查 exact native generation仍绑定、非disposed、非faulted、尚未exit，以及实际paused。同步onFact/onFault里dispose后此条件失败；清理可以记录“不再主动管理暂停/已retired”或保留原paused观测，但不能为美化snapshot调用resume。pause/resume调用后也检查其同步fault/disposal重入，不覆盖由内层改变的state；仍保留既有pause-fault防递归。

## 有限负例和独立接受

| 场景                    | 必须证明                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| public boundary         | compiled package无constructible class/attach/native ingress；facade及prototype不能暴露内部constructor；无法替换adapter；自己的fake factory仍能驱动early callbacks        |
| disposal reentry/重复   | retire/stop/model相关同步路径重入dispose返回同一Promise；one stop call；排队与正在settle的barrier失败完成；后续data不解析/发布                                           |
| 两种正常完成顺序        | writer closed先/actual exit先均直到两者事实成立才closure-proven；真实factory owner最终0；helper报告unknown不妨碍此结论                                                   |
| 有限未知                | stop-unverifiable+closed不谎称exit；exited+writer永不settle在3s窗口返回pending writer/unresolved；stop throw/reject或未settle仍独立观察writer/exit、typed失败不unhandled |
| 不确定writer            | exit+close-uncertain/invalid/rejected完成不能clean；snapshot保留不确定，fake/真实适用N2账目仍charged；不把错误signalFailure抹掉                                          |
| late facts              | dispose后但receipt前exit被记录；receipt后exit/writerclosed仅完善snapshot，receipt深值及Promise身份不变，不post-disposal fact/diagnostic，不重放/重启                     |
| observer边界            | sync throw、resolved/rejected/pending Promise、then getter/call throw均立即fence；后续query仍回复一次且parse继续；diagnostic同类返回无递归/无unhandled且snapshot可见     |
| paused callback dispose | 高水位pause后低水位onFact同步dispose；resume计数始终0，stop一次，字节队列/barrier释放，晚callback不恢复；保留原normal low-water resume正例                               |

以deferred fake-native completion和受控时钟/计时边界驱动负例，不让每个case真实睡3秒。允许局部非public测试 seam/现有timer控制；不增加生产scheduler配置框架。真实compiled PTY只补/改现有 run-session-real oracle读取新receipt并核对actual exit + writer closed + N2 owner释放；保留有/无observer的独立query receipt、原始字节、exit顺序和两run进度证据。fake native必须提供完整公共writerCompletion/stop/snapshot契约，不再用缺成员对象来绕过F2。

独立tester只使用compiled公共入口与自己的factory/observer，不import内部类。明确反事实：公开重attach、dispose返回新Promise、writer pending当clean、故意忽略thenable或resume-after-dispose任一错误应被测试拒绝。先定向构建/fake/real，再由root安排独立delta review/测试和一个最终完整gate；P3作者当前exclusive heavy运行结束前不抢跑。新source不继承26b/1793完整接受；保留旧通过/失败和准确限制。

## 文件、原子步骤与边界

作者沿用 `/root/m0_t1_impl` 的 W1a checkout/branch ownership：`packages/terminal-worker/src/run-session.ts`（如确需可拆一个局部session-lifecycle文件）、`tests/run-session.test.mjs`、`tests/run-session-real.test.mjs`、现有W1a plan/results。sole registrar才可调整 `package.json` execution公开入口/声明导出、CI新增实际case floors与tooling对应断言，和P3共享文件写入串行。

1. 先在owned task plan登记此修订；原26b/1793版本和证据不改写。F1+F2 facade/lifecycle与它们的完整fake/compiled consumer适配组成一个buildable原子修正；F3+F4 callback/reentry及对应负例可第二原子提交，若共享修改不能自洽则合并，不能让中间commit测试伪通过。
2. N2 native-pty/pty-input、T2、protocol、native patch/installer、lock及pins保持只读；当前 `./execution` export若已能直接导出facade无需改manifest。不拓展commands/control/input/pipe/recovery、helper清理或keeper。只有真实公共依赖反例才回报root，不私用内部状态。
3. root冻结新source/tree，交独立source/finite native验证；registration与完整check、双OS exact-head及final-main仍需按现有门禁。首切片最终接受前不释放后续W1a scope。

没有新增产品取舍：3000ms是本地观察窗口，不增加N2 stop预算、不降低writer/exit事实要求。Orca比较沿用已批准W1/pump及owned-stop计划的固定revision/path证据；这里是Cove新public session的边界修复，无对应未决选择需要再次审计Orca。

## Actual implementation allocation

Root allocated `/root/m0_t1_impl` (GPT-6 Sol high) on 2026-09-27 in the clean `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-view` checkout, branch `p/luchengxuan/m0-16-worker-execution-core`, starting at `1793ce7b3252a7be6b3796577e4ae90c155f1231` (tree `55d510b97e5499827b89ac9b378ffc71777ad459`). This copy is byte-identical to the approved Astra plan above through its final sentence; the independent plan review SHA-256 is `2c0c8e10ca6b67ea7907f79caa43c0a7c51d44e57bf829ed408709908d3b7477`. The original 26b full-gate and 1793 finite-native results remain historical, not acceptance of this correction.

Writable scope is this task document, `packages/terminal-worker/src/run-session.ts`, its existing fake and real session tests, and only directly necessary `@cove/terminal-worker/execution` registration/tooling case floors. Accepted N2/T2/protocol/native source, patch, pins and lock are read-only. P3a owns the other checkout and its registration is frozen independently. Implement F1–F4 with one truthful bounded disposal receipt and private ingress, test the public compiled boundary and negative paths, run affected static/fake tests first, then request the exclusive native/full lane. Root assigns independent review and testing; no worker controls, pipe or M1 work is included.
