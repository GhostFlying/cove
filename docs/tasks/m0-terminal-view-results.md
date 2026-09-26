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
