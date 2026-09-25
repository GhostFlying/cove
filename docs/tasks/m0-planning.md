# M0 planning integration

- Owner: coordinator; three independent GPT-6 Astra high module planners.
- Tracking: [Issue #5](https://github.com/GhostFlying/cove/issues/5), planning children #6, #7, #8; GitHub milestone M0.
- Base: `1e1398462c2aadc5a9171e40aef7c5d9f0ad3da7`.
- Checkout: primary Cove checkout, `p/luchengxuan/m0-5-plan-integration`; three task-owned planning worktrees.
- Objective: deliver a reviewable M0 scope, module plans, task DAG, acceptance and GitHub tracking. This is planning authorization, not permission to implement M0 features.
- Writable coordinator scope: this plan, `docs/milestones/m0.md`, `docs/handoff.md`; integrate the planners' committed `docs/plans/m0-*.md` files and necessary formatting/consistency corrections. No application code, dependencies, root configuration or CI workflow edits.
- Planner scopes: protocol/server/client/CLI plan (#6); terminal engine/worker/recovery plan (#7); CI/acceptance plan (#8). Each owns one plan file on its branch; no overlapping writes.
- Source evidence: clean local Orca fork `GhostFlying/orca`, revision `322c1839888f4a462e2d68839deafb1fe616c685`, branch `p/luchengxuan/fork-worktree-scan-candidate`, package version 1.4.190. This is a pinned fork checkout, not a claim of upstream behavior or latest release.
- Contracts: existing Cove product/server/terminal/protocol decisions. Plans must label additional proposals and user decisions rather than silently changing accepted design.
- Validation: inspect source evidence, reconcile cross-module dependencies and acceptance, independent documentation/DAG validation, separate GPT-6 Sol high review, hosted checks on the integrated documentation PR.
- Exclusions: M0 implementation, M1 domain features, deployments, private session fixtures, changes to Orca or shared services, automatic milestone entry.

## Delivery sequence

1. Planners inspect Cove decisions and relevant Orca source, document alternatives/tradeoffs and task dependencies.
2. Coordinator integrates atomic planner commits and reconciles a single DAG; dependency/conflict analysis may use a separate Sol high agent.
3. Create implementation issues as proposed/blocked on stage approval, with exact dependencies and acceptance.
4. Independently validate/review the integrated proposal and merge documentation through the normal gates. Planning document merge does not authorize feature execution.
5. Present scope, DAG and decisions to the user; wait for explicit entry approval before dispatching implementation.

## Execution record

User confirmed the local-only M0 experiment boundary: temporary access credentials, server-lifetime operation records, and two browser terminal test pages; durable persistence and formal pairing remain M1/M2. This scope decision is accepted, while final DAG/phase entry review remains pending.

Planning dispatched; no implementation tasks started. Detailed current state is in the milestone and linked Issues. Agent allocation respects the native four-slot limit including coordinator, with three planning worktrees and no recursive dispatch.

## Integrated dependency review

Sol high `/root/m0_dag_check` independently identified the missing full P2→T5 prerequisite, staged C2 entry wiring, complete A7 reference requirements, and credential handoff ownership. The coordinator incorporated these into the aggregate DAG and module addenda. B0/Q1/V1 now have explicit owners; P1a → parallel T1/Q1 → P1b breaks the recovery-freeze cycle. Implementation Issues #9–#26 plus #28 remain proposed and blocked on M0 entry approval. No feature implementation has started.

Upstream verification also read the latest stable v1.4.211 peeled commit `5534462b50c660888487a2108700d4cf284270db`; exact source distinctions and bounded comparison are recorded in the milestone. Original Orca checkout remains unchanged.

Independent final Sol review at `2e7b951` found that a later fixture-only SHA could pass the mixed-version acceptance with identical executable code. Added E1 #28 between F1 and C4b, owned by an implementation agent and coordinated by the protocol writer, requiring a useful compatible M0 evolution plus runtime source/normalized artifact differences. C4b remains independent validation, and metadata-only changes do not satisfy the gate.

GitHub review also identified that terminal-architecture §3.7 already requires 100 concurrently outputting PTYs on devbox in the first prototype. Restored that synthetic real-PTY gate to C5/X1 and their resource/measurement evidence; only 100 real agents, mobile performance and long-duration capacity remain deferred. This preserves the accepted scope rather than seeking a reduction. Normal hosted CI stays at small semantic workloads. The final revised head needs independent delta validation/review and new CI; exact evidence is in PR #27/Issue #5.
