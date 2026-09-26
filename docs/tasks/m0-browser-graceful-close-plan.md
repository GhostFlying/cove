# M0 query-profile graceful-browser-close：有界观测与修复计划

状态：Astra HIGH 仅规划，2026-09-27。只写本/tmp计划；不实现、测试、审查或修改repo/CI/Orca refs。当前事实不足以指定某个browser行为修复；首个可执行节点是有限观测修复，后续只按其证据修正具体实现缺口。不得重开已接受Issue40 page-close修复，不以green retry替代诊断。

## 精确基线与观察

- 接受main：77de10a2f91fb3eb0fc42c7fc27dd5270ce56704（含PR41/Issue40）。R1 head：49f49164d33cc402cd5b9864f2272440522159f9；本地此前验证56e567d85fade02d1baedc5dc0dcf6229ed8640c到49f仅两份docs变化。读取Git对象，未读取作者未提交实现。
- 只读诊断 /tmp/cove-m0-p3-r1-hosted-failure/report.md 已核验SHA2561a061bb2367f1361ddac85a148748798b658958134087605b2d5ca880ca1c2ce。run36258421531 synthetic138b6e55f09406099c8d2044e75e3844a54aa451的tree与49f相同。macOS282/283，唯一V1-L4失败为 `Browser close timed out`，Ubuntu283/283。V1-L4在withViewPage返回后才进行功能assertions，因此本次mac运行没有完成那些assertions，不称“功能已过、只是清理”。
- 我读取失败vitest-results.json与job log：仅保留managed-browser.ts:80内层计时器错误；下载产物没有cleanup记录。mac JSON SHA d4bb36ce515dff4fd6a73ec1ce90034abb76bc482359abb9b43e041ae642db7f 由独立诊断记录。此前本地通过与此次Ubuntu通过是独立证据，不能覆盖mac失败。
- 77de10a与49f的managed-browser.ts、view-lifecycle.test.mjs及view-browser-runner.mjs无差异。没有证据将其归因于R1协议变化、host load、资源泄漏或Issue40复发。当前仅证明graceful-close await超时；kill是否成功、何时退出、listener是否关闭均未由本次artifact证明。

## 既定契约与当前源码（不是新预算方案）

读取77de10a的 docs/tasks/m0-browser-cleanup-{plan,results}.md、m0-managed-browser-page-close-{plan,results}.md，以及B0/Q1/V1 cleanup要求。`packages/terminal-web/probes/node/managed-browser.ts` 当前query分配如下，均相对cleanup开始t0：

| 阶段                        | 当前限制                                             | 本任务要求                                       |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| page disposal/close         | shared deadline t0+3500ms，沿用Issue40 fair page份额 | 原样保留，不恢复固定500ms query page-close旧缺陷 |
| browserServer.close         | 最多2000ms且受t0+4500ms约束                          | 原样保留，不能借“phase余量”自动扩大2000ms上限    |
| browserServer.kill fallback | 最多1500ms且受t0+6000ms约束                          | 超时/拒绝后尝试owned fallback，保留原始close错误 |
| listener / evidence         | 最多750ms / 250ms，受t0+7000ms约束                   | 原样保留，不能为采证侵占kill或扩大总时限         |

B0/environment默认同样原样保留：500ms页面操作，browser close3000ms、kill2000ms及其既有总deadline行为。业务work预算/测试wrapper/CI超时不变。
当前query graceful可用预算小于2秒并不自动是bug：页面耗时若接近3.5秒，4500ms阶段截止只剩约1秒，这是已接受的保留kill/tail安排。此次无分阶段耗时，不能认定预算被错误消耗，也不能认定2000ms不够。当前唯一已证实的缺口是失败诊断持久化不足。
源码: :441–467为graceful/kill与process状态；:483–515仅在env指定时写evidence；:525–536将摘要放入AggregateError.message。V1 runner未为普通case配置该路径，Vitest此次只保存内层Error，导致已有摘要未进入可读产物。`cleanupRemaining`最少返回1ms，且operation在预算参数求值前调用；需记录真实阶段余量/调用耗时后判断是否存在过期阶段仍发起操作的可复现bug，不能把源码可能性当作此次原因。

## G0：最小可派发观测修复

根先分配独立作者/checkout/base；不得打断当前primary N1作者。建议interactive native Sol6 HIGH完成browser环境工作，另配独立验证和Sol-only审查；自包含审查优先TraeX5.6 Sol XHIGH。无nested agent/devbox retry。
作者scope：managed-browser.ts（仅有限evidence/现有test seam）、tests/view-browser-runner.mjs与view-lifecycle.test.mjs（V1 case关联/负例）、probes/query-input.test.mjs及node/query-input.ts（既有cleanup-only fixture）。不改renderer/protocol/native/依赖/lock。唯一registrar处理必要的scripts/ci-test-gate.mjs与其tooling回归、证据目录交接；不直接分配作者CI写权限。已有always-upload .cache/ci可复用，不新建日志服务/自定义reporter框架。

1. 增加一次调用固定长度的graceful/kill/listener记录：阶段开始相对t0、phase deadline、computed budget、attempt count、settled/timeout/rejected/not-started、elapsed；同时记真实owned ChildProcess pid及exit/signal观察时点，现有page records、listener port/closure、work完成/primary错误类别。区分close promise未结算与native process仍存活；不凭后者反推前者成功。不记录endpoint token、DOM或terminal内容。
2. V1每次withViewPage获得唯一且有界的case/invocation记录路径，保存在本次gate的 `.cache/ci/browser-cleanup/` 内，成功/失败都写；使用调用参数/既有配置传递，不能在并行case间覆盖进程全局env。兼容现有显式COVE_QUERY_CLEANUP_EVIDENCE负例。字段/记录数按当前suite实际调用上限加明确小余量，不无限增长；registrar在每次gate前清理该专属子目录并绑定source/run身份，防读到上次文件。
3. 复用既有250ms evidence尾部，记录落盘失败并使其可见，不能为证据吞掉原错误。挂死/中断缺少final记录必须报告“未完成/清理未证”，不能用缺失=成功。不要只继续扩大AggregateError文本期待Vitest保留。错误对象的primary/cause/cleanup顺序与语义仍不变，diagnostic artifact独立保存。
4. graceful只调用一次；超时promise可迟到settle，记录late outcome直到finite final snapshot，不能erase timeout或在final后修改已发证据。拒绝handler立即安装，kill仍只操作browserServer拥有的进程。不要先改launchServer/connect、主动断client、换context模型或重复close来猜修复。
5. 在作者自己安装的固定Playwright1.63.0中只读检查 BrowserServer.close/kill 的实际路径：其promise等待哪些process/transport/server清理，kill与尚pending close的协调；记录精确文件与hash。此检查用于解释采证结果，不以新的timeout或退出观测替代API完成。无跨任务node_modules依赖或版本升级。

## 有限验证设计（此规划不执行）

G0冻结后执行一次针对V1-L4的精确场景，以及一次完整B0/Q1/V1受影响套件，在固定macOS环境留证；这两个工作负载事先列出，不循环直到失败/通过。未复现则只报告“观测修复通过，原超时原因未复现”，保留原run红灯。完整注册dual-OS candidate CI属于后续正常验证，不是对旧失败job盲rerun。

| 控制/负例                        | 必须观察到的oracle                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ordinary real graceful           | 一次real close，graceful budget不大于2000ms且受4500ms约束，实际exit/listener观察，per-case artifact即使Vitest折叠AggregateError仍存在                                                                         |
| graceful gate永不settle          | 沿用已有COVE_QUERY_TEST_BROWSER_CLOSE_HANG负例：nonzero且保留Browser close timeout，真实owned kill被尝试，进程退出/listener关闭证据。明确该注入跳过real close，只证明fallback，不复现close/kill并发           |
| real close已发出但completion延迟 | 单次real close的完成经有界test-only gate延迟到超时后，随后真实kill；timeout保持失败，late result不双计/改为成功，记录实际process可能已先退出。验证pending close与kill的协调，不制造全局Playwright monkeypatch |
| kill拒绝/超时与primary错         | 局部controlled seam验证错误聚合、剩余listener尝试、最终未证状态；若用真实浏览器，独立外层watchdog/finally只清理本fixture记录的owned资源，不能把outer cleanup算成内层成功。不故意遗留host进程                  |
| 阶段份额/边界                    | 控制page phase接近既有截止，确认close预算由真实剩余时间clip；两端边界验证不超过现有caps。若发现错误deadline起点/错误重复调用/过期调度，用最小受控counterexample固定；单纯“超过2秒后可成功”不是bug oracle      |
| 保留契约                         | B0默认、Issue40 delayed/hung/late/expired page cases、Q1两页、V1-L6 primary+cleanup因果与全部既有真实V1 assertions不削减；超时后kill成功仍是失败                                                              |

时间测试断言预算/顺序/状态和原有外层调度容差，不要求精确毫秒。记录event-loop lateness若使用只应是本fixture单个已有deadline偏差，不能据此直接推断host load。外层PID扫描无匹配不替代ChildProcess exit观察，也不向已失身份的PID发signal。

## G1：采证后的有限分支与决策边界

- **具体实现错误被证明**（如close重复发起、可复现deadline计算错误、先后顺序导致own handle无法退出）：作者记录counterexample及最小源码修正，保持上述caps、错误与B0；独立验证确认原counterexample被修、超时negative仍失败。属于已批准工程修复，不需产品决定。改变候选后重做对应独立验证/审查，不能继承旧源通过结论。
- **仅诊断丢失被证明、真实close未复现**：G0可以作为观测修复候选独立审查/验证，但不能写“graceful timeout已修”。向根报告证据边界与一次候选CI结果；若同类failure复现，用新artifact继续有限定位，不自动再跑相同job。不得修改assertion来忽略真实graceful超时。
- **现有deadline真实被耗尽且实现正确**：这是是否改变已接受清理保证的选择，不是自动判定test oracle错。向用户列具体选项：①保留2000/4500/6000/7000限制，继续定位在该预算内可完成的实现；②有测量后提出精确新的graceful分配（说明削减哪个reserve，或是否扩大总budget/wrapper）；③允许graceful超时但kill/exit成功视为合格（明确从“所有cleanup操作成功”降为“资源最终回收成功”）。②③均改变已接受预算/失败语义，本计划不选择、不实施。没有数据不建议新数值。
- 只有assertion误读已合法且证据完整的结果时才可称oracle缺陷；此次是生产harness自己按deadline抛错，尚无此证据。不能用absence of leak当作graceful success。

最终：冻结source/plan/results → 独立精确源验证 + Sol审查 → 注册全gate/双OS artifacts → serial integration/final-main。R1既有protocol审查结论与本浏览器门禁分开；本计划不授权合入失败PR或改变N1/N2依赖。原失败永久保留。

## Orca参考边界

沿用已接受Issue40计划对固定Orca5534462b50c660888487a2108700d4cf284270db的有限检查记录：tests/config中未找到同样launchServer/kill/cleanupDeadline runner；tests/e2e/helpers/browser-link-server.ts只提供HTTP listener close，不具备Cove这组graceful/kill时间契约。本轮不扩大Orca审计、不改refs，不能用它替代本次Playwright实源与Cove artifact证据。

## 执行分配，2026-09-27

- 所有者：`/root/m0_t1_impl`，interactive GPT-6 Sol high；协调者 `/root` 仅调度独立验证/审查与产品决策。源计划 `/tmp/cove-m0-browser-graceful-close-plan.md` 的 SHA-256 为 `a51a7ebe42dc6c23a2fe1fe8e5d4b9076b0befd0f3bf4a88e2f73b046f613399`，独立 Sol 计划审查 `/tmp/cove-m0-browser-graceful-close-plan-review/report.md` 的全文件 SHA-256 为 `e4279bf5a09d44cf880b41c5cd87e5b7da1940612c332b81c5d757fdb2f71df0`，结论是有界 G0 可实施，非根因或预算改动批准。
- 基线与工作区：`/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-view`，新分支 `p/luchengxuan/m0-43-browser-graceful-close-evidence` 从接受的 main `77de10a2f91fb3eb0fc42c7fc27dd5270ce56704`（tree `c6fd2fbb412bfc29281a2857eac4dae55734ad1f`）创建。旧 V1 分支 `p/luchengxuan/m0-20-terminal-view` 留存于 `b79f271a9949b680680b65d896d25bbb60707e7f`，checkout 干净且未见在用 argv。
- 可写范围：本文件与任务 results；`packages/terminal-web/probes/node/managed-browser.ts`、`packages/terminal-web/tests/view-browser-runner.mjs`、`packages/terminal-web/tests/view-lifecycle.test.mjs`、`packages/terminal-web/probes/query-input.test.mjs`、`packages/terminal-web/probes/node/query-input.ts`；只有注册确有必要时，`scripts/ci-test-gate.mjs` 与对应 `tests/tooling/ci-test-gate.test.mjs`。不编辑 renderer、protocol、native、依赖、锁文件、共享架构/交接文档、N1 或 R1 checkout。
- 先实现单次有界 G0 观测和失败留存：不改变 2 秒 graceful、4.5/6/7 秒 phase、B0 默认或超时判失败语义。验证预列真实 V1-L4、受影响 B0/Q1/V1 套件与有限负例。只有新证据证明范围内实现错误才作最小 G1 修正；预算与判据交协调者请求用户决定。
- 集成边界：G0 独立原子提交、独立源码审查/测试与双 OS CI 后才可作为单独 PR 线性 rebase 合入。已冻结 N1 [PR #42](https://github.com/GhostFlying/cove/pull/42) 与 R1 [PR #43](https://github.com/GhostFlying/cove/pull/43) 不在本分支改写/force-push/merge-commit。G0 接受后由专职集成所有者按实际先后顺序刷新仍开放的 PR 基线，核对原子提交映射和组合 CI；旧 PR43 macOS 失败不能由 G0 本地通过自动视为通过。

## b39 候选有限修正计划，2026-09-27

- 基线：本工作区干净的 `b39b336121012aa9faa2f390b2967b1091ce3f27`；独立源码审查 `/tmp/cove-m0-browser-graceful-close-source-review/report.md` SHA-256 `1bdbb940f1a6fc143ab311b2aef5653ef3da06f2e498c1632526223c9c492542`，独立执行 `/tmp/cove-m0-browser-graceful-close-native-verify/report.md` SHA-256 `af4566f4bb041d574a3fc908b8cb78fc9e1b7cf29444b1cc77d5311e289be1c0`。后者的 5 文件回归为 37/38，L8 的 lateOutcome 时序断言失败；不能称 G0 已通过，也不能据此宣称 PR43 宿主超时根因。
- 作者与范围沿用上节；只修本计划列出的 `managed-browser.ts`、V1 browser runner/lifecycle tests、CI gate 与对应 tooling tests。先把受控 late-result 观察边界分出可直接验证的极小函数，分别固定 final 之前可记录与 final 之后不可变，真实浏览器 L8 保留 close timeout、单次 close、owned kill/exit 验证但不预设二者的完成次序。L10 仅验证 clipped budget 和实际分支一致，不额外要求真实 close 在短余量中成功。
- 证据门禁校验完整、有界的 phase/process schema 与各分支合法组合，拒绝缺字段、负预算、不可能时间和身份错配；把每次调用绑定当前 Vitest test identity，与已验证的通过用例逐个比对，而不是只比较栈行号数量。新增有限阴性回归，保持非 Vitest standalone 调用的已用边界。分关注点原子提交，定向回归后冻结交独立 delta 审查和运行；完整 gate、双 OS 及集成仍是后续必需门禁。
- 不修改 2 秒 graceful、4.5/6/7 秒 phase、B0 默认或 cleanup 错误语义，不增依赖或扩大产品范围。PR42 已合并 main `410e6f397b58440394667a4b1ba2c9f0f3e2a4e0`，其 final-main CI 尚未完成；G0 当前基线仍为已接受的 `77de10a`，后续按实际接受顺序评估并重放，不能暗中把未验收 R1 作为依赖。
