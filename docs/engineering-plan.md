# 工程结构与推进约束

状态：单仓库、pnpm workspace、构建/测试方向及第 6 节的多 agent 协作规则已确认；具体目录和里程碑拆分仍是待逐阶段审阅的计划。产品与技术决策以 [整体设计](design.md)、[Server 架构](server-architecture.md)、
[终端架构](terminal-architecture.md) 和 [协议设计](relay-protocol.md) 为准。
包管理已选 pnpm workspace，首期不叠加 Turborepo/Nx；构建/测试选择见第 9 节，根工具链版本已固定，RN/Expo 与发布流程尚未确定。
当前已初始化根工程配置；不创建应用空壳、不启动远端服务。安装与验收边界见 [开发说明](development.md)。

## 1. 已确认单仓库；建议按部署入口和真实依赖边界组织

已确认单仓库，使用 pnpm workspace 管理 TypeScript 包，并保留独立 Go 模块承载 tsnet。
不按 repo/task/tab 等每一个业务名词创建 npm package；业务领域先作为 server 内部模块。
只有跨应用复用、依赖隔离或独立构建有明确需求时才拆包。

```text
apps/
  server/                 # 独立服务入口、领域模块、Git/SQLite 适配、worker 管理
  cli/                    # 完整操作入口；本机 bootstrap 与远程 operator
  desktop/                # Electron main/preload 与 Web renderer
  mobile/                 # RN 宿主；Expo 与构建工具待选
packages/
  protocol/               # Zod 契约、RPC/事件/终端帧；worker pipe 契约独立子模块
  client/                 # 连接、鉴权、操作跟踪、订阅与恢复控制器
  terminal-engine/        # headless/serialize 适配与恢复生成
  terminal-worker/        # 子进程入口、PTY、顺序、查询回复、有限缓存
  terminal-web/           # xterm 显示适配；Electron 与 RN WebView 使用
native/
  tailscale/              # Go tsnet 模块与进程边界
tests/
  fixtures/terminal/      # 可重放的输出/resize/query 用例，非真实敏感会话
  compatibility/         # 同协议不同客户端/服务端版本组合
  integration/           # 真实 PTY、多客户端与临时 Git 仓库
docs/
  benchmarks/            # 有环境、命令、原始结果与解释的性能证据
```

目录表达目标边界，随里程碑按需建立；不提前创建空 Web App、scheduler、chat、hook 或 Shepherd 包。
terminal-worker 是 server 安装产物的一部分，不独立于 server 保活。
首个 worker 只有一个 PTY 也使用该边界，不先把 PTY 塞进 Electron 或控制进程再迁移。

## 2. 依赖方向与平台边界

- protocol 不依赖 Electron、RN、数据库、PTY 或终端引擎；外部协议与内部 pipe 协议分别版本化，
  不把外部兼容义务机械扩展成支持任意版本 runtime/worker 混用。
- client 依赖 protocol 和注入的平台 transport/凭据存储接口，不直接依赖 Node 原生模块。
- CLI 与 GUI 通过同一 server 领域操作，不各自实现 Git/SQLite 写入；本机安装、发现、启动和配对引导
  是明确的 bootstrap 边界，不是常规业务绕过 server 的入口。
- server 领域模块不引用 UI。Git、文件系统和 SQLite 由执行主机内的适配器访问，远程请求不使用客户端路径假装本地执行。
- terminal-worker 依赖 terminal-engine 和 pipe 契约；server 消费事件/基线，不再维护第二份 headless 镜像。
- terminal-web 不依赖 headless、node-pty 或 better-sqlite3。RN 宿主与 WebView 的订阅/恢复控制器放置需单独定案，
  不在两边同时维护权威输入队列或重复解析同一输出以实现同步。
- Electron main 处理宿主能力；renderer 不直接加载服务端原生模块。未来 Web 复用客户端代码，不能要求 Electron 才能执行领域操作。
- Go 组件只承载网络接入边界，不引入第二套 task/terminal 数据模型。

CI 后续应通过依赖检查约束这些边界，而不是仅靠代码 review 记忆。
包管理已选 pnpm，初期按包脚本与过滤执行；构建和测试方向已选，最低运行时版本与发布打包仍需收敛。

## 3. 建议的推进约束

### 3.1 每个功能都形成可操作的闭环

每个领域变更同时说明：契约、server 行为、CLI 操作/结构化结果、客户端消费方式和错误边界。
常规能力与设置不得只存在于 GUI；没有 GUI 时，CLI 仍能完成操作和检查结果。
客户端暂未实现时先提供 CLI 验收，不要求每个 commit 同时修改全部平台。

### 3.2 先记录计划，再实现；以验收而非目录数量判断完成

每个里程碑记录范围、依赖、验收方法和明确排除项；实现后补充实际执行的检查与未验证部分。
原型通过不等于产品完成，synthetic benchmark 不等于真实 agent 容量。
代码与受影响文档保持一致；方案变化先更新当前设计，不堆积互相冲突的平行方案。
运行时错误必须可定位到 server/run/subscription/operation 的准确身份，同时避免日志泄露 token 和真实终端内容。

### 3.3 显式处理副作用与失败

Git/worktree/PTY/传输变更必须说明部分成功、响应丢失、取消和重试行为。
不因超时推断进程退出，不自动重放不确定的用户输入或 agent 命令。
测试使用隔离的临时仓库、数据库与工作目录；不得为验收重启已有服务或操作用户活跃终端。
devbox 性能验证需记录测试进程归属并清理自身资源，不把共享主机噪声当性能结论。

### 3.4 不把未选择的功能变成首期前置条件

首期不包含定时任务、chat、Web App、Shepherd、独立 PTY keeper 或 agent 最后业务状态 hook。
保留合理接口边界即可，不实现空框架或未来功能的通用插件系统。
跨主机迁移仍属于产品范围，首期覆盖面尚待收敛；后移实现顺序不等于删除该能力。

## 4. 建议的里程碑与退出条件

| 阶段                         | 可交付结果                                                        | 进入下一阶段前的证据                                                                                      |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| M0：契约与终端风险原型       | 按目标边界启动 server/worker，CLI 驱动真实 PTY，两个最小客户端    | 查询唯一回复且不吞输入；恢复、裁剪历史后 resize、normal/alternate 切换正确；同协议兼容及明确不兼容行为    |
| M1：本地 task/workspace 闭环 | 注册 repo、创建多仓 workspace、tab/run、CLI 管理、SQLite 记录     | macOS/Linux 临时仓库验证；共享 checkout 与新 worktree 都可操作；server 重启保留记录、不伪造存活或自动重跑 |
| M2：独立远程服务与设备授权   | 本地服务部署、SSH/系统 Tailscale 接入、配对/撤销、独立 tsnet 接入 | Desktop 不在线也可操作；切入口保持身份；撤销影响活动连接；部署与重启影响可检查                            |
| M3：真实 Desktop/Mobile      | Electron 与 RN/WebView 接入相同契约，按可见范围订阅               | iOS/Android 真机输入、前后台与重连；Desktop 退出不影响 server；列表刷新和操作终端互不饿死                 |
| M4：迁移与容量/发布收敛      | 已确认范围的迁移闭环、100 终端验证、安装与升级产物                | 迁移部分失败可继续；慢端强制恢复；真实 PTY/agent 与长时资源预算；客户端更新不重启 server                  |

以上是依赖顺序；同一 milestone 内按依赖图并行，跨 milestone 不自动推进。
M0 即开始采集输入延迟和队列内存；移动端输入等后续风险可提前列入计划，但执行预研需纳入用户已批准的当前阶段范围，
不能将“提前验证”当作绕过阶段授权的理由。
无须将完整迁移或 100 个真实 agent 当 M0 前置条件，也不能将 M0 成功宣传为已经支持这些能力。

## 5. 紧接着需要逐项选择

1. 单仓库与多 agent 工作流已确认；按 milestone 审阅任务依赖图，目录名与包数量保持可调整。
2. pnpm workspace 与构建/test 方向已选；固定版本与 lint/格式化已落地，继续收敛 RN/Expo 与发布工具。
3. Workspace 实际目录与引用现有 checkout 的方式，形成真实 agent/Git 验收。
4. 数据库执行位置、schema migration 与 CLI bootstrap；执行库已选 better-sqlite3，不重开驱动选型。
5. 平台构建、服务安装发现与升级策略；独立本地 server 的稳定安装目录是必要条件。

已确定的工具链选择不等于已完成集成：当前仅初始化并验证根工具链；未实现应用，也未运行应用或远端测试。

## 6. 多 agent 并行开发

这里指开发 Cove 的协作方式，不是给 Cove 增加 managed agent 或调度器。
单仓库统一契约与集成，但不要求多个写入者共用同一目录、分支或 Git index。

### 6.1 角色、授权与执行入口（已确认）

根协调者只维护任务分派、依赖图、归属和闸门状态；文档、代码集成、GitHub 操作、冲突处理与验收执行都交给明确分配的执行者。

| 角色             | 模型                                                            | 责任                                                             |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| 模块规划         | GPT-6 Astra high                                                | 只写 plan、拆任务依赖图、定义接口和验收条件                      |
| 交互式实现/测试  | GPT-6 Sol high / GPT-6 Luna max（按难度选择）                   | 任务实现与独立验证，角色和文件归属分离                           |
| 自包含非规划任务 | 本地 TraeX GPT-5.6 Sol xhigh，经 warmpool                       | 优先执行适合的实现、测试、review 或运行事务                      |
| 独立 review      | 自包含任务优先独立 TraeX xhigh；交互式任务用独立 GPT-6 Sol high | 审查最终变更与证据，不由实现者或测试作者自审                     |
| 集成与运行事务   | 明确分配的非规划执行者                                          | 维护文档、处理冲突、执行 GitHub/CI 操作；实质改动重新验证/review |

规划与决策分析优先调查 Orca 对应实现；存在相关实现时记录仓库 revision、代码路径、实际行为和可验证证据，
说明哪些值得借鉴、哪些可能不合理，以及 Cove 的需求/不变量为何要求相同或不同的设计。
Orca 是比较对象，不是设计权威；不存在对应实现或未能验证时明确说明，不能用猜测填补证据。
结论须对照当前 Cove 设计文档，区分已确认决策、建议和仍待用户决定的问题。

Review 默认只报告问题，修复交回实现者；若 reviewer 参与实现，重新指派独立 reviewer。
每次派发记录角色、模型、推理强度、任务范围和实际 agent/session 标识；不能静默改用其他模型。
规划、实现、独立测试与 review 是不同责任，不要求同时占用四个执行槽位。

TraeX 是本地 CLI，不能使用 delegation 插件替代。交互 alias 不保证在非交互 shell 存在，
使用显式 `warmpool run -- traex ...`；显式指定 `gpt-5.6-sol` 和 `model_reasoning_effort="xhigh"`，
不从 `ultra` 之类 profile 名推断真实强度。可检查 daemon 和目标模型状态，并区分路由经过 warmpool 与实际命中 warm session。
Warm 命中仅是加速项，不能将 warm=0 或未命中当作不可用或延迟派发的条件：仍经 warmpool 启动，
可能短暂排队，也可能直接执行；只有实际启动/执行失败才按具体错误处理。
当前调用的可用性、失败和排队记录在任务中，不写入长期可用保证；不为任务修改共享池配置或重启其他任务的服务。
Linux 执行与验证通过 `ssh devbox`，使用任务独立 checkout 和资源，记录实际版本与环境。

产品取舍、架构调整、范围变化或验收标准改变，由分配的 Astra-high planner 整理选项、建议、影响和阻塞任务，根协调者负责转交用户评估决定。
普通实现细节和已批准契约内的冲突由执行者处理。等待决定时仅阻塞相关依赖，其他 ready 任务继续。
明确分配的集成执行者在独立测试、独立 review 和必需 CI 满足后可自主合并；根协调者只跟踪闸门并派发，不亲自合并。该授权不包含跳过卡口、发布部署或进入下一 milestone。
每个 milestone 的进入与切换均需用户 review 和明确许可，任务全部合入不自动授权下一阶段。

### 6.2 以契约和交付物切分任务

一个受派集成负责人维护当前目标、依赖和最终验收；执行任务各有明确负责人、文件范围和验收条件。
集成负责人不由只负责调度的根协调者兼任，也不将日常接口协调转成反复向用户请求许可。
每个 milestone 先由 Astra-high planner 拆分任务并整理为同一张无环依赖图，根协调者据此分派。
每条边说明依赖的契约或交付物及其版本；只有前置依赖满足的任务进入 ready，独立任务并行。
依赖尚未确定的任务先交付契约/fixture，消费者按同一契约工作，不各自猜字段。
不为并行而把一个需要同步修改的热路径硬切给多个 agent。

| 可并行方向            | 主要写入范围                             | 共同依赖                             |
| --------------------- | ---------------------------------------- | ------------------------------------ |
| 终端模型与恢复        | terminal-engine、其专属 fixtures/tests   | 已确认恢复语义及 profile             |
| PTY worker 与 pipe    | terminal-worker、进程生命周期 tests      | pipe 契约与 engine 接口              |
| Server 领域与存储     | server 内指定领域、适配及 tests          | RPC/事件契约、资源身份               |
| CLI / 客户端协议层    | 分配到的 cli 或 client 模块与 tests      | 相同 RPC/事件/终端契约               |
| Desktop / Mobile 宿主 | 各自应用、分配到的 terminal-web 接入部分 | 相同 client 与 terminal adapter 接口 |

表格是拆分候选，不代表现在启动这些任务。protocol、terminal-web 等共享包仍需按具体文件分配写入者。
未来目录不存在时先在计划中指定目标路径，不预建空工程。

### 6.3 隔离与高冲突文件

并行写入默认推荐一任务一分支/独立 worktree；记录基准提交和实际 checkout 路径。
同目录协作只在明确划分文件归属后进行，文件归属不清时不并发修改。
最多同时运行 5 个任务 agent、保留 5 个任务 worktree，覆盖本地子 agent、TraeX 和远端任务；测试/review checkout 也计入预算。
主 checkout 的文档与集成写入也须指定唯一执行者；根协调者只调度。实际调度同时服从工具槽位限制，不得让外部 CLI 或递归派发绕过总预算。
不为凑满并发启动无独立交付物的任务；阶段转换时先交接、释放对应任务资源。
即使使用 worktree，schema/类型和锁文件仍可能语义冲突，隔离目录不能代替协调。

以下文件族在同一轮工作中指定一个写入者：协议 schema 与错误码、根配置、lockfile、公共 export/注册入口、
数据库迁移顺序、根 AGENTS.md。其他任务提出具体改动需求，不自行改出第二个版本。
写入者按变更指定，可以轮换；不让一个固定 agent 承担所有日常改动。
依赖变更先协调 manifest 与 lockfile 的生成，不能手改 lockfile 合并冲突或把冲突一侧整体覆盖。

### 6.4 每个任务的最小记录与交接

实现前在独立计划文件记录任务 ID/负责人、目标、基准提交与 checkout、可写路径、依赖契约版本、
验收命令/条件和明确排除项。增加 Issue/PR、依赖任务、实现/测试/review 责任人、阻塞项与状态。
建议路径为 docs/tasks/<task-id>.md，随实际任务创建。
任务文件用于交接，不是跨机器原子锁；同一任务被并发领取时，需要通过协调方确认唯一写入者。
汇总状态由集成负责人维护，避免所有 agent 同时修改同一张 Markdown 总表。

交付时说明提交/变更范围、实际测试及结果、未验证项和对其他任务的接口影响。
实现不能依赖另一个 worktree 的未提交文件；依赖任务的契约以可定位的提交或明确共享 fixture 为准。
共享目录中只暂存自己的文件/行块，不提交其他任务尚未完成的改动。
跨 host 的结果必须记录来源提交、OS/架构与测试环境，不能用路径同名当成代码版本一致。

### 6.5 集成与验收

依赖顺序决定集成顺序，先合共享契约，再合消费者；独立改动可并行验证。
每个任务先完成针对性检查，集成后再运行受影响的跨模块验收。
冲突按最终契约语义解决，不能为通过类型检查或测试删掉另一任务的行为。
下游验证必须针对实际集成提交；各分支分别通过不代表组合后通过。
GitHub main 使用线性历史，仅允许 rebase & merge；禁用 squash 和 merge commit，禁止直接推送、force push 和删除 main。
空远端首次建立默认分支是一次性 bootstrap 例外，完成后立即启用保护；后续修改均经过 PR。
默认先合公共依赖，再从实际 main 提交建立消费者基线；不依赖未提交文件或长期堆叠未合入分支。
冲突交给明确分配的非规划执行者解决，解决后的代码属于新变更，必须重新验证并由独立 reviewer 审阅。

证据记录 PR head、base、测试执行 ref 和环境；检查缺失、取消、跳过或尚未完成均不视为成功。
代码追加、rebase 或 base 更新后重新评估受影响证据，不能沿用不对应当前版本的 review。
合并前核对预期 head 和最新 base；合并串行进行，通过 GitHub rebase & merge 保留原子提交。
GitHub rebase 会生成新 SHA，记录原提交与最终 main 提交的映射，下游从实际合入版本继续。
合并后验证 main 检查；失败时阻塞依赖任务并修复，不能把“PR 已 merged”当成阶段验收通过。

所有 agent 共用用户 GitHub 身份时，独立 agent review 不能冒充平台上另一个账号的 approval。
review 结论及对应 SHA 记录在 PR，由分配的集成执行者核对、根协调者跟踪闸门；CI 是机器卡口，agent 身份独立性由调度记录证明。
如以后要求 GitHub 原生独立 approval，需要先提供独立 reviewer 身份，不以管理员 bypass 模拟审批。

### 6.6 GitHub 状态与过程文档

GitHub Milestone 记录阶段目标与退出条件，总 Issue 保存任务依赖图与关键阻塞，任务 Issue 保存范围和进度。
仓库 plan/设计文档保存版本化的详细设计与已接受决定；PR 保存最终变更、实际验证和 review 证据。
状态统一为：待规划 → 待依赖 → 可开发 → 实现中 → 独立验证 → Review → 可合并 → 完成；阻塞另记原因。
任务完成需要合入且验收满足，阶段完成还需整体集成验收和用户 review。

每次交接、决策、依赖调整、冲突解决或范围变更都更新对应记录；记录原因、涉及版本、影响与后续动作。
不只在对话里保存状态，不公开凭据、原始终端内容或完整私有 agent transcript。
长期工作不依赖完整聊天记录。分配的文档/集成执行者维护 [当前 handoff](handoff.md)，各任务维护自己的 plan 与交接记录；根协调者只安排更新并跟踪状态。
Handoff 至少包含：当前获批阶段/范围、主干与活动分支、任务/agent/worktree 归属、契约版本、
已完成与未完成、检查/review 证据、阻塞与待用户决策、资源归属、下一步命令/条件和明确不可自动执行的动作。
敏感凭据、完整 agent transcript 和临时秘密不写入交接文档；运行 ID/私有日志位置在必要时使用本地受控记录。
接手时先核对 GitHub 和 checkout 的实际状态，不能将旧 handoff 的状态当作当前事实；更新旧文档，避免平行副本冲突。
设计变化更新相应设计文档并保留理由，handoff 只引用权威设计，不复制另一套架构定义。

里程碑报告包含实际交付、证据、未验证项、风险及下一阶段 DAG，等待用户许可后再切换。

### 6.7 原子提交与注释

使用 Conventional Commits：`type(scope): subject`，scope 可省略；分支使用 `p/luchengxuan/<milestone>-<issue>-<topic>`。
一个提交解决一个明确问题，能独立理解、review 和回退；必要的对应测试和文档属于同一原子变更。
不将无关改动打包，也不按文件机械拆分导致中间提交不可用。每个提交保持可构建、可检查。
Rebase & merge 保留每个提交，因此不能依赖最后 squash 来清理提交；开发期也应保持清晰历史。

提交正文可详细解释做了什么、为何如此、关键不变量与取舍；不写本次运行的测试命令、次数、耗时或临时通过状态。
这些执行证据放 PR 和任务记录；新增测试本身的目的和覆盖的行为仍可以在提交说明中解释。
PR 描述覆盖最终范围和关联 Issue；消息不带 agent/bot co-author，使用用户既有 Git 身份。

代码提供必要的原因说明，解释反直觉选择、不变量、边界和兼容性约束。
复杂状态机、顺序/并发、恢复及失败处理需详细说明关键流程和理由，必要时关联设计文档；不以“简短注释”省略重要解释。
避免复述逐行代码，行为变化时同步维护相关注释。

### 6.8 M0 的 GitHub Actions 卡口

根工程现有 macOS/Linux 冻结安装和 `pnpm check` 是基础检查，不能冒称已覆盖真实 PTY 或客户端。
M0 先将 CI/主分支保护作为显式任务，再随各能力补齐真实卡口，不能到阶段结束才补验收：

- 干净环境构建并启动编译后的 server、worker、CLI，验证 exports 和原生模块加载。
- macOS/Linux 的真实 PTY 输入输出、生命周期及任务资源清理。
- 两客户端、唯一查询回复、恢复、history 裁剪后 resize、normal/alternate 切换。
- 明确的混合版本兼容 fixtures 与不兼容拒绝，不能只用当前 schema 的两个实例代替兼容性验证。
- 有界队列、慢端处理和顺序断言；性能测量记录环境，不把波动耗时作为未经校准的门槛。
- 按批准的 M0 验收计划通过 `ssh devbox` 验证同一提交，保留 Linux 环境与执行证据。

必需检查要有稳定名称；若增加汇总 gate，须显式要求每个必需 job 为 success，不能将 skipped/cancelled 或零用例当成功。
现有检查失败时修复原因，不通过移除检查或放松安装策略换取合并。

## 7. AGENTS.md 的约束组织

根 [AGENTS.md](../AGENTS.md) 是 Cove 专属约束的唯一入口，保存稳定边界、工作流和验收原则，
不复制整份设计文档、不写入个人主机绝对路径，也不修改用户全局生成的 agent 指令。
领域目录出现后，只有存在真实差异时才增加局部 AGENTS.md，例如 worker 的顺序/背压、客户端平台边界。
局部规则细化根规则，不能静默推翻协议兼容性、CLI 完整性或已确认的产品边界。
任务的临时负责人、参数和进度放在任务计划中，不反复改根 AGENTS.md。

不同 agent 工具对 AGENTS.md 的自动发现规则不能假定相同；分派时明确要求读取根与适用局部规则。
需要工具专属入口时只引用同一份规则，避免维护多套手工复制内容。
可机器验证的约束逐步转成 CI：依赖方向、协议兼容用例、领域操作的 CLI 覆盖、迁移检查和受影响测试。
AGENTS.md 不替代执行证据，也不能把草案自动提升为用户已确认决策。

## 8. pnpm workspace（已确认）

- 内部包依赖使用 workspace:*，仓库维护一个根 pnpm-lock.yaml；应用 workspace 不混用其他包管理器锁文件。
  docs/benchmarks 下已有独立实验的 package-lock.json 是历史复现实验的一部分，不为统一应用工具链而改写。
- 初期使用各包的 build/typecheck/test 等脚本和 pnpm filter，暂不加入 Turborepo/Nx。
  按包执行用于任务局部检查，修改共享契约时覆盖其消费者，最终仍验收实际集成版本。
- 每个 worktree 独立安装、保存 node_modules 和构建输出，测试数据与开发端口也要隔离。
  可以复用 pnpm 依赖存储，但不将多个 worktree 的 node_modules 或可变构建目录软链接成同一份。
- 普通开发与 CI 使用冻结安装；依赖变更由当轮指定写入者更新 manifests 与 lockfile，不手工拼接 lockfile 冲突。
  精确 Node/pnpm 版本已记录在 .node-version / package.json，不能因不同 agent 的本地环境而漂移。
- 需要统一的依赖版本使用 catalogs 管理；React/RN/原生模块遵循宿主兼容要求，不强行统一不兼容版本。
- 先采用 pnpm 默认依赖隔离，并尽早验证 mobile 的 Metro、原生构建和 WebView；只有具体兼容问题才调整 linker。
  Expo 尚未选定。若选择 Expo，按所选 SDK 与实际依赖验证，不将文档支持视为 Cove 已验证通过。
- node-pty/better-sqlite3 属于独立 Node server；按 OS/架构/ABI 构建，不能因 Desktop 打包而将共享安装产物改编成 Electron ABI。
- 各 agent 默认执行局部检查；原生全量编译、集成测试和性能探针明确资源归属与并发预算，避免重复占满主机。

参考：[workspace](https://pnpm.io/workspaces)、[filtering](https://pnpm.io/filtering)、
[catalogs](https://pnpm.io/catalogs)、[frozen install](https://pnpm.io/cli/install#--frozen-lockfile)、
[Expo monorepo](https://docs.expo.dev/guides/monorepos/)。

## 9. 构建与测试工具链（已确认，待集成验证）

### 9.1 服务端与共享包

- Server、CLI、terminal-worker 和纯 TS 共享包使用 tsc + Project References 编译，初期不 bundling。
  产生 JS、类型声明与所需 source maps；具体 tsconfig 与输出布局在实现前确定。
- 内部包通过 package exports 消费构建产物，禁止跨包导入 src 内部路径，也不通过全局 paths alias
  把所有包名映射回源码。测试同样不能借助 alias 隐藏构建和包解析问题。
- Server 与普通共享包以 ESM 为默认，不同时发布 ESM/CJS 两套产物；Electron preload 等特殊入口按宿主要求单独配置。
- 首次 checkout 先构建依赖；开发时由明确的 build/watch 流程更新产物。一个 worktree 内不能让多个
  重叠的 tsc -b/watch 任务同时写同一依赖的 dist 或 tsbuildinfo；不同 worktree 的产物与缓存独立。
- 各包脚本封装依赖构建和检查顺序，不把正确工作所需的隐藏手工步骤留给 agent 猜测。
  Project References 的配置不能要求使用者先安装 Electron/mobile 工具链才能检查纯服务端包。

### 9.2 应用构建

| 入口                             | 已选方向      | 边界                                                   |
| -------------------------------- | ------------- | ------------------------------------------------------ |
| Electron main/preload/renderer   | electron-vite | 单独处理宿主模块格式与资源；不改写 server 原生模块 ABI |
| terminal-web 的 WebView 静态入口 | Vite          | 资源随应用携带，不依赖运行时 CDN；适配器仍可替换       |
| RN 应用                          | Metro         | Expo 尚未选择，沿用对应 RN 工程的原生构建流程          |
| Go tsnet                         | Go 原生工具链 | 仓库脚本协调，发布产物按 OS/架构隔离                   |

这些选择不确定发行安装器、签名、公证、自动更新或最低系统版本。

### 9.3 测试分层

- Vitest 为主要逻辑与 server/worker 集成测试框架；通过 projects 划分包和运行环境。
- 本包单元测试可引用本包源码；跨包走公开入口。集成测试必须包含启动编译后 server/worker 的路径，
  不能全部依靠 TS 运行器，从而漏掉 exports、入口、资源路径与原生模块加载问题。
- Playwright 验证真实浏览器中的终端交互；Electron 冒烟使用其 Electron 支持，所选版本须验证，
  不将上游 experimental 能力视为全场景保证。
- RN 原生组件测试不强行统一到 Vitest；Jest/jest-expo 等方案随 RN/Expo 决策确定。
  真机自动化工具待选，输入法、前后台和性能验收仍是必需项。
- macOS/Linux 均覆盖原生模块加载、PTY 启动与退出；测试只操作临时仓库、数据库和任务拥有的进程。
- 性能探针单独执行并记录环境，不混入普通 test；重型集成与原生构建按多 agent 资源预算调度。

根工具链使用 TypeScript 7.0.2、Vitest 5.0.2、Vite 8.3.1、Oxlint 1.85.0、Prettier 3.9.9，
按 2026-09-25 的最新正式 release 固定。工具链集成测试覆盖 Project References 与编译后 exports，
不是上述应用、PTY、Electron 或移动端验收。electron-vite/Playwright 随应用引入时再固定最新可用版本；
electron-vite 当前正式版与 Vite 8 的 peer 范围不兼容，不能全仓强行统一 Vite。
RN 组件测试与发布工具仍待选择，具体兼容性与执行证据见 [开发说明](development.md)。

参考：[TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)、
[electron-vite](https://electron-vite.org/guide/)、[Vitest projects](https://vitest.dev/guide/projects)、
[RN TypeScript](https://reactnative.dev/docs/typescript)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)。
