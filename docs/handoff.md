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

当前 main：`169002fca2e2b1fa40657c5a109995a01e29081e`（服务卸载顺序 PR #225 已合入）。

- T1 [#200](https://github.com/GhostFlying/cove/pull/200) → `2c45bf44`；实际 main Engineering39992275645 attempt2 与 tend39992275355 成功。
- T0a bridge [#203](https://github.com/GhostFlying/cove/pull/203) → `932f5261`；实际 main [Engineering40064147591](https://github.com/GhostFlying/cove/actions/runs/40064147591) 成功。
- T2 snapshot/events 与公共 CLI [#206](https://github.com/GhostFlying/cove/pull/206) 已合入；
  实际 main `82486ef5` 的 Engineering40065888728 与 tend40065888752 成功；原 #202 保留失败/修正历史，P2 #207 后续。
- T3 shared reader/mirror/ServerSession [#209](https://github.com/GhostFlying/cove/pull/209) 已合入；完整 review 无 P0/P1，P2 #212–#214 后续。
- T6 [#217](https://github.com/GhostFlying/cove/pull/217) 已合入 `6b12c5df`；候选 Engineering40070737219 与完整/integration review 通过。
  实际 main [Engineering40072307667 attempt2](https://github.com/GhostFlying/cove/actions/runs/40072307667) 与
  [tend40072307661](https://github.com/GhostFlying/cove/actions/runs/40072307661) 均成功，T4 与 Native 组合实现依赖已放行。
  原 #211 保留完整失败/review 历史；P2 #215、P3 #216 保留为后续。
- [#225](https://github.com/GhostFlying/cove/pull/225) 在完整 review 与全部所需 CI 通过后已 rebase & merge；
  `eab8f691`→`169002fc` 的作者、完整 message、stable patch 与 tree 映射全等，parent 为 `6b12c5df`。
  实际 main [Engineering40086300733](https://github.com/GhostFlying/cove/actions/runs/40086300733) 在途，
  [tend40086300726](https://github.com/GhostFlying/cove/actions/runs/40086300726) 成功；尚不能称 actual-main Engineering 通过。

## 正在推进

- T0b [#205 / draft #221](https://github.com/GhostFlying/cove/pull/221) 最终产品 source `9df608b5`，base `6b12c5df`。
  原 [#208](https://github.com/GhostFlying/cove/pull/208) 分支 `d14c47b7` 未改写；16 个 original→integration 映射在 #221。
  一次完整独立 review 与同 context delta/F5/主动 logout 收束无 open findings；[最终窄 review](https://github.com/GhostFlying/cove/pull/221#issuecomment-6383089595)。
  最终所需 CI 仍须按 exact head 核对；文档收尾不改变已验产品源码，不能把旧 head CI 当新 head 通过。
  frozen install、组合 build、局部 compiled mobile15/CI tooling60、完整 app TS7/lint/format、自有 clean-artifact prepare→typecheck→test 通过。
  Android14/API34 arm64 自有 AVD：`8a269ff2` 全部 Login/WhoIs/serverId/pair/SecureStore/RPC/cancel/binaryWS/BGFG/cold restore/logout 通过；
  最后仅 App 主动 logout 顺序 +9 行的 `9df608b5` 新 APK 再验 Login/pair/save/verified-client/单次 logout 通过，未冒称重跑全部链。
  iOS18.1 arm64 自有 Simulator：`9df608b5` 签名实 app 全部上述核心链、错误 control 选择固定分类、准确 same-run 与 logout 通过，无 PTY 输入。
  当前 Go Android API31 AAR 与 arm64 Simulator binding 源码/目标已核实；早期 iPhoneOS arm64/min16 unsigned compile/link 仅作对应旧产物证据。
  unsigned Simulator SecureStore 的 missing-entitlement 已确证；正常本地 ad-hoc 包同 options synthetic write/read/delete 通过，未降低访问级别。
  物理设备签名前提仍缺；不注册设备、不改用户证书。Simulator/Android14 不代作 API31 实机、真实 Tailnet、性能或 T7 通过。
  早期输入一次 UNKNOWN、后续未发均保留；完整键盘/IME/触摸属 T5/T7，不追加为 T0 合入 gate。
  原 NoState/缺模块/输入 URL/日志目录、F1 execution/loading/主动退出竞态及所有 tool FAIL/UNKNOWN 在 PR/私有 raw 保留；#210 仍后续。
- T4 [#196 / PR #219](https://github.com/GhostFlying/cove/pull/219) head `6d04294a`，base `6b12c5df`。
  独立 full/原 delta/新 delivery delta 无 open P0/P1/P2，P3 #220 后续；Engineering40082695647+tend40082695603 全成功。
  早期 profile 双进程/quit-reopen ledger 与局部检查保留；GUI/input/reload/quit/cold/paste 因用户保持 Mac 锁屏未执行，不豁免或称 Keychain/input 通过。
  devbox corrected-env 第1 shard 62 files：795 PASS/1 service-uninstall FAIL/0 skip，后2 shard 未执行。
  Linux shared-node 非 GUI proof `38147` 四项 PASS、own fixture 清理通过；使用 fixture cipher，
  不代表 GUI/Keychain/foreground/input/真实 Tailnet 通过；前两次 fixture 遗漏 controlURL 的 FAIL 保留，未归为产品故障。
  独立 delivery [#223](https://github.com/GhostFlying/cove/pull/223) `e6192533` CI/fresh full review 成功，尚未合入；
  pure-base external 4 PASS/1 旧 S1 uninstall FAIL 原样保留，待与当前 `169002fc` 组合重验5 cases及新 base 影响。
  #224 的 stop→disable linked-unit 顺序错误已由上述 #225 修正合入；fresh review 无 P0–P3，
  自有 systemd backend6/router2/safety16 检查与8 units 清理通过，不代称 #223 或完整外部 serial 已通过。
- T6 精确 run/实例/epoch 的 `tab send`、控制者观测、text/CR 分离回执及 receipt-only abandon 已交付当前 main。
  不抢 focus、不 resize、不重放未知输入；真实 Claude Code/Codex 提交行为与吞吐未执行，不冒充通过。
- T5 Mobile 产品导航、T7 集成试用仍按真实依赖派发；尚无完整 Desktop/Mobile 产品交付或 M3 退出结论。

## 单写者与本地资源

- Native owner 管理 `native/tailscale`、`apps/mobile`；最终产品源码冻结 `9df608b5`，root manifest/lock/TS/Vitest、
  mobile CI/tooling 与文档单写权已归还 root，本次仅获 `docs/handoff.md` 的集中 integration 更新权，提交后归还。
  T4 的 `runtime-closure.mjs` 与 #225 的 service/tend 文档由各自 owner 独占，Native 不碰。
  保留 main 的 T2/T3/T6 行为/计数；各 checkout 的安装、dist、tsbuildinfo 与运行资源独立，不采用他人未提交文件。
- Native 所有实际检查已终态，own AVD/Simulator/Dora lease/server/PTY/control/日志捕获均已清理，本地 heavy token 已归还 root。
  历史一次 Dora reverse 删除 UNKNOWN 与已核实 lease release 分开保留；不操作旧 SID 或猜名清理。
- 本机重资源串行 2 CPU，由 root 安排安全终态交接，不打断在途命令；Linux 使用 `ssh devbox`。
  不操作既有用户服务、终端、AVD/Simulator 或共享 pool；中断不证明旧进程退出，恢复先核资源归属。
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
