# 开发环境与工程检查

根工程已初始化，业务应用尚未实现。当前构建编译工具配置及两个实验环境探针；没有可启动的 Cove server、CLI、Desktop 或 Mobile。

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

当前有 tooling、protocol、terminal-engine-probes 和 terminal-web-probes 四个测试 project。`scripts/ci-test-gate.mjs` 的 required suite inventory 精确列出
已有工具链测试文件及最低用例数；`pnpm test` 先比较 Vitest project 发现结果与其拥有的
`tests/tooling`、协议包 `tests` 及两个终端实验包的 `probes` 下测试文件，
再核验实际 JSON 执行结果与 JUnit 非空。缺 suite、零用例、skip/pending/todo、失败或未执行均失败。
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

## B0 实验环境

Q1 浏览器查询与输入实验使用编译出口 `@cove/terminal-web/probes/query-input`，从同一 Vite fixture 的 `query-input` 模式启动托管 Chromium。命令 `pnpm --filter @cove/terminal-web --fail-if-no-match test` 运行十项必需浏览器测试；单独复现可在构建和安装浏览器后执行 `node packages/terminal-web/dist/probes/node/query-input.js queries`（也可用 `keyboard`、`paste`、`mouse`、`split-mixed`、`lifetime`）。探针输出合成字节、浏览器版本和动作证据；它只证明浏览器侧 xterm 输入来源和查询抑制，不连接真实 PTY。

`@cove/terminal-engine` 公开 `./probes/environment` 与 `./probes/recovery-boundaries` 编译入口，`@cove/terminal-web` 公开 `./probes/environment` 与 `./probes/query-input`；这些均非生产 API。前者用稳定版 headless `6.0.0`、serialize `0.14.0` 和 node-pty `1.1.0`，启动一个自己的 Node PTY 子进程验证 nonce 回应、尺寸、退出与小型 VT 序列化往返；后者用 xterm `6.0.0`、Vite `8.3.1` 和 Playwright `1.63.0` 构建静态 fixture，在托管 Chromium 中验证缓冲区、几何与键盘输入。

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

## P1a 临时协议实验

`@cove/protocol` 仅公开 `./provisional/terminal` 与 `./provisional/pipe` 两个编译入口。两者提供 Zod 身份与元数据 schema、交叉身份与基线块约束，以及接收/发送 `Uint8Array` 的临时帧编码器和增量解码器。调用方先校验元数据，自己完成 JSON 与 UTF-8 转换；接收方使用 fatal UTF-8 解码，只解析已经完整且不超过 4096 字节的元数据，再用 `validateTerminalFrame` 或 `validatePipeFrame` 核对头部 kind、身份和 payload 约束。具体组合例子见 `packages/protocol/tests/composition.test.mjs`。

实验帧有 16 字节头部，metadata 最多 4096 字节、payload 最多 65536 字节。一次 `read` 至多消耗 256 KiB 输入并交付 32 帧和 256 KiB 完整帧；返回 `consumedBytes`，调用方保留未消耗的输入，在下次调度重试。`finish` 遇半帧报错并关闭解码器。`baseline-chunk` 保持不透明，库不组装或安装基线，也不实现 terminal profile、输入控制、服务端 RPC、worker IPC 或恢复状态机。

```sh
pnpm --filter @cove/protocol --fail-if-no-match build
pnpm --filter @cove/protocol --fail-if-no-match test
pnpm check
```

Zod `4.6.5` 的自身声明在 `v4/core/schemas.d.cts` 的未使用 URL helper 中引用标准 `URL` 全局类型，故完整传递依赖声明无法在 `lib: ["ES2024"]`、`types: []`、`skipLibCheck: false` 下原样通过。协议包仅在自己的 tsconfig 使用 `skipLibCheck: true`，不启用 DOM/Node 库；边界测试把发出的 Cove 声明原文复制为临时 `.ts` 源文件，在相同 ES2024/no-global 条件下完整类型检查，同时跳过第三方 `.d.ts` 检查，并以直接 `URL` 泄漏负例验证该门禁。测试也从临时消费者运行真实编译 exports、拒绝私有子路径。此门禁证明 Cove 自有声明没有宿主类型泄漏，不声称 Zod 的全部声明在纯 ES 环境中通过严格检查。

## 兼容性边界

T1 恢复实验通过 `@cove/terminal-engine/probes/recovery-boundaries` 暴露编译后的探针入口；原有七个引擎 recovery suite 检查保存光标/样式、双缓冲区、分段 UTF-8/控制序列、实时查询、资源上限、普通打印的候选 checkpoint 刷新、复合几何、source-only 构造与临时 pipe 分块。每个 suite 在 `.cache/ci/smoke/terminal-recovery/` 写入带当前 SHA、运行环境和完成的 fixture ID 的有界 JSON，并验证读回。`recovery-boundaries.test.mjs` 保存了 41→40 列时保留列经 DCH 进入可见区、以及原始 ground-only 策略在普通连续打印超过 64 KiB 后无法刷新 checkpoint 的确切反例；`recovery-join.test.mjs` 和 `recovery-geometry.test.mjs` 分别验证有限矩阵中的 final-glyph-last 与复合双缓冲区候选。`recovery-source-derived.test.mjs` 验证有限的普通长流刷新、67 字节字簇和 120×40/1000 行预算，并保存 source-only 复合几何反例；其 limit 选项只能收紧固定上限。新增 `recovery-pragmatic.test.mjs` 单独记录 `pragmatic-logical-grid-v1` 的当前网格、双缓冲区和续写结果；原有严格诊断通过不表示修订后恢复验收通过。完整矩阵及候选几何边界见 [T1 实验记录](tasks/m0-terminal-spike.md)。

- 最新 typescript-eslint 8.70.1 的 TypeScript peer 范围为 `>=4.8.4 <6.1.0`，因此本次采用 Oxlint + tsc，未强行忽略 peer 范围。
- 最新 electron-vite 5.0.0 的 Vite peer 范围止于 7。Electron 尚未初始化，不在根安装该依赖，也不宣称与 Vite 8 已兼容。
  后续引入时重新检查最新 release；若仍有冲突，明确记录兼容版本例外或按包隔离其依赖，不能静默降级或关闭严格校验。
- Electron、React Native、Go 与业务运行库在真正建立相应入口时再选定当时最新正式版本；Playwright 已由 B0 的浏览器实验入口固定为 `1.63.0`。
  不为占位安装工具，也不将根 Vite 的版本强加给所有宿主。
- node-pty 已在 B0 的 macOS/CI 探针中验证单个 PTY；better-sqlite3、打包和最低系统版本仍未验证。单个探针通过不代表原生模块已可交付。

## 当前验证范围

`tests/tooling/project-references.test.ts` 创建并清理临时库/消费者，通过真实 tsc 构建引用图，
用 Node 运行编译后的 ESM/exports，并检查类型不匹配、私有子路径导入被拒绝。
不依赖临时包的源码 alias，也不启动真实 agent 或用户终端。

CI 保留严格必需的 `check (ubuntu-latest)`、`check (macos-latest)` 两项，冻结安装后先核对
Node/pnpm 精确版本，再执行 native 准备、浏览器安装与 `pnpm check`。每个 job 上传 `.cache/ci` 中的安装/浏览器准备记录、环境、inventory、
逐项命令 argv/退出码/信号/错误码、Vitest JSON/JUnit；artifact 名包含 commit、job、OS/arch。失败时也上传已有证据，
缺失 artifact 会使该 job 失败。Vitest 进程的 8 分钟上限是防挂死预算，给 30 分钟 job 的
浏览器安装、构建和上传留时间，并非性能 SLA。C1 原有 tooling 测试仍在；应用、完整 PTY 生命周期与移动端
测试必须随相应能力 PR 增补，当前绿色不表示这些能力已验证。B0 只补齐两个真实实验环境；C1 实施记录见
[任务计划](tasks/m0-ci-gates.md)；此前 bootstrap 验证见 [原任务计划](tasks/engineering-bootstrap.md)。
