# Cove 当前交接

更新：2026-10-24。本文只记录当前状态（不超过 150 行）；恢复前核对 GitHub、checkout 与在途资源。
历史见 Issues/PRs、Git；接管前长版见 `git show 3d7349a:docs/handoff.md`。

## 授权与用户决定

- 用户已接受 M2 交付、批准 M2 退出；[阶段决定 #185](https://github.com/GhostFlying/cove/issues/185#issuecomment-6358353029)。
  M2 双机 Tailnet、双平台安装升级与 Linux Docker 注销/init 周期补验通过；不包含 host kernel reboot。
  macOS 真实 GUI 注销/登录由用户暂缓，待测试机或实际使用观察（[#189](https://github.com/GhostFlying/cove/issues/189)），不记通过。
- [M3 D1–D7、任务与验收](milestones/m3.md)已获批准并授权实施（[#190](https://github.com/GhostFlying/cove/issues/190#issuecomment-6359407784)）。
  系统下限仍需实证；D7 延期 shell integration，不启动 T8。完整 tend 集成、M3 退出、M4、发布与部署均未获本轮授权。
- 用户要求原生 subagent 替代 Claude；root 为唯一协调者，只规划、派发、路由 review、集成与交接，不实施运行时代码。
  旧 Claude session `0433f23a-9e5f-4904-8d5f-d524dcaab09f` 只作历史参考。
- 所需 CI 全部成功且一次完整独立 review 无未关闭 P0/P1 时，协调者可 rebase & merge；P2/P3 转为后续 issue。
  默认全新 codex `gpt-6.1-sol` xhigh reviewer；修正仅做同 PR delta，遵循[工程 §6.9](engineering-plan.md#69-按比例验证与停滞处理2026-10-08-用户确认)。
- Cove 为单用户；经认证的所有者可信，不评审自我攻击。正常崩溃、顺序变化、Cove 自身重叠、数据丢失与未知副作用仍在范围内。
- 只检查 Cove 自建/已知管理目录的 owner/mode；既有 HOME、COVE_HOME、祖先及任意用户目录不做权限检查或 chmod。
  不再扩展大小写、别名、多级链接组合矩阵；来源与残留边界见 [#172](https://github.com/GhostFlying/cove/issues/172)、[#185](https://github.com/GhostFlying/cove/issues/185)。

## 实际 main 与集成门槛

当前 main：`6b12c5df0512b18a064c681b58f9d9111eb66526`（T6 PR #217）。

- T1 [#200](https://github.com/GhostFlying/cove/pull/200) → `2c45bf44`；实际 main Engineering39992275645 attempt2 与 tend39992275355 成功。
  共用 Node adapter、Session credentials/socketPort 已可供后续消费；原始失败和独立 review 保留在 PR。
- T0a bridge [#203](https://github.com/GhostFlying/cove/pull/203) → `932f5261`；实际 main [Engineering40064147591](https://github.com/GhostFlying/cove/actions/runs/40064147591) 成功。
- T2 业务 snapshot/events 与公共 CLI [#206](https://github.com/GhostFlying/cove/pull/206) 已合入；
  实际 main `82486ef5` 的 [Engineering40065888728](https://github.com/GhostFlying/cove/actions/runs/40065888728) 与 tend40065888752 成功。
  原 draft [#202](https://github.com/GhostFlying/cove/pull/202) 保留完整失败/修正历史；P2 后续为 #207。
- T3 shared reader/mirror/ServerSession [#209](https://github.com/GhostFlying/cove/pull/209) → `65f07e72`；
  实际 main [Engineering40070045827](https://github.com/GhostFlying/cove/actions/runs/40070045827) 与 tend40070045803 全部成功，T4 已释放完整源码。
  T3 P2 #212–#214 保留为后续；完整独立 review 和原始失败见 PR。
- T6 [#217](https://github.com/GhostFlying/cove/pull/217) 已经完整独立 review、integration delta 和候选必需 CI 后合入。
  实际 main [Engineering40072307667 attempt2](https://github.com/GhostFlying/cove/actions/runs/40072307667) 全部成功，tend40072307661 成功；
  attempt1 的失败/UNKNOWN 保留在 #217，候选 CI 不代作集成后的证明。原 [#211](https://github.com/GhostFlying/cove/pull/211) 保留原始测试/review，P2 #215/P3 #216 后续处理。

## 正在推进

- T6 #176：确切 run/实例/epoch 的 `tab send`、控制者观测、分离 text/CR 回执及 receipt-only abandon。
  不抢 focus、不 resize、不重放未知输入。原候选的编译/489 项受影响覆盖及自有 raw-mode Node TUI 验证见 #211；
  integration 验证及实际 main PASS 已写回 #217。真实 Claude Code/Codex 提交行为与吞吐未执行，不冒充通过。
- T0b [原生 #205 / PR #208](https://github.com/GhostFlying/cove/pull/208) 仍为 draft；当前 head/原生与设备结果以 PR 和 native owner 的交接为准。
  自有 Android AAR 与实际离线 `assembleRelease` APK 构建/打包通过；含 JS/Hermes、Kotlin/Java 与 Go JNI，minSdk31/target36、arm64。
  这是 development debug signing 构建，未发布；不等于设备启动或应用网络通过。
  Go mobile 与 compiled app ports 作者检查已通过；实际设备 login/WhoIs/pair/RPC/WS/cancel/前后台生命周期仍待验证。
  fresh Dora 设备段正在执行，lease、安装、载入与网络结果待 native owner 核对；不能声明零占用或设备验证通过。
  iOS 实际 unsigned app 已进入 Swift 编译/link 验证，最终结果待核对；已有 profile 不覆盖所查闲置物理设备，不自动注册设备或改签名。
  旧 head CI 的 held-PID 夹具失败保留在 #210；新 head 的 review/CI/原生与设备证据需分别核对。
- T4 [#196 / draft #219](https://github.com/GhostFlying/cove/pull/219)：own checkout `cove-worktrees/m3-196-desktop`，
  当前分支 `p/luchengxuan/m3-196-desktop-integrated`，base `6b12c5df`；原 #218/分支保留，映射见 #219。
  loopback-only 邀请、真实 Electron45/electron-vite6/React19.2 工作台、独立 Keychain 凭据、operation query ledger 与多 server UI 已发布。
  combined root build/受影响96项通过；源码修正至 `dcaeac26` 后 strict Desktop TS/bundle、scoped lint/format 通过，最终 CI/review/验收未冻结。
  实际 Electron 窗口、首屏、Keychain 配对加密保存、GUI repo/task/mount/path、run 创建和 VT 显示已执行；
  启动 ESM ready、fixture HOME、tab recipe/cwd、foreground/visibility 集成缺口已据实际失败修正，完整原始记录见 #219。
  尚无成功终端键入；reload、app quit 后同 run 存活、Keychain 冷恢复、共享节点 logout/stop、远程 GUI 仍待实际验收。
  七轮没有发送终端输入；自有进程/fixture 和核实匹配的唯一 Keychain 项已清理；新 GUI 段须由 root 与 Native 串行安排。
  支持声明仍为 macOS14 arm64 候选；本机 macOS26.3 运行不能代替14实机验证。不做安装器、签名、公证、更新或M4。
- T5 Mobile 产品导航、T7 集成试用仍按真实依赖派发；尚无完整 Desktop/Mobile 产品交付或 M3 退出结论。

## 单写者与本地资源

- Native owner 管理 `native/tailscale` 与 `apps/mobile`；root manifests/workspace/lock 写权已由 root 移交 T4。
  不采用别的 checkout 未提交文件。
  T3 owns shared client 与 CLI `_events.ts`；T6 owns protocol/server/worker/tab CLI 闭包，handoff 本轮由 T4 受托维护当前事实。
- root manifests/workspace/lock/TS/Vitest、inventory/tooling fixture/boundary 目前由 T4 单写；各集成段协调组合精确 delta。
  保留 T3 mirror7/reader7/session10 与已合入 T6 protocol4/server8/worker42/CLI suite3；不复制别的分支未合入源码。
  各 worktree 的 node_modules、dist、tsbuildinfo、端口与测试夹具独立。
- 本机只做低并发局部检查，root 安排重资源自然交接；不跑 stress/load 或长时并行循环。Linux 使用 `ssh devbox`。
  不操作既有用户服务、终端或共享 pool；中断不证明旧进程退出，恢复前确认 task-owned 进程/命令/资源归属。
- 用 fresh native implementation owner、独立 reviewer 与原子 Conventional Commits；不得 agent/bot 身份或 co-author。
  保护 main：只允许 GitHub rebase & merge，禁止 force push、删除、直接推送和 squash；逐次记录原→rebase 后 commit 映射。

## 已建后续

- [#207](https://github.com/GhostFlying/cove/issues/207)：P2，business observer 占用 runtime listener 容量，需保留全部正常 terminal slots。
- [#210](https://github.com/GhostFlying/cove/issues/210)：P2，held-Git PID 文件发布/读取竞态把空文件当 PID0；保留进程身份与清理验证。
- [#212](https://github.com/GhostFlying/cove/issues/212)：P2，session retirement 应保留已明确拒绝的 write。
- [#213](https://github.com/GhostFlying/cove/issues/213)：P2，VerifiedServerBinding 的普通 class getters 不应被 spread 丢失。
- [#214](https://github.com/GhostFlying/cove/issues/214)：P2，server 时钟回拨后 run-only mirror 不应丢弃真正最新 run。
- [#215](https://github.com/GhostFlying/cove/issues/215)：P2，明确零写入的临时 native 容量拒绝不应永久 fence 正常 run。
- [#216](https://github.com/GhostFlying/cove/issues/216)：P3，tab.send 完整 canonical 上限应在 pending 发布前校验并给准确 usage 错误。
- [#204](https://github.com/GhostFlying/cove/issues/204) 及 #100/#125–#127/#132/#149/#154/#157/#164/#168/#169/#181/#182/#107、M0 延后项的历史见对应 issue 与 #185。
  上述 P2/P3 不自动变成已接受里程碑的新前置条件；修复需独立 slice、review 与所需 CI。

## 保留的运行边界

- M1/M2 已提供持久身份、SQLite、repo/task/workspace/mount/tab/run、安装服务、升级影响、配对/撤销/轮换及 loopback/SSH/内嵌 tsnet。
  用法见[开发说明](development.md)、[Shepherd/tend 接口](integrations/shepherd-tend.md)；M2 试用/清理/UNKNOWN 见 #185，不在此复制 checkpoint。
- Cove 不使用系统 Tailscale；M2 创建的 fresh 两端试用节点已 logout/stop、配对已撤销；不得采用旧节点或猜名清理 UNKNOWN 控制面记录。
- 恢复输入暂存后只发送一次；不盲目重试未知效果，也不无手势抢回控制。server 失联不等于 run 退出。
- 首个正式版本之前不提升协议版本、不承诺混合 build 兼容；loopback Host 字面量与同主机冒充残留边界、SSH host-key 前置见设计与 #185。
- 远程默认入口取配对入口，可显式修改；SSH 邀请需设置 sshTarget，CLI 不自动写 known_hosts。
  T4 draft允许无远程入口的明确 loopback-only 邀请，不自动猜测目标或扩大监听。

## CI 与环境

- 必需 `check (ubuntu-latest)`、`check (macos-latest)`；各由本次 attempt 的 3 个 Vitest shards 聚合。
  重跑只能选 re-run all jobs，不能只重跑失败/聚合 jobs。missing/skipped/cancelled/pending 均不满足门槛。
- tend 接口变更同 PR 更新集成说明与 changelog；无影响才用有理由的 `Shepherd-Doc: not-affected`。
  合入前核对精确 head/base、完整 review 与 CI，合入后 actual-main 通过才释放依赖。
- 固定 Node26.10.0/pnpm12.6.0；Go 由 native go.mod 固定。各 agent 使用受控工具 PATH 与自己的安装/构建目录。
- 只保留一个活跃 root 协调者；旧 Codex 自动化保持暂停。接管前 M0 试用资源或旧证据目录的清理仍需明确授权。
