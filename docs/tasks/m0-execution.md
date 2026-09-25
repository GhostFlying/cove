# M0 execution coordination

- Authorization: user explicitly approved the merged M0 scope/DAG on 2026-09-26. No further entry confirmation is required within M0; M0 exit/M1 entry remain user decisions.
- Baseline: main `a902ee0bae0e6539afab6555c0585ff6745261d5`, PR #27, final macOS/Linux checks passed.
- Coordinator checkout: primary Cove repository; branch `p/luchengxuan/m0-9-ci-integration` for C1 integration.
- Coordinator writable scope: this execution record, `docs/handoff.md`, milestone and module-plan authorization/status; GitHub tracking. C1 implementation alone owns root tooling/CI/test changes and its task plan.
- DAG: [M0](../milestones/m0.md); 19 tasks, 22 edges. C1 #9 is initially ready; B0 #10 waits for C1 integrated main checks. Do not bypass contract/risk-probe gates to maximize concurrency.
- C1 implementer: `/root/m0_c1_impl`, GPT-6 Sol high, checkout `cove-worktrees/m0-ci-gates`, branch `p/luchengxuan/m0-9-ci-gates`, baseline above. Independent tester and Sol reviewer are assigned after a frozen implementation head; no recursive dispatch.
- Allocation: coordinator plus one active task agent, two task worktrees initially. Maximum five task agents/worktrees globally, with native limit four including coordinator. Local TraeX through warmpool is eligible for independent testing; warm hit is optional, not an admission gate.
- Checks: use exact Node/pnpm pins; root tooling changes require pnpm check; independent negative-path tests and separate Sol review; exact-head required macOS/Linux CI; rebase-only merge; tree/commit mapping and final main CI before dependent work.
- Constraints: preserve selected architecture and accepted devbox 100 synthetic real-PTY gate; no keeper, SQLite/task/product GUI or later milestone scope in C1. No existing services are restarted. Implementation/test logs contain only task-owned synthetic data.

## Entry checkpoint

The 2026-09-26 approval removes the common M0-entry blocker from implementation Issues #9–#26 and #28. Their individual dependency blockers remain. C1 is dispatched; all other implementation tasks wait for their prerequisite main SHAs. Product/architecture/scope/acceptance changes go to the user with evidence/options while independent ready work continues.

## C1 completion and B0 release

C1 PR #29 merged at `72c15b30c20d8d8228c4988517786c109197a6c5`; final main CI run 36163798332 passed macOS/Linux. Independent local TraeX GPT-5.6 Sol high via warmpool proved the final 10-test gate and counterfactual failures; a separate GPT-6 Sol high reviewer approved the exact source head. Full evidence and rebase mappings are in Issue #9 / PR #29. Clean delivered implementation/verification worktrees were removed; no application or devbox workload was run.

B0 #10 now starts from that baseline. Astra-high `/root/m0_b0_plan` owns only `docs/tasks/m0-package-plan.md` in `cove-worktrees/m0-package-plan`, branch `p/luchengxuan/m0-10-package-plan`. The coordinator owns this record and handoff on `p/luchengxuan/m0-10-package-integration`. Current allocation is coordinator plus one planner, two worktrees; recompute live counts before dispatch. Planning pins needed stable candidates and minimal executable probe boundaries; no code/config/install changes until the concrete scope is committed. The approved M0 DAG remains unchanged.

## B0 implementation dispatch

Astra-high plan `4d4e10142d3fd18a0df9e6436cc7e369a2717411` was integrated as `b1de6cb`; planning worktree was clean and removed. `/root/m0_b0_impl`, GPT-6 Sol high, owns the plan's explicitly listed manifests/lock/build/CI/probe/development-document paths in `cove-worktrees/m0-package-probes`, branch `p/luchengxuan/m0-10-package-probes`, base `b1de6cb`. Root owns only coordination records in the integration checkout. Independent testing and review are assigned after a frozen head; no concurrent root dependency writer. Two actual experimental packages are authorized, no production exports/placeholders. Native/browser smoke evidence remains pending.
