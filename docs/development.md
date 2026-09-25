# 开发环境与工程检查

根工程已初始化，业务应用尚未实现。当前构建只编译工具配置与工具链测试；没有可启动的 Cove server、CLI、Desktop 或 Mobile。

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
GitHub Actions 同样固定到当日最新正式 release 的 commit：checkout v7.0.1、setup-node v7.0.0、pnpm/action-setup v6.1.0。

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

| 命令                                | 行为                                      |
| ----------------------------------- | ----------------------------------------- |
| `pnpm build`                        | 按根 solution 的 Project References 编译  |
| `pnpm typecheck`                    | 同一引用图的增量类型检查，会生成/更新产物 |
| `pnpm clean`                        | 清理引用图的 TypeScript 产物              |
| `pnpm lint`                         | Oxlint，警告也导致检查失败                |
| `pnpm format` / `pnpm format:check` | 写入格式 / 只检查格式                     |
| `pnpm test` / `pnpm test:watch`     | Vitest 一次运行 / 持续运行                |
| `pnpm check`                        | 顺序执行格式、lint、构建、测试            |

目前只有 tooling 测试 project；新增真实包时将 tsconfig 加入引用图、将测试加入 Vitest projects，
提供对应包脚本，再使用 `pnpm --filter <package> <script>` 做局部验证。不要靠“未发现测试也成功”掩盖遗漏。
根工具配置/测试输出到 `.cache/tooling`；应用包各自设置 rootDir、dist 和 tsBuildInfoFile。
通用配置不注入 Node/DOM 全局类型，由各执行环境显式选择；浏览器/RN 按 bundler 宿主覆盖模块解析与库。
内部依赖使用 `workspace:*`，通过公开 exports 读取编译后的 JS/types，不提供跨包 src alias。

依赖变更由当轮指定写入者执行非冻结安装并提交 manifest 与 lockfile。
pnpm 使用 isolated linker、严格 engines/peer 校验；依赖构建脚本默认未授权，原生包引入时显式配置所需 allowBuilds。
已有 `docs/benchmarks/` 是独立实验，保留其 lockfile 和原始文件，不进入 workspace 或自动格式化/lint。

## 兼容性边界

- 最新 typescript-eslint 8.70.1 的 TypeScript peer 范围为 `>=4.8.4 <6.1.0`，因此本次采用 Oxlint + tsc，未强行忽略 peer 范围。
- 最新 electron-vite 5.0.0 的 Vite peer 范围止于 7。Electron 尚未初始化，不在根安装该依赖，也不宣称与 Vite 8 已兼容。
  后续引入时重新检查最新 release；若仍有冲突，明确记录兼容版本例外或按包隔离其依赖，不能静默降级或关闭严格校验。
- Electron、React Native、Playwright、Go 与业务运行库在真正建立相应入口时再选定当时最新正式版本。
  不为占位安装工具，也不将根 Vite 的版本强加给所有宿主。
- Node 26 上的 node-pty/better-sqlite3 ABI、打包、最低系统版本尚未验证；工具链通过不代表这些原生模块已可交付。

## 当前验证范围

`tests/tooling/project-references.test.ts` 创建并清理临时库/消费者，通过真实 tsc 构建引用图，
用 Node 运行编译后的 ESM/exports，并检查类型不匹配、私有子路径导入被拒绝。
不依赖临时包的源码 alias，也不启动真实 agent 或用户终端。

CI 配置覆盖 macOS/Linux，冻结安装后执行 `pnpm check`。实际本地验证结果记录在
[本次任务计划](tasks/engineering-bootstrap.md)。尚未执行的远端 CI、应用/原生/移动端测试不属于本次验收结果。
