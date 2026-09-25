# M0 browser probe cleanup deadline repair

Owner: `/root/m0_q1_impl`, GPT-6 Sol high. Checkout `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-browser-cleanup`, branch `p/luchengxuan/m0-12-cleanup-deadline`, base `a111a7ca9821ef903ca108d69304600866c683a0`. M0/Q1 remains authorized; this is a bounded repair of the probe harness, not a production terminal change.

## Evidence and objective

PR #33 run `36186368871` passed Linux but macOS arm64 failed the Q1 query-only test after its browser actions with `AggregateError: Browser cleanup failed` containing only `Query fixture disposal timed out`. The 42 query assertions did not report an error, but the missing query evidence JSON means that CI did not establish a passing Q1 run. Other Q1 tests and B0 passed on macOS. The error came from the shared managed-browser cleanup's fixed 500 ms `page.evaluate("window.coveQuery?.dispose()")` timeout. The query-only scenario owns two pages, and this was its longest CI case (13.665 seconds); the log does not show whether the browser event loop was briefly delayed or the fixture disposal itself was slow. The current cleanup deadline is seven seconds total, yet each page disposal is given only 500 ms. A timeout is reported even when the remaining cleanup budget could allow a delayed disposal to finish. This is a plausible scheduling sensitivity, not proof of the exact cause on the hosted runner.

The objective is to spend the **existing seven-second total cleanup budget** according to the actual number of pages, while reserving time to close/kill the owned Chromium process and close the loopback listener. A delayed disposal must complete and remain observable if it fits its page allocation. A hung disposal must still fail, continue closing all owned pages/browser/listener, and retain any primary and cleanup errors. No retry, swallowed disposal error, unbounded wait, or broad timeout increase is acceptable.

## Scope and contracts

Writable files: `packages/terminal-web/probes/node/managed-browser.ts`, `packages/terminal-web/probes/node/query-input.ts` only for a test-only two-page scenario if needed, `packages/terminal-web/probes/query-input.test.mjs`, and this plan/results pair. Shared manifests, lockfile, root CI registration, handoff, other probes and product code remain coordinator/T1-owned. Retain the pinned Node/pnpm/browser versions, exact Q1 tests, B0 negative checks, seven-second cleanup ceiling, error aggregation, browser process-exit and listener-closure checks.

The existing B0 lifecycle is the relevant local contract. Earlier Orca source comparison in the Q1 plan concerns terminal input provenance; it has no managed Chromium probe lifecycle counterpart to copy for this cleanup fix. The local `managed-browser.ts` implementation and the hosted CI trace are the executable evidence.

## Implementation and checks

1. Give page cleanup a bounded phase of the seven-second deadline, divided fairly across owned pages. Let a page's disposal use the available share after reserving page close, with a deliberate upper cap; let unused time carry to later phases. Reserve a browser-reap phase and final listener/evidence time. Keep the final absolute deadline authoritative for every operation, and include the stage and available budget in timeout diagnostics.
2. Add a probe-only two-page scenario and deterministic browser-evaluate delay above the old 500 ms cap. Assert success, exact owned page count, browser exit and closed listener. Inject a never-resolving disposal for one page; assert the timeout is reported, the other page is still disposed/closed, and the process/port are reaped. Keep the existing simultaneous work/cleanup failure check.
3. Run formatting, lint, package build and the scoped browser suite in this checkout. Record precise source SHA, OS/toolchain, results and limitations. A local timer injection demonstrates the budget behavior; it does not reproduce hosted CI load. Root owns independent review, integration and final macOS/Linux CI.
