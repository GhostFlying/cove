# Cove current handoff

Updated: 2026-10-09. Current state only (at most 150 lines). Recheck GitHub and checkouts
before resuming; history lives in Git, Issues and PRs (the long pre-takeover handoff is
`git show 3d7349a:docs/handoff.md`).

## Authorized stage

- M0 implementation approved 2026-09-26. M0 exit and M1 entry need explicit user review.
- 2026-10-09 the user narrowed M0 to the eight scenarios in [M0](milestones/m0.md) plus one
  day of real-agent use, and moved coordination to Claude Code
  ([engineering 6.1](engineering-plan.md#61-角色授权与执行入口2026-10-09-用户调整)).
- Autonomous rebase & merge is allowed after green CI and an independent review with no
  open findings.

## Main

- `origin/main` = `3d7349a` (PR #66 local entry merged 2026-10-09).
- Server runs as `cove-server` (`apps/server/dist/entry/main.js`) with HTTP RPC
  (`server.status`, `terminal.create|get|list|stop`, `operation.get`) and the terminal WebSocket.
- `@cove/client` and `@cove/terminal-web` exist as libraries; there is no `apps/cli` and
  no end-to-end browser page yet.

## Next actions

1. H1 (#21): `apps/cli` plus a browser terminal page using public package exports.
2. S1–S8 as compiled-artifact tests in CI.
3. User real-agent trial, fixes, then M0 stage review request.
4. GitHub: move #23, #24, #25, #28 out of M0; mark #22 superseded by S1–S8; narrow #17
   to recovery; rewrite #26 as the stage review.

## Environment

- Pinned toolchain (Node 26.10.0, pnpm 12.6.0): `~/.cache/cove-toolchain`; prepend
  `pnpm/bin` and `node-v26.10.0-darwin-arm64/bin` to `PATH`.
- Primary checkout `~/WORKSPACE/cove` is the only active writer.
- `~/WORKSPACE/cove-worktrees/m0-probes-verify` (PR #66 branch, merged) only holds an
  uncommitted pre-takeover pause note; it can be removed with the user's consent.
- The Codex automation `cove-m0-practical-recovery` is PAUSED and must stay paused; only one
  coordinator may be active.
- `~/WORKSPACE/cove-evidence` (~29 GB) is pre-takeover history; no new entries.
