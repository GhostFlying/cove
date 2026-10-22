# Cove 当前交接

更新：2026-10-22。只记录当前状态（不超过 150 行）。恢复工作前先核对 GitHub 与各 checkout；
历史在 Git、Issue 与 PR 中（接管前的长版交接见 `git show 3d7349a:docs/handoff.md`）。

## 授权阶段

- M0 实施于 2026-09-26 获批；M0 退出与 M1 进入于 2026-10-15 获批（[M1](milestones/m1.md)）。
- 用户于 2026-10-21 批准 M1 退出与 M2 规划，同日决定 D1–D14 并批准 [M2 计划](milestones/m2.md)（PR #142）。
  D9 是范围变更：Cove 不使用系统 Tailscale，两端只用内嵌的 tsnet；D14：客户端 tsnet 用按需启动的常驻进程。
- **M2 的实现任务 T0–T6 已全部合入；T7（设计文档写回与本交接）随其 PR 合入后，M2 的任务全部完成。**
  下一步是用户在两台真实机器上的试用（[M2 验收场景](milestones/m2.md#验收场景)末尾），发现的问题修复后再提交 M2 阶段 review；
  M2 退出与 M3 进入都需要用户明确批准，完成任务不等于批准进入下一阶段。
- 合入规则（用户于 2026-10-17 决定，见 AGENTS.md 与[工程 §6.1](engineering-plan.md#61-角色授权与执行入口2026-10-09-用户调整)）：
  所需 CI 全绿且一次完整独立 review 没有未关闭的 P0/P1 时，协调者可 rebase & merge；P2/P3 转为后续 issue。
  默认 reviewer 为 codex `gpt-6.1-sol` xhigh；认证边界、协议契约与节点身份核实的变更另加 TraeX 第二 review。
- 威胁模型：单用户，经认证的用户是受信任的所有者；不防范其自我攻击，判据是不丢数据
  （AGENTS.md「Trust the authenticated owner」）。每个 review 提示都写明这一点。

## Main

main 为 `379905d`（PR #165 合入）。M2 的 PR 与合入提交（rebase 后的最后一个提交）：

| 任务 | PR   | 合入于    | 内容                                                                  |
| ---- | ---- | --------- | --------------------------------------------------------------------- |
| T0   | #150 | `e8b35bf` | auth、服务与入口契约，秘密的分界，真实 build 标识                     |
| T6   | #152 | `034ffc9` | 操作记录 30 天保存期限与 tombstone（#97）                             |
| T5a  | #148 | `809e098` | `cove-tsnet` serve 与 dial（Go，`native/tailscale`）                  |
| —    | #158 | `1c306e8` | tend 集成说明的 CI 检查（#101）                                       |
| T1   | #153 | `4d55063` | 设备授权、配对监听、`auth`、`remote`、`--server`（loopback）          |
| T2   | #161 | `eea6b9b` | SSH 入口与入口选择，loopback IP 字面量 Host                           |
| T3   | #162 | `b146637` | 安装闭包、用户服务、重启影响、入口配置                                |
| —    | #166 | `9878530` | Vitest 门禁按 OS 分 3 片并聚合（#163）                                |
| T5b  | #167 | `60860bd` | server 的 tsnet 节点、`server tsnet`、业务端口原始连接上限（#156）    |
| T4   | #165 | `379905d` | 客户端 tsnet（常驻 `cove-tsnet dial`）、`remote tsnet`、`--via tsnet` |

M2 之前的最后一批是 #141、#143、#145（M1 后续修复）与 #147（测试 flake）。

已实现的范围（设计写回见 [Server 架构 §§4、5、9](server-architecture.md#4-host-网络和内置-tailscale)、
[relay-protocol §§4、11.8](relay-protocol.md#4-握手本身必须跨业务协议可读)）：

- M1：持久 server 身份与 SQLite 存储、repo 注册、task/workspace、checkout 与托管 worktree 挂载、绑定变更与删除、
  tab/run，全部经 `cove` CLI 操作。
- M2：`cove server install` 的版本化安装闭包与用户服务（macOS LaunchAgent、Linux systemd user + linger）、
  `server status/impact/restart/upgrade`；入口配置（固定 loopback 业务与配对端口、`sshTarget`、`tsnetHostname`）；
  一次性邀请配对、每设备 token、撤销与轮换；`--server` 经 loopback、SSH 或 tsnet 入口远程操作，不自动换入口；
  server 监督的 `cove-tsnet serve` 节点与客户端的 `cove-tsnet dial` 常驻进程；操作记录保存期限。
- 场景测试：M0 S1–S8 在 `apps/cli/tests/scenarios.test.mjs`，M1 S1–S10 在 `apps/cli/tests/m1/`，
  M2 S1–S13 在 `apps/cli/tests/m2/`（tsnet 部分在 Tailscale 测试控制面上），都在 macOS 与 Ubuntu CI 上运行。
  真实 Tailnet、两台机器与注销/开机行为只能在实机试用中验证。
- 用法：[开发说明 · M2 远程 server](development.md#m2-远程-server安装配对与入口)；
  tend 可用的接口：[Shepherd/tend 集成说明](integrations/shepherd-tend.md)（PENDING 为空）。

## 实机试用（下一步，由用户执行）

按 [M2 验收场景](milestones/m2.md#验收场景) 末尾的清单，在笔记本与 devbox（或两台 Mac，都不装 tailscaled）上约一小时：
安装与服务（退出 SSH、注销、重启后的行为）、两端 tsnet 登录、经 SSH 与 tsnet 各配对与操作一次、
在终端中运行真实 agent、撤销与重新配对、安装新构建后查看重启影响。要点：

- 从另一台主机配对时，配对记录只保存所用的那一个入口（`pairedRecord`），同一客户端数据目录也不能再配对同一 server；
  所以试用清单中“在笔记本上用 `--via` 在 SSH 与 tsnet 之间切换”目前做不到，只有在 server 主机上不带 `--via` 配对的记录含多个入口。
  这与 M2 交付范围第 6 条（一台 server 记录多个已验证入口）不一致，需要协调者决定是建 issue 修代码还是调整试用与验收。
- 已知限制 #172：数据目录位于另一个非 root 用户拥有的目录之下时 server 启动只报 `m0-local startup unavailable`
  （现行规则与修复方向见 #172 与[开发说明](development.md#构建与启动)）。

- 先在 devbox 上 `cove server entry set sshTarget <user>@<host>`，否则邀请没有 SSH 入口（没有自动推断）。
- 经 SSH 配对前先用普通 `ssh <目标>` 记录 host key；CLI 不写 known_hosts。
- 记录 revision、OS/架构与命令；发现的问题建 issue，修复后再提交阶段 review。

## 保留的用户决定

- 恢复期间输入的内容先暂存，视图就绪后发送一次（#83）；控制采用前缀封闭
  （[relay-protocol §9.1](relay-protocol.md#91-focus控制权与自动-resize)）。
- harness 从不自动重试可能已生效的控制命令，也不在没有用户手势时重新取得控制权。
- 协议首个正式版本（含 alpha）之前不提升协议版本、不承诺兼容（M2 D12：build 不同只在 stderr 警告）。
- loopback 入口接受任何 loopback IP 字面量 Host，只拒绝域名 Host（2026-10-22）；同主机端口抢占冒充 server 是已记录的残留限制（2026-10-21）。
- tend 集成方向已接受但未排期（[设计 §7.1](design.md#71-以-tend-实现-shepherd经-cli-集成方向已接受未排期)）：
  经本机 CLI，worker 是 Cove tab，需要 `tab send`；具体 milestone 另行批准。

## 未关闭的后续 issue（不阻塞 M2 试用）

- #100 M1 T1 测试夹具失败路径上的清理缺口（只涉及测试）。
- #125 M1 T4 后续：`tab stop --run` 的实例分类、reopen 的 revision 溢出、跨重启停止的覆盖。
- #126 M1 T3b 后续（P2）：陈旧跟踪 ref 选中已删除的远端主分支、受理时的记录大小上限等。
- #127 run 退役与 run 编号上限的后续（PR #121 第二轮 review）。
- #132 M1 T5 后续：删除恢复与 `sourceChanges` 解析的独立测试覆盖。
- #149 flake：S7 慢客户端退订，以及高负载下 `ps` ETIMEDOUT 导致 “worker identity uncertain”。
- #154 操作记录清理的每批都重新扫描全部过期积压（P2，需要匹配遍历顺序的索引）。
- #157 操作记录没有保存发起设备（D7 的归属记录，P2，需要协议字段）。
- #164 SSH 入口的 `ssh -G` 预检未受命令生命周期监督，CLI 被 SIGKILL 时可能残留（P2）。
- #168 server tsnet 登录/登出的终态回执遇到一时的存储拒绝时不重试，记录停在 running 直到重启（P2）。
- #169 tsnet 监督与原始连接上限的测试从 CLI 测试项目移到 server 测试项目（P3）。
- #172 rendezvous 路径检查要求数据目录的各级上级目录属于当前用户或 root，将改为信任 `$HOME` 及其上级并指明不安全的目录（试用中发现）。
- #107 主线程请求路径约 0.3–0.6 ms 的回显延迟残留，属于 M4 容量验收。
- #23、#24、#25、#28 已移出 M0（兼容参考、混合版本、有界队列与调度、兼容演进），留待后续阶段。

未建 issue 的 M0 已知问题：harness 中点击 xterm 屏幕之外会让键盘焦点离开终端；128 个受控 run 之后 arbiter 返回 BUSY。

## CI 与合入

- 必需检查（ruleset `main-linear-history`，严格要求分支最新）：`check (ubuntu-latest)`、`check (macos-latest)`。
  每个 OS 的 Vitest 门禁分成 3 个分片 job（`check shard (<os>, k/3)`），由必需的 `check (<os>)` 聚合本次 run attempt 的分片证据。
  重跑必须选 **re-run all jobs**：“re-run failed jobs” 与只重跑聚合 job 都会失败（[开发说明 · 当前验证范围](development.md#当前验证范围)）。
- `Shepherd/tend doc` workflow：PR 改动 tend 依赖的接口（CLI 命令、install、protocol 方法与 schema、server 的 store/operations 等）
  而未改[集成说明](integrations/shepherd-tend.md)时失败；确实不影响 tend 时在 PR 描述中单独一行写
  `Shepherd-Doc: not-affected <理由>`。它不在 ruleset 的必需项中。
- main 只接受 rebase & merge，线性历史，禁止 force push 与删除；合入前核对 head/base 与证据，串行合入并记录原提交到 rebase 后提交的对应。

## 环境

- 固定工具链：Node 26.10.0、pnpm 12.6.0（见[开发说明](development.md#固定工具版本)），Go 版本由 `native/tailscale/go.mod` 固定
  （`COVE_GO` 或 PATH 上的 `go`）；使用前把它们放在 `PATH` 最前面。
- 只能有一个活跃的协调者；接管前的 Codex 自动化保持暂停。
- 接管前的证据目录、M0 试用 server 与其构建目录不在仓库中；清理或停止它们需要用户同意。
