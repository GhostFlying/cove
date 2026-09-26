# V1 replaceable xterm browser TerminalView results

Status: implementation candidate frozen for independent testing, review, and shared CI registration on 2026-09-26. This is scoped macOS browser evidence, not M0 integration or final renderer-performance acceptance.

## Candidate and scope

The implementation candidate is commit `b137c844f9b8a312449834e4beb7cc9c39f2d214`, tree `76ed60e234ba2fd9c772e371c081e55bad296594`, on `p/luchengxuan/m0-20-terminal-view`. Its authorized base is `560d6e3e0fe79e3e6d2f7ff51dbbef0fa943b5a0`; the pre-code execution entry is commit `47e001b`. The sole implementer was local TraeX GPT-5.6 Sol with high reasoning effort through warmpool (`WARMPOOL_ACTIVE=1`, thread `01a0dd11-2749-7580-9d9c-8117185ecace`). No warm-session identifier was exposed, so this report does not claim an actual warm hit.

The candidate exports `createXtermTerminalView(container: HTMLElement): TerminalView` as `@cove/terminal-web/xterm-view`. It adds no protocol, dependency, pin, lockfile, root configuration, shared test-gate, transport, controller, PTY, server, product UI, agent, SSH, or GPU-renderer change. Historical Q1 probes and fixtures are unchanged. The browser test fixture consumes the built public package subpath; production imports no probe implementation.

The adapter uses xterm 6.0.0's built-in DOM renderer and implements:

- exact-version and private-core ownership guards before input admission;
- permanent suppression of non-user xterm data emissions while preserving provenance-qualified keyboard, paste, mouse, alternate-wheel, composition, and raw binary input;
- real `Terminal.write(bytes, callback)` completion with one pending parse, a 15-second hang deadline, cancellation, and external-generation/internal-incarnation fences;
- streaming `vt-checkpoint-tail-v1` installation with the accepted 64-KiB chunk, 8-MiB VT, 64-KiB tail, and 129-chunk bounds without retaining a second whole baseline;
- authoritative ordered resize/control/appearance application, pure and clamped measurement proposals, fixed 1000-line history, fresh-model replacement, and finite failure/disposal behavior;
- focus-before-input intent, while selection, copy, ordinary scrolling, visibility, appearance, output, and recovery do not independently claim control.

The pending P3 external `SubscriptionRef` routing decision is outside this adapter. V1 consumes the unchanged inner `TerminalEvent` and does not make a routing decision.

## Environment and immutable inputs

- Checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-view`
- OS/architecture: macOS 26.3, Darwin arm64
- Node: 26.10.0
- pnpm: 12.6.0
- xterm: 6.0.0
- Playwright: 1.63.0
- Managed Chromium: 153.0.8010.12, revision 1243
- Lockfile SHA-256: `4173cbfdbc0c169a7d5d3780461276e6ae77791ab98c2662fe1cc071dbacdc0f`
- Retained Q1 query fixture SHA-256: `8e07fc93db4688526566484c4b0814012369ba2a7dbecc20dd36040c5a1779c7`
- Accepted profile/encoding: `pragmatic-logical-grid-v1` / `vt-checkpoint-tail-v1`
- Comparative Orca revision: `5534462b50c660888487a2108700d4cf284270db`, inspected only through immutable Git objects

The approved plan report was verified before implementation at the coordinator-provided SHA-256 `51b4e70df3702b1cf6030053d68703f2d6aae58c453b5c0ea17a7e1b0049d578`. At final evidence collection, the mutable file `/tmp/cove-m0-adapter-plan-review.md` instead hashed to `c0c06d7ed4fae6c102838b0c384d852ca1d869bf2c9c9e8842dcc7da04e49c75` and had a later modification time. The original approval hash remains the pre-code authorization evidence; the changed temporary artifact is reported as unverified residue and is not treated as equivalent evidence.

## Checks actually run

All commands used the pinned toolchain path. The frozen formatted source produced these final results:

| Check                                                                                    | Result                                        | Scope                                                                           |
| ---------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                         | pass                                          | Worktree-local install; no lockfile change                                      |
| `pnpm --filter @cove/terminal-web --fail-if-no-match build`                              | pass                                          | Production/probe TypeScript projects plus both Vite browser bundles             |
| `pnpm exec prettier --check` over owned terminal-web manifests, TS, MJS, and HTML        | pass after mechanical formatting              | Owned V1 files only                                                             |
| `pnpm exec oxlint --deny-warnings packages/terminal-web/src packages/terminal-web/tests` | pass                                          | Owned production and acceptance source                                          |
| `pnpm --filter @cove/terminal-web --fail-if-no-match test`                               | pass, 2 files / 15 retained Q1 tests, 50.74 s | Existing registered `terminal-web-probes` project after rebuilding both bundles |
| `pnpm exec vitest run --config /tmp/cove-m0-v1-traex/vitest.config.mjs`                  | pass, 3 files / 18 tests, 40.39 s             | External task-owned V1 config; not the shared/full CI gate                      |
| `git diff --cached --check` before source commit                                         | pass                                          | Frozen source/test patch                                                        |

The 18 finite V1 cases are exactly `V1-I1` through `V1-I6`, `V1-R1` through `V1-R6`, and `V1-L1` through `V1-L6`. They exercise authored Q1 replies in live/baseline/replay phases; exact keyboard, paste, SGR/legacy mouse, binary, and query-shaped genuine input; UTF-8/CSI/OSC/DCS split tails; normal/alternate model recovery; parser overlap, deadline and stale-callback fencing; full maximum streaming baseline; authoritative resize and pure measurement; focus, appearance, construction failure, oversized input, and 20 create/dispose cycles. Browser assertions inspect raw intent bytes/sources, public xterm buffer/mode/cursor evidence, parser promise settlement, typed failures, DOM ownership, and cleanup errors rather than screenshots or query counts alone.

Earlier development runs are not final evidence: Chromium was initially absent; fixture import and byte conversion bugs caused setup failures; a later run passed 12/18; another passed 17/18 but hit the graceful browser-close bound; and an earlier corrected corpus passed 18/18 before assertions were tightened. The final reported run is the formatted, tightened 18/18 result above. These failures led to installation of only the pinned managed browser, corrected fixture ownership/oracles, next-task mouse provenance lifetime, a three-second graceful-close bound with forced-kill fallback, and genuine checks of missing payload, full baseline maximum, construction failure, and the real 15-second parser deadline.

## Cleanup and remaining gates

The managed runner closed its owned page, browser server/process, and ephemeral HTTP listener on success. A post-run process scan found no owned `chromium-1243`, V1 runner, or Vite browser process. The worktree intentionally retains its own `node_modules`, compiled `dist`/TypeScript state, and pinned Playwright browser cache for subsequent independent checks. No user terminal, clipboard content, service, credential, remote host, or external device was used.

The bounded shared-registration request is `/tmp/cove-m0-v1-traex/registration-request.md` (SHA-256 `4d95c5f26770f7544eb8fad088be59a2810565cd900487c1754faf69c136c619`). The temporary scoped config is `/tmp/cove-m0-v1-traex/vitest.config.mjs` (SHA-256 `803c8870aa5ba50153b7d1e67813000db229f5edb6a3aec6f4739bf0386416a4`). The root/shared owner still must register the three suites and floors in the shared Vitest/tooling/CI gate. Consequently, no full `pnpm check`, tooling/public-boundary integrated result, Linux result, GitHub CI URL, or full-CI pass is claimed here.

Independent test strategy/results and independent GPT-6 Sol review have not yet been supplied, so no tester/reviewer report hash is available. The coordinator still owns integration, exact-head/base reassessment, GitHub PR/CI, and final-main verification. H1/C3 still owe the real server/worker/P3/V1 two-browser-client PTY workflow, actual ACK/flow control and operator races, real agent workflows, and subscription rebuild during output. Native desktop/mobile input/rendering, GPU context loss, hardware performance, 100-real-PTY capacity, M0 exit, and M1 entry remain unverified and out of scope. Zero outbound automatic bytes here establishes client-view suppression only; it does not by itself establish server PTY reply authority.

## First independent review repair

The independent GPT-6 Sol high source review `/tmp/cove-m0-v1-code-review.md` was verified at SHA-256 `f76f944a738f166d8229471598b214491f2c826abfacf7b51fc8e519bc571d33`. It reviewed author commit `b137c844` and held approval for five bounded repair classes. The corrected source is commit `08c299edf304014be6682ba45ab74592d32f40f6`, tree `a9e7546bb1b91fcddd11a26452f0c4e5d6a20010`; its pre-edit repair allocation is commit `b348bea`. Root had integrated the earlier source/results as `1eb5aa3` and `8941e50` in draft PR 38, but this implementer did not push or modify that PR.

The correction makes replacement construction and runtime resize/theme/refresh failures retire the current backend, publish exactly one typed fatal notification, attempt every tracker/origin/terminal disposer, and retain primary plus cleanup errors in `AggregateError`. Provenance source-clear timers are explicitly tracked and cancelled, repeated disposal is deterministic, and hidden state is installed without exposing a replacement DOM terminal. V1 now uses the accepted Q1/B0 `withManagedBrowser` lifecycle through a minimal backward-compatible built-root and generic-page extension; the runner keeps its prior deadlines, forced-kill fallback, error aggregation, PID/port evidence, and Q1 environment override. The retained Q1 fixture/source semantics and 15 cases are unchanged.

Finite browser assertions now require every UTF-8/CSI/OSC/DCS cut to reach its exact line, buffer, cursor, modes, and zero-input state; the full 129-chunk / 8-MiB-plus-tail transfer must execute all 129 ordered OSC markers and render the last marker; SGR and legacy high-coordinate mouse assertions compare exact bytes, order, and source. Pinned xterm version mismatch, non-pristine replacement construction failure, runtime theme failure with nested cleanup failure, timer cancellation, repeated disposal, and managed-runner simultaneous work/cleanup failures are explicit controls.

Final checks on the frozen corrected source, using the same macOS arm64 and pinned toolchain/browser described above:

| Check                                                              | Corrected result                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `pnpm --filter @cove/terminal-web --fail-if-no-match build`        | pass                                                     |
| Prettier check over the allocated runner glue, V1 source and tests | pass                                                     |
| `pnpm exec oxlint --deny-warnings` over the same paths             | pass                                                     |
| External unregistered V1 suite                                     | pass, 3 files / 18 tests, 49.72 s                        |
| Retained registered Q1 suite via package test                      | pass, 2 files / 15 tests, 51.35 s                        |
| Post-run owned-process scan                                        | no managed Chromium, V1 runner, or Vite process remained |

Development failures are retained rather than recast as candidate failures. The first runner-migration probe failed 18/18 before test bodies because the generic fixture's favicon request returned 404; the authorized shared runner now returns an explicit 204. The next strengthened run passed 17/18; its sole failure expected no rows through a stale test-only `capturedTerminal` pointer after replacement construction failed. The corrected oracle checks zero owned DOM/backend roots, while the public operation already rejected and emitted one fatal failure. The final frozen-source run is the 18/18 result above. No withheld independent V1 sentinel corpus was read or executed.

Shared root Vitest/gate registration, full `pnpm check`, Linux, independent candidate execution, renewed independent review, and GitHub CI remain pending and are not claimed. The P3 routing decision and all prior real-PTY/native/GPU/performance exclusions remain unchanged.

## Final authored-oracle completion

The updated independent review appendix was read in full and verified at SHA-256 `d680d3e49e184e7595968943f4b65a27f60d360363a728c13c94563d01112667`. It closed production findings 1–3 and runner finding 5 on source `08c299e`, leaving two test-only controls. The pre-edit test allocation is commit `f8c964e`; the frozen corrected test commit is `b26892d865d285a8a7bde215f7959cb88ad8cd96`, tree `7a633ef7122dd1f6a68905b58d3dfa1d3252a434`. A diff from `08c299e` confirms no production source or managed-runner change in this batch.

R1 now executes every finite interior cut `1 <= cut < bytes.length` for the authored UTF-8, CSI, OSC and DCS sequences, including both sides of the final `ESC`/backslash terminators, while retaining the exact per-cut line, active-buffer, cursor, mode and zero-input assertions. I4 retains the normal tracking-off click/wheel control and exact tracking-on SGR streams in normal and alternate buffers, then disables 1000/1006 while alternate remains active and asserts one exact `[27, 91, 65]` arrow intent with `source: "mouse"`.

The first affected-suite run passed R1 and 11/12 total cases; I4 showed that one Playwright `wheel(0, -120)` produces one `ESC [ A` intent rather than the initially expected three concatenated arrows. The expected vector was corrected to this observed exact single-delivery behavior without changing production. Final checks were: terminal-web build/typecheck pass; affected Prettier and Oxlint pass; affected recovery/input suites 2 files / 12 tests pass in 18.48 s; and the one instructed final external run 3 files / 18 tests pass in 47.05 s. Retained Q1 was not rerun because production, Q1 fixtures and the shared runner were unchanged. No owned Chromium, V1 runner or Vite process remained after validation.

These remain author-scoped, externally configured results rather than shared/full CI or independent acceptance. The withheld independent corpus was neither read nor executed. All prior registration, Linux, review, integration, PTY, native and performance limitations remain in force.

## PR review production repair

The reopened PR review appendix was read in full and verified at SHA-256 `a1a7cf5a15d819a3e70fae487432dab8fe5ca33fda5bd676b73b56dbe5053a2c`. Root had integrated/rebased the prior candidate onto T2 main and reached reviewed head `bc75e057604d1eb91c3352ac094a32c0cd9c72cd`, including registered dual-OS and independent results, but PR 38 remained unmerged and approval was withheld for two concrete production classes. The pre-code allocation is commit `33186ba`. The repaired source/test head is `4751172e8a09562cf63160d70d1b73001436fa96`, tree `5139fdd6322762a56f97f6144842f1c7ed5dee90`; it consists of public-CSS commit `29b4acd` followed by fatal-retirement commit `4751172`.

The public `@cove/terminal-web/xterm-view` entry now imports xterm 6.0.0's structural stylesheet. The compiled V1 browser consumer no longer imports vendor CSS itself; L3 verifies computed root, viewport, screen and helper-textarea positioning/opacity plus nonzero screen geometry. Thus the test exercises the production import contract instead of masking it with fixture-owned styling. Historical Q1 fixtures remain separate and unchanged.

Fatal parser timeout, synchronous `Terminal.write` failure and fatal input-origin guard callbacks now retire the exact failed backend immediately. The parse operation clears and detaches its deadline before invoking retirement, so backend cancellation cannot re-enter and replace the original rejection or discard teardown evidence. Retirement fences the failed incarnation before notifying listeners, clears backend/baseline state, cancels source timers, restores private wrappers/listeners, disposes xterm, retains primary plus cleanup errors, publishes once, and cannot dispose a listener-created successor. L6 observes zero DOM/owned roots, restored wrappers, attempted listener cleanup, terminal disposal and zero pending source timers before any caller reinitialize/dispose; it then releases the late parser callback and observes no second settlement, input or failure. The same existing case exercises synchronous-write failure with injected cleanup error aggregation and fatal `onUserInput` guard failure, keeping the registered inventory exactly three suites and 18 cases.

Checks on the frozen repair used the pinned Node 26.10.0/pnpm 12.6.0 toolchain:

| Check                                                            | Result                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm --filter @cove/terminal-web build`                         | pass; TypeScript references and both Vite browser bundles        |
| Prettier check over allocated production/browser/lifecycle files | pass                                                             |
| Oxlint `--deny-warnings` over the same paths                     | pass                                                             |
| Affected compiled public-layout control L3                       | pass, 1/1 in 2.93 s after build                                  |
| Affected real-deadline retirement control L6                     | pass, 1/1 in 18.52 s after build                                 |
| Complete lifecycle suite                                         | pass, 1 file / 6 tests, 25.45 s Vitest duration (25.82 s wall)   |
| One final external scoped V1 run                                 | pass, 3 files / 18 tests, 40.80 s Vitest duration (40.97 s wall) |

The final worktree was clean at the frozen source/test head, and a targeted post-run scan found no owned Chromium, V1 runner or Vite process. Retained Q1 was not rerun because this batch changed neither Q1 source/fixture nor the accepted managed runner. These are author-scoped external-config results; root `pnpm check`, renewed independent review/execution, integrated macOS/Linux and GitHub exact-head qualification remain for the coordinator and are not claimed. The withheld corpus was not read. No shared/root gate/config/manifest/lock/pin, protocol/schema/wire/P3, native/W1, PTY/server/product, GPU/performance or GitHub operation was performed.

## Final focus and disposed-registration repair

The additional independent review appendix was read in full and verified at SHA-256 `ba0ba3bd1e0e29cda3dd7e81041cb0c7d4d9a28e542599c90c7fba0cf23b1567`. Root had integrated the preceding CSS/fatal repair as `aa2463e2f3ba4c81bbbace5de03e49a3aa41bbd5`; its C1/F1/F2/F3, full 267 and dual-OS results predate this batch and are not carried forward as exact-head evidence. PR 38 remained unmerged. The pre-code allocation is `f3c2e8b`; the frozen new source/test head is `399c4da2cfd45fdb1bd119299468678e297d1537`, tree `2875cad2dd4b48d52bdc1b417dd6f67f27f6d334`, comprising focus commit `4fdcbfb` and disposed-registration commit `399c4da`.

Every provenance-qualified genuine input now publishes a fresh checked monotonic `focused: true` intent synchronously before its bytes, even when local DOM focus did not transition. This supplies a new activation token after an unobservable remote takeover while leaving ownership/grants/coalescing to the future P3 controller. Blur stays transition-only. L4 performs two genuine Playwright keyboard actions without blur: its lightweight consumer accepts `focusSeq=1` before `x`, invalidates that token to model intervening takeover, and then observes higher `focusSeq=2` immediately before `y`. Its prior visibility, appearance and scroll controls plus new selection/copy control remain free of focus/input intents until deliberate input.

All three public listener registrations now check disposed state before adding a callback and throw typed `RESYNC_REQUIRED` after disposal. L6 verifies live subscriptions can still be disposed repeatedly, then attempts `onInputIntent`, `onFocusIntent` and `onFailure` after first disposal and after a repeated disposal; every call rejects and none returns a subscription. Its earlier real-timeout, synchronous-write, fatal-origin, timer, wrapper/listener, DOM and repeated cleanup assertions remain in the same case. The shared registered inventory remains three suites and 18 cases.

Checks on the frozen repair used pinned Node 26.10.0 and pnpm 12.6.0:

| Check                                                 | Result                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Terminal-web build/typecheck and both Vite bundles    | pass after each defect and at final source                       |
| Affected L4 focus/takeover control                    | pass, 1/1 in 2.87 s after build                                  |
| Affected L6 disposed-registration/lifecycle control   | pass, 1/1 in 17.67 s after build                                 |
| Final-source Prettier and Oxlint with warnings denied | pass over allocated source/browser/lifecycle paths               |
| Complete lifecycle suite                              | pass, 1 file / 6 tests, 24.68 s Vitest duration (24.84 s wall)   |
| One final external scoped V1 run                      | pass, 3 files / 18 tests, 40.26 s Vitest duration (40.42 s wall) |

No failed candidate or driver-correction run occurred in this batch. The source/test worktree was clean at freeze, and a targeted process scan found no owned Chromium, V1 runner or Vite process. Retained Q1 was not rerun because its source, fixture and managed runner were unchanged. These remain author-scoped external-config results; root integration, renewed independent review/testing, full gate, Linux/dual-OS and GitHub exact-head qualification remain separate and are not claimed. No independent corpus, shared/root registration/config/lock/pin, protocol/schema/wire/P3, native/W1, PTY/server/product, GPU/performance or GitHub operation was touched.

## Exact-incarnation input reentry repair

The latest independent review appendix was read and verified at SHA-256 `e39f712bb68c7c1e2079c891c91a15931804c03b6ccfc5ddd8465c7e50983828`. It approved the preceding per-input focus and disposed-registration fixes at author `399c4da`, integrated by root as `62d8b15` with results `ec27a9b`, but identified one synchronous focus-listener reentry residual. The pre-code allocation is `5905dda`; the frozen correction is `2991acf554707ea1ca4d92ce42f93e15f8aec7ed`, tree `dc45c07b91f7f41ccbd38079cf05fd6bfe079c5b`.

Before publishing focus, `publishInput` now requires the captured incarnation to match both the view counter and current backend and requires lifecycle state `ready`. Because focus listeners run synchronously and may mutate the view, it repeats those checks immediately after fresh-focus publication and additionally requires focus to remain effective before copying/emitting bytes. A listener that replaces, hides/blurs, fails or disposes the view therefore suppresses the stale or withdrawn input rather than relabeling it with successor state; input is not replayed. Existing monotonic-counter failure and normal fresh focus-before-input behavior are preserved.

L4 retains its real two-action remote-takeover model and non-input negative controls, and adds two reentry controls. One focus listener synchronously initializes a successor: old `s` bytes are absent, then fresh `n` input reaches the ready successor with that generation's fresh focus. A separate listener synchronously hides/blurs: `h` bytes are absent after the nested false-focus intent, while fresh `v` input succeeds after explicit show. No extra test was added; registration remains three suites and 18 cases.

Checks on the frozen source used pinned Node 26.10.0 and pnpm 12.6.0:

| Check                                                 | Result                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Terminal-web build/typecheck and both Vite bundles    | pass before focused regression and again at final source         |
| Focused L4 exact-incarnation/reentry control          | pass, 1/1 in 1.62 s after build                                  |
| Final-source Prettier and Oxlint with warnings denied | pass over allocated source/browser/lifecycle paths               |
| Complete lifecycle suite                              | pass, 1 file / 6 tests, 25.29 s Vitest duration (25.46 s wall)   |
| One final external scoped V1 run                      | pass, 3 files / 18 tests, 40.33 s Vitest duration (40.50 s wall) |

No failed candidate or driver correction occurred. The worktree was clean at source/test freeze, and a targeted scan found no owned Chromium, V1 runner or Vite process. These are author-scoped external-config results; root full gate, Linux/dual-OS, independent reentry execution/review, GitHub exact-head qualification and merge remain separate and are not claimed. Retained Q1 was not rerun because its source/fixture/runner did not change, and the independent corpus was not read. No protocol/P3/controller, shared/root file, W1/native, server/PTY/product, GPU/performance or GitHub operation was performed.

## Final input-observation predicate correction

Independent Sol review approved source `e5377119a69d850938ccbb17ef091aa70c868b01` for qualification in `/tmp/cove-m0-v1-code-review.md`, verified at SHA-256 `b86dedfca19378b8e46d66f5fa4ae62874fb34beaf827c9f8dcc7e91b581376e`. Root mapped this source as `6aea173`. This approval closes the unintended ready-only admission regression and requested reentry controls; it is source-review approval for qualification, not merge or task acceptance.

The correction replaces the `ready`-only checks introduced at `2991acf` with a shared exact-incarnation predicate evaluated both before and immediately after synchronous focus listeners. A genuine provenance-qualified input remains observable whenever its captured incarnation still identifies the current backend and lifecycle state is neither `disposed` nor `failed`, including `initialized`, `installing`, and a held baseline parse. The post-listener fence additionally requires effective focus, so synchronous successor initialization, hide/blur, failure, or disposal still suppresses stale or withdrawn bytes without replay or generation relabeling. P3 alone retains server recovery/control admission; this adapter observation is not authorization to send input to a PTY.

L4 now observes exact focus-before-input ordering for real keyboard input while a baseline parse callback is held, then releases and completes that parse without duplicating the input. It retains successor-initialize and hide/blur reentry controls and adds synchronous focus-listener disposal, requiring zero stale input and zero owned DOM after disposal. The registered inventory remains three suites and 18 cases.

The first scoped build failed before browser execution with TypeScript `TS2367`: control-flow narrowing treated direct post-callback `disposed` and `failed` comparisons as unreachable even though synchronous listeners can mutate the captured state. Moving the identical runtime predicate into `acceptsInputFrom` forces each pre/post call to reread closure state. The corrected scoped evidence at frozen tree `1866775a0c36506aa6cba9b40d719b30fc4d146c` is:

| Check                                                                | Result                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Terminal-web build/typecheck and both Vite bundles                   | pass after the predicate-expression correction                 |
| Prettier over allocated production/browser/lifecycle files           | pass                                                           |
| Oxlint `--deny-warnings` over the same paths                         | pass                                                           |
| Focused L4 held-recovery and initialize/hide/dispose reentry control | pass, 1/1 in 1.38 s Vitest duration (1.55 s wall)              |
| Complete lifecycle suite                                             | pass, 1 file / 6 tests, 24.71 s Vitest duration (24.88 s wall) |

No full external 18-case suite was run at `e537711`; the coordinator intentionally held broader execution until source review. The 18/18 result above belongs to prior source `2991acf` and is historical, not evidence for this final correction. Root's independent verifier is separately running its bounded strategy and one full 267-test gate, and CI remains pending; neither result is claimed here. No source/test, Q1, protocol/P3, root/shared, lock/pin, W1/native, GitHub, or other-checkout change is included in this documentation-only handoff.
