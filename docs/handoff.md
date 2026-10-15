# Cove current handoff

Updated: 2026-10-15. Current state only (at most 150 lines). Recheck GitHub and checkouts
before resuming; history lives in Git, Issues and PRs (the long pre-takeover handoff is
`git show 3d7349a:docs/handoff.md`).

## Authorized stage

- M0 implementation approved 2026-09-26. M0 exit and M1 entry need explicit user review;
  neither is authorized.
- 2026-10-09 the user narrowed M0 to the eight scenarios in [M0](milestones/m0.md) plus one
  focused real-agent trial session (checklist in M0), and moved coordination to Claude Code
  ([engineering 6.1](engineering-plan.md#61-角色授权与执行入口2026-10-09-用户调整)).
- Autonomous rebase & merge is allowed after green CI and an independent review with no
  open findings.

## Main

- Main is `7940733` (PR #89); Engineering checks run 38077319185 succeeded on it.
- All eight scenarios S1–S8 are compiled-artifact tests in
  `apps/cli/tests/scenarios.test.mjs` and run in the macOS and Ubuntu CI jobs on main.
- Server runs as `cove-server` (`apps/server/dist/entry/main.js`) with HTTP RPC and the
  terminal WebSocket; `apps/cli` (`cove`) and the M0 test harness page (`apps/m0-harness`,
  `cove server start --harness`) are on main.
- Merged since the 2026-10-09 handoff:
  - #78 S3 and S7 compiled tests; #79 client per-connection lifetime caps;
  - #80 resize recovery and deferred focus; #81 worker accepts the route-control window;
  - #82 WebGL2 renderer with DOM fallback and fit inside the visible area;
  - #85 W2C-C03 flake fix; #86 unified callback re-entry rule and input hold during
    recovery (#84, #83); #89 per-lifetime fatal coalescing and the wait-for-fact rule for
    unknown harness control results (#88).
- Review waivers (explicit user decisions):
  - #80 and #82 were merged under a user waiver; their findings went into #84, which #86
    resolved.
  - #86 was merged under a user waiver on 2026-10-11; its findings went into #88, which
    #89 fixed. #89 was merged with no open review findings.

## Kept user decisions

- Input typed during a recovery is held and sent once the view is ready (#83).
- Prefix closure for control ([relay-protocol §9.1](relay-protocol.md#91-focus控制权与自动-resize)).
- The harness never auto-retries a control command that may have been applied and never
  retakes control without a user gesture.
- Future idea from the user, not scheduled: idempotent control requests with request keys.

## Real-agent trial

- The user ran the focused trial on the harness, with trial servers built from main
  `e85da0a` and `7940733`. On 2026-10-15 the user reported no remaining problems. This is
  the user's report; no individual checklist item was measured separately.

## Known follow-ups (do not block M0)

- #87 test flakes: `untilTurn` turn budget; partial JSON read at `pipe-harness.mjs:423`,
  seen in worker-query-observation and pipe-main-real.
- A harness click outside the xterm screen leaves keyboard focus off the terminal.
- The arbiter returns BUSY after 128 controlled runs.
- A fifth simultaneous ack gets BUSY.

## Next actions

1. M0 stage review (Issue #26) by the user. Do not start M0 exit or M1 work without the
   user's explicit permission.

## Environment

- Pinned toolchain (Node 26.10.0, pnpm 12.6.0): `~/.cache/cove-toolchain`; prepend
  `pnpm/bin` and `node-v26.10.0-darwin-arm64/bin` to `PATH`.
- The Codex automation `cove-m0-practical-recovery` is PAUSED and must stay paused; only one
  coordinator may be active.
- `~/WORKSPACE/cove-evidence` (~29 GB) is pre-takeover history; no new entries.
- `~/WORKSPACE/cove-worktrees/m0-probes-verify` (PR #66 branch, merged) only holds an
  uncommitted pre-takeover pause note; it can be removed only with the user's consent.
- Trial servers trial3–trial6 may still be running from `~/WORKSPACE/cove-worktrees/trial-*`;
  stopping them needs the user's consent.
