# 开发环境与工程检查

当前可构建并启动本机的 Cove server（`cove-server`）与 `cove` CLI：M0 的终端链路与测试 harness，加上 M1 的本机
task/workspace 闭环（见[下文](#m1-本机试用与-cli-用法)）。还没有远程接入、配对、Desktop 或 Mobile。

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
- 停止 server（Ctrl-C）时先打印将受影响的存活 run；再次启动后记录都在，旧 run 显示为会话中断，
  不自动重开或重跑（[D9](milestones/m1.md#d9-重启后的-run-显示选-a)）。
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

CI 保留严格必需的 `check (ubuntu-latest)`、`check (macos-latest)` 两项，冻结安装后先核对
Node/pnpm 精确版本，再执行 native 准备、浏览器安装与 `pnpm check`。每个 job 上传 `.cache/ci` 中的安装/浏览器准备记录、环境、inventory、
逐项命令 argv/退出码/信号/错误码、Vitest JSON/JUnit；artifact 名包含 commit、job、OS/arch。失败时也上传已有证据，
缺失 artifact 会使该 job 失败。时间上限是防挂死预算，并非性能 SLA，统一定义在
`scripts/ci-environment-setup.mjs` 的 `ciTimeBudget`：install/native/browser 各 10 分钟，
gate 辅助命令（toolchain、discovery、source revision）各 2 分钟，Vitest 20 分钟；`pnpm check` 阶段
32 分钟，包括无独立上限的 native/format/lint/build 预留 5 分钟、两条辅助命令、Vitest、source
revision 与收尾 1 分钟；job 至少 69 分钟，包括三个准备步骤、`--environment`、check 阶段与 runner
action/上传预留 5 分钟，`check.yml` 设为 70 分钟。外层上限按内层的配置上限而非实测耗时组合；只要无独立
上限的工作不超出其预留，挂死时就由最内层上限先触发并写下证据；tooling 测试校验这一组合与 workflow 值。C1 原有 tooling 测试仍在；应用、完整 PTY
生命周期与移动端测试必须随相应能力 PR 增补，当前绿色不表示这些能力已验证。B0 只补齐两个真实实验环境；C1
实施记录见 [任务计划](tasks/m0-ci-gates.md)；此前 bootstrap 验证见 [原任务计划](tasks/engineering-bootstrap.md)。
