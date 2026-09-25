# Cove current handoff

Updated: 2026-09-26. Verify live GitHub/checkout state before resuming. Accepted behavior remains in the design documents; exact task evidence belongs to linked Issues/PRs.

## Authorized stage

The user explicitly approved M0 implementation on 2026-09-26 after reviewing [the merged M0 DAG](milestones/m0.md). The entry blocker is removed; do not ask again for routine implementation, testing or gated PR merges within that scope. M0 exit and M1 entry still require user review/permission. Architecture, product scope and acceptance changes still go to the user with evidence/options.

Planning PR [#27](https://github.com/GhostFlying/cove/pull/27) merged six atomic commits by rebase. Baseline main `a902ee0bae0e6539afab6555c0585ff6745261d5` passed macOS/Linux checks; tree equality, independent validation/review, corrected review findings and commit mappings are recorded in PR #27 and [Issue #5](https://github.com/GhostFlying/cove/issues/5). Planning Issues #5–#8 are closed and their clean worktrees were removed.

## Current dispatch

[M0 execution record](tasks/m0-execution.md) owns current allocation and the milestone DAG owns prerequisite order. All 19 implementation Issues #9–#26 and #28 are authorized in scope, but cannot start before their individual dependencies pass on integrated main.

| Task                                                    | Owner and writable scope                                                                                                                                                             | State                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| C1 [#9](https://github.com/GhostFlying/cove/issues/9)   | `/root/m0_c1_impl`, GPT-6 Sol high; task checkout `cove-worktrees/m0-ci-gates`, branch `p/luchengxuan/m0-9-ci-gates`; root tooling/CI/tests plus its own task plan/development notes | Implementing early inventory and fail-closed CI gate from baseline above |
| C1 integration and authorization records                | Coordinator; primary checkout `p/luchengxuan/m0-9-ci-integration`; handoff, execution record and plan authorization updates                                                          | No overlapping edits to implementation files                             |
| B0 [#10](https://github.com/GhostFlying/cove/issues/10) | Root/dependency writer to assign after C1                                                                                                                                            | Waiting for C1 main checks; all later tasks follow DAG                   |

C1 independent tester and separate Sol-high reviewer will receive a frozen head. Local TraeX 5.6 Sol high through warmpool is eligible; warm miss is allowed and does not justify bypassing the wrapper. No delegation plugin. Linux task execution uses `ssh devbox`. No application or remote workload has yet been executed in M0.

There are initially two task worktrees and one active child implementer. Recompute live allocation rather than trusting these historical counts: at most five task agents/worktrees globally, and the current native tool limit is four including coordinator. No nested dispatch without allocation. Preserve unrelated files/processes and clean up only verified task-owned resources.

## Fixed execution boundaries

- M0 is a loopback experiment with per-launch credentials, instance-lifetime operation receipts, CLI and two browser terminal test views. Durable task/workspace/SQLite and pairing/remote deployment remain M1/M2.
- Recovery/query input probes precede final profile freeze. P2 owns runtime pool/refresh, W2 supplies worker status/preview, P3 owns controller and V1 display adapter. Shared manifests/lockfile/exports and CI each have one writer.
- F1 freezes a complete reference; E1 must make an actual useful compatible runtime change before independent C4b tests. Metadata-only differences do not qualify.
- C5 and final-main X1 retain 100 real PTYs concurrently producing sustained synthetic output on devbox. Idle PTYs/headless models do not qualify. Only real-agent/mobile/long-duration qualification remains deferred.
- Required main ruleset `23994191`: linear history, PRs, strict `check (ubuntu-latest)` and `check (macos-latest)`, no force/deletion/bypass; only rebase & merge. Independently test/review each exact head, resolve concrete findings, record mapping and verify final main CI before releasing dependents. Agent review is not second-account GitHub approval.

## Source and durable references

[AGENTS.md](../AGENTS.md), [engineering](engineering-plan.md), [product](design.md), [server](server-architecture.md), [terminal](terminal-architecture.md), [protocol](relay-protocol.md), and [M0 plans](milestones/m0.md) remain authoritative. Write the task-specific implementation plan before coding; use atomic what/why commits and rationale comments. Keep execution results out of commit messages.

Orca research pinned fork `322c1839888f4a462e2d68839deafb1fe616c685`, upstream main `646e9a5b02514795af5139961ccca225dfa01b12`, and stable v1.4.211 `5534462b50c660888487a2108700d4cf284270db`; compare relevant implementation when deciding, without treating upstream as authority or modifying the user's Orca checkout.

Next: complete C1 implementation, independent tests/review and exact-head CI, merge rebase-only and verify main; then release B0. Continue inside approved M0, escalating only actual product/architecture/scope/acceptance decisions. X1 completion never authorizes M1 automatically.
