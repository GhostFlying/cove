# W1 N1b：公开 preflight 与无 handle spawn 清理回执

状态：2026-09-27，Astra HIGH 有界规划，未实现/测试/审查。根提供 N1 accepted main410e6f397b58440394667a4b1ba2c9f0f3e2a4e0、final-main37 files/304 tests；此接受状态不因本次接口补充被倒写成失败。N2 approved plan /tmp/cove-m0-w1-n2-plan.md SHA256fc765f52ec398b926495e14ac872809639019aa14cf9f45cb4db72de98df6762 在接入时发现公共契约缺口，继续held。未读取/修改primary a230f807的N2未提交docs或实现；只读其指定handoff /tmp/cove-m0-w1-n2-implementation/registration-request.md 和immutable410 Git对象。

## 已证实的缺口

410的 patches/node-pty@1.1.0.patch 增加 boundedWrite、writeBounded/getBoundedWriteState/disposeBoundedWrite/boundedWriteCompletion，却未改 src/index.ts 的公开spawn工厂或提供公开preflight。patch中 src/unixTerminal.ts 的 capability检查位于constructor、pty.fork之前；公开 `spawn(...) => IPty` 成功后才能取得completion。不能从private `native` export或lib内部函数拼装N2判断。
当前constructor adoption catch：writer dispose/close、ReadStream.destroy、stopOwnedChild(9) 后抛普通原异常或含cleanupErrors数量的Error。destroy和watcher reap可能稍后完成；“没有同步cleanupErrors”不证明资源已闭合。native pty.cc的duplicate/nonblock/其他rollback路径执行close/kill/waitpid或交现有watcher；部分结果被丢弃，未以公开稳定结果返回。现有native-write-rollback测试经package私有fault seam捕获fd并等待关闭/reap，证明测试可观察的清理，不能成为生产adapter的公共完成通知。
这不是已证明的新泄漏或N1成功writer回归；是N2已批准的“纯校验不占slot、post-entry确认清理才释放slot”无法通过公开接口实现。所有ordinary throw都永久tombstone或读错误文本都不是修复。

## 选定最小公开补充

不改现有成功spawn/IPty、成功writer completion、FIFO/字节/task上限或settlement顺序；不另造spawn scheduler。追加下面两个小接口到同一个patched node-pty公共入口，名字按此冻结供N2映射：

```ts
checkBoundedPtySupport():
  | { supported: true; contractVersion: 2 }
  | { supported: false; reason: 'unsupported-platform' | 'binding-unavailable' | 'binding-mismatch' };

class BoundedPtySpawnError extends Error {
  readonly code: 'COVE_BOUNDED_PTY_SPAWN_FAILED';
  readonly cause: unknown;
  readonly cleanup: Promise<
    | { kind: 'confirmed-clean' }
    | { kind: 'cleanup-uncertain'; reason: string }
  >;
}
```

1. preflight只读同一已加载binding及公开包能力，覆盖Darwin/Linux、正确native合约marker和必要函数形状；不得spawn/openpty/dup、signal、改env、安装/rebuild或产生PTYowner/timer/thread。普通模块加载/读取binding不意味着试spawn。若整个包导入因missing addon失败，导入发生在owner预留前、零spawn，同样不得收费；不为把load error强转枚举而重构整个loader。Windows/其他OS返回unsupported，不改legacy平台行为。
2. native marker提升到2，公开preflight和constructor都必须核对2；避免新JS加载旧v1 addon却声称有失败清理回执。preflight成功只表示本次绑定能力就绪，不保证资源足够或未来spawn成功；constructor保留校验，禁止缓存true后降级、裸native访问或TOCTOU式假承诺。N2在preflight和纯参数校验后、实际spawn前才预留slot。
3. 仅bounded opt-in的同步spawn失败包装为该公开Error，保留原cause而不依赖message/errno来分类。legacy不启用bounded的返回/throw行为保持。参数/能力拒绝若已经进入public spawn但尚无owner，则cleanup为立即fulfilled confirmed-clean；异常发生前未进入该API的纯校验失败仍不预留slot。catastrophic进程终止/OOM不是可承诺返回Error的范围，不凭兜底把未知异常判clean。
4. `cleanup`在任何资源获取前建立为本次spawn唯一回执，至多一次settle、never reject，无公共PID/fd/native handle。错误立即抛回而不是阻塞事件循环等reader关闭/reap；N2捕获后保留原provisional slot直到回执结果。正常异步清理在pending期间不算uncertain/tombstone，收到confirmed-clean才释放一次；只有真实清理错误、身份/关闭状态不确定或有限观察期限耗尽才成为原slot的fatal tombstone。禁止自动重试spawn。
5. confirmed-clean的定义必须覆盖**本次失败获取的全部owner**：native/raw/read-stream/write-owner所有descriptor已由各自owner确认关闭，已有writer同步settlement/accounting已结束，创建过的child已由唯一reaper确认reaped，且无待发旧身份signal/owned cleanup工作。未创建child/fd为真空clean；成功kill请求、ReadStream.destroy返回或writer关闭单独均不够。任一ambiguous close维持uncertain，不盲重试数字fd。
6. pending cleanup沿用既有W1有界owned-cleanup政策，以3秒观察上限（已有2秒graceful+1秒forced总量）作本失败回执终态界限；已在constructor rollback发SIGKILL的不再人为等待graceful两秒或重复发信号。只新增每失败spawn至多一个清理deadline timer，完成即取消；N2已计费slot限制并存数量，不维护全局重试/回执history。超时只使回执uncertain，不强关issued write fd、不在后来迟到回调时改成clean或释放tombstone。现有唯一watcher仍负责已有child的真实退出，deadline不得制造第二reaper或假称OS可被强制按时回收。
7. 此失败回执与成功`boundedWriteCompletion`不同：后者仍只证明writer关闭及其同步结算，不突然承诺child退出。成功spawn交出IPty后沿用原契约，本失败回执不再通知或保留新资源；Error cause保持调用方本地信息，公开reason使用有限分类字符串，诊断不复制env/argv/用户内容。

## 内部实现边界（不把异步清理藏进普通throw）

| 失败阶段                                                  | clean的充分证据 / 必需动作                                                                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯校验/能力拒绝、尚无native entry                         | 无资源获取；立即clean，不执行清理syscall                                                                                                                                                |
| native entry未创建child或只取得部分fd                     | native记录实际owner取得与每个close结果；存在资源才清理，成功确认后clean，未分类结果uncertain                                                                                            |
| child已建、watcher前发生nonblock/dup/publication错误      | sole native rollback负责stop/reap及fdclose，检查并保留结果；不能因执行过waitpid就认定成功。避免新增blocking wait；需要异步观察时向同一个既有owned watcher机制移交一次，不新建第二reaper |
| watcher已安装、native返回失败                             | watcher继续sole reaper；native关闭其仍拥有的fds并将有类型的关闭/退出状态关联到本次回执，reap证据可以在throw后到达；记录reaped后拒绝signal                                               |
| 返回JS但read未/部分adopt，writer未/已adopt，后续setup错误 | narrow constructor guard做现有owner正确清理；等ReadStream实际close及错误、writer completion、owned child reap；不再把destroy/stop同步返回当完成                                         |
| cleanup throw/close歧义/stop或wait异常/观察超时           | 保留primary原因；尝试其他仍合法的owned cleanup，终态uncertain，原slot保留；不得重复close/信号已reaped pid                                                                               |

在内部throw跨native→JS边界前须保留结构化cleanup事实和后续通知通道：复用本次fork预先建立的onExit/rollback状态单元即可，不能指望未返回的term对象被N2拿到。当前adoptionFailed早退不得丢掉reap事实；先记录内部rollback结果，再屏蔽未成功构造对象的用户exit事件。native已知pre-watcher同步reap结果可直接标记，不再重复wait。错误包装只在公共入口/constructor边界各一次，内部已包装错误不得重新建立第二回执。
不把private `native` export升级成生产接口，不改变正常事件顺序/成功writer预算，不放宽macOS inherited-fd修复、不复制Orca的私有kill改写。

## 所有权与原子交付

N1b native作者独占 `patches/node-pty@1.1.0.patch`；其内必要surface为src/index.ts、src/interfaces.ts、src/unixTerminal.ts、src/native.d.ts、src/unix/pty.cc及对应lib/index.js、lib/unixTerminal.js/source maps、typings/node-pty.d.ts。最多增加一个包内部命名明确的spawn-cleanup类型/状态文件及生成lib/map，若现有文件可容纳则不拆。所有C++按既定style，不重排无关upstream代码。
作者测试：`packages/terminal-worker/tests/native-write-spawn-contract.test.mjs`与必要`fixtures/native-write-spawn-contract-*.mjs`；可扩充既有native-write-rollback/fault用例，保留N1已有测试。生产N2 native-pty.ts/pty-input.ts、N2未提交docs、协议/runtime/W2/P2均不可写。
sole registrar持有patch注册hash、pnpm lock、必要manifest/build/export/CIinventory/evidence与durable任务记录；N1b和N2不能各写一套注册。新增源码/执行lib/声明、真实tests、注册、native marker/build指纹同一完整可构建原子candidate，不能先交仅有类型或旧binary能混过的API。

## 有限验收（只规定，不执行）

- compiled public consumer（仅import node-pty）调用preflight；错marker/stock旧addon、unsupported平台、重复纯校验失败均零child/fd/owner计费、不增长thread/timer；guard与spawn使用同binding。import失败与API返回unsupported分别记录，不称同一路径通过。
- 通过package-local故障注入覆盖上表每阶段；断言公开Error discriminator/cause、立即拿到唯一cleanup promise、known clean释放一次、pending保持slot、uncertain保留一次。真实read-adoption后的异步close/reap完成能得到clean；不能将这些正常失败统一tombstone。无handle不要求调用方轮询privatefd/PID。
- close错误/stop错误/观察超时通过受控seam验证uncertain；迟到callback不得二次settle/解锁slot；reentry/throw不遗失其他owner cleanup。测试隔离subprocess，无进程全局生产monkeypatch；外层finally只清理fixture nonce/身份绑定对象。
- 独立有限ledger容量1/2：重复preflight/参数失败不耗额；重复confirmed-clean post-entry失败恢复baseline；held cleanup阻止下一spawn直到完成；uncertain到cap拒绝。此为fixture consumer，不编写N2生产factory/调度器。
- 真实macOS/Linux失败spawn/adoption/child exit与公开回执交叉验证actual owner cleanup，不用自己返回clean作为唯一oracle；原始字节、fdreuse/CLOEXEC/inherited-fd隔离、成功writer callback/completion顺序和无legacy bypass仍通过N1回归。无继承fd回归豁免或100PTY扩张。
- 同一源精准Node26.10.0/pnpm12.6.0/node-pty1.1.0 clean frozen install、source rebuild；native marker2、loaded addon path/hash、patch/source/lib/types/map hash、Node ABI/N-API记录一致。旧marker1/未重建native必须fail closed；不换pin、不开global build fallback。公有声明独立tsc consumer和执行lib一起验证。
- 原37files/304tests仅历史baseline，gate采用实际新增inventory且保留原suite。冻结源码后独立验证（先定strategy）+独立Sol审查，hosted双OS与final-main产物核验后才接受N1b。

## DAG、参考与决定边界

`accepted N1 410 → N1b公共contract补充/注册/独立gates/final-main → N2重新分配基于已接受N1b → N2接受 + accepted R1 → W1a`。N2当前只保留作者handoff，不代注册stub，也不通过caller私有检查抢跑。根只调度；interactive native实现Sol6 HIGH，自包含独立review优先TraeX5.6 Sol XHIGH；遵守当前5任务cap，不嵌套。
只读固定Orca5534462b50c660888487a2108700d4cf284270db：src/main/daemon/pty-subprocess/native-pty-spawn.ts:27–85调用pty.spawn，Unix失败rethrow，Windows走shell fallback；没有该公开no-handle cleanup回执。subprocess-handle.ts:28–59、77–85分离ioFailed/native exit并处理已成功proc，不能覆盖spawn没有返回proc的失败。借鉴状态分离，不复制其Windows重试/私有kill覆盖，也不把Orca当作已证明Cove所需API。
本补充落实既已批准的N2资源计费/失败可观测性，不降低保证，无新产品决定。若实现只能通过裸PID推断、修改成功completion意义、去掉回滚确认/强制无限等待、改变平台支持或扩大backend/process架构才能完成，才提交具体tradeoff给根；不得静默替换。3秒是回执观察界限，不能被写成进程必然3秒退出承诺。计划本身不接受任何实现。

## 实际执行分配，2026-09-27

- 本文件源自 Astra HIGH 只规划的 `/tmp/cove-m0-w1-n1b-public-contract-plan.md`，原始 SHA-256 `68d63b523c8ad921c5eca279d63cd6f23e7084c0c7602c22b1d26248a146b70e`；独立 Sol 计划审查 `/tmp/cove-m0-w1-n1b-plan-review/report.md`，全文件 SHA-256 `faf8aed265f61366dfafb25831b13fad8de26d61a53b2589d350bf52a1aa4958`，批准的是实现派发而非源码验收。
- 根 `/root` 只调度；作者与唯一 patch/共享注册写者 `/root/m0_t1_impl`，interactive GPT-6 Sol high。工作区为已清理的 primary `/Users/luchengxuan/WORKSPACE/cove`；从已接受 N1 main `410e6f397b58440394667a4b1ba2c9f0f3e2a4e0`（tree `bcdceba2770ceaee7233a01854fb1f610245f6c0`）创建新分支 `p/luchengxuan/m0-16-public-spawn-contract`。N1 原分支和 N2 blocked 文档分支 `p/luchengxuan/m0-16-native-adapter`（`da086197d590a4b2b19e0f89130279f5fd285a74`）均保留，不改写。N2 仍 held，不在此分支移植其作者文件或编写生产 adapter。
- 可写范围：`patches/node-pty@1.1.0.patch` 及其批准的 node-pty1.1.0 补丁表面；`packages/terminal-worker/tests/native-write-spawn-contract.test.mjs`、必要的命名对应 fixture 和已有同类 native-write rollback/fault 测试；本任务 plan/results；若源码真实需要，唯一写者负责 patch/hash、`pnpm-lock.yaml`、manifest/build/导出、根 Vitest/CI inventory 与对应 tooling 测试。不要改协议、R1/G0、N2 native-pty/pty-input、worker pump、W2/P2、pin版本或 devbox。
- 先核对接受源码与当前已安装编译/原生表面，做最小公开 preflight 和失败 spawn 回执，保持成功路径。测试须直接消费重新构建后的公开 JS/声明，且以实际独立 owner/child/fd 事实验证 cleanup；不把仅返回 `confirmed-clean` 当作自身证明。新增真实套件和注册作为同一个可构建候选原子边界，无空导出/空门禁。先定向 Node26.10/pnpm12.6 build 和有限 native 检查，冻结 SHA 后交独立测试/审查，最后双系统 hosted/final-main 才接受。
- G0 的独立候选在另一既有 checkout `m0-terminal-view`，不混入本分支。若真实 public/native 合同达不到本计划的确认清理与 3 秒终态界限，按前节向根报告最小反例与取舍，不以私有读取或普通异常文字替代承诺。
