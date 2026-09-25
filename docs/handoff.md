# Cove current handoff

Updated: 2026-09-25. This is the coordinator-owned entry point; verify live GitHub and checkout state before acting. Design authority remains in the linked design documents, not this status record.

## Authorized scope and stage boundary

Engineering bootstrap and workflow governance are merged through PRs #4 and #3. Current main baseline is `1e1398462c2aadc5a9171e40aef7c5d9f0ad3da7`, with post-merge checks successful. The user authorized proceeding with the next planning step: produce the concrete M0 scope and dependency graph for review. The user accepted the local-only experimental scope (temporary credentials, run-lifetime operation records, two browser test terminals; persistence/pairing later). M0 feature implementation is not yet authorized; final DAG/entry review and plan publication are separate from implementation permission.

Autonomous PR merging remains conditional on independent validation, GPT-6 Sol review and required CI. Product/architecture/scope/acceptance decisions and milestone entry/transitions remain with the user.

## Current tasks and dependencies

| Task                            | Tracking                                                 | Owner / checkout                                                     | State                                        |
| ------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| M0 plan integration             | [Issue #5](https://github.com/GhostFlying/cove/issues/5) | Coordinator; primary checkout, `p/luchengxuan/m0-5-plan-integration` | Delivered in PR #27; evidence recorded there |
| Protocol/server/client/CLI plan | [Issue #6](https://github.com/GhostFlying/cove/issues/6) | Astra high; task branch `p/luchengxuan/m0-6-protocol-plan`           | Delivered `docs/plans/m0-protocol.md`        |
| Terminal engine/worker plan     | [Issue #7](https://github.com/GhostFlying/cove/issues/7) | Astra high; task branch `p/luchengxuan/m0-7-terminal-plan`           | Delivered `docs/plans/m0-terminal.md`        |
| CI/acceptance plan              | [Issue #8](https://github.com/GhostFlying/cove/issues/8) | Astra high; task branch `p/luchengxuan/m0-8-ci-plan`                 | Delivered `docs/plans/m0-ci.md`              |

All planner checkouts start at the stated baseline. Native runtime has four concurrent slots including coordinator, the three planners have delivered and are idle; task agents/worktrees remain capped at five across runtimes. No recursive dispatch. The coordinator alone owns this handoff and aggregate milestone/task records. Read-only source reference is clean GhostFlying/orca fork `322c1839888f4a462e2d68839deafb1fe616c685` (version 1.4.190, not a claim of current upstream behavior).

Use live agent/checkout/GitHub state before cleanup or continuing a task. A task record is not permission to adopt another session or overwrite another writer.

## Stable decisions and references

- [Engineering workflow](engineering-plan.md): roles, DAG scheduling, user decisions, rebase-only merge, atomic commits and M0 CI requirements.
- [Contributor instructions](../AGENTS.md): stable rules for every agent.
- [Product design](design.md), [server](server-architecture.md), [terminal](terminal-architecture.md), [protocol](relay-protocol.md): accepted architecture and unresolved proposals.
- [Workflow setup record](tasks/workflow-governance.md), [registry fix record on its branch](https://github.com/GhostFlying/cove/blob/40b0ad89b34d4a602c641be0b39440762097c4c0/docs/tasks/public-registry.md): task scope and evidence.

Planning and decision analysis should inspect relevant Orca implementation, pin source revision/paths, and assess suitability rather than assume it is correct. Preserve reasons in the existing design documents. Use local TraeX rather than delegation; warm misses do not block dispatch. Linux work uses `ssh devbox`.

## Integration checkpoint

The previous governance setup is complete. PR #4 preserves public-registry dependency versions/integrities; PR #3 introduced atomic commits, rebase-only integration, role independence and durable handoffs. Evidence and source-to-main SHA mappings are in their PR comments. Prior temporary worktrees were cleaned.

Main ruleset `23994191` remains active: linear history, PRs, strict `check (ubuntu-latest)` / `check (macos-latest)`, no force-push/deletion or bypass actors. Independent agent review remains a coordinator gate, not a fabricated second-account approval.

## Next actions

1. Complete gated publication of [PR #27](https://github.com/GhostFlying/cove/pull/27); verify its live head/base, review/validation and final main CI in PR/Issue #5 evidence before resuming. The original proposal passed independent checks; subsequent corrections require corresponding revalidation.
2. Present the M0 scope, DAG, exit criteria and material choices to the user. Start implementation only after explicit review/permission; do not infer stage entry from closing planning Issues.

## M0 planning delivery

The three Astra module plans are integrated in `docs/plans/m0-*.md`; [aggregate scope/DAG](milestones/m0.md) maps exclusive writers, staged CI, and all cross-module prerequisites. Implementation Issues [#9–#26 and #28](https://github.com/GhostFlying/cove/milestone/1) are proposed/blocked on user M0 entry approval, not runnable authorization. Root integration branch remains `p/luchengxuan/m0-5-plan-integration`. Planning worktrees have delivered clean commits; no implementation agent or application service has started.

Module originals → integration commits: terminal `4c02bc9` → `4ac1333`; CI `229482c` → `a792059`; protocol `738cc32` → `ca30379`. Coordinator reconciliation is a separate atomic change. Sol high dependency analysis resolved P2/T5, staged C2, full A7 reference and credential ownership gaps. Independent final documentation validation/review and hosted CI gate [PR #27](https://github.com/GhostFlying/cove/pull/27); exact current PR/head/main evidence is recorded on [Issue #5](https://github.com/GhostFlying/cove/issues/5) and PR comments, avoiding stale SHA claims in this file. A documentation merge does not approve M0 implementation.

The compatibility review correction adds E1 #28, and the accepted synthetic 100-PTY devbox gate is retained in C5/X1; only 100 real-agent/mobile/long-duration capacity remains deferred. Next: finish the exact-head publication gates, then present the concrete plan for user entry review. After approval, C1 is the only initial ready task; subsequent dispatch follows the DAG. End-of-M0 X1 requires another user review before any M1 work.
