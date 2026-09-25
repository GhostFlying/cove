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

当前有 tooling、terminal-engine-probes 和 terminal-web-probes 三个测试 project。`scripts/ci-test-gate.mjs` 的 required suite inventory 精确列出
已有工具链测试文件及最低用例数；`pnpm test` 先比较 Vitest project 发现结果与其拥有的
`tests/tooling` 及两个包的 `probes` 下测试文件，
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

`@cove/terminal-engine` 与 `@cove/terminal-web` 只公开 `./probes/environment` 编译入口，尚无生产 API。前者用稳定版 headless `6.0.0`、serialize `0.14.0` 和 node-pty `1.1.0`，启动一个自己的 Node PTY 子进程验证 nonce 回应、尺寸、退出与小型 VT 序列化往返；后者用 xterm `6.0.0`、Vite `8.3.1` 和 Playwright `1.63.0` 构建静态 fixture，在托管 Chromium 中验证缓冲区、几何与键盘输入。Zod `4.6.5` 仅为后续协议包保留 catalog 版本，B0 没有安装或验证协议实现。

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

## 兼容性边界

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
