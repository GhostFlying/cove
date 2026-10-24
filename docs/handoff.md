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
- T5 [#197](https://github.com/GhostFlying/cove/issues/197) 已正式 source release。
  own checkout `cove-worktrees/m3-197-mobile`，branch `p/luchengxuan/m3-197-mobile`，基于 exact 8b。
  实现 RN 直连多 server、repo/task/workspace/mount/tab、公共 ServerSession/mirror、独立 SecureStore slots、SQLite journal、bundled terminal。
  SQLite55.0.20 是唯一新增存储依赖；原 ID/canonical digest 在 dispatch 前事务落盘；cold start 只 operation.get，不重派原写。
  64 profiles、8 live server sessions、256 journal rows/1 MiB、UI50 rows；未决记录不淘汰。
  [draft PR #228](https://github.com/GhostFlying/cove/pull/228) 原子产品提交 `8c7dd698`；完整独立 review 无 P0/P1，F1–F5 五项P2在同批纠正。
  当前 Mobile prepare:js/typecheck/lint、compiled31、tooling69、原 client302 已过；root check 的 format/lint/build 通过，
  完整 test gate 因本地缺 worker-qualification CI identity 退出；保留失败，不记 full PASS。PR CI 与产品 native 验证推进中。
  `8c7` own AndroidAPI31 AAR/offlineAPK（d55bd132…7ef055）已构建，实际新AVD证实原生SQLite启动与keyless测试控制登录。
  首UI harness在输入后错误Back退出app，尚未配对；FAIL与cleanup[]保留，不能记完整产品通过。
  own iOS Simulator binding已编译；F1–F5纠正后将冻结head并重建新JS/app，旧APK不代新源码证据。
  物理 iPhone/Android、真实 Tailnet 且 Desktop off、IME/外接键盘与完整生命周期属于明确保留的 T7/硬件验收。
- T7 集成、实际使用试用与 M3 退出尚未完成，M4 未启动。

## 单写者、资源与恢复

- T5 是 apps/mobile、必要 SQLite manifest/lock、inventory/tooling 与本 handoff 的唯一实现写者。
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
- #215 native 零写入拒绝 fence；#216 tab.send canonical bound；#220 Desktop P3，以及 M0–M2 历史后续见 #185。
  这些后续不自动成为里程碑的新前置。凭据/真实终端 raw 不公开；历史未证结论不追记成功。
