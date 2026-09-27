# M0 N1c → N2：直接拥有主进程的真实、有界 stop

状态：2026-09-27，用户已明确接受较小契约“可以，按照这个原则进行”；本文件为后续实现/验收的规范修订，无须再问A/B。仅规划，未实现、运行测试或修改repo/refs/CI。旧方案与决策稿原样保留作历史。
基线：accepted main/N1b `edc6278ef9fb990258cb1cf172591c7abb5f5d06`；冻结N2 `6cdd23aa74df699a8187c327ebd49905fafd7ce8`；起始docs HEAD `10398482d5862d2e161ce6888a62ade000a5a3f8`；根随后确认较小契约已写入docs `7dad593eed4be64538f6ff355311248c30783e58`的handoff/results及Issue16 comment5853589937，functional6cdd未变。本轮从不可变objects复核N2 public result/stop/owner ledger、N1b preflight/native closure，不读作者未提交实现。

## 1. 显式替代的验收与保留的不变量

用户接受：可靠、安全地停止**直接拥有的PTY leader**，有限等待并真实报告；相关初始进程组清理尽力而为，未确认helper消失不构成关闭硬门禁。自然退出不因helper清理增加等待或改变reap顺序。初始组不包含所有shell作业/任意后代，逃逸session/group不承诺覆盖。
这明确替代旧stop-plan `6d64f92…`及A/B决策稿`d43a0dd…`要求保持组权力到force/expiry、改变自然退出、helper unknown永久占slot的方向；也替代旧N2文档中把child+helper全部清理作为production stop成功前提的解释。原plan review F1的强清理要求由用户选择修订；其误杀/结果真实性反例仍须测。source review的公开stop依赖、吞错、无限等待和fixture安全问题继续有效，不能仅靠改文档关闭。

| 事实 | 唯一计费规则 |
|---|---|
| 成功spawn writer confirmed closed AND实际leader exit | 同一maxOwners slot释放恰好一次；两顺序均成立，helper unknown单独不阻止释放 |
| writer未闭合或leader未实际exit | 保持原slot；stop已请求、超时、native already-reaped但JS未交付都不替代缺失事实 |
| writer close-uncertain/原已定义post-entry失配 | 原有有界tombstone继续持有；不因leader退出或helper诊断清除 |
| 失败spawn typed cleanup pending/confirmed-clean/uncertain | 原N1b receipt规则不变：pending持有、不提前fatal；clean一次释放；uncertain/非法/无receipt保守tombstone |

maxOwners约束直接拥有的PTY/writer/leader，不宣称约束全部OS后代总数。不新增group tombstone、第二ledger、factory轮换或自动respawn。用户输入及自动query/focus共用既有FIFO/两级bytes+tasks预算；同步settlement finally、未知写不重放均不变。

## 2. N1c仍是必要的窄公开依赖

证据：N2 `packages/terminal-worker/src/native-pty.ts:454–468`仍使用legacy kill并永久await exit；accepted patch `src/index.ts`preflight仅native marker2，`src/unix/pty.cc`闭包持owned-child mutex检查reaped后signal，但`src/unixTerminal.ts`只私藏该closure，boolean false混合reap与ESRCH。不能在N2读private、解析错误message、裸PID signal或用timeout掩盖此缺口。
在bounded Unix IPty新增公开 `signalOwned(signal, scope)`，同步、小型固定结果；范围仅darwin/linux，legacy非bounded kill行为保持原样：
```ts
type OwnedSignal = 'SIGHUP' | 'SIGKILL';
type OwnedSignalScope = 'leader' | 'initial-process-group';
type OwnedSignalResult =
  | { kind: 'signaled' }
  | { kind: 'already-reaped' }
  | { kind: 'unverifiable'; reason: 'not-found' | 'signal-failed' | 'scope-unavailable'; errorCode?: string };
// IPty.signalOwned?(signal: OwnedSignal, scope: OwnedSignalScope): OwnedSignalResult
```
- Native闭包绑定该spawn的owned-child对象，无caller PID/PGID输入；同一mutex覆盖reaped检查和signal，sole watcher仍按原时序reap。recorded reaped时零signal syscall；ESRCH只表示not-found，不能冒充recorded reap或exit。合法调用的OS错误显式分类，程序性异常可throw，N2捕获且保留首错。
- leader scope用正owned PID；group scope仅当owned leader尚未reap、原生实际验证其初始PTY/session组且`getpgid(pid)==pid`时向该组signal。须据Darwin/Linux真实spawn路径验证此资格，无法确认则scope-unavailable；禁止继承host组、缓存PGID、外部PID或进程名猜测。mutex避免同一watcher在检查和signal之间释放leader身份；不延后reap、不接管helper reaping。
- group信号接受仅表示此次内核接受，不表示helper结束。leader在group调用前已reap或两scope调用之间被reap均允许返回already-reaped并安全跳过，不能因想补齐group强行保留身份或追加重试。
- 原失败构造rollback使用的owned-stop布尔闭包/cleanup receipt语义必须保持；可内部复用身份检查，但不能改变N1b caller对false、reap或错误的解释。新public typed result独立适配，不顺手重写spawn/reader/writer生命周期。
- binding contract提升3；`checkBoundedPtySupport()`须在owner reservation和native spawn之前，同时验证exact native marker3及**实际用于spawn的同包UnixTerminal prototype公开方法callable**。检查不能实例化PTY、只看export、或检查另一个constructor。已有unsupported/binding-mismatch结果足够，不新增wire。marker2实验版无需兼容。
- 保留成功handle的公开shape检查；preflight后单实例方法缺失是post-entry契约违规，原slot保守持有并fault，不改称零owner拒绝，不legacy/private兜底。

## 3. N2消费：leader结果与group尝试报告分开

保持 `stop(): Promise<NativeStopResult>`；结果的顶层`exited`仅表示本adapter实际收到leader exit，`unverifiable`表示有限期内没有该事实。新增一个固定大小的本地`cleanup`报告到两分支，不加wire/event框架：`scope:'initial-process-group'`、`verified:false`、`graceful`与`force`两个attempt槽。每槽为`not-attempted(reason)`或对应公开OwnedSignalResult；reason固定区分already-exited/deadline-not-reached/capability-fault。**绝不提供all-helpers-exited字段或由signaled推导verified:true。** leader送达首错用既有onFault及结果可选`signalFailure:{phase,cause}`保留；不累积错误数组。

1. 第一次stop先保存唯一promise/状态，再做可能重入的retire或公开调用；即使早已exit也缓存相同promise。停止接纳input，不等待writer completion才开始stop。已实际exit则返回exited+group未尝试/未验证，不再signal。
2. 第一次阶段在同一调用链先尝试group SIGHUP，再尝试leader SIGHUP，均用public capability；group失败/失权不能跳过仍可安全尝试的leader。每阶段每scope最多一次，共最多4次公开signal调用，没有循环signal或继承新的deadline。
3. 单一绝对deadline：start+2000ms仍未实际exit时，先尝试group SIGKILL再leader SIGKILL；start+3000ms仍无实际exit则返回unverifiable。延迟timer醒来若已过最终deadline，不补发逾期signal，直接结束未知。实际exit立即取消未发force/所有stop timer。
4. `already-reaped`仅令该scope安全跳过；仍有限等待真正exit callback。主进程可在group attempt后立刻reap，所以helper仍活着/未证实是合法报告，不保持缓存PGID到下一阶段。native已reap、JS callback迟到的变体必须零额外signal。
5. 若HUP/force送达失败但之后实际leader exit，顶层可如实exited，首错仍留signalFailure/onFault；不会把真实退出事实改写为“仍未知”，也不把failed attempt抹成成功。若无实际exit则unverifiable带cause。**只有helper unknown时既不改leader结果，也不新增fatal/tombstone。**
6. 超时后结果不被迟到callback改写；真实迟到exit仍更新既有ledger，writer closed也到达时可一次释放。natural exit逻辑不主动追加group清理或3秒延迟。observer throw走既有隔离/finally路径，不打断timer清理、promise结算或ledger。

## 4. 有限强制验收（独立测试者验证）

| Oracle | 必须证明 |
|---|---|
| 双preflight | native3+缺失/非callable实际JS方法零spawn/零reservation拒绝；旧marker/stock拒绝；完整3通过。单实例损坏仍post-entry持有 |
| 身份边界 | native已reap但JS callback人为hold，public leader/group均不signal；不对无关真实PID做危险复用实验。ESRCH未记录reap是unverifiable；scope未证不发负PGID；组检查不会命中host组 |
| stop有限性/重入 | 2s后force最多一次、3s无exit返回未知；timer超期不补signal；重复/重入同promise；exit取消force；HUP错后实际exit仍有首错诊断 |
| 真实native leader | 不会自行结束的child分别响应HUP、忽略HUP直到KILL，要求actual exit callback和writer completion；macOS/Linux各用真实compiled binding，不能以自退出digest例代替 |
| 非对称同组helper | leader响应HUP、helper忽略HUP并在leader reap后仍活着：leader可exited，group报告未验证，之后不得cached-PGID signal；writer+leader齐全正常释放slot，cap=1可再次spawn。独立fixture安全收尾helper且证明absence；**helper幸存本身不使production stop测试失败** |
| 已退出及逃逸边界 | stop前已实际exit/已native reap等变体不延后reap；逃逸group不得声称覆盖，未知不持额外owner。实际scope资格失败须真实skip，非硬凑group成功 |
| 计费/输入回归 | writer+leader两顺序释放一次；helper unknown不阻塞；writer uncertain仍持有；超时未exit仍持有，晚exit可按事实结算；failed-spawn receipt/FIFO/caps/never replay不变 |
| fixture失败安全 | 第一PTY stop失败或writer挂起、第二spawn失败、body断言失败：全部已创建session均获cleanup尝试，primary error保留，其他cleanup失败附带，不因首错跳过剩余资源 |

真实fixture仍在既定15秒case ceiling内：单一body最多8秒、全部finally合计最多5秒、2秒余量；各wait使用剩余deadline，非逐会话叠加。创建后立刻登记每个session；cleanup对所有PTY并行/非短路启动stop与writer观察，全部有限settle后才assert/throw，取消多余timer。
helper外层收尾优先用本次fixture独立拥有的控制通道；若需要test-only signal fallback，重新验证精确fixture路径+nonce/PID，身份不明不得signal，有限确认absence且不得把ps absence当leader watcher reap。外层收尾只能证明测试未留资源，不升级production cleanup.verified。安全negative oracle只在受控seam注入，不向其他进程试错。

## 5. 文件ownership、原子切片及DAG

- N1c作者（interactive native Sol HIGH）：仅维护node-pty patch内 `src/unix/pty.cc`、`src/native.d.ts`、`src/unixTerminal.ts`、`src/interfaces.ts`、`src/index.ts`、`typings/node-pty.d.ts`及必要匹配lib/maps；包内新增 `packages/terminal-worker/tests/native-write-owned-stop.test.mjs`及其最小fixture/public declaration consumer，已有spawn-contract tests只补marker/JS矩阵。不得N2顺手修改writer实现。
- N2作者：在N1c接受后的base继续现有 `packages/terminal-worker/src/native-pty.ts`；测试限native-adapter-factory/real/input suites及 `tests/fixtures/native-adapter-child.mjs`。pty-input仅确证必要时调整，原FIFO/预算不重构。
- 唯一registrar：实际 `patches/node-pty@1.1.0.patch`落盘/lock/hash/marker构建登记、suite inventory及tooling floor、相关docs转录；与N1c逻辑作者单一文件交接，禁止两人同时写patch/lock。现有`./native-adapter`export及test-only engine dependency保留，不造新包/入口。
- 每个candidate包含source+compiled lib/types+native构建/注册，独立可构建；不得先注册无实现capability或交付无法消费的半个commit。native tests编译源、addon ABI/marker3、patch hash及实际加载路径核验；沿用Node26.10.0/pnpm12.6.0、N1/N1b inherited-fd/rollback/settlement回归，不沿用历史41/350代替新证据。
- 根转录用户决定至既有native-input decision、native-adapter plan/public API及handoff，由当前docs owner处理，明确supersede而非删除历史。只Astra规划，作者/独立source reviewer/独立native tester分离；bounded review优先TraeX5.6Sol XHIGH，interactive由native Sol。

DAG：`已接受用户契约 → 本修订独立计划检查 → N1c public capability+双preflight原子candidate → 独立source/native验证、macOS+Linux/full/final-main接受 → N2 rebase并修stop+fixture → 独立source re-review/native/full/双OS/final-main接受 → W1a`。N2测试结构可准备，但依赖N1c的实现/接受结论不得提前派发为就绪。没有W2/P2、run pump、wire、PID轮询、通用descendant framework、keeper或延后reap。真实新增依赖若出现先报告事实，不擅自恢复旧强保证或再问已决定的A/B。

## 6. Orca仅作对照，非此契约依据

沿用已核验 `/tmp/cove-orca-stop-guarantee-comparison.md` SHA256 `722cdf932b7d65c049f799315f83cbea6ba4969386828e3cd2a032d35e477940`，本轮无重复audit。当前fork322/v1.4.190：`src/main/pty/posix-pty-process-groups.ts:88–129`和`src/main/pty-descendant-termination.ts:203–208,332–374`有组/后代尽力清理及root-only降级；553/v1.4.211：`src/main/pty-descendant-exit-verification.ts:99–118,219–243`提供三态，但普通teardown caller `src/main/pty-descendant-termination.ts:292–319`不以exited硬门禁。Cove采用自己的public native身份保护，不能照搬ps后裸PID signal；也不从Orca推导必须“all helper gone”。

## N1c execution allocation — 2026-09-27

- Owner: `/root/m0_t1_impl`, interactive GPT-6 Sol high, sole N1c native author and shared registrar. Root coordinates independent review and testing. User selected the smaller truthful leader-stop contract, recorded at `7dad593eed4be64538f6ff355311248c30783e58` and Issue #16. This task does not restore the superseded all-helper guarantee.
- Reviewed plan: `/tmp/cove-m0-w1-n2-owned-stop-revised-plan.md` SHA-256 `b7fc1b7295e28a6794bbe43d7dc1dec6fbc96bf5001de61dff58beb78ea6a2e2`; independent plan review SHA-256 `a5149f76868fff5c7d0a5f19b363ff7710ff294c69c71730aec5daf97d31c4de`. The plan above is copied verbatim through section 6; this allocation follows it.
- Checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-view`, clean new branch `p/luchengxuan/m0-16-owned-stop-capability` at accepted main `edc6278ef9fb990258cb1cf172591c7abb5f5d06`. Original G0 branch `p/luchengxuan/m0-43-browser-graceful-close-integration` remains at `af2bf56bdcc91abcba967c477e10aeaf7313faa1`. The primary N2 functional candidate and docs are owned separately and remain untouched.
- Writable scope: this task plan and N1c results; the existing `patches/node-pty@1.1.0.patch`, matching `pnpm-lock.yaml`/package registration and CI gate/inventory/tooling tests; minimal node-pty source/lib/types/maps used to derive and prove that patch; package-local `packages/terminal-worker/tests/native-write-owned-stop.test.mjs` and its necessary fixture/declaration consumer; existing spawn-contract tests only for marker/JS-preflight matrix. Source patch contents are limited to the files named in section 5. No protocol, N2 adapter, pump, generic process framework, or unrelated shared configuration changes.
- Atomic delivery: first this plan commit, then a buildable functional candidate containing real public method, native marker 3, compiled declarations, patch/hash/lock registration and nonempty tests together. Preserve initial failures. Run pinned Node 26.10.0/pnpm 12.6.0 scoped native checks and one full gate when coherent. Freeze exact SHA for independent source/native review and hosted macOS/Linux gates; N2 remains blocked until N1c final-main acceptance.
