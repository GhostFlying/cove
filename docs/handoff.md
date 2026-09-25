# Cove current handoff

Updated: 2026-09-25. This is the coordinator-owned entry point; verify live GitHub and checkout state before acting. Design authority remains in the linked design documents, not this status record.

## Authorized scope and stage boundary

Engineering bootstrap is complete locally. The CI portability prerequisite is merged. Workflow-governance changes are delivered through PR #3; verify its final merge/check status on GitHub rather than infer it from this document. M0 implementation has not started; submit the M0 task DAG and scope for user review/permission before dispatching feature work. Autonomous PR merging is authorized only when independent testing, GPT-6 Sol review and required CI pass. Milestone transitions and material decisions remain with the user.

## Current tasks and dependencies

| Task                               | Tracking                                                                                                      | Owner / checkout                                                                                      | State and dependency                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public registry portability        | [Issue #2](https://github.com/GhostFlying/cove/issues/2), [PR #4](https://github.com/GhostFlying/cove/pull/4) | Sol implementation; `p/luchengxuan/fix-public-registry` in task worktree                              | Merged as `3628bc03935067b5f5ddf3524b035be5ea9d24fe` from source `40b0ad89b34d4a602c641be0b39440762097c4c0`; independent validation, Sol review and both PR checks passed |
| Workflow governance                | [Issue #1](https://github.com/GhostFlying/cove/issues/1), [PR #3](https://github.com/GhostFlying/cove/pull/3) | Coordinator; `p/luchengxuan/workflow-governance` in primary checkout                                  | Based on the merged #2 fix; includes latest user clarifications. Final head/base evidence and merge status are on the PR                                                  |
| Documentation validation via TraeX | Local bounded read-only worker, no standalone feature Issue                                                   | Local TraeX `gpt-5.6-sol`, explicit high, through warmpool; detached validation checkout at `8bb98e4` | Completed against that revision; flagged a task-record Linux-route omission, now clarified. Supplementary validation, not the required Sol review                         |

Task agents/worktrees are capped at five each across runtimes, also respecting lower native tool limits. The coordinator owns allocation and root governance documents. The registry implementer alone owns its package configuration/lockfile change. Review/test workers do not modify implementation files. Inspect task records and live processes before cleanup; never remove resources belonging to another task.

## Stable decisions and references

- [Engineering workflow](engineering-plan.md): roles, DAG scheduling, user decisions, rebase-only merge, atomic commits and M0 CI requirements.
- [Contributor instructions](../AGENTS.md): stable rules for every agent.
- [Product design](design.md), [server](server-architecture.md), [terminal](terminal-architecture.md), [protocol](relay-protocol.md): accepted architecture and unresolved proposals.
- [Workflow setup record](tasks/workflow-governance.md), [registry fix record on its branch](https://github.com/GhostFlying/cove/blob/40b0ad89b34d4a602c641be0b39440762097c4c0/docs/tasks/public-registry.md): task scope and evidence.

Planning and decision analysis should inspect relevant Orca implementation, pin source revision/paths, and assess suitability rather than assume it is correct. Preserve reasons in the existing design documents. Use local TraeX rather than delegation; warm misses do not block dispatch. Linux work uses `ssh devbox`.

## Integration checkpoint

Initial remote main was bootstrapped at `9be4021dff2c10a059dd943dd3dac512483e15b4`. Rebase-only merge settings and active ruleset `23994191` require linear main, PRs, strict macOS/Linux checks, no force-push/deletion and no bypass actors. Independent agent review is a coordinator gate because all workers share the same GitHub account.

First hosted CI failed because private mirror tarball URLs entered the root lockfile. PR #4 fixes project registry scope without dependency-version or integrity drift. Do not weaken the required checks. Source review and validation comments are recorded on each PR; verify their head/base before using them.

## Next actions

1. Verify post-merge main CI for #4 and the latest PR #3 state. If #3 remains open, require current-head/base independent validation, Sol review and both hosted checks before rebase-merging. If merged, inspect its final main checks; do not replay or duplicate it.
2. Record source-to-main SHA mappings and final evidence on the Issue/PR. Remove only clean task-owned validation resources after workers finish; completed workers in the table are history, not permission to adopt another session.
3. Present M0 planning/entry review to the user. Do not automatically start M0 implementation or later milestones.
