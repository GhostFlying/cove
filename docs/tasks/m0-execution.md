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
