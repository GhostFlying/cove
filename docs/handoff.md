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
- T0a bridge [#203](https://github.com/GhostFlying/cove/pull/203) → `932f5261`；实际 main [Engineering40064147591](https://github.com/GhostFlying/cove/actions/runs/40064147591) 成功。
- T2 snapshot/events 与公共 CLI [#206](https://github.com/GhostFlying/cove/pull/206) 已合入；
  实际 main `82486ef5` 的 Engineering40065888728 与 tend40065888752 成功；原 #202 保留失败/修正历史，P2 #207 后续。
- T3 shared reader/mirror/ServerSession [#209](https://github.com/GhostFlying/cove/pull/209) 已合入；完整 review 无 P0/P1，P2 #212–#214 后续。
- T6 [#217](https://github.com/GhostFlying/cove/pull/217) 已合入上述当前 main；候选 Engineering40070737219 与完整/integration review 通过。
  实际 main [Engineering40072307667 attempt2](https://github.com/GhostFlying/cove/actions/runs/40072307667) 与
  [tend40072307661](https://github.com/GhostFlying/cove/actions/runs/40072307661) 均成功，T4 与 Native 组合实现依赖已放行。
  原 #211 保留完整失败/review 历史；P2 #215、P3 #216 保留为后续。

## 正在推进

- T0b [#205](https://github.com/GhostFlying/cove/issues/205)：旧 draft [#208](https://github.com/GhostFlying/cove/pull/208) 保留到 `d14c47b7`，替代 [draft #221](https://github.com/GhostFlying/cove/pull/221) 当前 `97234b90`。
  新 integration branch `p/luchengxuan/m3-205-native-integration` 基于 main `6b12c5df`，16 个原子 cherry-pick 的映射记入替代 PR；旧分支未改写。
  组合 frozen install、全 workspace build、tooling 73 项及 compiled client/mobile 36 项作者检查通过；最终 CI/review 待新 head。
  Android arm64 AAR、含离线 JS/Hermes/JNI 的实际 APK 构建通过；初始 minSdk31/target36 不变，development signing 非发布签名。
  fresh 自有本地 Android14/API34 arm64 AVD 已实际 Login→Running、WhoIs/serverId、单次兑换与 SecureStore 保存通过。
  旧 Boot `NoState` 重连失败已修；组合 APK 实际 Reconnect、RPC、cancel `not-sent`、terminal WebSocket attach/控制通过。
  单次测试输入未确认恰好一次，保留 UNKNOWN 不重发；内部文本框未聚焦及首读时序只作观测，生命周期尚待复验。
  Dora 与本地 nc 辅助探针均未证明回程，不能据此归因云路由或 native 网络失败；旧失败/UNKNOWN 全保留。
  iOS arm64/min16 unsigned 实际 app compile/link 通过；自有 iOS18.1 arm64 Simulator 的真实模块加载、Login/HTTP/WhoIs/兑换通过。
  旧 unsigned Simulator SecureStore persist 失败（redemption 已 handed-off，未重放）；独立 synthetic probe 确证 missing-entitlement。
  正常本地 ad-hoc Simulator 构建后，同 API/options 的 synthetic write/read/delete 已实际通过，未降低访问级别。
  组合 iOS RPC/WS/lifecycle 仍待执行；物理设备签名前提缺失，未申请注册或修改用户签名。
  Android14 与 iOS Simulator 是中间功能证据，不代表 API31、物理机、真实 Tailnet 或 T7 完整通过。
  原 CI held-PID 夹具失败见 #210；新候选须有自己的 CI、完整独立 review 与组合实际链证据。
- T4 [#196 / PR #219](https://github.com/GhostFlying/cove/pull/219) head `d1267afe`（product `833c06b8`），base `6b12c5df`。
  完整 review/delta 的原 P1/P2 已关闭，P3 #220 后续；Engineering40079052218 与 tend40079052207/40079174469 成功。
  实际 Electron45 profile 双进程、quit/reopen ledger 与 14 项 scoped tests、inventory60 通过。
  用户明确保持本机锁屏，GUI input/reload/quit/cold/paste 未执行、不豁免；不绕过 foreground guard。
  devbox fullcheck 仍在执行，已发现 S1/S9 测试环境假设失败，待 T4 批次修正；shared-node 非 GUI 编译链证明尚待执行。
- T6 精确 run/实例/epoch 的 `tab send`、控制者观测、text/CR 分离回执及 receipt-only abandon 已交付当前 main。
  不抢 focus、不 resize、不重放未知输入；真实 Claude Code/Codex 提交行为与吞吐未执行，不冒充通过。
- T5 Mobile 产品导航、T7 集成试用仍按真实依赖派发；尚无完整 Desktop/Mobile 产品交付或 M3 退出结论。

## 单写者与本地资源

- Native owner 管理 `native/tailscale`、`apps/mobile`，当前持 root manifest/lock/TS/Vitest 与 mobile 所需 CI/tooling fixture 单写权，
  以及本轮 handoff/development integration 文档；T4 只持其协调的单文件修正，不写这些共享文件。
  保留当前 main 的 T2/T3/T6 行为、inventory 计数和依赖限制；不采用别的 checkout 未提交文件。
- 本轮 iOS synthetic probe 已清理 own UDID；Native 正在 fresh 本地 AVD 组合链复验，资源归属/在途命令以 owner 当前回报为准。
  无 Dora lease，不采用旧 AVD/Simulator；每轮 finally 清理自己的 package/PID/root、reverse 和 server/PTY/control 夹具。
  历史一次 Dora reverse mapping 删除 UNKNOWN 独立保留；lease 已释放，禁止再操作旧 SID 或猜名清理。
- 本机 heavy token 当前 Native，串行 2 CPU；其他作者重检查由 root 在安全终态安排交接，不打断在途命令。
  各 worktree 的 node_modules、dist、tsbuildinfo、端口、测试夹具独立；Linux 使用 `ssh devbox`。
  不操作既有用户服务、终端、AVD/Simulator 或共享 pool；中断不证明旧进程退出，恢复先确认资源归属。
- fresh native implementation owner 与独立 reviewer；原子 Conventional Commits，不得 agent/bot 身份或 co-author。
  main 只允许 GitHub rebase & merge，禁止 force push、删除、直接推送和 squash；保留原→集成→main commit 映射。

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
- 远程默认入口取配对入口，可显式修改；server 邀请前需设置 sshTarget，CLI 不自动写 known_hosts。

## CI 与环境

- 必需 `check (ubuntu-latest)`、`check (macos-latest)`；各由本次 attempt 的 3 个 Vitest shards 聚合。
  重跑只能选 re-run all jobs，不能只重跑失败/聚合 jobs。missing/skipped/cancelled/pending 均不满足门槛。
- tend 接口变更同 PR 更新集成说明与 changelog；无影响才用有理由的 `Shepherd-Doc: not-affected`。
  合入前核对精确 head/base、完整 review 与 CI，合入后 actual-main 通过才释放依赖。
- 固定 Node26.10.0/pnpm12.6.0；Go 由 native go.mod 固定。各 agent 使用受控工具 PATH 与自己的安装/构建目录。
- 只保留一个活跃 root 协调者；旧 Codex 自动化保持暂停。接管前 M0 试用资源或旧证据目录的清理仍需明确授权。
