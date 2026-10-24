# Cove 当前交接

更新：2026-10-24。当前状态不超过 150 行；恢复先核对 GitHub、checkout 与在途资源。历史见 Issues/PRs、Git。

## 授权与边界

- M2 已获用户接受与退出批准；[#185](https://github.com/GhostFlying/cove/issues/185)。Linux init/注销周期通过，不冒充 host kernel reboot。
  macOS 真实 GUI 注销/登录按用户决定暂缓（#189），不记通过。
- M3 [D1–D7、任务与验收](milestones/m3.md)已批准（#190）；D7 延期 shell integration，不启动 T8。
  完整 tend 集成、M3 退出、M4、正式发布与部署未获本轮授权。
- 用户要求 native subagent 替代 Claude；root 唯一协调者，不实施产品代码。fresh 实现者、独立 reviewer 与 required CI 保持。
  所需 CI 全成功、完整独立 review 无 open P0/P1 时，协调者可 rebase & merge；P2/P3 转后续，不伪造 GitHub 第二账户 approval。
- Mac 保持锁屏；不请求解锁、不激活 Desktop GUI。headless 原生构建/任务自有资源验证可继续，真实 GUI 未执行必须保留。
- Cove 单用户、经认证的 owner 可信；不报告 owner 自我攻击。正常崩溃、顺序变化、Cove 重叠、丢数据、未知假成功仍在范围。
  只检查 Cove 自建/已知管理目录 owner/mode，不扩 HOME/祖先/用户目录权限或 alias 矩阵。

## 实际 main 与已合入能力

当前 main：`88e4a284f24211b5f1fb97ced880d809c3335c6d`（packaging #227）；T5 源分支保留已放行的 exact `8b4f8be4` base。

- T1 Node adapter #200、T0a bridge #203、T2 business snapshot/events #206、T3 ServerSession/mirror #209 已合入。
- T6 #217 → `6b12c5df`，actual-main Engineering40072307667 attempt2 + tend40072307661 成功。
  原 #211 保留失败/review 历史，P2 #215/P3 #216 后续；真实 agent/TUI 提交与吞吐不冒称通过。
- 服务卸载顺序 #225 → `169002fc`，actual-main Engineering40086300733 + tend40086300726 成功。
  先完成安全 preflight 再停止任务拥有的服务；原/rebased mapping 及风险证据在 PR。
- Native replacement [#226](https://github.com/GhostFlying/cove/pull/226) 已合入；树 `531dda`，其已验证实际 main 为 `8b4f8be4`。
  [Engineering40091194200](https://github.com/GhostFlying/cove/actions/runs/40091194200) 全 6 shards、2 Go jobs、2 required aggregates 成功；
  [tend40091194256](https://github.com/GhostFlying/cove/actions/runs/40091194256) 成功，Go checkout 已实际核对。
  T0/T3 真实依赖满足后 root 已明确放行 T5，不能由此声称 Mobile 产品验收通过。
- Native 历史：原 #208/#221 保留完整失败/review/mapping，最终产品 source `9df608b5`，集成最终 `f911c668`。
  Android14/API34 arm64 自有 AVD `8a269ff2` 全核心链通过；`9df608b5` 新 APK 再验 login/pair/save/单次主动 logout。
  iOS18.1 arm64 自有 Simulator `9df608b5` 签名 app 全核心链与 same-run/logout 通过，无 PTY 输入。
  unsigned Simulator SecureStore missing-entitlement 已证实；正常 ad-hoc 同 options synthetic write/read/delete 通过。
  早期 iPhoneOS/min16 unsigned compile/link 只属旧产物；不冒充物理机签名、API31 实机、真实 Tailnet、性能或 T5/T7。
  原输入 UNKNOWN/后续未发与工具失败保留；最终 IME/外接键盘/触摸接受仍待实机。

## 正在推进

- T4 [#196 / PR #219](https://github.com/GhostFlying/cove/pull/219) head `29f1e825`；full/delta 结果见 PR，P3 #220 后续。
  真实 Desktop GUI 验证因 Mac 锁屏未执行，不能记 PASS；依赖集成/真实 app gate 由 root 路由。
- Runtime packaging [#227](https://github.com/GhostFlying/cove/pull/227) 已合入上述 88e4，仅 runtime closure/CLI S1/S9 三文件。
  actual-main Engineering40093259061 全6 shards/2 Go/2 required aggregates 与 tend40093259092 成功，artifact 均88e4。T5 不修改这些文件。
- T5 [#197 / draft PR #229](https://github.com/GhostFlying/cove/pull/229) 产品实现与一次完整独立 review/同 context 窄 delta 已完成，无 open P0–P3。
  own author checkout `cove-worktrees/m3-197-mobile` 基于8b；integration checkout `m3-197-mobile-main88` 基于上述88e4。
  当前 code/inventory head `cde35b29`，原作者 `ee930805`；实际 native 产品冻结 `19e121f0` → `23239369`，两侧 Mobile/terminal-web trees 完全相等。
  RN 自有 ServerSession/mirror/TerminalController、embedded tsnet/native ports 与独立 SecureStore slots；WebView 仅 bundled xterm 桥。
  多 server、repo/task/workspace/mount/tab/history/device 工作流；SQLite55.0.20 是唯一新增存储依赖。
  dispatch 前持久化原 ID/credential slot/instance/method/canonical digest 与非 secret summary；cold recovery 只查询原 ID，不重派写或重兑未知 invitation。
  64 profiles、8 live server sessions、256 journal rows/1 MiB、UI50；未决记录不淘汰。导航 focus 本地拥有，恢复不重放输入/focus/resize。
  Mobile opt-in 固定 xterm6 committed-insertText/legacy diff 去重适配；Desktop 默认不启用，origin/query filtering 与 composition/普通键盘路径保留。
  Mobile prepare/typecheck/compiled34、terminal-web build/77 unit+真实 xterm browser tests、CI inventory tooling61、full discovery2117/189files 已过。
  code head cde 的 [Engineering40105842730](https://github.com/GhostFlying/cove/actions/runs/40105842730) 全6 shards/2Go/2 required aggregates SUCCESS，
  [tend40105842610](https://github.com/GhostFlying/cove/actions/runs/40105842610) SUCCESS；final handoff docs append 后仍需该 exact head CI 与 actual-main。
  local author ee930/base8b 的 pnpm check：prep/format/lint/build PASS，188files PASS/1FAIL，2192tests PASS/1FAIL/2local-service SKIP。
  唯一 S8 FAIL：首次 continue 与产物/ledger 断言已过，同原 ID 第二次 continue 返回无 operation；完整 error 未留，cause UNKNOWN。
  S8 test/domain/SQL 与 main88/cde same blobs；保留 local FAIL/UNKNOWN，公开摘要/后续见 PR229，不记 full local PASS、不改 server 或重跑。
  ba62 iOS18.1 Simulator core PASS：原生 SQLite/profile/journal、task.create、cold 原 ID 只读核实、same-run observer 前后台恢复/history，无输入且 grid/control 不变。
  ba62 Android14/API34 arm64 core 已观察 pairing/current/task.create/原 ID 成功卡/SQLite1ready+1operation/cold restore；reader 最后跨页面查错状态，最终 query 未执行，保留 FAIL。
  正常19e121 iOS ad-hoc app 单次 UI marker 恰14B/1marker PASS；Android 正常 APK 单次 marker+Enter 恰16B/1marker PASS，独立 raw TUI bytes 核实。
  iOS bundle `3f81ac65…64b27b`；Android APK `b096f438…df3d94` / bundle `2e2291b8…f42c67`；所有自有 Simulator/AVD/fixture 已终态清理。
  旧 FAIL/UNKNOWN 与112records/dropped0 的单次诊断 payload 保留，诊断不作验收；精确 source/hash/mapping/原始结果归属在 PR229。
  物理 iPhone/Android、真实 Tailnet 且 Desktop off、IME/selection/外接键盘仍属 T7 未执行；不冒充全平台/硬件或 M3 退出。
- T7 集成、实际使用试用与 M3 退出尚未完成，M4 未启动。

## 单写者、资源与恢复

- T5 是 apps/mobile、必要 SQLite manifest/lock、已授权 terminal-web 小适配/tests、inventory/tooling 与本 handoff 的唯一实现写者。
  public client/protocol/native contracts/native/tailscale 变更先交 root 协调；不借 T0/T4 未提交 generated outputs。
- 各 worktree 独有 node_modules/dist/tsbuildinfo/native bindings/测试数据库/端口；共享 pnpm package store 和只读 toolbins 可以。
  Node26.10.0/pnpm12.6.0/Go1.27.3；私有 TS5 仅 Expo loader，实际 tsc 仍 root TS7。
- 本机只低并发局部检查、最多2CPU串行重构建；重资源 token 当前 T5。Linux 使用 ssh devbox 自有 checkout/resources。
  不操作现有用户服务/终端/设备；Dora 仅 fresh idle+online lease，每次操作前核实 session ID，finally 仅释放匹配自有 lease。
- 前后台/进程重建不重放输入、mutation、focus；失联不证明 run 退出。客户端退出不停止 server/PTYS。
  测试 controlURL 为开发隔离配置，不成为产品连接字段；native digest binding 不静默迁移。
- 工程 §6.9 优先于历史逐原子 prereview/seal 门槛。作者自测、CI 独立测试、一次完整独立 review 与实际 main 验证保持。
  task-owned 一次性 harness 自查后可执行，保留原始 FAIL/UNKNOWN/未执行，不公开敏感 raw logs。
- 必需 check(ubuntu-latest)/check(macos-latest) 按本 attempt 聚合全部3 shards；missing/skipped/cancelled/pending 不通过。
  重跑选 all jobs；合入串行、核对 head/base/review/CI 和 original→rebased mapping；actual-main 通过再释放依赖。
- tend-facing CLI/flags/JSON/run/control/recipe 变化同 PR 更新 integrations/shepherd-tend.md；T5 无 CLI surface 变更。
- 不 reset/stash/clean/覆盖其他贡献者；提交用户已有 Git identity，无 agent co-author。main 保护、rebase merge、禁止 force/squash/direct push。

## 后续与残留

- #207 business observer 容量；#210 held-Git PID fixture race；#212 session retirement 的已拒 write；#213 binding getters；#214 clock rollback。
- #215 native 零写入拒绝 fence；#216 tab.send canonical bound；#220 Desktop P3；#230 queued background/disconnect 非阻断；M0–M2 历史见 #185。
  这些后续不自动成为里程碑的新前置。凭据/真实终端 raw 不公开；历史未证结论不追记成功。
