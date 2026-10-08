# Cove current handoff

Updated: 2026-10-08 process reset. Recheck GitHub, checkout and live command state
before resuming. This file holds current state only (maximum 150 lines).

## Authorized stage and process

M0 implementation was approved on 2026-09-26 ([M0 DAG](milestones/m0.md)).
Routine M0 implementation, isolated verification and gated PR integration are
approved; M0 exit and M1 entry require explicit human stage review/permission.
Product, architecture, scope and acceptance changes still go to the user.

[Engineering 6.9](engineering-plan.md)
was approved on 2026-10-08. It supersedes conflicting historical per-atom
source-prereview/seal gates. One-off off-tree verification tools may run after
self-check; preserve raw failures/UNKNOWN and fix/rerun tool defects directly.
Repository/CI tests, acceptance semantics, independent roles and mandatory local,
native, CI and actual-main gates remain. No first-run-success requirement.

## Main and remaining DAG

- Coordinator-verified `origin/main`: `6414a0dfd6cb6f8830d592d91ea814c678dae90e`
  (PR #65); actual macOS/Ubuntu main CI each passed 1119 identities / 90 files.
- C1, B0, P1a, Q1, T1, P1b, T2, W1 and V1 have accepted scopes. PR #46–#65
  history is retained; W2, P2 and P3 practical slices do not establish full closure.

| Issue | Node | Current condition                                                         |
| ----- | ---- | ------------------------------------------------------------------------- |
| #17   | W2   | Bounded practical slices merged (#63–#65); installed/native gaps remain   |
| #18   | P2   | Active D local entry; earlier private slices merged, full P2 pending      |
| #19   | P3   | Bounded controller/state slices merged; real integrated journeys pending  |
| #21   | H1   | Wait for actual P2, P3 and V1 prerequisites; DG alone cannot release it   |
| #22   | C3   | Waits on H1; real two-client compiled acceptance                          |
| #23   | F1   | Waits on C3; freeze compatibility reference                               |
| #28   | E1   | Waits on F1; actual compatible evolution                                  |
| #24   | C4b  | Waits on E1; mixed-version acceptance                                     |
| #25   | C5   | Waits on C3; devbox 100 real PTYs and resource/queue acceptance           |
| #26   | X1   | Waits on C4b/C5; same-main-SHA cross-platform evidence, then human review |

## P2-D current candidate and evidence

- Checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-probes-verify`;
  branch `p/luchengxuan/m0-18-local-entry`. Original D head
  `b443982e123224ad0a8d4249db5ba86c32fcd4ce`, tree
  `6f8dc22fa0205a5ecbfb7943c7841acebdb50b44`: 17 original commits above main.
  Product/compiled bytes remain at `b443982`; preserve all original commits/refs.
  The three process documents are checked and staged; no reset commit was created.
  Normal commit is blocked by `NORMAL_PRECOMMIT_SHELL_STARTUP_WAIT`; the task's
  stuck Git/hook command was cancelled and reaped, with raw diagnostics retained.
- Candidate is not pushed, has no PR/hosted CI yet. Push/open draft early and run
  CI in parallel with local acceptance; independent full-PR review batches findings.
- [D plan](tasks/m0-server-local-entry-plan.md) and
  [D results](tasks/m0-server-local-entry-results.md) retain source and scoped history.
  Process-only stop/review gates in old records are superseded by 6.9.
- Implemented: local entry/admission, six-method HTTP/WS wiring, rendezvous,
  installed worker support in `apps/server/tests/independent/installed-local-entry/`.
- Accepted lower-carrier evidence at `92252d2`: original DN 162 PASS / 4 named
  NOT_EXERCISED; fixed-status 3 PASS / 2 NOT_EXERCISED; four fetch supplements
  pass separately. Generic/component results do not establish native/full D.
- Six named unexercised stages remain tracked: `DN04.bootstrap-absent-browser`,
  `DN04.rpc-absent-browser`, `DN06.clock-5000-close-before-message`,
  `DN06.clock-5000-expiry-before-message`, `DN09.close-held-completion-close`,
  `DN09.held-completion-close-late-completion`. Supplements never substitute for them.

### DG carrier controls and separate required acceptance

The original six DG carrier controls completed once: **6/6 PASS**, 2026-10-08
03:58:18.426692Z–03:58:25.662265Z (7.235s), on `b443982` with the three staged docs;
product and compiled97 bytes unchanged. Expected negative-control errors remain raw.
Result: `process-reset-20261008/dg-execution/result-summary.json` and `report.md`
under the evidence root below. PASS applies only to these controls:

| Control | Actual check                          |
| ------- | ------------------------------------- |
| C01     | Runtime composition/admission frames  |
| C02     | Worker-stop unavailable rejection     |
| C03     | Actual `listen(-1)` error and cleanup |
| C04     | Rendezvous failure                    |
| C05     | Observer installation rollback        |
| C06     | Preclosed journal FD failure          |

These are carrier control checks, not installed entry/startup13/QN8 acceptance.
Remaining requirements include installed entry, 13 startup rows, QN01–QN08,
default timer, native HTTP parsing/registered WS upgrade and reassembly, real OS
pipe/socket, two task-owned PTYs, coherent full ordinary `pnpm check`, required
hosted dual-OS CI/artifacts and actual-main checks, and devbox same-SHA evidence
at the allocated DAG gate. Preserve each task's actual prerequisite/acceptance scope.

### Next actions

1. Transfer coordination using this checked/staged handoff. User-approved 6.9 is
   effective; fresh sessions must not restart per-tool source-prereview loops.
2. Allocate the remaining actual installed/startup13/QN8/default-timer/native/full
   acceptance above on isolated owned resources; completed DG does not satisfy it.
   Self-check/fix off-tree tools directly and retain raw failures/UNKNOWN/history.
3. Push the buildable candidate/open draft PR early; run CI while independently
   completing required installed/native/full acceptance. Product fixes get atomic
   Conventional Commits; original 17 subjects remain historical deviations.
4. Complete one full independent PR review, batch findings, then review fixes'
   delta and impact. Integrate only with current evidence/all required gates;
   verify actual main before releasing dependencies. Check real P2/P3/V1 readiness
   before H1; do not jump to H1 after DG. M0/M1 remain gated by human stage review.

## Worktrees, active resources and controlled transfer

Only primary `cove` (`aef2fe1`) and `m0-probes-verify` (`b443982`) remain.
Approved recovery/view cleanup completed: normal `git worktree remove` both CLI0,
target directories absent; all Git refs unchanged and branches `ca934043`/`1c3a61e9`
retained (5/6 equivalent patches, zero unmatched against accepted main `6414a0d`).
249 `.cache/ci` files / 58,565,302 bytes are privately recoverable. Restore commands
and details: `process-reset-20261008/worktree-cleanup/outcome.md` under evidence root.
R54–R72 evidence is untouched; archive only after D PR merge and active-path release.

R73 is RELEASED_STOP (CLI0, own commands reaped); its cleanup-order tool finding
R73-F01 remains PR reference, not product acceptance or a DG prerequisite.
No R74 per-tool review is planned; full detail remains in off-tree reports.

`/root/dg_runtime_execution` completed and RELEASED its runtime-heavy lease.
Own carrier/Node births, CLI0 wait/reap and later absence confirmed, signals0;
no host-zero claim. The pre-close outcome lease
snapshot lacks an explicit durable outcome-close receipt; preserve that limitation.
The normal-hook environment block does not gate runtime. The document writer
releases its three-doc/Git scope with its completion report. After safe environment
recovery, the next assigned Git owner completes the normal atomic docs commit with original user hooks/identity;
do not bypass hooks, retry blindly or wait for all runtime tests to commit docs.
The coordinator has replaced the heartbeat with the
approved short process prompt and it is ACTIVE; the old prompt is superseded.
Root will open the fresh coordinator chat and transfer its heartbeat from this
ready handoff; old owners have no active commands after completion.
Only one coordinator may be active; transfer live command handles/resources
explicitly. Notify on the 6.9 three-round/24h/48h/interruption>2h conditions;
events advance work immediately, heartbeat is fallback, unchanged alerts are quiet.

## Preserved limits and history

- Pins remain Node 26.10.0 / pnpm 12.6.0; frozen installs and normal user hooks.
- Original failed results, UNKNOWN causes, missing raw, R5/R6 one-use history,
  scoped cleanup/positive persistent and reserved accounts remain; no host-zero claim.
- Open technical gaps: I10 same-worker native counter, native/RSS, real-agent,
  devbox same-SHA qualification, authentic other-UID/ephemeral-inode observations.
- No keeper, scrollback persistence, scheduler, chat, Web App, Shepherd or agent
  final-status hook in M0. See [design](design.md), [server](server-architecture.md),
  [protocol](relay-protocol.md), [terminal](terminal-architecture.md).
- Long handoff history: `b443982:docs/handoff.md`; task plans/results and Issues/PRs
  retain detailed acceptance. Off-tree checkpoint `w1-completion/dispatch-20261008T033120Z.json`
  is history only; 6.9 controls current process. Evidence root is
  `/Users/luchengxuan/WORKSPACE/cove-evidence`. Archive complete superseded evidence
  only after active absolute-path dependencies are resolved; retain failures/UNKNOWN
  and irreplaceable results, and keep sensitive raw private logs private.
