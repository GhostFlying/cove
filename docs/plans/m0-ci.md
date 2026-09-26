# M0 CI 与验收计划

> 2026-09-26 用户决策更新：首发采用 [terminal-architecture.md §3.2.1](../terminal-architecture.md#321-首发恢复精度与验收2026-09-26-用户已确认) 的实用恢复 profile。保存 SGR/charset、retained off-grid/混合物理行完整等价改为保留证据的非阻塞诊断；普通画面/输入/预算内 normal+alternate、解析/顺序/有界性仍必需。暂停引擎安装 API 和逆向 reflow。T1 确定性验证后才释放 P1b；Codex/TraeX/Claude Code 小规模真实工作流在 H1/C3 的真实 PTY+浏览器链路验证，原生 mobile 和 100 个真实 agent 的容量资格仍属后续阶段。本文原有完整等价措辞按此明确更新解释，旧失败不改记为通过。

状态：用户已于 2026-09-26 批准 M0 实施；[Issue #8](https://github.com/GhostFlying/cove/issues/8)，父任务 [#5](https://github.com/GhostFlying/cove/issues/5)。按汇总 DAG 派发，不自动进入 M1。

## 归属与边界

- 规划 owner：M0 CI planner，GPT-6 Astra high；集成与根配置 owner：协调者指定的唯一 CI 写入者。
- 基线：`1e1398462c2aadc5a9171e40aef7c5d9f0ad3da7`；分支：`p/luchengxuan/m0-8-ci-plan`；checkout：`/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-ci-plan`。
- 本次唯一可写文件为本文；不改 workflow、manifest、lockfile、实现或其他计划，不执行远程命令、启动服务、push 或 PR。
- 依据：`AGENTS.md`、`docs/handoff.md`、`engineering-plan.md` §4/6/9、`development.md`、`terminal-architecture.md` §3、`relay-protocol.md` §4/5/9/10、已保存的 benchmark RESULTS。
- M0 交付验证真实 server/worker/CLI、两个最小终端客户端及兼容契约；排除完整产品 UI、Electron/RN/真机、持久配对/部署、tsnet、迁移、发布、100 个真实 agent 和长时容量承诺。
- 用户已批准 M0 本地 loopback 实验 server、临时凭据、实例内易失操作回执及两个浏览器终端测试页；Origin 校验随协议契约落实。正式持久化/配对属 M1/M2；汇总 DAG 已于 2026-09-26 经用户批准。

## 现状与 Orca 比较证据

Cove 基线 `.github/workflows/check.yml` 冻结安装后运行 `pnpm check`，仅包含格式、lint、tsc 和 `tests/tooling/project-references.test.ts:75/95` 的两个工具链测试。它不验证 PTY、应用入口或 Node 原生 ABI。固定 Node `26.10.0`、pnpm `12.6.0`，不得用机器默认版本替代。

2026-09-25 只读查询确认 ruleset `23994191` 为 active、无 bypass，严格必需检查为 `check (ubuntu-latest)` 和 `check (macos-latest)`；main 线性、禁止强推/删除，仅 rebase & merge。平台 approving review 数为 0 不取消独立 agent review；同账号报告不能冒充另一 GitHub 账号 approval。

Orca 实地参考 checkout `/Users/luchengxuan/orca/orca`，clean，`GhostFlying/orca` 分支 `p/luchengxuan/fork-worktree-scan-candidate`，HEAD `322c1839888f4a462e2d68839deafb1fe616c685`，package `1.4.190`。以下行号均指该 SHA；源文件可通过 `https://github.com/GhostFlying/orca/blob/<SHA>/<path>#L<line>` 回查。比较对象是 fork 快照，不将 fork 结果称为上游 CI 结果。

| 源文件与行号                                                                                                                         | 观察及 Cove 处理                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/pr.yml:119-126`；`config/scripts/runtime-serve-terminal-smoke.mjs:1-20,29-36,47-55,166-177`                       | import graph ratchet 加编译产物启动、CLI/PTY 往返比端口存活更强；Cove 同时验证公共 exports。脚本实际默认端口为 6800，且缺 built CLI 会回退 PATH；Cove 要求动态分配端口、缺产物立即失败，禁止回退已安装 CLI。 |
| `config/scripts/ensure-native-runtime.mjs:57-90,124-133`                                                                             | 原生加载失败在新进程复核；可借鉴 ABI 探针。其 Node/Electron 原地 rebuild 路线不用于 Cove 共享安装，server 仅用本 checkout 的 Node ABI 产物。                                                                 |
| `.github/workflows/pr.yml:431-476,478-505`                                                                                           | Node 24/26 分片、原生/跨版本独立 lane；不能凭普通 suite 绿色推断被 exclude 的 PTY 用例通过。Cove 初期无需 32 shards。                                                                                        |
| `tests/e2e/cross-version-wire/release-checkout.ts:63-92,126-129`；`cross-version-terminal-wire.unit.test.ts:46-64,107-113`（同目录） | 旧版本提取、SHA 不同和完整 journey/frame 断言有价值；alias 指向新代码会伪造混合版本。Cove 固定 fixture SHA/依赖/校验和，不动态选 latest tag。                                                                |
| `tests/e2e/cross-version-wire/host-terminal-runtime-stub.ts:7-12`                                                                    | 该 wire 测试使用 fake PTY；证明协议层交互，不证明原生 PTY、完整产物或真实重连。Cove 分开记录契约与进程集成证据。                                                                                             |
| `.github/workflows/pr.yml:762-842`                                                                                                   | `always()` 汇总只接受明确结果，但未依赖 cross-version-wire；注释明确 E2E 未作为阻断项。Cove 必须核对全部必需 lane 清单，不能把“运行了”写成“已阻断合并”。                                                     |
| `tests/playwright.config.ts:19-40`；`.github/workflows/e2e.yml:85-93,187-199`                                                        | 每测试隔离应用状态、CI 单 worker、零自动 retry、失败 trace；构建 artifact 1 天、trace 7 天。Cove 采用小并发和合成数据，浏览器证据不代替真实手机。                                                            |
| `.github/workflows/fork-release-build.yml:23-50,504-558`                                                                             | fork 特有精确 candidate SHA、资产清单与 finalize 依赖闭环值得借鉴；发布、签名、ref promotion 不属于 Cove M0。                                                                                                |

上述普通 PR、E2E、native、smoke、wire 文件与本地上游稳定 tag `v1.4.190^{}`（`6e4f817101daa18d82824b69243d9079baa9c416`）逐文件 diff 无差异，故为该上游 release 继承内容；fork-release workflow 单独标为 fork 维护逻辑。这里只审源码，未运行 Orca 测试或验证其当前线上 run。

### 最新上游补充核对

2026-09-25 另用 `git show` 只读检查 `stablyai/orca` main 的 `646e9a5b02514795af5139961ccca225dfa01b12`；未切换或修改上述 fork checkout。协调者另确认最新正式 release 为 `v1.4.211`，本段证据对象是 main SHA，并非该 release 或其线上 CI 成绩。

| 最新上游路径与行号（均在 `646e9a5…`）                                                                                            | 更新后的判断及 M0 影响                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/pr.yml:1090-1107,1142-1143,1185`                                                                              | **cross-version-wire 已加入 verify 的 needs 与结果检查**；旧 fork 的遗漏不能描述为最新上游缺陷。Cove 继续要求完整 inventory，并用回归测试防止以后漏接依赖。                                                                                              |
| `.github/workflows/pr.yml:1111-1118,1160-1189`                                                                                   | E2E 仍有意不阻断 verify；`check_job` 对 should-run=true 要求 success，否则要求 skipped。该条件检查比泛化接受 skip 更严谨，但正确性依赖路径分类器。M0 规模小，维持全部必需场景每次运行，不复制复杂路径跳过。注释声称 E2E 为红不是本次查验线上运行的结论。 |
| `.github/workflows/pr.yml:585-612`                                                                                               | 先准备 Node 24 native cache，再调用 reusable unit workflow，PR 传入的 Node 列表只有 24；旧 fork 的 24/26 matrix 已变。避免多 shard 同时原生编译可借鉴；Cove 仍必须测试自己固定的 Node 26.10.0 ABI，不能从 Orca 绿色推断兼容。                            |
| `.github/workflows/pr.yml:724-759`；`tests/e2e/cross-version-wire/release-checkout.ts:107-136,169-181,202-216`                   | cross-version lane 扩到多个兼容旅程，参考 checkout 校验 commit/format、必需 wire 文件并锚定旧源码导入；值得借鉴防止 fixture 漂移。仍默认选择最新本地稳定 tag，Cove 使用冻结 reference manifest 与独立构建产物，避免测试对象随标签集合漂移。              |
| `tests/e2e/cross-version-wire/host-terminal-runtime-stub.ts:7-12`；`config/scripts/runtime-serve-terminal-smoke.mjs:32-39,50-58` | wire 层仍用 fake PTY，smoke 仍默认 6800 且 built CLI 缺失可回退 PATH。先前关于真实产物/PTY 证据边界、动态端口和禁止 PATH 回退的建议仍成立。                                                                                                              |

此补充修正比较对象的时效性，不改变 C1-C6：吸收明确依赖与 fixture 完整性检查，不照搬 Orca 的路径过滤、Node 支持矩阵或非阻断 E2E 策略。

## 任务与依赖 DAG

P/T 表示协议/终端计划的语义交付物，协调者在派发前补实际任务 ID、接口 revision 和合入 SHA；不能依赖另一个 checkout 的未提交文件。每行由独立实现、测试、review 角色顺序交接，不要求同时占槽。

| ID / owner                             | 前置依赖                                                                                                           | 可审阅交付与完成条件                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 / CI writer                         | 用户批准 M0；当前根工具链                                                                                          | 早期 CI 接线：保留两项 check 名称，增加非零测试发现、必需 suite 清单与环境/版本证据；用现有两个 tooling 用例证明接线。核验冻结安装和规则快照；不创建空应用 project、不假造 PTY 成功、不等 C2-C6 才交付。                                                                                             |
| C2 / CI writer + native tester         | C1；P 公共包/入口契约；T1 恢复/query 风险探针决定的依赖版本；T 可启动 worker/PTY                                   | 按实际入口分批接入：worker PR 加 native/worker lane，server PR 加 server lane，P4 PR 加 CLI lane；各入口在引入的同一 PR 接入编译产物与 exports 检查，P4 后 C2 才整体完成，macOS/Linux 均真实 spawn/read/write/resize/exit；缺任一入口/原生模块即失败。T1 可用自己的隔离探针先产证据，不依赖最终 C3。 |
| C3 / terminal test owner               | C2；P 经 T1 反馈冻结的 profile/顺序/恢复契约；T 权威模型与客户端 adapter；已完成 P4 两 view harness 及 T4 恢复路径 | 两个真实浏览器 harness 实例共享生产 adapter，运行 A1-A6；另执行 Codex、TraeX、Claude Code 小规模真实工作流并记录版本/身份/同尺寸重连/真实 resize/输入及退出行为。认证失败为外部阻塞，不能用回放替代。反例注入证明断言会失败；功能与确定性测试同步接必需 check，凭据相关 live 证据独立记录。          |
| C4a / protocol fixture owner           | C2；P 首个完整支持 A7 attach/query/input/resize/recovery/exit 的参考版本与 T 真实旅程                              | 冻结参考 client/server 可执行产物与 source SHA、依赖锁、profile、摘要、构建说明；它是 M0 内独立历史参考，不虚称已有发布版。固定后由后续候选演进验证。                                                                                                                                                |
| C4b / independent compatibility tester | C4a；E1 实际兼容演进后的不同 SHA 当前候选；P 可选能力/不兼容 fixture；C3                                           | 运行 A7，旧 client×新 server、新 client×旧 server、同代控制组；参考产物独立安装，不能重新导出当前 schema 冒充旧版；E1 由独立实现 owner 完成，验证相关 runtime 源码及归一化编译产物的实际行为差异，不能靠仅改 fixture/版本标签/构建时间产生不同 SHA。                                                 |
| C5 / resource test owner               | C2；P 限长/错误/ACK 契约；T 两层流控、恢复调度                                                                     | 运行 A8/A9，硬性有界与公平性断言进入 CI；devbox 必须另跑 100 个真实 PTY 同时持续合成输出的原型门槛，延迟/CPU/RSS 另生成测量 artifact，不能沿用 parser benchmark 的数值作为应用 SLO。                                                                                                                 |
| C6 / integration tester + coordinator  | C3、C4b、C5 均合入；最终 coverage inventory 无缺项                                                                 | 同一集成 SHA 在 macOS、GitHub Linux、`ssh devbox` 任务隔离 checkout 重跑 A0-A9，devbox 含必需 100 个持续输出真实 PTY 场景，形成验收报告和新独立 review；用户审核退出，不自动启动 M1。                                                                                                                |

依赖图：`批准 → C1 → C2 → {C3,C4a,C5}`；`T1 → P profile 冻结 → C3`；`C4a → E1 实际兼容演进`；`E1 + C3 → C4b`；`{C3,C4b,C5} → C6`。C1 不依赖尚未实现的功能；C4a 不依赖最终兼容性通过，因此不会把基线冻结与最终测试互相锁死。

实现：GPT-6 Sol high / GPT-6 Luna max；独立测试：另一 GPT-6 Sol high / GPT-6 Luna max；review：第三位 GPT-6 Sol high，未实现且未编写被审测试。可选实现/测试用本地 `warmpool run -- traex ...` 明确 GPT-5.6 Sol high，记录 routing 和实际 warm hit；不用 delegation，不改共享池。review 修复代码后改派 reviewer。

## 验收矩阵与判定

下表 A0-A9 为最终必须存在的 coverage inventory；文件、测试 ID、项目、平台、CI step 和 owner 在对应实现 PR 填入任务记录。最终不能仅数总测试数：每项、每个平台及必要变体都必须有成功记录。环境不支持或缺少 artifact 是 blocked/fail，不计 pass。

| ID / 平台                      | 必需断言与证据                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A0 / macOS + Linux             | 干净 frozen install → tsc Project References → Node 启动 dist server/worker/CLI；通过公开 exports 加载 JS/types，私有路径拒绝；无跨包 src alias、无 Electron/RN/native 依赖泄漏入 protocol/client。捕获精确 Node/pnpm、`process.versions.modules`、OS/arch、原生库版本和构建日志；node-pty 必测，其他原生库仅在 M0 实际引入时纳入，不能借 CI 引入 SQLite。                                                  |
| A1 / macOS + Linux             | CLI 经公共域操作启动合成子进程 PTY，nonce 输入输出、真实 resize、正常退出码/信号；全部客户端断开后再 attach 保持 server/run/PTY 身份及可输入；观察 worker pipe 丢失为不可验证，核实 task-owned 子进程退出才报告退出；不自动再 spawn。完成和故障路径均核对拥有的 PID、端口、临时文件清理。                                                                                                                   |
| A2 / 两浏览器 + 两 OS server   | A/B focus 按 server 接受顺序改变 controlEpoch；异尺寸按序改变 PTY/模型，两视图遵循同一网格；同尺寸没有额外 resize；旧 epoch input/resize/blur、旧 connection generation、重复 focus 均不撤回新状态；后台重连/输出通知不争抢，前台恢复按契约取得控制。                                                                                                                                                       |
| A3 / 同上                      | 0/1/2 客户端及 detach/replay 下，profile 内每个实时 query 只有 worker 一份回复，PTY 字节计数可核对；replay/history 自动回复为零；在异步 parse/write 同时发真实键盘、paste、mouse，输入按已定契约保留，不通过丢弃所有 onData 伪造成功。                                                                                                                                                                      |
| A4 / 同上                      | retained model+连续窗口走增量；新视图/缺口走基线 N 后 N+1；基线安装期间持续输出、ACK 丢失、重复/乱序/旧订阅事件不能丢失或重放已应用事件；不确定用户输入不自动重试。独立 oracle 按 pragmatic-logical-grid-v1 比较预算内 normal/alternate 可见内容、当前 cursor/mode、identity 和 event log，不只截图；已批准的 saved-style/off-grid/物理行差异独立记为诊断，不放宽普通可见丢失或事件错误。                   |
| A5 / 同上                      | 1000 行原型预算与强制小预算分别裁剪历史，宽→窄→宽、CJK/emoji/wrap-pending、normal→alternate→normal；含隐藏 normal buffer。上下文不足须取得新尺寸基线，不能凭当前屏幕相似宣称 reflow 完整。 恢复一致性按 §3.2.1 pragmatic profile 判定：保存样式/字符集及 off-grid/物理行完整等价仅作诊断，普通内容/当前状态/顺序/解析仍必需。                                                                               |
| A6 / 契约单测 + 真实浏览器/PTY | 在每个 UTF-8/CSI/OSC/DCS 切分边界恢复再接后缀；验证未闭合序列超限显式失败且内存有界，不注入 reset 修复。每个声明 profile 状态均有 oracle；不支持项明确拒绝，不能悄悄删减已批准范围。 恢复一致性按 §3.2.1 pragmatic profile 判定：保存样式/字符集及 off-grid/物理行完整等价仅作诊断，普通内容/当前状态/顺序/解析仍必需。                                                                                     |
| A7 / Linux + macOS 进程 lane   | C4 冻结产物×当前产物双向真实协议旅程：attach/query/input/resize/recovery/exit；可选字段缺省、未知可选能力降级、新 opcode 未协商不得发送。显式不同协议/未知 bootstrap 在业务操作前拒绝，原实例与 PTY 仍存活、无 reset/replacement；fixture 缺失、同 SHA、相同程序仅改 metadata、alias 偷换或零场景均失败；E1 候选必须证明真实可选行为演进及旧端缺省回退。                                                    |
| A8 / 两 OS + devbox            | 人工阻塞一个订阅解析 ACK，超过预算只终止/恢复该订阅，健康客户端继续且控制消息不饿死；堵住 worker parse 驱动 PTY pause/resume，原始字节不丢，Ctrl-S/Ctrl-Q 不充当私有协议；per-terminal、pipe、socket、recovery 和全局队列峰值均不超过已冻结字节/帧预算及明确 in-flight 余量。                                                                                                                               |
| A9 / 两 OS + devbox            | 恢复请求洪峰去重/限流，snapshot 在 worker 调度，输入及其他终端获得有界调度机会；测试用可控阻塞/步数验证公平性和 seq，另记真实输入→服务端 ACK/浏览器应用延迟 p50/p95/p99、serialize 时长、event-loop lag、CPU/RSS、队列峰值、source offered/achieved rate。devbox 另用 100 个真实 PTY 并发持续输出合成负载，保留两个客户端、操作者及隐藏预览/慢端/恢复场景；仅建 100 个空闲 PTY 或 headless 模型不满足门槛。 |

合成 shell/VT 固定 seed 与 profile，用例时限只防止挂死（建议单场景 30 秒、恢复压力 120 秒、整 lane 15 分钟，首轮证据后调整），不是性能 SLA。

Codex、TraeX、Claude Code 的小规模真实 TUI 工作流现已纳入 H1/C3 与最终 X1 验收：精确记录 CLI 版本、启动方式、平台、独立合成任务、真实 PTY/browser 链路和清理结果。认证/服务不可用是外部阻塞，不计成功；不把捕获字节回放或合成程序冒充真实 agent 验收。公开 CI 保留确定性合成控制，凭据相关 live 验收证据单独关联同一候选 SHA。100 个真实 agent 的容量资格仍属 M4。

`docs/benchmarks/2026-09-25-xterm/RESULTS.md` 是 Node 22.16.0、100 个 headless 模型的短 parser 探针，无 PTY、网络或渲染；其 4-process 配置、parse p95、RSS 不代表 Node 26 Cove 延迟或容量。M0 记录测量值、主机竞争和未知项；硬门槛只用明确语义、队列预算、无泄漏和已校准测试超时。新增性能阈值需有基线/波动依据，经协调者提交用户决定。

## GitHub Actions 接线、失败与证据

优先扩展现有两项 `check (...)` 的实际步骤；C1 先覆盖现有工具链，每个能力 PR 同时增加真实 suite、coverage 项和必需执行路径。合并前对比 suite 清单、Vitest projects、脚本和 workflow，避免文件存在而 CI 从未执行。每次 PR、main push 都执行，不增加 M0 路径过滤、`continue-on-error`、passWithNoTests 或静默 retry。

若后续拆独立 jobs，由协调者在同一变更计划中维护依赖全集和规则迁移：先让新命名 job 在 PR/main 实际出现并验证，再启用必需状态；旧保护在新保护生效前保留。汇总 `always()` 必须枚举全部必需 job、逐个要求 `success` 且非零用例；漏 job、skip、cancel、timeout、pending、missing 都失败。保护变更前后保存规则快照，不用移除红项换绿。自动取消旧 PR run 仅节省资源，不能充当新 head 成功证据。

CI 验证 harness 自身的失效路径：缺产物、错 ABI、坏参考摘要、删除一个 suite、跳过一个 matrix entry、取消下游 job 必须导致总 gate 不成功；这些是控制逻辑测试，不实际修改 live 规则或扰动用户服务。冻结依赖和 action SHA；仅允许必要原生 build scripts，缓存键含 lockfile、OS、arch、Node ABI，原生安装目录和 dist 不跨 OS/ABI 共享。

保留 JUnit/JSON、coverage inventory、environment、命令/exit code、fixture/artifact SHA256、队列指标和失败 trace；artifact 名含 commit、job、OS/arch，完整性检查拒绝缺件。建议成功证据 14 天、失败日志/trace 7 天；长期摘要与不可变兼容 fixture manifest 入库，所需参考源码/产物须能重建或稳定取回，不能依赖会过期的 Actions artifact。只上传合成终端内容，过滤 token、密钥、真实路径/终端记录，日志有字节上限；private auth 不进入 trace。权限 contents:read、checkout 不保留凭据，PR 测试不带发布凭据。

## devbox 与资源预算

M0 已经用户批准，执行仍需协调者按依赖派发；本计划没有运行 Linux 检查。C6 经 `ssh devbox` 创建自己的 clean checkout，checkout 精确集成 SHA，记录 uname/arch、Node/pnpm/ABI、CPU/cgroup、内存及当时负载。frozen install、独立 node_modules/dist/tsbuildinfo/state，临时 loopback 端口；浏览器若在本地，显式 SSH tunnel 并分别记录两端环境，不能把本机 Linux 模拟当作 devbox 结果。

使用带 finally/trap 的有界 runner 记录自己创建的进程、启动身份和目录；失败/取消只终止这些资源，核实清理。SSH 失联不能宣称进程已退出；恢复联系后核实 task-owned PID/身份，无法核实时报告剩余资源并阻断退出。禁止 pkill 全局进程、重启 daemon、修改现有服务/防火墙或清理其他 checkout。

初始调度建议：全局 active agents/worktrees 各最多 5，服从当前更低运行时上限；同时最多一个原生集成/性能任务，每个 CI lane 一个测试 worker、2 个浏览器 context、1 个 server + 1–2 个 terminal worker、通常 2–4 个 PTY。GitHub 两 OS 最大并发 2；devbox 单 lane。常规用例可从约 2 vCPU/2 GiB 开始测量，不能将其当作 100-PTY lane 的容量上限。C5/X1 必须在 devbox 同时运行 100 个真实 PTY 的持续合成输出；运行前检查可用 CPU/内存并记录共享负载，单次有界压力建议 120 秒，明确输出速率、尺寸、历史与 worker 配置。逐 run 记录 offered/achieved rate、活跃数量、背压时段及正常清理，不能通过串行化或只让少量 PTY 输出伪造规模。硬门槛仍是语义/有界/公平调度，不临时发明吞吐 SLO；低于提供负载的完成速率必须如实报告。资源不足则排队或报告阻塞，不能把 100 静默改小或终止他人负载。100 个真实 agent、mobile 渲染及长时间容量验收仍留后续阶段；合成 PTY 门槛不等同于它们。

## 集成与里程碑验收报告模板

```text
Scope / Issue / owner / model+effort / agent(session) ID:
Authorized M0 boundary / user decisions:
Base SHA / PR head SHA / dependency P,T,C revisions:
Artifact and frozen fixture SHA256 / build environment / exact commands:
A0-A9: test IDs + platform + expected counts + actual pass/fail/skip + evidence URL:
Functional hard gates / measured metrics / unverified or deferred claims:
Independent tester identity + tested SHA/base + findings:
Independent Sol-high reviewer identity + reviewed SHA/base + findings/resolution:
Required checks names + run URLs + conclusions / ruleset snapshot:
Rebase mapping original→main SHA / final main CI / same-main devbox evidence:
Owned resource inventory + cleanup result / residual blockers:
M0 acceptance recommendation / explicit user exit decision / next stage NOT started:
```

协调者串行 rebase merge 前重新核对 head/base、独立测试/review 和必需 CI；base 漂移或冲突解决后重做受影响验证和 review，不沿用旧 SHA 结论。合入后记录映射、检查最终 main CI；C6 验收对象为最终 main 的精确 SHA，不能拼凑多个分支绿色结果。

用户已批准实验认证/易失回执/双浏览器 harness 范围；汇总 DAG 与 M0 入口已于 2026-09-26 经用户批准；下一阶段卡口是 M0 退出/M1 进入，CI 不新增架构选择。若 T1 显示所选 profile/query/recovery 无法满足已确认语义，协调者呈现复现证据和替代方案，由用户决定范围/架构变化；此前不降低断言。普通实现参数在已批准契约内由 owner 决定并记录。
