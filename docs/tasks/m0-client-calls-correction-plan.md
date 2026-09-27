# P3a：RPC dispatch、cancel 与写结果不确定性修正

2026-09-27；Astra HIGH bounded PLAN ONLY。root另行派发一次有限作者修正；本轮仅读immutable objects/正式证据及写本文，不实现/测试/启动worker/更改仓库。原批准计划 `/tmp/cove-m0-p3a-controller-slice-plan-v2.md` SHA-256 `8370138082768ba9ab7c989d0114c7a290902a0ecdacdbe012ddac7bbd028202` 保持原样。

## 依据与范围

- production review head `ee3cec639bf42d6bacbdbebcbe17c840b30764a3` / tree `a40046fc0b48d0ab472673ac2ae3614b04e5bf0e`；accepted base `a4e50cb27b26db91a64c9711c5531e68f47c8c6c`。
- 当前候选 `89b41e5b46a0827f06fa429e46f154a62db33c6c` / tree `a8ff916a6156a3e20abf6de53b9b592dc92ed843`。本轮 `git diff ee3..89b` 仅见 task plan 和 connection-rpc.test 的显式test命名变化，四个production client文件未变；不将原source findings当成已修。
- 正式 source review `/tmp/cove-m0-p3a-source-review/report.md` whole-file SHA-256 `36a162b717c1c80beece3f0cd5fc4ae24e0c9a64bafc14f10392321dafdc6e9a`（与报告内部canonical-SELF digest不同）；三项P1均需修。
- 独立 finite `/tmp/cove-m0-p3a-native-verify/finite-89b41-report.md` SHA-256 `960046b865f848f07addcea479c3e8b685b159771c765ea7e29f651a9573b959` 的11+1 family通过保留，但没有覆盖下面的post/cancel重入及internal-error语义，不能覆盖本次修正或声称整体接受。
- bootstrap一致性、身份绑定、预算、ES-only exports和registration不重做设计。无订阅/恢复/input、HTTP真实adapter、serverreceipt、新protocol/newledger或通用transport框架。

## 三个最小反例

1. `client.ts:812–870,887–970`：create/stop进入http.post后，端口同步dispose/reconnect或触发timer，尚未返回handle。旧逻辑用handle缺失当not-sent；即使已收到handed-off，timer也可能错误not-sent。实际请求可能执行，必须保留原operation reference并报unknown。
2. `client.ts:817–851,958–966`：cancel同步调用onFailure；guard在cancel返回后才设置，uncertainOrLocal无settled保护，递归进入cancel直至栈耗尽。成功response后的cleanup和timeout/dispose均可触发。
3. `rpc-calls.ts:121–136` / `client.ts:901–947`：正确headers/id的HTTP200标准-32603，或domain `acceptance:unknown/accepted`但kind不为RESULT_UNKNOWN，被当普通rpc-error。相关错误只证明收到响应，没有证明写未接受或取得绑定operation结果。

## A. RPC-local最小状态修正

只在现有dispatchRpc闭包内加必要状态，不引入全局调度器。

- 显式单调dispatch phase：`before-post` → `post-entered`。通过最后一次settled/current-generation检查后，**紧挨着调用post之前**置post-entered；不能等handle返回。任何credential/timer/observer同步重入已结束该RPC则不再调用post。
- disposition独立于phase：undefined不是not-sent证明；进入post后缺handle/无callback、post抛错、未知cancel都只能保守unknown。仅before-post失败，或合法明确not-sent且尚无handed-off/unknown等相矛盾证据，允许operation-not-sent。handed-off/unknown不能被后续not-sent降级；所有response先记录handed-off。不要在不同timeout/fence入口手工传一个覆盖事实的definitelyNotSent布尔值。
- post/handle完成是独立时点：post内同步完成/失效时，public outcome可有限settle，但返回后获得的handle仍须一次清理。不能等待post永不返回的同步代码；不声称JS代码可抢占任意阻塞adapter。
- 一个RPC一个终态owner：最小 `active → settling → settled` 或等价guard。外部调用（timer dispose/cancel/state observer）之前先claim settling，阻止reentrant callback再次发起终态或替换已选择的valid response。清理期间允许记录更强的transport disposition供**当前未知分类**使用，不能递归settle；成功/已验证remote response的cleanup故障也不能把既有valid response覆写。
- RPC-local `cancelOnce` 管理 cancellationRequested、handle availability、cancelStarted/used。先把guard置位再调用handle.cancel；handle尚无时记录待清理，不能谎称已取消；handle后来返回同一入口只调用一次。catch throw/invalid result为unknown；onFailure/onDisposition同步重入可以提供更强证据但不能再次cancel。同一handle不因finish/timeout/late-return三条路径重复使用。
- 公共Promise exactly-once，pending map/activeOperationIntents/timer exactly-once释放；清理的外部异常不得跳过后续本地释放/resolve。late callbacks在settled后不改snapshot/outcome、不emit新状态；迟到handle清理仍执行一次，其callback同样fenced。
- timeout、onFailure、dispose/reconnect与同步post异常统一使用上述phase和settlement机制。before-post credential失败保持not-sent，读调用仍local-error；没有自动retry、替换operationId或永久保存operation ledger。

## B. 已验证response的有限结果分类

前提仍是response status/identity/byte/JSON/schema/request-ID与当前generation全通过。错误绑定/畸形响应不进入下面白名单，写按可能handoff unknown。返回有效operation result的现有success/accepted/running/failed状态数据不改。

| 已验证响应                                                  | create/stop的现有public outcome                                                             | 依据/边界                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain acceptance=not-accepted                              | rpc-error，保留该validated domain error                                                     | 明确服务端拒绝；它**不是transport未发送**，不能改成operation-not-sent，也不能声称同operationId以前从未执行                                                                                                                                               |
| domain acceptance=unknown或accepted，无绑定operation result | operation-unknown + 原immutable OperationReference + RESULT_UNKNOWN/unknown/query-operation | 不再要求原kind恰好是RESULT_UNKNOWN；不能从错误code/name推断执行未发生                                                                                                                                                                                    |
| 标准 -32603 Internal error                                  | 同上unknown                                                                                 | 没有acceptance/operation record，不证明副作用未发生                                                                                                                                                                                                      |
| 标准 -32700/-32600/-32601/-32602                            | 仅完整绑定且符合既有pre-dispatch语义时rpc-error                                             | accepted `protocol/src/rpc.ts:76–153` 的classifier在产生call前拒绝parse/request/method/params；不扩大到internal或任意code。原parse/invalid-request通常id:null，不匹配本客户端字符串requestId时仍须按invalid-response/unknown处理，**不能为此放宽ID校验** |
| read方法的合法JSON-RPC错误                                  | 维持rpc-error                                                                               | 无create/stop写operation，不凭空创建receipt/unknown-operation                                                                                                                                                                                            |

实现可在rpc-calls.ts加窄的validated-error分类helper或在现有分支内完成；不要给无结构的错误文案猜语义。新unknown使用现有domainError函数/OperationReference，不加wire字段/public结果kind。保留绑定的operation method/id/instance和显式operation.get路径；未要求保存所有原始error/cause或敏感文本。

## C. 有限验收与counterfactual

所有新增case用现有scripted HTTP端口、controlled scheduler和compiled public @cove/client；不启动真实网络/浏览器/PTY。测试名显式声明，沿用89b已修的静态discovery形式，不能回退到gate无法发现的动态test声明。

1. 对create和stop覆盖post中同步dispose、reconnect、timer：无disposition和已有handed-off两类；handle返回前不可得到not-sent，每次一个unknown、原operation ref、一post、迟到handle一cancel、pending清零。重连后旧callbacks不污染新context。
2. 正例保留：credential失败/timeout发生在post前为not-sent且零post；明确not-sent且无矛盾可返回not-sent。负例：handed-off/unknown后cancel返回not-sent不能降级；post抛错无明确拒绝为unknown。
3. cancel同步onFailure，分别从valid成功response cleanup、timeout、dispose触发；callback可进一步dispose/reconnect但不递归cancel。断言cancel=1、outcome一次、pending/active intent/timer清零；成功响应仍success，未知路径保留正确operation ref。补cancel throw与late-handle callback控制，不借try/catch吞掉栈溢出来当通过。
4. valid HTTP200/绑定id：-32603、非RESULT_UNKNOWN domain unknown、domain accepted均operation-unknown；domain not-accepted保留rpc-error；合法匹配ID的method/params predispatch error保留rpc-error；id:null parse/invalid-request不变成已绑定拒绝。读方法-32603仍rpc-error。所有写均没有自动重发/自动getOperation，用户显式query仅一次新请求。
5. 保留现有six-method相关性、bootstrap/dual-agreement、caps/copy、immutable intent、ES declarations/public export以及disposed late response正负例；scoped回归即可覆盖未改源，不能删旧case为新计数腾位置。
6. 独立tester需证明至少三种反事实会红：用handle缺失代替postEntered、cancel guard移到调用之后、把internal-error直接rpc-error。可用单次有限mutant或独立violating seam；不需要循环/随机压测。author测试与独立验证分别报告实际源码SHA/条目与限制。

## 文件、分工与原子交付

- 单次bounded local TraeX5.6 Sol XHIGH作者：主要 `packages/client/src/client.ts`、必要的`rpc-calls.ts`；`packages/client/tests/connection-rpc.test.mjs`和确有相关需要的`compiled-client.test.mjs`；owned任务plan/results。`connection-session.ts`无需改bootstrap，`transport-ports.ts`最多补说明callback可重入/handle晚返回，不新增能力或协议。
- 原public options/types可保持；没有新增依赖、lock变化、native接口或跨package source读取。作者在root分配的client checkout工作，不读/写其他owner未提交内容，不兼任独立测试/审查，不嵌套派发。
- 三项关联RPC状态修正与对应测试可作为一个可构建原子commit；不能提交中间暂时依赖未来registration的破碎状态。先package build/scopedclient tests/静态检查，再freeze精确source/tree给独立source delta review和finite compiled tester。
- **sole registrar/native Sol后续独占** gate/inventory/tooling及共享docs集成。若case计数变化，作者交精确显式suite inventory/request，不改root注册/manifest/lock。现有2个suite仍真实注册；case增加但旧floor不降低不阻碍作者原子修正，最终接受前registrar更新真实冻结inventory与对应tests。
- root安排重型运行时隙和最终full check、exact-head双OS CI、集成映射/final-main。旧finite89b通过不能充当新source通过，也不把任何历史full失败改绿。此修正未释放P3b或其他runtime实现。

无需用户新产品决定：这是已批准not-sent/unknown和exactly-once本地资源契约的实现修复。Orca比较复用批准P3计划的固定553 handshake/unknown-outcome证据，本次没有未决方案需扩大源码审计。

## 实际修正派发记录

本计划原文 SHA-256 `3fac9758324e474859f73db463693839514a40969abdfed3548844fb797b1e4f`；独立批准报告 `/tmp/cove-m0-p3a-correction-plan-review/report.md` whole-file SHA-256 `39abb54008b5badfb7577c337ef6db1d15c7dd1b894ba373ebb0dd42efc6f4f5`。原候选 `89b41e5b46a0827f06fa429e46f154a62db33c6c`、tree `a8ff916a6156a3e20abf6de53b9b592dc92ed843`，位于 `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-recovery` 的 `p/luchengxuan/m0-19-client-calls`；此提交只转录已审计划，源码未修正，P3a 尚未验收。

Root 在本提交后接回该 checkout 的分配权，另行指派独立作者只改本计划列出的 `packages/client/src/**`、`packages/client/tests/**` 与局部任务结果。原 P3a 注册与共享清单由指定 sole registrar 串行处理，独立验证和审查不能由作者兼任；W1a 的独立 checkout 不受此交接影响。M0 保持进行中，M1 与 devbox 资格均未放行。
