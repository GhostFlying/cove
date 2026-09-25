# Workflow governance setup

- Owner: coordinator; Astra high provides read-only planning input, GPT-6 Sol high independently reviews the final change.
- Base: 9be4021dff2c10a059dd943dd3dac512483e15b4.
- Checkout: primary Cove checkout, branch `p/luchengxuan/workflow-governance` (created before adopting the new milestone/issue naming convention).
- Objective: apply the user's multi-agent workflow, atomic commits and rebase-only GitHub policy before milestone implementation.
- Write scope: this plan, `docs/engineering-plan.md`, root `AGENTS.md`, `docs/handoff.md`; GitHub repository merge settings, main ruleset and this task's Issue/PR/evidence.
- Dependencies: existing engineering baseline; read-only Astra planning recommendations; independent Sol review; required GitHub checks.
- Validation: document consistency/format, verify actual repository rules and merge methods, required macOS/Linux CI, independent review on the final PR head.
- Exclusions: M0 feature implementation or transition approval, shared TraeX/warmpool configuration changes, delegation plugin, service restarts, new runtime/toolchain selections.

## Sequence

1. Inspect local TraeX CLI and warmpool without modifying shared service state.
2. Bootstrap the empty remote from already accepted commits and configure rebase-only merging and main protection.
3. Record the accepted coordination and GitHub workflow in the engineering plan.
4. Translate stable policies into contributor instructions in a separate atomic commit.
5. Track this change in an Issue/PR, validate and obtain independent GPT-6 Sol high review, then rebase & merge when all gates pass.

## Commit boundaries

- Engineering workflow and this task's execution record: describe roles, dependency planning, stage approval, provenance and rebase-only integration.
- Contributor instructions: apply atomic commits, rationale comments and dispatch/merge constraints to future work.

Commit messages explain what changed and why. Execution-specific test results belong in the PR and task records, not commit messages.

## Execution record

- Tracking: [Issue #1](https://github.com/GhostFlying/cove/issues/1).
- Astra high supplied the role/contract/CI plan. Implementation, independent validation and review are tracked separately.
- Confirmed the remote was empty, then bootstrapped main at `9be4021dff2c10a059dd943dd3dac512483e15b4` without rewriting its existing three commits.
- Repository merge settings now enable rebase only. Active main rules require PRs, linear history, no deletion/force-push, resolved review conversations, strict current-base checks for both `check (ubuntu-latest)` and `check (macos-latest)`, and no bypass actors.
- GitHub native approving-review count is zero because all agents use the same user identity; independent GPT-6 Sol review is an explicit coordinator gate, not a fabricated GitHub approval.
- First hosted CI exposed developer-private registry tarballs; [Issue #2](https://github.com/GhostFlying/cove/issues/2) tracks the separately planned Sol fix. That fix passed independent validation/review and both hosted checks, then rebase-merged as `3628bc03935067b5f5ddf3524b035be5ea9d24fe` (source `40b0ad89b34d4a602c641be0b39440762097c4c0`). Required checks remain enabled; this branch was rebased onto the fix.
- Local TraeX 0.205.1 lists `gpt-5.6-sol`. The interactive alias wraps warmpool but its profile selects a different model/effort; model and high effort must be explicit for task dispatch. At inspection, the target pool was cold with zero warm slots. The user clarified that a warm hit is optional: dispatch still proceeds through warmpool and may queue briefly or start immediately. No shared configuration/service was changed.
- Local TraeX was invoked explicitly with GPT-5.6 Sol high through warmpool and completed read-only documentation validation at `8bb98e4`. It reported a task-record omission of the Linux route; agent-run Linux validation uses `ssh devbox`, while GitHub-hosted Linux CI is a separate required gate. No manual Linux validation was needed for this documentation change.
- Source review and independent documentation validation at the earlier head passed; final evidence is refreshed on the PR after these user clarifications and rebase.
- User requires comparative Orca source research during planning/decisions and durable design/plan/handoff records for long-running work.
- User added atomic commits: one coherent, independently understandable change per commit, preserving useful buildable intermediate history.

Validation and independent review results will be attached to the PR against its exact head/base. Milestone implementation remains subject to the user's stage-entry review and permission.
