# 开发环境与工程检查

当前可构建并启动本机的 Cove server（`cove-server`）与 `cove` CLI：M0 的终端链路与测试 harness，M1 的本机
task/workspace 闭环（见[下文](#m1-本机试用与-cli-用法)），以及 M2 的本机安装与用户服务、设备配对与经 SSH、tsnet 的远程操作
（见[下文](#m2-远程-server安装配对与入口)）。还没有 Desktop 或 Mobile 客户端。

## 固定工具版本

以下版本于 2026-09-25 从官方 release index / npm `latest` 核实，均为正式版本。
“最新 release”包含 Node Current，不限定 LTS；不要由本机默认版本隐式替换。

| 工具        | 版本    | 用途                                          |
| ----------- | ------- | --------------------------------------------- |
| Node.js     | 26.10.0 | 开发与当前 CI 运行时                          |
| pnpm        | 12.6.0  | workspace、冻结安装                           |
| TypeScript  | 7.0.2   | tsc、Project References、类型检查             |
| @types/node | 26.6.2  | 工具代码的 Node 类型                          |
| Vitest      | 5.0.2   | 工具链集成测试；后续增加核心与服务端 projects |
| Vite        | 8.3.1   | 当前 Vitest 的构建依赖                        |
| Oxlint      | 1.85.0  | JS/TS lint；类型检查由 tsc 负责               |
| Prettier    | 3.9.9   | 代码、配置与文档格式化                        |

Node 固定在 `.node-version`，Node/pnpm 同时由 `package.json` engines 校验；`packageManager` 固定 pnpm。
直接依赖使用精确版本，间接依赖由根锁文件固定；不在每次安装时查询或升级 latest。
GitHub Actions 固定到正式 release 的 commit：checkout v7.0.1、setup-node v7.0.0、
pnpm/action-setup v6.1.0、upload-artifact v7.0.1。上传 action 的 SHA 由官方
`actions/upload-artifact` v7.0.1 tag 核对。

参考：[Node Current](https://nodejs.org/en/download/current)、[pnpm 安装](https://pnpm.io/installation)、
[Oxlint 配置](https://oxc.rs/docs/guide/usage/linter/config)。

## 安装与日常命令

先用自己的 Node 版本管理工具安装 `.node-version` 指定版本，再安装 pnpm 12.6.0，例如 `npm install --global pnpm@12.6.0`。
每个 checkout 单独安装依赖；可共享 pnpm 内容存储，不共享 node_modules、dist 或 tsbuildinfo。
仓库根目录的 `.npmrc` 固定公共 npm registry；在私有镜像配置的机器上也应使用该项目配置生成根锁文件。
根锁文件由 pnpm 生成，不要手工替换 tarball URL；提交前在干净 checkout 中验证冻结安装。
若使用单独下载的 Node 和 pnpm 可执行文件，应把 Node 的 `bin` 目录和 pnpm
可执行文件所在目录依次放在 `PATH` 最前面。只直接执行一次 pnpm 的绝对路径还
不够：package script 内的 `pnpm` 与 `node` 也必须解析到同一组 pin。安装后用
`command -v node`、`command -v pnpm` 和 `pnpm exec node --version` 一并核对；
不要把登录 shell 的默认 Node 或能自动下载其他版本的用户级 launcher 当作证明。

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
```

| 命令                                | 行为                                             |
| ----------------------------------- | ------------------------------------------------ |
| `pnpm build`                        | 按根 solution 编译，再生成 xterm 浏览器静态资源  |
| `pnpm typecheck`                    | 同一引用图的增量类型检查，会生成/更新产物        |
| `pnpm clean`                        | 清理引用图的 TypeScript 产物                     |
| `pnpm lint`                         | Oxlint，警告也导致检查失败                       |
| `pnpm format` / `pnpm format:check` | 写入格式 / 只检查格式                            |
| `pnpm test` / `pnpm test:watch`     | 运行有 inventory gate 的 Vitest / 交互式持续运行 |
| `pnpm check`                        | 顺序执行格式、lint、构建、测试与 inventory gate  |

当前注册 `protocol`、`client`、`server`、`cli`、`tooling`、`terminal-engine`、
`terminal-engine-probes`、`terminal-worker`、`terminal-web-probes`、`terminal-web-unit` 和
`terminal-web` 十一个 Vitest project（以 `vitest.config.ts` 为准）。`scripts/ci-test-gate.mjs` 的 required suite
inventory 精确列出已有测试文件及最低用例数；`apps/cli/tests/m1/` 例外，每个测试文件旁放同名 `.suite.json`
声明最少测试数，门禁核对两者一一对应。`pnpm test` 先比较 Vitest project
发现结果与它拥有的 `apps/server/tests`、`apps/cli/tests`、`packages/client/tests`、
`packages/protocol/tests`、`tests/tooling`、`packages/terminal-engine/tests`、
`packages/terminal-engine/probes`、`packages/terminal-worker/tests`、
`tests/integration/terminal-worker`、`packages/terminal-web/probes` 和
`packages/terminal-web/tests` 下测试文件，再核验实际 JSON 执行结果与 JUnit 非空。
缺 suite、零用例、skip/pending/todo、失败或未执行均失败。
新增真实包时，在同一 PR 将 tsconfig 加入引用图、将其真实测试根目录及 suite 加入
Vitest projects 和 inventory，
提供对应包脚本，再使用 `pnpm --filter <package> <script>` 做局部验证。`pnpm test:watch` 供开发交互使用，
不产生 CI gate 证据。
根工具配置/测试输出到 `.cache/tooling`；应用包各自设置 rootDir、dist 和 tsBuildInfoFile。
通用配置不注入 Node/DOM 全局类型，由各执行环境显式选择；浏览器/RN 按 bundler 宿主覆盖模块解析与库。
内部依赖使用 `workspace:*`，通过公开 exports 读取编译后的 JS/types，不提供跨包 src alias。

依赖变更由当轮指定写入者执行非冻结安装并提交 manifest 与 lockfile。
pnpm 使用 isolated linker、严格 engines/peer 校验；依赖构建脚本默认未授权，原生包引入时显式配置所需 allowBuilds。
已有 `docs/benchmarks/` 是独立实验，保留其 lockfile 和原始文件，不进入 workspace 或自动格式化/lint。

## M1 本机试用与 CLI 用法

范围、场景与决定见 [M1](milestones/m1.md)。完整用法以 `cove help`（或 `cove --help`）打印的 usage 为准，
`cove help <组>`、`cove <组> --help` 只打印该组（如 `cove help mount`）；
tend 等脚本依赖的 JSON 输出、错误 kind 与退出码见 [Shepherd/tend 集成说明](integrations/shepherd-tend.md)。
首个正式发布前，命令、参数与输出都可能变化。

### 构建与启动

按 [D7](milestones/m1.md#d7-cli-bootstrap安装目录与-server-生命周期选-a)，server 从仓库构建产物前台运行；
试用时用一个单独的 checkout 构建，不在正在开发的 worktree 中运行。

运行 server 与 CLI 的机器需要 **Git 2.45 及以上**。Cove 让 Git 不为缺失的对象联系远端（`GIT_NO_LAZY_FETCH`），
这个变量从 Git 2.45 才有，更早的 Git 会静默忽略它，在 partial clone 中读取缺失的对象时就可能联网 fetch，
即使请求了 `--no-fetch`。因此 server 在启动时检查 `PATH` 上的 `git`，版本过旧、缺失或不报版本时不启动并说明原因；
此后每条 Git 命令都只运行通过检查的那个可执行文件（文件被替换时重新检查，`PATH` 中的相对路径项不搜索；
转交给另一个 Git 的文件，例如 Apple 的 xcrun shim `/usr/bin/git` 或包装脚本，其 `--exec-path` 下的 `git`
既不是它自己，也不是与它内容相同的副本（如 Debian 分别安装的 `/usr/lib/git-core/git`），每条命令前都重新检查版本，因此切换 Xcode 选择后也不会运行旧 Git），
仍不满足时请求以 `GIT_UNAVAILABLE` 拒绝。macOS 上 Apple 的 Xcode Command Line Tools 自带的 Git
（`/usr/bin/git`）可能早于 2.45，需要把更新的 Git（例如 Homebrew 的）放在 `PATH` 中它之前，并用
`git version` 核对。

```sh
pnpm install --frozen-lockfile
pnpm native:prepare
pnpm build
alias cove="node $PWD/apps/cli/dist/main.js"
cove server init [--workspace-root DIR]   # 可省略：start 在未初始化时按默认值初始化
cove server start --harness               # 前台运行；打印 harness 页面地址
```

- 数据目录依次取 `--home DIR`、`$COVE_HOME`、`~/.cove`；数据库为 `<home>/server/cove.db`，
  默认 `workspaceRoot` 为 `<home>/workspace`，随 `--home` / `COVE_HOME` 变化，默认数据目录下即 `~/.cove/workspace`（[D1](milestones/m1.md#d1-workspace-布局fetch-与基准选-a基准规则按用户要求修改)、
  [D5](milestones/m1.md#d5-数据库位置schema-与迁移选-a)）。同一数据目录只允许一个 server。
  一次性试用可另给 `--home`，其他命令使用同一个 `--home` 连接它。
- 其他命令在另一个 shell 中执行，经 `<home>/server/run/rendezvous.json`（或 `--rendezvous`、`$COVE_RENDEZVOUS`）找到 server。
- 停止 server（Ctrl-C）时先打印将受影响的存活 run；再次启动后记录都在，有序停止的旧 run 记为随 server 停止
  （stopped-with-server），崩溃或被强杀后为会话中断（interrupted），都不自动重开或重跑（[D9](milestones/m1.md#d9-重启后的-run-显示选-a)）。
- 目录检查（#172，用户决定 2026-10-22）：数据目录下 Cove 自己管理的目录（`<home>/server` 及其 `run`、`service`、`backups`，
  `<home>/tsnet` 及其 `run`、已存在的 `state`；安装命令使用的 `install`、`bin` 与 `server/log`；数据目录之外的 `--rendezvous` 只有它所在的目录）必须属于当前用户、权限 0700、不是符号链接，
  否则在业务入口与 rendezvous 就绪前启动失败，原因写明目录、属主 uid、权限与规则，Cove 不自动修正。已存在的数据目录本身（自己指定的或早先建立的）
  与它的所有上级目录（包括 `$HOME`）不检查属主与权限，也可以是符号链接；数据目录不存在时 Cove 以 0700 创建。
- server 启动失败时以 1 退出，stderr 先写一行 `{"event":"startup-failed","atMs":…,"category":…,"cleanup":…,"detail":…}`
  （`detail` 不含秘密，最多 512 个字符，控制字符已转义；无可安全报告的原因时为 `null`），再写一行 `cove-server: <原因>`。
- harness 页面列出全部终端 run（tab 的 run 也在其中），点击即可接入；它是 M0 的测试载体，不是 GUI 客户端。

### 命令

所有写命令都接受 `--operation-id ID`：请求在发送前保存在 `<home>/cli`，`cove operation resend ID` 原样重发到同一 server。
带 `--expected-revision N` 的命令在 revision 不符时拒绝；`mount` 的 revision 是 workspace revision。
每个命令向 stdout 输出 JSON，0 为成功，2 为用法错误，1 为其他错误；提示写到 stderr。
显式请求的帮助（`help`、`--help`）把 usage 写到 stdout 并以 0 退出；`cove` 不带参数或 `cove <组>` 不带子命令
仍是用法错误（2），在 stderr 打印 usage，组内的用法错误只打印该组的 usage。

| 领域       | 命令                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务       | `server init [--workspace-root DIR]`、`server start [--port N] [--origin URL]... [--harness [--harness-port N]]`、`status`                                                                                                                                                                                                                           |
| 设置       | `config get`、`config set workspaceRoot <DIR>`、`config reset workspaceRoot`（只影响之后新建的 workspace）                                                                                                                                                                                                                                           |
| Repo       | `repo register <PATH> [--name NAME]`、`repo list`、`repo get <repoId>`、`repo set <repoId> mainBranch <BRANCH>`、`repo set <repoId> displayName <NAME>`、`repo reset <repoId> mainBranch`、`repo remove <repoId>`                                                                                                                                    |
| Task       | `task create <TITLE> [--checkout SPEC]... [--worktree SPEC]...`、`task list [--archived exclude\|include\|only]`、`task get <taskId>`、`task rename <taskId> <TITLE>`、`task archive <taskId>`、`task unarchive <taskId>`                                                                                                                            |
| 挂载       | `mount add <taskId> (--checkout SPEC \| --worktree SPEC)`、`mount remove <taskId> <mountId>`、`mount retry <taskId> <mountId> [--branch B] [--base REF] [--no-fetch]`、`mount convert <taskId> [mountId] [--branch B] [--base REF] [--no-fetch]`、`mount delete-worktree (<taskId> [mountId] \| <PATH>) [--yes]`、`mount history <taskId> <mountId>` |
| 操作       | `operation get <operationId>`、`operation resend <operationId>`、`operation continue <operationId>`、`operation abandon <operationId>`                                                                                                                                                                                                               |
| Tab 与 run | `tab create <taskId> [--name NAME] [--cwd entry\|mount:MOUNT_ID] [--start yes\|no] [--cols N --rows N] [-- <可执行文件> [参数...]]`、`tab list <taskId>`、`tab get <tabId>`、`tab runs <tabId>`、`tab reopen <tabId> [--cols N --rows N]`、`tab stop <tabId> [--run RUN_ID]`、`tab close <tabId>`                                                    |
| 终端       | `terminal create [--cwd DIR] [--cols N] [--rows N] -- <可执行文件> [参数...]`、`terminal list`、`terminal get <runId>`、`terminal stop <runId>`                                                                                                                                                                                                      |

挂载规格：

- `--checkout REPO_ID[,name=NAME][,path=PATH]`：已注册 clone 本身，或用 `path=` 指定它已有、且不由 Cove 管理的
  worktree（`path=` 放在最后）。Cove 不写入 checkout，按约定只用于只读任务，不强制（[D4](milestones/m1.md#d4-共享-checkout选-a不加锁)）。
- `--checkout PATH[,name=NAME]`：同上，直接给目录。CLI 用 `repo list` 与 Git 公共目录找出 PATH 所属的已注册 repo，
  再发送与 `REPO_ID` 写法相同的请求（clone 本身不带 `path=`，其他 worktree 带 `path=`）；不属于任何已注册 repo 时
  不发送并以 1 退出。第一个逗号之前的部分以 `/`、`.`、`~` 开头或含 `/` 时是路径，否则是 repo ID（ID 从不如此），
  因此当前目录写 `.`，名为 `foo` 的子目录写 `./foo`。`~` 只替换为家目录前缀，`..` 在跟随符号链接之后才生效。
  这一查找需要本机 Git 2.45 及以上（同上），且不受继承的 `GIT_DIR` 等环境变量影响；Git 缺失、版本过旧或执行失败时
  各有提示，同样不发送。
- `--worktree REPO_ID[,name=NAME][,branch=BRANCH][,base=REF][,no-fetch]`：在 `<入口>/<NAME>` 新建托管 worktree，
  分支默认 `cove/<slug>`，slug 保留标题的文字与大小写（如 `cove/转换测试`、`cove/Fix-bug`）；该分支已在本地或远端
  跟踪分支中存在时依次改用 `-2`、`-3`…（至多 `-100`），显式 `branch=` 不加后缀。先 fetch `origin`，基准默认
  远端主分支，从不回退到本地 HEAD（D1）。
- `NAME` 默认取 repo 显示名。入口目录中的 `cove-workspace.json` 列出每个挂载的真实路径，checkout 经它访问（D2）。

### 一次典型试用

```sh
cd /path/to/clone
cove repo register .                                     # 注册当前 clone
cove task create "调查" --checkout .                      # 输出中的 taskId；只读调查，直接用已有 checkout
cove tab create <taskId> -- <agent 命令>                   # cwd 为 workspace 入口；在 harness 中接入
cove tab stop <tabId>                                    # 转换前结束使用该 checkout 的 run
cove mount convert <taskId>                              # 需要改代码时把唯一的 checkout 转到独立 worktree（D3）
cove tab reopen <tabId>                                  # 新 run 看到新的 worktree
cove tab stop <tabId>
cove mount delete-worktree <taskId> --yes                # 删除唯一的托管 worktree，分支保留（D10）
```

要指定某个挂载时照旧在 task ID 后给出 mountId；也可以直接给 worktree 路径：
`cove mount delete-worktree <worktree 路径> --yes`。

- `mount convert` 只从提交开始：来源 checkout 的改动计入结果的 `sourceChanges` 并原样留在来源；本 task 有使用该
  checkout 的存活 run（入口 tab 的 run 也算，其挂载映射包含全部挂载）时拒绝（`LIVE_RUNS_PRESENT`）。
  目标核实 ready 之前挂载仍是 checkout。省略 mountId 时转换该 task 唯一的 checkout 挂载；没有或有多个时不发送，
  列出候选（mountId、名称、路径）并以 2 退出。
- 准备失败的 worktree 挂载用 `mount retry` 重试。转换失败时挂载仍是 checkout，`mount retry` 不适用：按 stderr 的提示
  重新执行 `mount convert <taskId> <mountId>` 并加 `--branch NEW`、`--no-fetch` 或 `--base REF`（其余选项重新给出）。
  结果不确定的操作为 `requires_attention`，用
  `operation continue` 继续或 `operation abandon` 放弃，Cove 不盲目重做已生效的步骤。
- `mount delete-worktree` 连同未提交与未跟踪的改动一起删除，终端上 y/N 确认，脚本中必须传 `--yes`；
  有存活 run 使用该 worktree 时拒绝。省略 mountId 时删除该 task 唯一的托管 worktree 挂载，规则同 `mount convert`。
  给出路径（规则同 `--checkout PATH`）时，CLI 按真实路径在全部 task（含已归档）中找出该托管 worktree 所属的 task 与挂载，
  再发送同一请求；路径无法解析（例如目录已不存在）时不发送并以 1 退出，已消失的 worktree 仍用 task ID 与 mountId 删除；
  不是 Cove 托管的 worktree 时同样不发送并以 1 退出：checkout 或非 Cove 的 worktree 用 `mount remove`
  卸下（不删除目录），或自己用 git 删除。`mount remove` 只改 workspace，从不删除目录。
- 两者因 `LIVE_RUNS_PRESENT` 被拒或停下时，stderr 为每个阻塞 run 写一行，给出其 tab 与可直接复制的
  `cove tab stop <tabId>`；不属于任何 tab 的终端 run 给出 `cove terminal stop <runId>`。

## M2 远程 server：安装、配对与入口

范围、场景与决定见 [M2](milestones/m2.md)。M2 让每台执行主机在本机安装 server 并作为用户服务运行，其他设备经一次性邀请配对后，
用 `--server <别名>` 经 SSH 或 tsnet 入口远程操作它；Desktop 不在线也可操作。Cove 不使用系统 Tailscale：server 与客户端都只用
自己内嵌的 tsnet 节点（D9），主机上不需要安装 tailscaled。tend 等脚本依赖的接口见 [Shepherd/tend 集成说明](integrations/shepherd-tend.md)。
设计见 [Server 架构 §§4、5、9](server-architecture.md#4-host-网络和内置-tailscale)。

一次两台机器的典型流程（devbox 是执行主机，laptop 是客户端；每台主机都在本机用自己的 CLI 安装）：

```sh
# devbox：在一个单独的构建 checkout 中 pnpm install --frozen-lockfile、pnpm native:prepare、pnpm build 之后
node apps/cli/dist/main.js server install            # 安装闭包、注册并启动用户服务
~/.cove/bin/cove server entry set sshTarget me@devbox.example   # 邀请中写入的 SSH 目标（经 SSH 配对时需要）
~/.cove/bin/cove server tsnet login                  # 可选：让 server 节点加入 Tailnet（auth key 经提示或 stdin）
~/.cove/bin/cove auth invite create                  # 输出一次性邀请，只显示这一次
# laptop 经 SSH 配对：先用普通 ssh 记录 devbox 的 host key
cove remote add devbox --via ssh                     # 在提示中粘贴邀请
cove --server devbox task list                       # 之后所有业务命令都可远程执行，走 SSH
```

或者经 tsnet 配对（另一个客户端，或代替上面的 SSH 配对；devbox 已 `server tsnet login`，邀请含 tsnet 入口）：

```sh
cove remote tsnet login                              # 客户端自己的节点登录同一 Tailnet
cove remote add devbox --via tsnet                   # 在提示中粘贴邀请
cove --server devbox task list                       # 走 tsnet
```

已知限制（#173，将改为记录邀请中的全部入口）：目前从另一台主机配对时，配对记录只保存配对所用的那一个入口
（`--via ssh` 只有 ssh，`--via tsnet` 只有 tsnet），因此这台客户端不能再用 `--via` 换到另一个入口；同一客户端也不能把同一 server
再配对一次（`remote add` 拒绝已配对的 serverId）。现在只有在 server 所在主机上不带 `--via` 配对时，记录才同时含 loopback、
邀请中的 ssh 与 tsnet 入口，可用 `--via` 切换（见下文“设备配对与 `--server`”中的数据目录 B）。

### 安装与用户服务

范围与决定见 [M2](milestones/m2.md)（D1–D3、S1、S2）。前提：本 checkout 已 `pnpm build`、`pnpm native:prepare`，
`pnpm` 与 Go（`COVE_GO` 或 PATH 上的 `go`，版本见 `native/tailscale/go.mod`）可用，并用 `.node-version` 的 Node 运行 CLI。
server 需要 Git 2.45 及以上（见上文“构建与启动”）。服务管理器不提供登录 shell 的环境，服务单元的 `PATH` 是固定顺序的
系统目录 `/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`；执行 `cove server install` 的 shell 在 `PATH` 中最先找到的
`git` 所在目录不在其中时，才加在它们之前（#177）。所以那个 `git` 在系统目录之外时，`git version` 检查的就是服务使用的 Git；
它在某个系统目录中时，服务按上述固定顺序使用最先找到的 `git`（例如有 `/usr/local/bin/git` 时用它而不是 `/usr/bin/git`），
应检查那一个（如 `/usr/local/bin/git version`）。换用别的 Git 后重新执行 `cove server install` 以重写服务单元。

```sh
node apps/cli/dist/main.js server install          # 从本 checkout 构建闭包并安装、注册、启动服务
~/.cove/bin/cove server status                      # 之后用安装的 CLI；它不需要 PATH 上有 Node
~/.cove/bin/cove server entry get                   # 固定的业务与配对端口（install 时选定，20000–29999）
~/.cove/bin/cove server restart                     # 先列出将结束的 run 与平台后果；确认后才重启（脚本用 --yes）
node scripts/runtime-closure.mjs build --out DIR    # 只构建一个封好的闭包；`server install --closure DIR` 安装它
```

- 闭包：`<home>/install/<build>/` 含 `bin/node`（固定版本）、`bin/cove-tsnet`、`app/`（`pnpm deploy --prod` 的 CLI、server、
  worker 与原生模块）与 `cove-install.json`（build、schema 版本与内容摘要）。装好后不再修改；`current` 原子切换，
  服务单元与 `<home>/bin/cove` 只引用 `current`。`cove server prune` 删除既不是 `current` 也不在运行的 build。
  build ID 覆盖闭包全部内容与 cove-tsnet 本身：用占位 ID 构建一次 cove-tsnet 并计入其摘要，再用最终 ID 重建，所以 Go
  源码、工具链、构建参数与 `GOAMD64`/`GOARM64` 等环境都会改变 build ID。带 `--build` 的 cove-tsnet 构建不嵌入 Go 的
  VCS 信息（`-buildvcs=false`），所以 `git archive` 导出的源码即使位于另一个 Git 仓库之内也能构建；开发构建
  （`pnpm tsnet:build`）只在 checkout 根目录本身是 Git 工作树时嵌入提交（`dev+<提交>`），否则为 `dev+unknown`。
  同一提交在不同路径的 checkout 中构建出的 build ID 不同（pnpm 按源路径命名 workspace 包），只多一个安装目录。
- stamp 另记录来源 checkout 的 source build（`source`，#175）：开发 build ID 的文件加 cove-tsnet 的 Go 源码，不含 Node、
  原生模块与路径，同一提交在任何机器、OS 与路径上都相同。远程命令的 build 提示（D12）在 CLI 与 server 都有 source build
  时比较它，不同才在 stderr 写 `cove: warning: <别名> runs source build <X>, this CLI is source build <Y>`；任一方没有时
  比较 build ID（`runs build <X>, this CLI is build <Y>`）。不同平台的同一提交因此不再每次提示。
  已安装的同名 build 只有内容摘要相同才复用，否则拒绝安装。
- 安装新 build 不替换正在运行的 server：`server status` 显示 `pendingBuild`，`server restart`（或一步完成的
  `server upgrade`）之后才生效。
- 启动等待：`install`、`service start`、`restart` 与 `upgrade` 启动服务后最多等 90 秒，直到新实例应答。其间服务输出
  （macOS 为 `service.log` 的末尾，Linux 为 `journalctl --user -u`，读取有字节、行数与时间上限，读不到时不影响命令）中
  出现本次启动之后的 `startup-failed` 事件时，立即在 stderr 写
  `cove: the server failed to start: <原因>; waiting for the service manager to start it again`，
  仍继续等待（服务管理器会再启动它）；服务管理器因反复崩溃放弃重启时立即以 1 失败；超时的错误也带上最近一次的原因。
- 非终端下 `restart`、`upgrade`、`service stop` 与 `uninstall` 拒绝时（退出 2），除 stdout 的 JSON 外，在 stderr 列出
  将结束的 run 与全部平台后果（与终端确认时显示的内容相同）。
- server 是否在运行：能连上即为运行；连不上时看它的实例锁（`<home>/server/cove.lock`，server 存活期间一直持有）：
  没有进程持有才算已停止。锁被持有却连不上（握手超时、容量拒绝、启动中或卡住）时状态未知：`restart`、`upgrade`、
  `service stop` 与 `uninstall` 照样要求确认，但无法列出 run，`--yes` 才继续（这也是停止一个不再应答的 server 的办法）；
  `prune` 拒绝删除任何 build；`service start` 与 `install` 不动服务。`server status` 的 `serverState` 为
  `running`、`stopped` 或 `unknown`（附 `serverError`）。
- 安装锁（`<home>/install/.lock.sqlite`）是随进程结束而释放的 OS 锁，崩溃的命令不留下需要接管的锁；第二个安装命令立即被拒绝。
- 服务：macOS 为 `~/Library/LaunchAgents/dev.cove.server.<摘要>.plist`（gui 域，登录时启动、注销时停止，日志在
  `<home>/server/log/service.log`）；Linux 为 `~/.config/systemd/user/cove-server-<摘要>.service`（日志用 `journalctl --user -u`）。
  `<摘要>` 取自数据目录的真实路径，不同数据目录各有一个服务。Linux 需要 linger 才能在注销后与开机后运行：
  `sudo loginctl enable-linger $USER`（CLI 只提示，不执行 sudo）。没有 systemd user 的主机继续用前台 `cove server start`。
- 崩溃重启有上限：systemd 单元 300 秒内最多启动 5 次；launchd 没有这种上限，由 server 自己计数，300 秒内第 6 次崩溃重启时
  记录一次有序停止并以 0 退出（launchd 不再重启），在 `service.log` 写明原因。两种情况下 `cove server service status`
  显示 `stoppedAfterCrashes: true`，`cove server service start` 重新开始计数。通过计数检查后才失败的启动（worker 启动、
  监听端口、发布 rendezvous）不记录有序停止，下一次启动仍算崩溃重启。server 来不及读到计数就崩溃时（闭包无法加载、
  数据目录无法打开），launchd 仍会每 5 秒（ThrottleInterval）重启它，没有上限。
- 停止与重启的后果：systemd 用默认的 `KillMode=control-group`，停止或重启服务会结束 cgroup 内全部进程，**包括在 Cove
  终端里用 `nohup`、tmux 等脱离的进程**，前台 `cove server start` 则不会。macOS 上由 launchd 停止或重启 server（`bootout`）时，
  Cove 终端里用 `nohup` 脱离的进程在测试中继续运行（本机 macOS 26 arm64 观察，S2 在 CI 中记录）；这是 launchd 与进程会话
  的行为，不是承诺，注销场景未验证。
- 回退：`cove server install --activate <build>` 切换到已安装的 build，先用目标 build 检查数据库 schema；新版本启动时
  会前进迁移，所以只有与当前 schema 兼容的旧版本能激活，否则拒绝且数据库不变。确需回到不兼容的旧版本时：
  1. `cove server service stop --yes`；
  2. 用迁移前留下的备份替换数据库：把 `<home>/server/backups/` 中旧 build 的 schema 对应的最新备份
     （`cove-schema-<旧 schema>-<时间>-*.db`）复制为 `<home>/server/cove.db`，并删除
     `cove.db-wal` 与 `cove.db-shm`（备份之后写入的记录会丢失）；
  3. `cove server install --activate <旧 build>`，再 `cove server service start`。
     Cove 不自动降级数据库，也不代为执行这些步骤。
- `cove server uninstall --yes` 停止并移除服务单元、全部已安装 build 与 `<home>/bin/cove`，数据目录（数据库、身份、设备）保留。
- 测试：`apps/cli/tests/m2/s1-*`、`s2-*` 注册真实的用户服务，名称取自临时数据目录，只在 `COVE_TEST_SERVICE_MANAGER=1`
  时运行（CI 的 check job 设置它）；本机运行它们会在当前用户的 gui 域或 systemd user 管理器中短暂注册并移除测试服务。

### 入口配置

入口配置保存在 server 的数据库中，`cove server entry get` 输出 `{ revision, settings, restartRequired }`：

| 项              | 含义                                                                   | 生效            |
| --------------- | ---------------------------------------------------------------------- | --------------- |
| `businessPort`  | loopback 业务端口（HTTP RPC 与终端 WS）；SSH 与 tsnet 都转发到它       | server 下次启动 |
| `pairingPort`   | loopback 配对端口，只在有未结束的邀请时监听                            | server 下次启动 |
| `sshTarget`     | 邀请中写入的 SSH 目标 `[user@]host`；未设置时没有 SSH 入口，不自动推断 | 下一个邀请      |
| `tsnetHostname` | server tsnet 节点的主机名，默认 `cove-<主机名第一个点之前的部分>`      | server 下次启动 |

`cove server entry set <名> <值>` 与 `entry reset <名>` 是普通写（可带 `--expected-revision`、`--operation-id`），需要重启的项在
stderr 提示 `cove server restart`。`server entry`、`server status` 与 `server impact` 也可经 `--server` 远程使用，其他 `server`
子命令只作用于本机。`cove server start` 不带 `--port` 时绑定配置的业务端口，`--port N` 只覆盖这一次启动。
既没有 `sshTarget`、server 的 tsnet 节点也不可用时，`auth invite create` 以 `ENTRY_UNAVAILABLE` 失败。

### 设备配对与 `--server`

范围与决定见 [M2](milestones/m2.md)（D4–D8、D11）。loopback 入口是同一主机上的 server，SSH 入口经系统 `ssh` 连到另一台主机，
tsnet 入口经客户端自己的 Tailnet 节点（见下文“客户端 tsnet”）。下面用同一台机器上的两个数据目录模拟两台设备：

```sh
cove --home A server start                           # 或已安装的服务；前台运行时在另一个 shell 中执行下面的命令
cove --home A server entry set sshTarget me@devbox.example
cove --home A auth invite create [--ttl-minutes N]   # 输出邀请，只显示这一次
# 客户端（数据目录 B），从提示或 stdin 粘贴邀请，不经命令行参数
cove --home B remote add box [--name laptop]         # 不带 --via：同一主机，默认 loopback，另记邀请中的 ssh 与 tsnet 入口
cove --home B --server box status                    # 或 COVE_SERVER=box
cove --home A auth device list                       # 本机所有者也能管理设备
cove --home B --server box auth device rotate        # 轮换本客户端自己的 token
cove --home A auth device revoke <deviceId>
# 另一台主机上的客户端（数据目录 C）经邀请中的 SSH 目标配对，之后默认走 SSH
cove --home C remote add devbox --via ssh
cove --home C --server devbox status
cove --home B --server box --via ssh status          # 同一主机配对的记录也有 ssh 入口
cove --home B remote entry default box ssh           # 改默认入口；失败时从不自动换入口
```

- loopback 入口只核对 server 回报的 serverId：它识别 server，但不证明对端就是它。同一主机上的其他进程抢先占用端口
  并冒充 server 的情况不在防护范围内（见 [relay-protocol §11.8](relay-protocol.md)）。
- 配对监听是单独的 loopback 端口，只在有未结束的邀请时开放。邀请默认 10 分钟有效，最长 24 小时，
  错误 secret 达到 5 次后作废。兑换的响应丢失时不能重试：重新创建邀请，那次留下的设备显示为 never-connected，可以撤销。
- token 保存在 `<home>/client/servers/<serverId>.json` 中（0600，所在目录 0700），server 只保存其哈希。
  `remote remove` 只删除本机记录，不撤销 server 上的设备。修改记录的命令（`auth device rotate`、`remote entry default`、
  `remote remove`）持有同目录下 `<serverId>.lock.sqlite` 上的锁并合并到最新记录，因此并发执行时依次进行，最后保存的 token 就是有效的那个；
  rotate 从读取 token 到新 token 首次使用一直持有该锁。这是随持有进程存在的 OS 锁（SQLite 排他事务）：
  持有者无论怎样退出，锁都由内核释放，不需要接管；锁文件不含内容，`remote remove` 后也保留，不要手工删除。
- `--server` 模式下路径参数是 server 主机上的路径：相对路径与 `~` 是用法错误，不发送；绝对路径原样发送，
  `terminal create` 必须给 `--cwd`。CLI 不在本机文件系统上解析这些路径：`mount delete-worktree PATH` 要在本机
  解析真实路径，因此 `--server` 模式下以 2 拒绝，须改用 `<taskId> <mountId>`。`remote` 组与除 `server entry/status/impact`
  之外的 `server` 子命令只作用于本机，给 `--server` 时以 2 退出。
- 撤销会立即拒绝该设备的所有请求，并关闭它的连接（终端连接持有的控制权随之释放）；它已受理的操作照常完成。
  `auth device revoke` 等这些连接关闭后才返回，响应中的 `unclosedConnections` 是等待期限内仍未关闭的连接数，
  不为 0 时命令以 1 退出。设备撤销自己时同样如此：server 先关闭它除承载这次撤销的请求之外的所有连接（包括 CLI
  自己的终端连接），再应答，应答发出后才结束那个请求；CLI 因此用一个不依赖终端连接的单独 HTTP 请求发送自我撤销。

### SSH 入口

- 每条命令启动一个系统 `ssh -N -L 127.0.0.1:<本地端口>:127.0.0.1:<server 端口>`，命令结束（包括被 kill）时随之结束；
  ssh 在 `sh` 监督进程下运行，监督进程在 CLI 的管道关闭时结束 ssh，不留下孤儿进程。
- 使用用户自己的 ssh 配置、agent 与 known_hosts。命令行固定 `BatchMode=yes`、`StrictHostKeyChecking=yes`、
  `NoHostAuthenticationForLocalhost=no`、`ExitOnForwardFailure=yes`、`GatewayPorts=no`、`UpdateHostKeys=no`，
  并关闭连接复用（ControlMaster）；ssh 认识时还固定 `NoHostAuthenticationForProxyCommand=no`（Apple 的 ssh）与
  `ForkAfterAuthentication=no`（OpenSSH 8.7 起）。命令行选项优先于用户配置，因此用户配置中的 `GatewayPorts yes`、
  `ControlPersist`、跳过本机或 ProxyCommand 目标 host key 检查的设置以及 `ForkAfterAuthentication yes`，都不会关闭
  host key 检查、让转发监听非 loopback 地址或在命令后继续存在。每次建隧道前先用 `ssh -G` 解析目标的实际配置：
  ssh 不认识的可选项不加，解析结果中 host 认证未开启、会 fork 或固定项未生效时，命令报 `ENTRY_UNAVAILABLE` 且不连接。
  CLI 不写 known_hosts：第一次连接某台主机前，先用普通 `ssh <目标>` 确认并记录它的 host key。
- host key 未知或不符时，ssh 在建立转发前失败，命令报 `ENTRY_UNAVAILABLE` 与 ssh 的最后一行输出，不发送 token 或邀请。
  隧道建立后先核对 serverId，再交出 token。
- 经隧道的请求以隧道本地端口作 Host。server 接受任何 loopback IP 字面量 Host（`127.0.0.1:<端口>`、`[::1]:<端口>`，
  用户决定 2026-10-22），只拒绝域名 Host（DNS rebinding 必然带域名）与 `localhost`，因此 CLI 不改写 Host。
- 入口失败时命令以 1 退出，列出记录中的入口；不会改用其他入口，需要时用 `--via` 或 `remote entry default`。

SSH 场景测试（`apps/cli/tests/m2/s5-*`、`s6-*`、`s7-*`）用 `sshd-fixture.mjs` 自起一个非特权 sshd：独立配置、
测试生成的 host key 与客户端 key、127.0.0.1 上的高端口、`UsePAM no`。客户端经 PATH 上的 `ssh` 包装加 `-F`
使用夹具自己的 ssh 配置与 known_hosts，不读取操作者的 `~/.ssh`。找不到 sshd 时这些用例以原因失败而不是跳过（门禁把跳过的必需用例算作失败）。

### server 的 tsnet 节点

范围与决定见 [M2](milestones/m2.md)（D6、D9、D10、S9）。server 自己的 Tailnet 节点由它监督的子进程 `cove-tsnet serve`
承载（[本机协议](../native/tailscale/PROTOCOL.md)），状态在 `<home>/tsnet/`（0700），不需要也不使用系统 Tailscale。

```sh
cove --home A server tsnet login     # auth key 从隐藏提示或 stdin 读；输入为空则在 stderr 显示一次登录 URL 并等待完成
cove --home A server tsnet status    # { state, hostname, nodeId, nodeName, hold, ports, warnings }
cove --home A server tsnet logout    # 删除节点状态；控制面未确认时在 stderr 提示到管理控制台删除该节点
```

- CLI 整组只作用于本机（不接受 `--server`）。RPC 权限上，`server.tsnet.login` 与 `logout` 是 local-owner 方法（设备调用为
  `FORBIDDEN`）：远程登录或登出可能切断请求本身所走的入口；`server.tsnet.status` 是普通读方法，设备经 RPC 也可调用。
- 在隐藏提示处直接回车（空行）是交互登录；Ctrl-C、Ctrl-D、终端断开或输入在回车前结束（已输入的部分不算提交）取消命令并以 130 退出，不保存待定记录、不发送请求
  （对已登记的节点开始登录会使它保持 hold，直到登录核实）。
- 交互登录时 CLI 最多等待 5 分钟；超时后输出 `{ operation, status }` 并以 1 退出，但节点仍在等待，之后打开 URL 批准，
  登录仍会完成。超时不等于失败：用 `cove server tsnet status` 查看结果，不要因此重新登录。
- 节点有状态（`<home>/tsnet/state` 存在）时随 server 启动，否则直到第一次 login 才启动 `cove-tsnet`，从未登录的 server
  不启动任何进程、不连控制面。server 启动不等节点就绪。`cove-tsnet` 意外退出或无法启动（例如可执行文件缺失）后按 1 秒起、
  翻倍到 60 秒的退避重启（实际运行满 60 秒后才回到 1 秒，status 说明无法启动的原因），恢复原状态而不重新登录；PTY、run 与 loopback、SSH 入口不受影响。本机协议不兼容时不重启，
  status 说明原因。server 停止时关闭它的 stdin（有序停止），最多等 20 秒后才强制结束。
- logout 删除节点状态后（#175），没有其他 login 或 logout 进行时，server 以同样的有序停止结束 `cove-tsnet`，不再重启，
  status 在本地回答 `logged-out`；下一次 login 等这次停止结束后启动新的 `cove-tsnet`。失败或结果不明的 login 之后不停止它
  （交互登录可能仍在浏览器中完成）。
- 节点只监听业务端口（与 loopback 业务端口同号）以及有未结束邀请时的配对端口（同号）；每个连接由 `cove-tsnet` 转交给对应的
  监听，与 loopback 连接经过同样的原始连接上限、凭据检查与准入，WhoIs 对端只用于显示与设备的最后入口记录。节点运行、无身份保留
  且两个端口都已开放时，邀请写入 `entries.tsnet = { nodeId, name }`；节点不可用时邀请只有 SSH 入口，两者都没有时为 `ENTRY_UNAVAILABLE`。
- login 与 logout 是有操作记录的写：结果不确定（`cove-tsnet` 无应答或中途退出，server 中途停止）时记录为 `requires_attention`
  （`RESULT_UNKNOWN`），用 `server tsnet status` 判断节点状态，不自动重做。`TSNET_IDENTITY_CHANGED`（登录成了另一个节点：先 logout，
  再用正确的 key 登录，并重新配对客户端）、`TSNET_LOGIN_UNCERTAIN`（未完成且可能已生效，status 会澄清）与 `TSNET_LOGIN_FAILED`
  （节点不变，包括已经登录）以 1 退出。登录或登出进行中 status 报 `BUSY`，稍后再问。
- auth key 只在请求的输入秘密中，经 stdin 帧交给 `cove-tsnet`，不进 argv、环境变量、日志、数据库、操作记录与 CLI 待定记录
  （因此这次请求不能 `operation resend`，重新运行命令即可）；登录 URL 只出现在发起这次登录的应答中，CLI 只写到 stderr。
  `cove-tsnet` 的 stderr 写入 server 日志前替换其中的 URL。
- 开发与测试专用的环境变量与客户端相同：`COVE_TSNET_BINARY`（`cove-tsnet` 的绝对路径）与 `COVE_TSNET_CONTROL_URL`
  （测试控制面）只在开发 workspace 中生效；安装闭包中设置了它们时 server 不启动 tsnet 节点（status 说明原因）。

测试：`apps/cli/tests/m2/s9-tsnet-supervisor.test.mjs` 与 `s9-tsnet-login.test.mjs` 用脚本化的假
`cove-tsnet`（`s9-fake-tsnet.mjs`）；`s9-tsnet-node.test.mjs` 是 S9，用真实 `cove-tsnet` 与一个对端节点加入 testcontrol 的测试 Tailnet
（`TS_PANIC_IF_HIT_MAIN_CONTROL=1`），可执行文件构建到 `.cache/tsnet-test/<源码摘要>/`，需要 `native/tailscale/go.mod`
固定的 Go（`COVE_GO` 或 PATH 上的 `go`），找不到时以原因失败而不是跳过。真实 Tailnet 与两台机器的验证在 CI 之外进行。

### 客户端 tsnet

客户端的 Tailnet 节点由每个 OS 用户与 Cove 数据目录（`--home`）一个、按需启动的 `cove-tsnet dial` 常驻进程承载，状态在 `<home>/tsnet-client/`
（0700），不需要系统 Tailscale。CLI 找 `cove-tsnet` 的顺序：安装闭包的 `bin/cove-tsnet`，再是开发 checkout 的
`native/tailscale/dist/<平台>-<架构>/cove-tsnet`（`pnpm tsnet:build`）；都没有时 tsnet 入口报 `ENTRY_UNAVAILABLE`。

```sh
cove --home B remote tsnet login          # auth key 从隐藏提示或 stdin 读；输入为空则在 stderr 显示登录 URL 并等待
cove --home B remote tsnet status         # 节点状态、活动流与 dial 进程（pid、build）
cove --home C remote add devbox --via tsnet   # 经邀请中 server 节点的稳定 ID 配对，之后默认走 tsnet
cove --home B --server box --via tsnet status # 同一主机配对时也记录邀请中的 tsnet 入口
cove --home B remote tsnet logout [--yes] # 有活动流时不带 --yes 列出它们并以 1 退出；带 --yes 先关闭再登出
cove --home B remote tsnet stop [--yes]   # 只结束 dial 进程（状态保留）；从不启动；锁被占用而无应答时以 1 退出
cove --home B remote tsnet config --idle-timeout 30m   # 空闲退出期限（默认 10m），下次启动生效
```

- 每条经 tsnet 的命令先连 `<home>/tsnet-client/run/dial.sock`（0600），连不上时以脱离的方式启动 dial 进程并在
  10 秒总期限内循环连接与重新启动（一个绝对期限，识别可执行文件、连接、hello 与替换旧版本的 stop 共用；自己启动的进程
  正常退出、退出码 75 或被信号结束时重新启动，退出码 1、2 立即失败）；期限用尽报 `ENTRY_UNAVAILABLE`，附 `run/dial.log` 的末尾。
  `remote tsnet stop` 用 `cove-tsnet dial-owned` 查看锁：只有没有 hello 且锁空闲时才报告没有 dial 进程。重试只发生在提交请求之前；
  流建立并转发字节后，连接中断就是连接中断，不重发。dial 进程没有活动流时空闲 10 分钟退出，先删 socket 再释放锁。
- 每条流按配对记录中 server 节点的稳定 ID 请求，dial 进程用 WhoIs 核对对端后才转发（`PEER_MISMATCH` 时拒绝），
  CLI 再核对 serverId，之后才发送 token 或邀请 secret。节点名称只用于显示。后续连接的流被拒时（身份保留、`PEER_MISMATCH`），
  该连接不转发任何字节，命令失败时的错误给出原因；配对时同样如此；命令自己处理的失败（例如写已受理、读回失败时输出回执并以 1 退出）
  另在 stderr 写出原因，回执与退出码不变。
- 版本：dial 进程的 build 与 CLI 将启动的 `cove-tsnet` 不同时，没有活动流就请它退出并启动当前版本；
  有活动流时绝不替换——本机协议兼容则沿用并在 stderr 警告，不兼容则报错并列出活动流（等待其结束或 `remote tsnet stop --yes`）。
- 登录结果按 dial 进程的回答报告：`IDENTITY_CHANGED`（登录成了另一个节点，先 logout 再用正确的 key 登录）与
  `LOGIN_UNCERTAIN`（未完成且可能已生效，先看 status）以 1 退出；status 中的 `hold` 表示节点在此期间拒绝流；
  logout 的 `remoteLogoutConfirmed: false` 表示本地状态已删除但控制面未确认，需要在管理控制台删除该节点。
- 交互登录时 CLI 最多等待 5 分钟，超时后以 1 退出（提示仍可能完成），但节点仍在等待，之后打开 URL 批准，登录仍会完成；
  用 `cove remote tsnet status` 查看结果，不要因此重新登录。
- auth key 不进 argv、环境变量、日志与客户端文件；登录 URL 只显示在 stderr，不进 JSON 输出。
- 开发与测试专用的环境变量（不是回退路径，正常使用时不要设置）：`COVE_TSNET_BINARY` 指定 `cove-tsnet` 的绝对路径
  （设置时是唯一候选），`COVE_TSNET_CONTROL_URL` 让 dial 进程连到测试控制面。它们只在开发 workspace 中生效；
  安装闭包（T3 的 `<home>/install/<build>/`，根目录有 `cove-install.json`）中设置了它们时，tsnet 入口在启动 dial 进程、
  发送任何内容之前以错误退出（`remote tsnet` 命令在读取输入之前；`remote add` 此时已在本机读过邀请，但没有发送），
  并始终使用闭包自己的 `bin/cove-tsnet`。CLI 与 server 用同一个查找（`@cove/server/build-id` 的 `tsnetBinaryPath`）。

tsnet 场景测试（`apps/cli/tests/m2/s7-tsnet-*`、`s8-*`）用 `scripts/tsnet-build.mjs` 把当前 build、另一 build ID 的
同一源码（模拟旧版本）与仅供测试的 `cove-tsnet-testcontrol` 构建到 `.cache/tsnet-test/<源码摘要>/`，同一轮测试共用；
需要 `native/tailscale/go.mod` 固定的 Go（`COVE_GO` 或 PATH 上的 `go`），找不到时以原因失败而不是跳过。
所有节点只加入 testcontrol 的测试 Tailnet（`TS_PANIC_IF_HIT_MAIN_CONTROL=1`）。`s8-tsnet-server-node` 用 server
自己的 tsnet 节点（T5b）：`server tsnet login` 后按邀请的 `entries.tsnet` 经 tsnet 配对并运行命令。其余场景为了单独
控制 server 节点（占用名称、重启、记录收到的字节），自己运行 `cove-tsnet serve`，把业务端口与配对端口转发到 server 的
同号 loopback 端口，并把 serve 节点写入邀请；协议不兼容、身份冻结、未确认的登出与 `PEER_MISMATCH` 用脚本化的假
dial 进程（`tsnet-fake-dial.mjs`）覆盖。

## B0 实验环境

Q1 浏览器查询与输入实验使用编译出口 `@cove/terminal-web/probes/query-input`，从同一 Vite fixture 的 `query-input` 模式启动托管 Chromium。命令 `pnpm --filter @cove/terminal-web --fail-if-no-match test` 运行十项必需浏览器测试；单独复现可在构建和安装浏览器后执行 `node packages/terminal-web/dist/probes/node/query-input.js queries`（也可用 `keyboard`、`paste`、`mouse`、`split-mixed`、`lifetime`）。探针输出合成字节、浏览器版本和动作证据；它只证明浏览器侧 xterm 输入来源和查询抑制，不连接真实 PTY。

`@cove/terminal-engine` 公开根入口 `createTerminalModel`，负责一个权威 headless 模型的 FIFO 解析、有限恢复快照、当前屏幕预览和实时查询/焦点回复；其五个 `terminal-engine` suite 通过编译后的根出口验证这些边界。引擎包仍保留 `./probes/environment` 与 `./probes/recovery-boundaries` 实验入口，`@cove/terminal-web` 公开 `./probes/environment` 与 `./probes/query-input`；实验入口均非生产 API。引擎环境探针用稳定版 headless `6.0.0`、serialize `0.14.0` 和 node-pty `1.1.0`，启动一个自己的 Node PTY 子进程验证 nonce 回应、尺寸、退出与小型 VT 序列化往返；后者用 xterm `6.0.0`、Vite `8.3.1` 和 Playwright `1.63.0` 构建静态 fixture，在托管 Chromium 中验证缓冲区、几何与键盘输入。

首次安装与复验使用以下命令。macOS 的浏览器下载只写入本 checkout 的 `packages/terminal-web/.cache/playwright`；Ubuntu CI 的 `browser:install` 在一次性 runner 中加 `--with-deps` 安装系统库，本地 macOS 不自动修改系统依赖。

```sh
pnpm install --frozen-lockfile --config.side-effects-cache=false
pnpm native:prepare
pnpm --filter @cove/terminal-engine --fail-if-no-match build
pnpm --filter @cove/terminal-engine --fail-if-no-match test
pnpm --filter @cove/terminal-web --fail-if-no-match build
pnpm --filter @cove/terminal-web --fail-if-no-match browser:install
pnpm --filter @cove/terminal-web --fail-if-no-match test
pnpm check
```

node-pty `1.1.0` 发布包的 macOS `spawn-helper` 缺可执行位（[上游问题 #850](https://github.com/microsoft/node-pty/issues/850)）。`pnpm native:prepare` 验证精确版本和实际加载的 `.node` 文件位置；仅在 macOS 发现辅助程序不可执行时，将本 checkout 安装目录里的硬链接复制成新文件，再原子替换并设置 `0755`，不改 pnpm 共享内容存储。Linux 的 `binding.gyp` 不构建这个 macOS 专用 helper，因此只核对本 checkout 中实际加载的 native 文件。`pnpm check` 和引擎包 `test` 会显式调用该准备脚本。原生加载或准备失败使检查失败，不会跳过。

serialize 发布声明引用浏览器 xterm 类型但未声明其依赖；引擎探针只在运行时校验并使用 serializer 的公开构造器/方法，以保持 Node 编译配置没有 DOM。Web 的 Node runner 与浏览器 fixture 分开编译；Playwright 的 Node API 声明也引用 DOM，所以 runner 只描述所调用的公开运行时方法。浏览器测试必须先显式安装固定 Playwright 对应的 Chromium `1243`；缺浏览器、静态资源、native 文件或真实交互都会失败。以上探针不验证完整终端恢复、查询回复来源、远端运行、移动端或 100 PTY 容量。

两个编译后探针各有整体工作期限和独立、有限的资源清理期限，测试进程上限高于两者之和。测试还用分阶段延迟迫使整体期限到期，核验 PTY 子进程、临时目录、Chromium 和本地 HTTP listener 的清理结果。PTY 尺寸探针在同一期限内轮询子进程报告的实际尺寸。Web fixture 的 Vite 构建同时拒绝直接、动态、间接引入的 Node 内置模块和原生包；独立负例构建覆盖这些导入形式。

Web 探针从已安装的 `playwright-core/browsers.json` 读取 Chromium revision 和版本，要求可执行文件位于本 checkout 对应的托管 revision 目录，并在连接后核对浏览器实际报告的版本。结果记录 revision、实际版本和规范化的可执行文件路径；错误选择或版本不匹配会使检查失败，并清理已启动的浏览器与 listener。

## P1a 临时协议与 M0 支持契约

`@cove/protocol` 保留 `./provisional/terminal` 与 `./provisional/pipe` 两个实验入口，并新增 M0 的 `./identity`、`./errors`、`./profile`、`./budgets`、`./terminal`、`./pipe`、`./runtime`、`./bootstrap`、`./rpc`、`./view` 编译契约入口。入口提供 Zod 身份与元数据 schema、交叉身份与基线块约束，以及接收/发送 `Uint8Array` 的帧编码器和增量解码器。调用方先校验元数据，自己完成 JSON 与 UTF-8 转换；接收方使用 fatal UTF-8 解码，只解析已经完整且不超过 4096 字节的元数据，再用对应 `validateTerminalFrame` 或 `validatePipeFrame` 核对头部 kind、身份和 payload 约束。具体组合例子见 `packages/protocol/tests/composition.test.mjs` 与 `packages/protocol/tests/consumer-contracts.test.mjs`。

帧有 16 字节头部，metadata 最多 4096 字节、payload 最多 65536 字节。一次 `read` 至多消耗 256 KiB 输入并交付 32 帧和 256 KiB 完整帧；返回 `consumedBytes`，调用方保留未消耗的输入，在下次调度重试。`finish` 遇半帧报错并关闭解码器。解码器只持有已收到的半帧字节（`storageBytes`），校验通过的帧头不预分配其声明长度。支持契约定义 profile、输入控制、RPC 与 worker pipe 的纯 schema/校验器；库不启动 PTY、安装基线或实现 server/worker/controller 状态机。

```sh
pnpm --filter @cove/protocol --fail-if-no-match build
pnpm --filter @cove/protocol --fail-if-no-match test
pnpm check
```

Zod `4.6.5` 的自身声明在 `v4/core/schemas.d.cts` 的未使用 URL helper 中引用标准 `URL` 全局类型，故完整传递依赖声明无法在 `lib: ["ES2024"]`、`types: []`、`skipLibCheck: false` 下原样通过。协议包仅在自己的 tsconfig 使用 `skipLibCheck: true`，不启用 DOM/Node 库；边界测试把发出的 Cove 声明原文复制为临时 `.ts` 源文件，在相同 ES2024/no-global 条件下完整类型检查，同时跳过第三方 `.d.ts` 检查，并以直接 `URL` 泄漏负例验证该门禁。测试也从临时消费者运行真实编译 exports、拒绝私有子路径。此门禁证明 Cove 自有声明没有宿主类型泄漏，不声称 Zod 的全部声明在纯 ES 环境中通过严格检查。

## 兼容性边界

T1 恢复实验通过 `@cove/terminal-engine/probes/recovery-boundaries` 暴露编译后的探针入口；原有七个引擎 recovery suite 检查保存光标/样式、双缓冲区、分段 UTF-8/控制序列、实时查询、资源上限、普通打印的候选 checkpoint 刷新、复合几何、source-only 构造与临时 pipe 分块。每个 suite 在 `.cache/ci/smoke/terminal-recovery/` 写入带当前 SHA、运行环境和完成的 fixture ID 的有界 JSON，并验证读回。`recovery-boundaries.test.mjs` 保存了 41→40 列时保留列经 DCH 进入可见区、以及原始 ground-only 策略在普通连续打印超过 64 KiB 后无法刷新 checkpoint 的确切反例；`recovery-join.test.mjs` 和 `recovery-geometry.test.mjs` 分别验证有限矩阵中的 final-glyph-last 与复合双缓冲区候选。`recovery-source-derived.test.mjs` 验证有限的普通长流刷新、67 字节字簇和 120×40/1000 行预算，并保存 source-only 复合几何反例；其 limit 选项只能收紧固定上限。新增 `recovery-pragmatic.test.mjs` 单独记录 `pragmatic-logical-grid-v1` 的当前网格、双缓冲区和续写结果，包含 16 个情景家族、20 次新 checkpoint、138 个 parser 切点和 9 类实时查询；原有严格诊断通过不表示修订后恢复验收通过。完整矩阵及候选几何边界见 [T1 实验记录](tasks/m0-terminal-spike.md)。

- 最新 typescript-eslint 8.70.1 的 TypeScript peer 范围为 `>=4.8.4 <6.1.0`，因此本次采用 Oxlint + tsc，未强行忽略 peer 范围。
- 最新 electron-vite 5.0.0 的 Vite peer 范围止于 7。Electron 尚未初始化，不在根安装该依赖，也不宣称与 Vite 8 已兼容。
  后续引入时重新检查最新 release；若仍有冲突，明确记录兼容版本例外或按包隔离其依赖，不能静默降级或关闭严格校验。
- Electron、React Native、Go 与业务运行库在真正建立相应入口时再选定当时最新正式版本；Playwright 已由 B0 的浏览器实验入口固定为 `1.63.0`。
  不为占位安装工具，也不将根 Vite 的版本强加给所有宿主。
- node-pty 已在 B0 的 macOS/CI 探针中验证单个 PTY。better-sqlite3 由 server 存储测试在 macOS arm64 与 Ubuntu x64 的 Node 26.10.0 上
  实际加载，且在 worker thread 中加载（`apps/server/tests/author/store-worker.test.mjs`、`apps/cli/tests/m1/store-worker-entry.test.mjs`）。
  打包和最低系统版本仍未验证。单个探针通过不代表原生模块已可交付。
- 存储 worker 的入口是编译产物 `dist/store/store-worker.js`，由 `dist/store/database.js` 按自身 URL 定位，必须与存储模块一起发布；
  worker 以空 `execArgv` 启动，不继承父进程的 `--input-type` 等选项。

## 当前验证范围

`tests/tooling/project-references.test.ts` 创建并清理临时库/消费者，通过真实 tsc 构建引用图，
用 Node 运行编译后的 ESM/exports，并检查类型不匹配、私有子路径导入被拒绝。
不依赖临时包的源码 alias，也不启动真实 agent 或用户终端。

CI 保留严格必需的 `check (ubuntu-latest)`、`check (macos-latest)` 两项。自 #163 起 Vitest 门禁按 OS 分成
`ciShardCount`（3）个 `check shard (<os>, k/3)` job，各在独立 runner 上运行，端口、`COVE_HOME`、浏览器、sshd
fixture 与用户服务标签都不共享；每个分片冻结安装后先核对 Node/pnpm 精确版本，再执行 native 准备、浏览器安装与
完整 `pnpm check`（`COVE_CI_SHARD=k/3`）：照常验证整个仓库的 discovery、inventory 与最低用例数，再只运行并验证
按确定性计划分到本分片的文件（`scripts/ci-test-gate.mjs` 的 `planShards`，按记录耗时贪心平衡，terminal-web
project 整体放在同一分片；权重只影响平衡，不影响正确性；按 `.suite.json` 新注册的文件自动分配）。必需的
`check (<os>)` job 在分片失败或取消时也运行（`always()`），首步在分片 job 未全部成功（`needs.check-shard.result`）时
直接失败，再以 `--aggregate` 下载该 OS 本次 run attempt 的分片 artifact，要求每个
分片都记录了同一 commit、同一 run attempt 与平台下的通过结果、discovery 一致、实际文件与计划一致，再把合并报告按完整 inventory
用 `verifyInventory` 与 V1 浏览器证据校验，严格程度与单次不分片运行相同；任一分片失败、缺失、多跑或漏跑文件都使其失败。
本地 `pnpm test` 不设 `COVE_CI_SHARD`，仍作为一个分片运行全部文件。每个分片 job 上传 `.cache/ci` 中的安装/浏览器准备记录、环境、inventory、
`shard.json`（计划与 discovery）、逐项命令 argv/退出码/信号/错误码、Vitest JSON/JUnit；artifact 名包含 commit、OS、
run attempt、分片序号与 arch。聚合只接受当前 attempt 的分片：“re-run failed jobs”（通过的分片仍属旧 attempt）
与只重跑聚合 job 都会失败，重跑须选 “re-run all jobs”。失败时也上传已有证据，缺失 artifact 会使该 job 失败；聚合结果另存为
`ci-<sha>-check-<os>-attempt-<n>-aggregate`。时间上限是防挂死预算，并非性能 SLA，统一定义在
`scripts/ci-environment-setup.mjs` 的 `ciTimeBudget`：install/native/browser 各 10 分钟，
gate 辅助命令（toolchain、discovery、source revision）各 2 分钟，Vitest 40 分钟；`pnpm check` 阶段
52 分钟，包括无独立上限的 native/format/lint/build 预留 5 分钟、两条辅助命令、Vitest、source
revision 与收尾 1 分钟；job 至少 89 分钟，包括三个准备步骤、`--environment`、check 阶段与 runner
action/上传预留 5 分钟，`check.yml` 设为 90 分钟；这些上限都按每个分片 job 计。聚合 job 的 `--aggregate` 步骤 5 分钟，
加 runner action 预留共至少 10 分钟，`check.yml` 设为 15 分钟。Vitest 上限由 #151 从 20 分钟提高：除少数纯逻辑 project 外都设
`maxWorkers: 1`，这些 project 依次执行，Vitest 实际串行，每个新增场景 suite 都把自身耗时全部加到总时长上；
不分片的 macOS 绿色运行到 2026-10-21 已达 27.8 分钟（run 39696359165），#163 因此改为分片而非放开 `maxWorkers`
（后者会改变 3 vCPU runner 上计时敏感的 PTY、浏览器、sshd 与用户服务 suite 的隔离）。分片的绿色运行接近 20 分钟时
应增加分片，而不是再提高上限。外层上限按内层的配置上限而非实测耗时组合；只要无独立
上限的工作不超出其预留，挂死时就由最内层上限先触发并写下证据；tooling 测试校验这一组合与 workflow 值。C1 原有 tooling 测试仍在；应用、完整 PTY
生命周期与移动端测试必须随相应能力 PR 增补，当前绿色不表示这些能力已验证。B0 只补齐两个真实实验环境；C1
实施记录见 [任务计划](tasks/m0-ci-gates.md)；此前 bootstrap 验证见 [原任务计划](tasks/engineering-bootstrap.md)。

`Shepherd/tend doc` workflow（`.github/workflows/tend-doc.yml`，#101）执行 `scripts/tend-doc-check.mjs`：PR 改动 tend
依赖的接口而未改 [Shepherd/tend 集成说明](integrations/shepherd-tend.md) 时失败。路径清单及理由见脚本：
`apps/cli/src/commands/`、`apps/cli/src/install/`（`server install/service/restart/upgrade/status` 等）、`apps/cli/src/main.ts`、`apps/cli/src/session.ts`、protocol 的 RPC 方法与 schema
（`rpc-methods.ts`、`rpc.ts`、`workspace.ts`、`errors.ts`、`auth.ts`、`bootstrap.ts`）、server 的 `store/` 与
`operations/`，以及运行与 recipe 环境（#160）：`apps/server/src/domain/tabs.ts`、
`packages/protocol/src/pipe-command.ts`、`packages/terminal-worker/src/worker-execution.ts`。只有真实测试根
（仓库根 `tests/`、`apps/<名>/tests/`、`packages/<名>/tests/`）下的文件与 `<名>.test|spec.<js/ts 扩展名>` 不计；
源码树内的 `tests/` 目录和 `x.test.helpers.ts` 之类仍计入。比较的是 PR head 与它和 base 分支的 merge base 之间的改动；
说明文档在 PR head 不存在（删除或改名移走）时始终失败。
确实不影响 tend 时，在 PR 描述中单独一行写 `Shepherd-Doc: not-affected <理由>`，理由不能为空；以 `Shepherd-Doc:`
开头但格式不符的行也会失败。修改描述会重新触发该检查；push 到 main 等非 PR 事件只报告“已跳过”，不算通过。
输出的文件名来自 PR，控制字符一律转义，打印期间停用 workflow command；step summary 中以实体转义的 `<code>` 呈现。
