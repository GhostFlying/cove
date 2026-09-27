# P3a PR51 macOS browser-close：一次有界诊断分配

状态：Astra HIGH 仅规划；2026-09-27。本计划不执行浏览器、测试、CI、仓库或 ref 修改。工程观测补充，不改变产品决定。P3a/P3b 继续受 final-main 门禁约束；W1 commands 独立进行。

## 1. 冻结事实与证据边界

- 失败候选 `c47b11dffe5690e359e04d873428e5d107182bf0`，tree `37a2d71226249c1f4dcc500fb8c8208916cac46c`；组合 base `03b73ddecd34495718490a09f9c37a134390223a`。run `36320038531` attempt 1 的 synthetic merge `af662375aa7ed2d5bb53517d6fabc6f268d7888c` 与候选同 tree。保留原提交、失败与 artifacts，不重写/重跑该 job。
- 独立诊断 `/tmp/cove-m0-p3a-macos-failure-triage/report.md` SHA256 `faf32d43f2721d3d6f85cb1194087c645f06d47bd7c1eb4bfd7cf12812b2be6b`；独立 hosted 核验 `/tmp/cove-m0-p3a-hosted-verify/report.md` SHA256 `0ae9ed15e2a9d95f60e72f293f7c55b717e39ae2aa0a0c5f6f76209f83b70600`。
- macOS 463/464、45/46 文件；Ubuntu 通过。唯一失败 V1-L4：primary callback 完成，fixture dispose 6ms、page.close 39ms；后面的 focus/input assertions 因 cleanup throw 未执行，不能称完整功能已通过。
- graceful budget 2000ms，记录 outcome timed-out、elapsed 2162ms；kill 89ms，owned PID 6733 exit SIGKILL，listener closed，总 cleanup 2207ms < 7000ms。25 份记录均 final。`5918-8.json` SHA256 `0879a83abeef0f91ddb8dfc40b5bfe09a4c278e5d0b11f64659d9ad6bdb7cf69`。
- **2162ms 不是纯 close Promise 持续时间**：c47 `managed-browser.ts:513–567` 的 graceful.elapsed 在 catch/kill 后采样，包含 fallback。已有 lateOutcome 也不足以解释底层等待。尚不能区分客户端连接关闭、服务端关闭事件、进程退出与 Promise 结算的先后，更不能证明私有 close RPC 已确认/卡住。
- 先前 N2 V1-R2 navigation timeout 是不同阶段，原因仍未知；不推断共同负载原因。相关 harness 未变不构成免责证据。

## 2. 唯一实现目标与不变项

只增加被动、有限的公开事件时间线，随后执行一次不注入故障的 hosted macOS V1-L4；不先改变 close 顺序或改用 browser.close/context 模型。沿用 `docs/tasks/m0-browser-graceful-close-plan.md` 的 G0 合约与现有 cleanup 记录。

query page/graceful/kill/final deadline 3500/4500/6000/7000ms，graceful 2000ms、kill 1500ms、listener 750ms、evidence 250ms 上限全部保留；B0 默认、work/test 超时、错误聚合顺序、一次 close/一次 fallback、超时即失败全部保留。不能以最终 exit/listener closed、迟到 close fulfilled 或单例通过覆盖原失败。

已只读核对固定 Playwright 1.63.0 的公开 types：`playwright-core/types/types.d.ts:11047–11190` 提供 Browser disconnected / isConnected；`:20385–20429` 提供 BrowserServer close event、close()/kill() 与 process():ChildProcess。close() 合约包含进程终止等待；这两个公开事件均不暴露私有协议 ACK。实现时在作者自己安装的同版本中核对声明，禁止私有字段/协议 monkeypatch/升级依赖。

## 3. 文件、角色与原子交接

- interactive native Sol HIGH 作者：隔离、已释放且由根指定的 checkout，从精确 c47 创建诊断分支；先登记本计划/可写范围。拥有 `packages/terminal-web/probes/node/managed-browser.ts`、`packages/terminal-web/tests/view-browser-runner.mjs`、受控时间线测试（现有合适 probe test 或专名 `packages/terminal-web/probes/managed-browser-timeline.test.mjs`）。不改 V1-L4 的工作负载/断言；不写 P3a client、renderer、worker、protocol。
- sole Sol registrar：`.github/workflows/check.yml`、必要的 `scripts/ci-test-gate.mjs` 与 `tests/tooling/ci-test-gate.test.mjs`、已有 tooling workflow 注册断言、任务计划/results/handoff。manifest/lock/pins 不变；如测试注册需要变更仍仅 registrar。作者先交字段/测试清单，registrar与作者不得重叠写同一文件。
- 独立 bounded TraeX GPT-5.6 Sol XHIGH 审查；独立 native Sol 执行唯一 hosted 诊断与读取 artifacts。根只调度；不新增嵌套 agent。诊断提交必须可独立 build，合成注册提交后冻结最终 SHA/tree，再审查和运行；不能拿未注册半成品当证据。

## 4. 最小时间线契约

1. 每次 managed invocation 使用同一 `performance.now()` 原点，固定字段记录 first-observed 时间与 outcome：cleanup 开始、真实 browserServer.close 调用前/同步 throw/Promise fulfilled 或 rejected、wrapper timeout 被观察、真实 kill 调用前/settle、Browser disconnected、BrowserServer close、已有 owned ChildProcess exit、final snapshot。未知用 null，未调用与未结算分开。附连接状态在 close 调用前与 final 的公开 isConnected 采样。
2. BrowserServer/ChildProcess handle 可用即注册各自 listener；connect 成功即注册 Browser listener，均早于 test work。失败/正常/超时路径最终拆除 listener；订阅前已发生且无公开证明的事件不能补造时间。保持原 ChildProcess exit 事实，不拿 PID 扫描替代。
3. 真实调用 Promise 与现有注入 wrapper 分别标识。公开同步 throw 与异步 rejection 都被保留，立即安装非抛错 rejection handler；不得用 instrumentation 派生出无人处理的 rejected Promise。`COVE_QUERY_TEST_BROWSER_CLOSE_HANG` 跳过真实 close，不能记录一次真实调用；delay 注入也不能冒充底层 close 延迟。
4. 记录器仅同步写固定大小内存字段，不 await、不采样 DOM/network 内容、不记录 WebSocket endpoint/token，不增加持续计时器/外部日志服务。重复事件只增加有限饱和计数；数据上限固定。继续在既有 250ms 尾部写同一 evidence 文件；final 后冻结字段，迟到事件/Promise 不修改已发证据、不改变 timeout verdict。
5. 保留现有 schema/mandatory fields；新增命名的有限 timeline 对象并由 registrar 严格验证其类型、范围、invocation/source 绑定及 final 不变性。不得要求特定 disconnected/server-close/exit 次序，也不得从事件缺失直接判断 hang 原因。既有 graceful.elapsed 语义不暗改；新增 raw-call 时间明确消除其含 kill 的歧义。

## 5. 一个 hosted 诊断入口，不是旧 CI 重试

c47 的 `check.yml` 只有全量双 OS workflow_dispatch；直接再 dispatch 原 workflow 不符合本计划。registrar 在**既有 workflow**增加显式 manual-only `diagnostic=browser-close-v1-l4` 选择及 expected source SHA 校验；空/default、push、pull_request 继续执行原全量双 OS check。诊断使用单独命名的 macOS job/并发组/产物，不提供可替代 required check 的成功结论，不取消在途 PR gate。

- 在 c47 加观测与诊断入口后的冻结诊断分支执行，先只读核对 workflow ref、expected SHA、diff allowlist。checkout 后校验实际 HEAD 与期望完全相同、clean，记录原 c47/tree、诊断 SHA/tree、OS/arch、固定 Node/pnpm/Playwright/browser 版本及 run/attempt。若入口不可用或身份不符，停止，不改成普通重试。
- 复用已有 frozen install/native preparation/browser install/build；只运行 `view-lifecycle.test.mjs` 中名字含完整 `V1-L4 publishes focus before input but not for selection scrolling appearance or show` 的一例。无 repeat/retry、无故障注入、无本地先跑一轮。保持 terminal-web worker/timeout 配置；JSON 必须证明正好这一例执行且其所有返回后 assertions 完成。
- 诊断 JSON 与完整 `.cache/ci/browser-cleanup` 放独立诊断产物命名空间，always 上传并记录 SHA；环境与 timeline/cleanup schema 仍严格校验。单例不能调用/伪造全量 22 身份、25 records 的通过判据；报告明确未运行的完整 inventory 不满足 PR gate。执行失败也必须保留同样产物。
- 一次任务只允许一次该 instrumented browser workload。若安装、调度或 artifact 失败，没有有效结论；停止交根，不自动第二次运行。后续普通新候选全量 acceptance 是另一个明示阶段，不把它藏作诊断循环。

## 6. 运行前有界反例与独立审查

受控测试不启动浏览器，可用已有局部 seam/fake emitter/Promise：①exit/disconnect 早于 close settle；②close pending，timeout 后 kill/exit，再迟到 close settle；③同步 throw 与异步 rejection；④事件未观察/重复事件；⑤final 前后 settle；⑥connect/primary 失败仍释放 listeners。断言事件不冒充 ACK、timeout 不洗白、raw/wrapper 分离、原错误不丢、记录有界、无 unhandled rejection、无 final 后修改。测试事件次序来自受控输入，不对真实浏览器强加理想次序。

registrar 负例覆盖错误 SHA、非 manual 调用不能走诊断、诊断不能满足普通 inventory、缺 final/非法时间线被拒；原 ordinary workflow 选择保持全量。独立源审查先确认没有额外 close/kill/await/延长预算、schema 不削弱、case 不变，再授权这唯一真实运行。已有真实 L6–L10/G0 negatives 留给后续完整新候选验证复用，不额外分配一串真实诊断运行。

## 7. 停止规则、结果分支与接受边

- 复现且证据明确具体实现缺口：记录最小 counterexample，再分配只修该缺口的有界计划/实现，保留预算和错误语义；独立审查/验证新源后才进入普通新候选 CI。公开时间线只定位等待阶段时，结论仍是未定根因，不猜修复。
- 未复现：只称“这次观测候选的 V1-L4 通过，原 graceful timeout 未复现/未修因”；保留 c47 红灯。经独立审查、受控负例、源注册核验后，可将观测补充作为新候选，走一次正常全量 macOS+Ubuntu 严格 PR CI；不能凭单例放行。完整 gate 任一同类或新失败即停止交根，读新 evidence，不自动 rerun。
- 新候选正常 gate 需完整测试与 cleanup inventory、所有 budget/error negatives、独立 source/runtime 结果和 hosted artifacts 均通过；若 base/source 变化，registrar更新映射并核验组合。随后 serial merge 和 final-main CI 仍必须通过才接受 P3a/释放 P3b。诊断成功不等于 PR51 已合格。
- 若证据最终要求增加 deadline、改变 graceful failure 判据或放弃原 cleanup 合约，交根向用户提出具体测量与取舍。本计划未选择任何这类变更；目前观测与受控验证是既定范围内工程工作，无需新产品决定。

DAG：本计划独立审查 → 观测/诊断入口原子候选 → 受控测试与独立源码审查 → **一次 macOS V1-L4** → 证据分支（具体修复或仅观测候选）→ 独立完整验证/审查 → 新 tip 普通双 OS gate → serial integration/final-main → P3b。W1 commands 不新增依赖。

Orca：沿用已冻结 G0 文档对 `5534462b50c660888487a2108700d4cf284270db` 的比较；`tests/e2e/helpers/browser-link-server.ts` 只对应 listener close，无同等 launchServer/graceful/kill/deadline runner。此次没有需要重选的 Orca 设计，不再扩大检查；本计划依据 Cove 实证和固定 Playwright 公开能力。

## 8. 实际执行分配（编码前）

- 2026-09-27：本文件逐字复制自已批准计划 `/tmp/cove-m0-p3a-browser-close-diagnostic-plan.md`（SHA-256 `a25749c20188b47ebc1d317958c60cb39f7f8797d253c5441cf5b5a61b2e2d65`），本节记录实际分配；独立计划审查 `/tmp/cove-m0-p3a-browser-diagnostic-plan-review/report.md`（SHA-256 `361f5f3430dbd5ba677b2b723e33bcc430d6f706af4c51958cb139fb2e56b992`）结论为有界实现通过，并非源码或运行验收。
- 作者及唯一注册写入者：`/root/m0_t1_impl`，interactive GPT-6 Sol high。复用已确认干净、无在用进程的 `/Users/luchengxuan/WORKSPACE/cove`；分支 `p/luchengxuan/m0-browser-close-diagnostic` 从原 P3a 候选 `c47b11dffe5690e359e04d873428e5d107182bf0`（tree `37a2d71226249c1f4dcc500fb8c8208916cac46c`）创建。原 P3a PR #51、旧 N2 分支及其他 refs 保留，不重写。
- 可写范围：本任务文档及同任务结果文档、`packages/terminal-web/probes/node/managed-browser.ts`、`packages/terminal-web/tests/view-browser-runner.mjs`、一份明确命名的受控无浏览器 timeline 测试、`.github/workflows/check.yml`、必要的 `scripts/ci-test-gate.mjs` 与 `tests/tooling/ci-test-gate.test.mjs` 及现有 workflow 注册断言。更改以本计划的被动公开事件、严格诊断证据与 manual-only 单例入口为限。
- 依赖与验证：保持 Playwright 1.63.0、Node 26.10.0、pnpm 12.6.0、G0 七秒聚合及所有阶段上限；先校验本地安装的公开 types，再做受控无浏览器反例、workflow/注册负例、范围内格式/类型/测试检查。冻结独立可构建提交及精确 SHA/tree 后交独立源码审查；只有根明确调度，才执行一次 hosted macOS V1-L4 诊断。当前不运行真实浏览器、常规全量 gate、旧 job 重试、CI dispatch 或 PR 推送。
- 排除：不改 P3a client、renderer、worker、protocol、native patch、manifest/lock/pins，不改 V1-L4 工作负载/断言、既有超时和错误结论，不触发 M1 或 P3b。
