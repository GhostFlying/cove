# M0 terminal-engine / terminal-worker plan

> 2026-09-26 用户决策更新：首发采用 [terminal-architecture.md §3.2.1](../terminal-architecture.md#321-首发恢复精度与验收2026-09-26-用户已确认) 的实用恢复 profile。保存 SGR/charset、retained off-grid/混合物理行完整等价改为保留证据的非阻塞诊断；普通画面/输入/预算内 normal+alternate、解析/顺序/有界性仍必需。暂停引擎安装 API 和逆向 reflow。T1 确定性验证后才释放 P1b；Codex/TraeX/Claude Code 小规模真实工作流在 H1/C3 的真实 PTY+浏览器链路验证，原生 mobile 和 100 个真实 agent 的容量资格仍属后续阶段。本文原有完整等价措辞按此明确更新解释，旧失败不改记为通过。

Status: M0 entry approved by the user on 2026-09-26. Dispatch follows the aggregate DAG; this plan is not implementation evidence.
Tracking: [#7](https://github.com/GhostFlying/cove/issues/7), parent [#5](https://github.com/GhostFlying/cove/issues/5).
Planner: `/root/m0_terminal_plan`, GPT-6 Astra high; coordinator assigns separate implementation, independent test and Sol high review owners.
Base: `1e1398462c2aadc5a9171e40aef7c5d9f0ad3da7`; branch: `p/luchengxuan/m0-7-terminal-plan`.
Checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-plan`; this task writes only `docs/plans/m0-terminal.md`.
Implementation owners record their actual checkout, base and dependency SHAs before starting; proposed paths below are not pre-created packages.

## Scope and fixed boundaries

Authority: [terminal §§3–4](../terminal-architecture.md), [server §§5,10.4](../server-architecture.md),
[protocol §9](../relay-protocol.md), [engineering §§6,8–9](../engineering-plan.md), and [handoff](../handoff.md).
Deliver a real PTY risk prototype with two independent clients, not an engine-only demonstration.
Accepted M0 scope is a local-only experimental server/CLI harness with two browser terminal views sharing the client adapter,
temporary per-launch credentials/Origin checks and volatile instance-bound operation records; durable identity/persistence and pairing stay in M1/M2.
Each run has node-pty and exactly one authoritative headless model in one worker subprocess; runtime caches previews, never another model.
Use the selected `@xterm/headless` + serialize adapter, VT plus explicit metadata, one ordered pipe send queue per direction, and a bounded subprocess pool.
Worker arbitrates per-run output/resize/exit order. Full duplex is not a total order across directions; command replies carry correlation identity.
Client disconnect/view disposal never stops PTY. Runtime/worker failure has no keeper or automatic agent restart guarantee.
Preserve normal and alternate state, limited history, server-only query replies, foreground control epochs and replaceable client renderers.
Refresh state/previews for every run, including unobserved runs, with bounded staggered work and stale-cache reporting.
Exclude PTY keeper, disk snapshots/scrollback/raw logs, agent management/hooks, task/workspace/SQLite domains, migration, production Desktop/RN and deployment.
M0 retains the accepted devbox gate of 100 real PTYs concurrently producing sustained synthetic output. This is distinct from at least 100 frequently outputting real agents, mobile rendering and long-duration capacity acceptance in later milestones.

## Pinned Orca comparison

Read-only source: `/Users/luchengxuan/orca/orca`, clean at `322c1839888f4a462e2d68839deafb1fe616c685`,
GhostFlying fork branch `p/luchengxuan/fork-worktree-scan-candidate`, package version `1.4.190`; this is not an upstream-latest claim.
The following are observed source behaviors, not runtime reproduction or claims that all Orca recovery fails.

| Evidence at the pinned revision                                                                                                                                                                                                                                                                                             | Observed behavior; benefit, limitation and Cove consequence                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [headless-emulator.ts:168–193,241–270](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/src/main/daemon/headless-emulator.ts#L168)                                                                                                                                                         | Updates mode/tail mirrors after parse callback; augments serialized VT with modes, dimensions and tail. Useful parsed-boundary discipline; serializer alone is insufficient. Cove freezes baseline at one acknowledged worker boundary.                                                                            |
| [terminal-partial-escape-tail.ts:27–31,144–148](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/src/shared/terminal-partial-escape-tail.ts#L27)                                                                                                                                           | Bounds tracked tail to 4096 characters, then returns empty and abandons tracking. Bounds memory but can lose continuation state. Cove reports baseline unavailable/unsupported until a proven checkpoint, never treats empty tail as proven parser ground.                                                         |
| [terminal-serialize-absolute-cursor.ts:24–39,56–68](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/src/shared/terminal-serialize-absolute-cursor.ts#L24)                                                                                                                                 | Reads private saved-cursor fields and clamps wrap-pending position. Concrete evidence that visible cursor parity does not prove saved register/wrap parity; Cove needs continuation tests and version-contained adapter access.                                                                                    |
| [pty-connection.ts:4246–4255,4290–4301](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/src/renderer/src/components/terminal-pane/pty-connection.ts#L4246)                                                                                                                                | Replay guard drops the mixed callback; live query-shaped strings take an immediate client-reply path. Avoids replay replies and reply debounce, but is incompatible with Cove's sole-server reply authority and genuine-input preservation. Do not copy blanket suppression or infer provenance from byte grammar. |
| [terminal-multiplex-round-robin.ts:3–30](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/src/main/runtime/rpc/terminal-multiplex-round-robin.ts#L3)                                                                                                                                       | Advances drain cursor across streams with continuation budget. Reuse the fairness principle; Cove adds explicit per-run FIFO and reserved control budget, not this module's surrounding session model.                                                                                                             |
| [package.json:148–154,317–321](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/package.json#L148), [terminal-frame-restore-sequences.ts:89–96](https://github.com/GhostFlying/orca/blob/322c1839888f4a462e2d68839deafb1fe616c685/src/main/daemon/terminal-frame-restore-sequences.ts#L89) | Uses beta xterm/serialize packages and patches; frame restore relies on patched out-of-range serialization. Source feasibility is not proof for Cove's unpatched stable packages. T1 pins and tests the actual candidate dependencies.                                                                             |

### Upstream comparison addendum

Read-only `git show`/diff against `stablyai/orca` main `646e9a5b02514795af5139961ccca225dfa01b12`; local Orca checkout remains at the fork SHA above.
This main snapshot's `package.json` says `1.4.197`; it is not identified as the separately reported latest formal Release `v1.4.211`.
The comparison below is source evidence only; no upstream app or tests were executed.

| Upstream evidence                                                                                                                                                                                                                                                                                                                                                                                         | Fixed, refactored or still a boundary; M0 impact                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [headless-emulator.ts:230–244](https://github.com/stablyai/orca/blob/646e9a5b02514795af5139961ccca225dfa01b12/src/main/daemon/headless-emulator.ts#L230)                                                                                                                                                                                                                                                  | Fixed: same-size resize returns before discarding restored OSC-8 ranges. Add same-size restore/resize continuity to T1 fixtures; this is not a general reflow or hidden-state solution.                                                                                                                                                                           |
| [terminal-partial-escape-tail.ts:120–164](https://github.com/stablyai/orca/blob/646e9a5b02514795af5139961ccca225dfa01b12/src/shared/terminal-partial-escape-tail.ts#L120)                                                                                                                                                                                                                                 | Fixed ESC→ESC and ESC→CAN/SUB transitions after OSC/string; refactored common introducer classification and optimized plain-text scanning. Still returns empty above 4096. Add these transition counterexamples; retain explicit overflow/unavailable guard and mandatory bounded-parser success.                                                                 |
| [pty-input-forward.ts:31–46,176–189](https://github.com/stablyai/orca/blob/646e9a5b02514795af5139961ccca225dfa01b12/src/renderer/src/components/terminal-pane/pty-connection/pty-input-forward.ts#L31), [terminal-user-input-signal.ts:47–66](https://github.com/stablyai/orca/blob/646e9a5b02514795af5139961ccca225dfa01b12/src/renderer/src/components/terminal-pane/terminal-user-input-signal.ts#L47) | Refactored from pty-connection; fixed blanket keyboard loss by retaining private-core user-input provenance across deferred forwarding. Replay still suppresses pointer reports/alternate-screen wheel arrows. T1 should investigate this provenance adapter, including absent-private-API behavior, rather than describe upstream as blanket-dropping all input. |
| [pty-input-forward.ts:81–92](https://github.com/stablyai/orca/blob/646e9a5b02514795af5139961ccca225dfa01b12/src/renderer/src/components/terminal-pane/pty-connection/pty-input-forward.ts#L81)                                                                                                                                                                                                            | Still routes query-shaped data to immediate client replies without testing `wasUserInput` in this branch. Cove's server-only query authority and reply-shaped real paste fixture remain necessary; source inspection is not an end-to-end input-loss reproduction.                                                                                                |
| [terminal-serialize-absolute-cursor.ts:24–68](https://github.com/stablyai/orca/blob/646e9a5b02514795af5139961ccca225dfa01b12/src/shared/terminal-serialize-absolute-cursor.ts#L24)                                                                                                                                                                                                                        | Unchanged against the pinned fork: private saved-cursor access and wrap clamp remain. Keep T1 continuation/profile gate; neither implementation proves complete arbitrary parser-state recovery.                                                                                                                                                                  |

These fixes refine the evidence and fixtures, not the accepted engine/renderer choice, worker authority or M0 scope.

## Dependencies and exclusive writers

Cross-plan labels below name semantic outputs, not assumed task numbers; the coordinator maps them to the integrated DAG and exact merged SHAs.

| Output / owner                               | Required content and consumers                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-envelope / protocol writer                 | Run/server-instance/subscription identity, frame sizes, decoder limits, request correlation, seq and byte-credit meanings, errors; consumed by T3/T4. Worker pipe version is distinct from public protocol; exact packaged runtime/worker matching suffices initially.                |
| P-terminal / protocol writer, informed by T1 | Frozen terminal profile, baseline format version, history/reflow coverage, restore token and sequence boundary, focus/controlEpoch and input outcome semantics; T2/T4 consumers. Includes frozen compatible and incompatible fixtures, not two copies of the current schema.          |
| CI-packages / tooling writer                 | Engine/worker manifests, exact candidate dependency pins, native install allowlist, exports/tsconfig references, root lockfile and scoped scripts; prerequisite to T1 executable probes and all production packages. Request changes; terminal workers never edit root configuration. |
| S-runtime / server owner (P2)                | Sole owner of pool admission/routing, focus-grant serialization, HTTP/WS, volatile receipts and all-run refresh/cache orchestration; consumes T3/T5. No second headless model or M1 task domain.                                                                                      |
| C-adapter / client owner                     | Real keyboard/paste/mouse provenance, permanent suppression of live/replay query replies, applied-after-parse ACK, generations and VT backend contract; joint T1 proof, T6 integration dependency. Client owner alone writes terminal-web/client paths.                               |
| CI-terminal / independent verification owner | Compiled-process launcher, real PTY macOS/Linux jobs, browser two-client runner, frozen compatibility fixtures, devbox same-SHA record and required gate wiring; consumes T2–T6. Missing/skipped/zero-case jobs are not success.                                                      |

Terminal implementation owns `packages/terminal-engine/src/**`, `packages/terminal-worker/src/**` and local unit tests;
each package export entry has one nominated writer. Engine and worker may have different owners after their interface freezes.
T1 owns `packages/terminal-engine/probes/**` and authored deterministic data under `tests/fixtures/terminal/engine/**`;
independent testers own their integration specs and adversarial fixtures, not implementation source.
Server owns `apps/server/src/terminal/**`; client owns `packages/client/**` and `packages/terminal-web/**`.
Shared `packages/protocol/**`, package manifests and all root build/CI files remain their designated writers' scope.
Any ownership change goes through the coordinator; plans are not locks. Implementation must import package exports, not another package's `src`.

## Tasks and release gates

| ID  | Deliverable / target files                                                                                                                                                                                                                          | Exact prerequisites / acceptance                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Bounded recovery/query spike: `terminal-engine/probes/recovery-boundaries.ts`, `docs/tasks/m0-terminal-spike.md`, `tests/fixtures/terminal/engine/**`. Propose profile and engine contract; client owner supplies the query-suppression experiment. | M0 entry + CI-packages candidate pins. Produce reproducible state/continuation matrix and supported/unsupported list. No production recovery claim. Submit concrete gaps before P-terminal freeze; P-envelope work can proceed independently.                                                                                                                                       |
| T2  | Production adapter: `terminal-engine/src/terminal-model.ts`, `vt-baseline.ts`, `terminal-profile.ts`, `recovery-checkpoint.ts`; exposes write/parsed barrier, resize, bounded preview/history/baseline and dispose without xterm objects.           | T1 passing required cases + P-terminal + CI-packages. Required suffixes under pragmatic-logical-grid-v1 preserve current-grid normal/alternate content, current cursor/modes and query observations; approved saved-style/off-grid/topology exceptions are separately reported diagnostics. Isolate any approved private-engine access/patch and fail explicit version conformance. |
| T3  | Worker execution: `terminal-worker/src/main.ts`, `run-session.ts`, `ordered-run-pump.ts`, `pty-input.ts`, `pipe-endpoint.ts`. Raw bytes, asynchronous parsing, single PTY/model owner, correlated command completion and server query sink.         | P-envelope + T2 interface commit + CI-packages. Compiled worker loads native PTY on both OSes; output/resize/exit ordered; accepted stale epoch rejection reported; no unbounded read/write queues or independent Node send channel.                                                                                                                                                |
| T4  | Recovery and flow: `terminal-worker/src/recovery-subscription.ts`, `replay-window.ts`, `byte-budget.ts`, `snapshot-scheduler.ts`. Atomically reserve baseline boundary plus bounded subsequent replay.                                              | T2 + T3 + P-terminal. Parse-complete boundaries, drain/resume, fresh subscription on overflow, no gap or duplicate event, no slow observer pausing all PTYs. S-runtime/C-adapter consume the same fixtures.                                                                                                                                                                         |
| T5  | Worker lifecycle/status service: `terminal-worker/src/worker-lifecycle.ts`, `run-status.ts`, `preview-service.ts`; serve runtime requests through T4's worker snapshot scheduler, without a second pool/refresh orchestrator.                       | T3 + T4 and agreed S-runtime interface. Correlated stop/drain/status/preview outcomes, unchanged preview reuse and explicit failure; P2 owns placement/admission and all-run refresh/cache checks.                                                                                                                                                                                  |
| T6  | Integrated terminal evidence: independent `tests/integration/terminal/**`, browser cases and `docs/benchmarks/m0-terminal/**`; terminal owner fixes only its modules.                                                                               | T2–T5 + S-runtime + C-adapter + CLI operation path + CI-terminal/P compatibility artifacts at actual integrated SHA. Two real clients/real PTY satisfy matrix below on macOS/Linux; clean up only owned processes.                                                                                                                                                                  |

T1 is disposable experimental code/evidence, not a shortcut for production APIs. Promote only proved behavior into T2.
T1 follows provisional P1a profile/pipe examples and candidate pins; P1b final contract follows T1 evidence, avoiding a freeze/spike cycle.
T2/T3 need not wait on unrelated server/CLI work; T6 cannot substitute mocks for missing consumers.
Independent testing and independent Sol high review precede coordinator integration; integrated checks must be repeated after semantic conflicts.

## Recovery and query spike: hard questions

Write callback means bytes parsed, not parser ground. Visual VT serialization is not a full checkpoint of UTF-8 decoder, CSI/OSC/DCS,
saved SGR/charset, wrap-pending, tab stops, margins, input modes or both buffer registers. A screen-only preview is never a recovery baseline.
T1 tests published headless/serialize candidates (existing benchmark uses 6.0.0/0.14.0; not an automatic app dependency decision).
For each required state, record public support, adapter supplementation, unsupported gap, continuation oracle and wire-compatible representation.
Baseline carries same-boundary run/instance, profile/version, dimensions, seq, bounded VT and coverage metadata; never private xterm memory.
Candidate recommendation: validated parser-safe checkpoint plus bounded raw tail, preserving a clear unavailable state when no checkpoint exists.
Mandatory pragmatic-profile fixtures include ordinary normal/alternate TUIs, saved position, current pen/charset, margins, current wrap-pending, bounded split UTF-8/CSI/OSC/DCS,
and budgeted history/new-grid baseline recovery. These must pass the required practical restore-and-continue oracle; returning unavailable is not their acceptance path. Saved SGR/charset and exact retained off-grid/physical topology remain separate non-gating diagnostics under the approved decision.
Test C0 actions inside unfinished sequences: appending a tail to a snapshot taken after its side effects can execute them twice.
UTF-8 tails are bytes, not substring guesses. Account for all tail/checkpoint retention in the memory budget.
An arbitrary snapshot plus guessed ESC tail is insufficient; required current/saved-position registers and ordinary subsequent behavior must be proved under the pragmatic profile, without reimposing its explicitly excluded saved-style/topology guarantees.
Long unterminated OSC/DCS cannot grow storage indefinitely. Keep authoritative live parsing, cap recovery retention and return explicit bounded retry/unavailable;
do not inject reset bytes, discard live output, fake a parser checkpoint or automatically restart the application to make recovery pass.
The exact parser adapter or maintained dependency patch is a spike output; narrowing accepted recovery behavior needs user decision.

Server model answers only supported live queries exactly once, including zero connected clients; baseline/history generation never writes replies to PTY.
Test CPR/DSR, DA, supported mode reports and color queries; declare only profile capabilities backed by both server and client.
Appearance updates are ordered and epoch-checked; unknown properties get no invented answer.
Client experiment must separate actual keyboard/paste/mouse intent from automatic parser replies during asynchronous writes and recovery.
Identical user-pasted query-reply bytes remain genuine input; regex classification and discarding every onData during replay are unacceptable.
If query suppression needs an adapter patch, document surface, version check and upgrade fixture before freezing C-adapter/P-terminal.

## Ordering, resource and lifecycle rules

Assign seq in one worker arbiter; distinguish received, parsed, baseline and client-applied positions. Do not compare byte offsets as event seq.
Resize waits for prior model writes, updates PTY/model, records authoritative dimensions, then handles later output; SIGWINCH is not a repaint fence.
Same-size focus changes epoch without redundant resize. Old epoch queued input is explicitly rejected; already written input cannot be recalled.
Runtime serializes focus requests; worker commits epoch plus ordered resize before runtime exposes the grant. No parallel worker control election.
Input accepted/written/uncertain outcomes must not promise application consumption; ACK loss never authorizes automatic replay.
Retrying a baseline request with limits or invalidating a subscription is distinct from dropping genuine input: return busy/rejected before admission,
and report admitted-but-uncertain input without silently resending or losing its outcome.
Pipe framing limits allocations before decoding. Chunk snapshots and paste, with finite per-run, per-worker and total budgets plus control reserve.
On pipe write returning false, stop dequeuing until drain; EPIPE/EOF rejects pending correlations and invalidates affected transport identity.
One-direction FIFO preserves already enqueued frames; priority applies across eligible unsent run work, not reordering output/resize within a run.
Model high/low watermarks pause/resume the affected PTY using API flow control; never send Ctrl-S/Ctrl-Q or lose raw bytes.
Subscriber credits return only after parse ACK; one slow observer loses its subscription on budget exhaustion, not another observer's data.
Recovery expiration clears old buffers and generation callbacks; bounded retries/backoff cannot become a resnapshot storm.
Fair byte/time slices prioritize current operator while reserving progress for other runs, control, exits and periodic previews.
Yield between snapshot jobs and coalesce equivalent requests. Synchronous serialize cannot be preempted: cap dimensions/history/content and measure its worst stalls.
Start engineer-configurable probes at 1,000 history lines and up to four workers on devbox; these are measured starting points, not product defaults.
No live run migration. Runtime caps workers/run admission; workers never detach as a keeper. Drain stops admission, reports accepted pending work,
reaps task-owned PTYs through bounded shutdown and escalates only verified owned processes; failure/timeout leaves explicit uncertainty.
Disconnected clients preserve workers and PTYs. Broken worker contact is `unverifiable`; only execution-host evidence permits `exited`.
Worker exit is not proof all descendants exited. Runtime preserves run identity/outcomes, never restarts agent commands or labels a replacement as the old run.
Runtime requests staggered preview/status refresh for every run; worker handles limited-screen serialization only when output/version changed.
Cache keys include run/instance/seq/dimensions/generation time. Failed refresh keeps last-known preview marked stale; cache contains no full engine.

## Acceptance fixtures and measurement

Independent tests extend the authored fixtures with adversarial scheduling; assertions inspect continuation semantics, not screenshots alone.

| Fixture                   | Required assertion                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Query / input             | Raw-mode PTY program issues supported queries with 0/1/2 clients; exactly one reply. Inject real typing, paste containing reply-shaped bytes and mouse events during parsing/replay; preserve authorized intent without auto replies.                                                            |
| Partial parser            | Split every byte boundary of UTF-8, CSI, OSC BEL/ST, DCS and ESC/CAN/SUB; include C0 side effects. Required bounded valid cases restore + suffix equal uninterrupted model. Invalid/over-budget pathological streams have explicit bounded failure; this does not waive required recovery cases. |
| History / resize          | Soft wrap, exact right-margin wrap-pending, wide/combining/emoji text and a logical line longer than retained history; 120→40→120 columns after trimming. Missing reflow context forces worker resize then new baseline; never inserts late history into live state.                             |
| Alternate screen          | Populate hidden normal, enter alternate, save cursor/SGR/charset, set margins/modes, resize during alt, restore, exit alt and continue. Validate both buffers and later DECRC/wrap/input encoding, not only current alt frame.                                                                   |
| Recovery / replaceability | Live output during baseline transfer, delta-window gap, view disposal/recreation, stale callback and duplicate/reordered frame injection. Same PTY identity; new baseline+subscription has exact handoff boundary; renderer-specific state never enters wire.                                    |
| Drain / fairness          | Tiny pipes, split/coalesced frames, false write then drain, malformed length, pause/resume hysteresis, slow ACK client, recovery storm and overflowing queues. Bounded byte accounting; control/current input/other runs/preview jobs make progress without per-run reorder.                     |
| Disconnect / failure      | All clients disconnect/reconnect original run; close runtime pipe, kill owned worker, drain timeout and runtime restart. Honest live/unverifiable/exited, no input replay/automatic agent restart; unaffected worker continues; no adopted or orphaned test resources.                           |
| Preview cache             | Active and never-subscribed runs change output; periodic refresh sees both. Unchanged version reuses preview; failed refresh keeps stale identity-tagged cache; list requests do not synchronously serialize every terminal.                                                                     |
| Compatibility             | Frozen older/newer same-protocol profile fixtures recover and continue; unsupported profile/format/pipe version is explicit. Private-engine version changes run the same continuation suite.                                                                                                     |

CI owner supplies executable scoped commands before implementation readiness: package typecheck/test/build, compiled worker/server/CLI smoke,
real PTY integration and browser two-client test; do not document nonexistent commands as already verified.
Both required macOS/Linux jobs and `ssh devbox` use the integrated SHA, exact Node/native ABI and dependency pins; record OS/arch and owned PIDs.
M0 workload: ordinary CI uses multiple real PTYs with operator plus bulk output, both client connections, hidden previews and forced resnapshots; include a deterministic TUI. C5/X1 additionally require 100 concurrently outputting real PTYs on devbox, with per-run offered/achieved rate, active count, bounds, fairness and cleanup evidence at the final integrated SHA. Idle PTYs or headless-only models do not satisfy this gate; insufficient host resources block the lane rather than reduce its required count.
Use monotonic timestamps for input admission→PTY write, PTY read→parsed, serialize wall time, pipe queue/drain and client parse→paint;
measure client input→paint on one client clock, avoiding subtraction of unsynchronized host clocks. Correlate sequence IDs without recording private contents.
Record p50/p95/p99/max, event-loop lag, per-worker CPU/RSS, total memory, queue peaks, recovery time and preview age by workload/dimensions/history.
Deterministic CI asserts finite queue limits, order and scheduling opportunities; timing budgets are calibrated evidence, not arbitrary flaky pass thresholds.
Later 100-agent devbox qualification separately measures real agent resource use, long-duration load and mobile rendering; parser-only figures do not establish it.

## Decisions still requiring evidence or user review

Recommend the checkpoint/profile adapter route first; alternative is a narrow maintained engine patch with conformance tests.
If neither restores accepted hidden state, stop the affected recovery production task and present exact counterexamples and maintenance impact to the user.
Failure of any mandatory fixture blocks T1/P-terminal acceptance; unsupported-profile rejection cannot hide a common TUI incompatibility.
Reducing recovery/profile guarantees, changing sole query authority, adding persistence/keeper, or replacing the selected architecture requires user decision.
Protocol field spellings, frame representation and tunable queue/watermark/refresh limits are coordinated engineering choices after T1 measurements.
History delivery should use an isolated read-only history consumer in M0 fixtures; product history-view interaction remains undecided, not silently selected here.
Exit: coordinator has exact contract/implementation/test SHAs, independent evidence and review, no open required recovery/query defect,
and actual integrated CI results. That permits M0 review, never automatic entry to M1.

## 汇总交接补充

实施任务以 [M0 汇总 DAG](../milestones/m0.md) 为派发入口。CI-packages 对应 B0，client query 实验对应 Q1/P1q，正式显示适配对应 V1/P3v；T1 不等待正式 controller 或 adapter。T5 的 S-runtime 接口在 P1b 冻结，W2（T4/T5）实现不等待 P2。P5/T6/C6 最终集成证据统一到 X1，域内缺陷仍归原 owner。
