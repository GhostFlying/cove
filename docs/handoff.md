# Cove current handoff

Updated: 2026-10-09. Current state only (at most 150 lines). Recheck GitHub and checkouts
before resuming; history lives in Git, Issues and PRs (the long pre-takeover handoff is
`git show 3d7349a:docs/handoff.md`).

## Authorized stage

- M0 implementation approved 2026-09-26. M0 exit and M1 entry need explicit user review.
- 2026-10-09 the user narrowed M0 to the eight scenarios in [M0](milestones/m0.md) plus one
  focused real-agent trial session (about an hour, checklist in M0), and moved coordination to Claude Code
  ([engineering 6.1](engineering-plan.md#61-角色授权与执行入口2026-10-09-用户调整)).
- Autonomous rebase & merge is allowed after green CI and an independent review with no
  open findings.

## Main

- PR #66 local entry, #67 scope/workflow, #68 web ports + `cove` CLI, #69 server fixes +
  S1/S2/S8 merged 2026-10-09. Earlier qualification notes for PR #66 below.
  PR #66 qualified by macOS/Ubuntu CI (run 37880784592), the earlier full independent
  review on `5c7ba9b`, and a TraeX delta review of the two test-expectation fixes.
  Protocol version 2, profile `pragmatic-logical-grid-v1`, encoding `vt-checkpoint-tail-v1`.
- Server runs as `cove-server` (`apps/server/dist/entry/main.js`) with HTTP RPC
  (`server.status`, `terminal.create|get|list|stop`, `operation.get`) and the terminal WebSocket.
- `apps/cli` (`cove`) and `@cove/client/web-ports` are on main; the M0 test harness page
  (`apps/m0-harness`, `cove server start --harness`) is in progress.

## Next actions

1. Client fix: fast typing and the first key after focus lose input (per-keystroke
   set-control churn; input sent before the covering applied-ack). In progress.
2. H1 harness page + Playwright smoke (types at normal speed; green once 1 lands).
3. S3–S7 compiled tests (S3/S7 extra requirements are on Issue #21).
4. Focused real-agent trial (checklist in M0), fixes, then M0 stage review request.

## Environment

- Pinned toolchain (Node 26.10.0, pnpm 12.6.0): `~/.cache/cove-toolchain`; prepend
  `pnpm/bin` and `node-v26.10.0-darwin-arm64/bin` to `PATH`.
- Primary checkout `~/WORKSPACE/cove` is the only active writer.
- `~/WORKSPACE/cove-worktrees/m0-probes-verify` (PR #66 branch, merged) only holds an
  uncommitted pre-takeover pause note; it can be removed with the user's consent.
- The Codex automation `cove-m0-practical-recovery` is PAUSED and must stay paused; only one
  coordinator may be active.
- `~/WORKSPACE/cove-evidence` (~29 GB) is pre-takeover history; no new entries.
