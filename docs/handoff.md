# Cove current handoff

Updated: 2026-09-26. Verify live GitHub/checkout state before resuming. Accepted behavior remains in the design documents; exact task evidence belongs to linked Issues/PRs.

## Authorized stage

The user explicitly approved M0 implementation on 2026-09-26 after reviewing [the merged M0 DAG](milestones/m0.md). The entry blocker is removed; do not ask again for routine implementation, testing or gated PR merges within that scope. M0 exit and M1 entry still require user review/permission. Architecture, product scope and acceptance changes still go to the user with evidence/options.

Planning PR [#27](https://github.com/GhostFlying/cove/pull/27) merged six atomic commits by rebase. Baseline main `a902ee0bae0e6539afab6555c0585ff6745261d5` passed macOS/Linux checks; tree equality, independent validation/review, corrected review findings and commit mappings are recorded in PR #27 and [Issue #5](https://github.com/GhostFlying/cove/issues/5). Planning Issues #5–#8 are closed and their clean worktrees were removed.

## Current dispatch

C1 [PR #29](https://github.com/GhostFlying/cove/pull/29) is merged. Current completed baseline is `72c15b30c20d8d8228c4988517786c109197a6c5`; [final main CI](https://github.com/GhostFlying/cove/actions/runs/36163798332) passed both OSes. Independently tested/reviewed source tree equals main; exact maps, counterfactual tests and final artifact readback are in PR #29 and Issue #9. C1 gates the actual 10 tooling tests; it makes no app/PTY claim. Its clean implementation/verification worktrees were removed.

[M0 execution record](tasks/m0-execution.md) tracks allocation and the milestone DAG owns prerequisite order. All 19 implementation tasks are authorized in scope; remaining tasks still wait for their individual dependencies.

| Task                                                                         | Owner and writable scope                                                                                                                                                                    | State                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| B0 [#10](https://github.com/GhostFlying/cove/issues/10) implementation       | `/root/m0_b0_impl`, GPT-6 Sol high; `cove-worktrees/m0-package-probes`, branch `p/luchengxuan/m0-10-package-probes`, base `b1de6cb`; exclusive paths in [B0 plan](tasks/m0-package-plan.md) | Implement compiled native/browser environment probes and blocking CI; no production API |
| B0 integration and coordination                                              | Coordinator; primary checkout `p/luchengxuan/m0-10-package-integration`; handoff/execution records                                                                                          | Independent testing and Sol-high review follow a frozen implementation head             |
| P1a [#11](https://github.com/GhostFlying/cove/issues/11) and remaining tasks | Owners assigned when ready                                                                                                                                                                  | Wait for B0 integrated main checks, then follow DAG                                     |

Local TraeX 5.6 Sol high has been successfully used through warmpool for independent C1 tests, including resumes after fixes. Model/effort and wrapper routing were verified; pre-dispatch warm count was 0, no warm-hit claim made. Do not require a warm hit or use delegation. Linux execution uses `ssh devbox`.

The implementer and coordinator use separate checkouts; `cove-worktrees/m0-package-verify` is reserved for independent TraeX verification (session `01a0d989-82a7-7b13-b6f7-2195da7e733a`, verified GPT-5.6 Sol high through warmpool). `/root/m0_b0_review`, GPT-6 Sol high, performed an early read-only review and will re-review the frozen head. Recompute active agents before dispatch; there are three task checkouts. Limits remain five task agents/worktrees globally and four native agents including coordinator. No recursive dispatch. No application or remote workload has yet been executed in M0.

## Fixed execution boundaries

- M0 is a loopback experiment with per-launch credentials, instance-lifetime operation receipts, CLI and two browser terminal test views. Durable task/workspace/SQLite and pairing/remote deployment remain M1/M2.
- Recovery/query input probes precede final profile freeze. P2 owns runtime pool/refresh, W2 supplies worker status/preview, P3 owns controller and V1 display adapter. Shared manifests/lockfile/exports and CI each have one writer.
- F1 freezes a complete reference; E1 must make an actual useful compatible runtime change before independent C4b tests. Metadata-only differences do not qualify.
- C5 and final-main X1 retain 100 real PTYs concurrently producing sustained synthetic output on devbox. Idle PTYs/headless models do not qualify. Only real-agent/mobile/long-duration qualification remains deferred.
- Required main ruleset `23994191`: linear history, PRs, strict `check (ubuntu-latest)` and `check (macos-latest)`, no force/deletion/bypass; only rebase & merge. Independently test/review each exact head, resolve concrete findings, record mapping and verify final main CI before releasing dependents. Agent review is not second-account GitHub approval.

## Source and durable references

[AGENTS.md](../AGENTS.md), [engineering](engineering-plan.md), [product](design.md), [server](server-architecture.md), [terminal](terminal-architecture.md), [protocol](relay-protocol.md), and [M0 plans](milestones/m0.md) remain authoritative. Write the task-specific implementation plan before coding; use atomic what/why commits and rationale comments. Keep execution results out of commit messages.

Orca research pinned fork `322c1839888f4a462e2d68839deafb1fe616c685`, upstream main `646e9a5b02514795af5139961ccca225dfa01b12`, and stable v1.4.211 `5534462b50c660888487a2108700d4cf284270db`; compare relevant implementation when deciding, without treating upstream as authority or modifying the user's Orca checkout.

Next: complete B0 implementation, independently test/review and integrate; then release P1a. Continue inside approved M0, escalating only actual product/architecture/scope/acceptance decisions. X1 completion never authorizes M1 automatically.
