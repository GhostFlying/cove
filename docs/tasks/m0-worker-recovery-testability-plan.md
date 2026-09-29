# W2 finite testability seam plan

Owner: W2 source author. Frozen accepted F5 base H `f48d0dcef61bd62b9a325f0f3e3ff8e45e838f36`, T `fa8fcef2eb92f04157ca6003799290d2309ad859`. Independent source approval and root acceptance precede this task. Preserve all four existing atoms and append buildable S1 and S2 commits with the existing user Git identity. This plan binds Astra's frozen finite-completion plan SHA-256 `755ee21a40425fe0d9c071eaa5917bf9a896d92b75e2375bca85ec6292d504b4` and independent plan review SHA-256 `a1136728b7a1937b39148fcc16dbd4fad95bc3a75bd0679468d3ea7edcb57a5f`.

Writable scope: this task-local plan/results; `packages/terminal-worker/src/recovery-subscription.ts`, `preview-service.ts`, optional internal `recovery-clock.ts`, `replay-window.ts` and direct tests for these classes. Production worker construction, public options/exports/wire, budgets, engine, native, endpoint, manifests, lock, shared registry and handoff stay untouched.

## S1: instance-local clock

Introduce an internal optional final constructor argument on RecoverySubscriptions and PreviewService. Its `now()`, `setTimeout(callback, delayMs)` and `clearTimeout(handle)` use a monotonic default backed by performance.now and native timers. Existing construction supplies no argument. Every recovery/preview deadline, capture race and deadline rearm/clear within each instance uses its own clock. Keep preview `generatedAtMs: Date.now()` as wall-clock metadata. Timer callbacks compare deadlines against the same injected monotonic source. Direct deterministic controls exercise before/exact deadline, late capture fencing, cancellation/rearm and a default-constructor contrast. There is no global fake timer or public WorkerExecutionOptions seam.

## S2: observed reservation owner tags

Add constant second-argument tags to existing reservation calls, with first-argument byte expressions, order and release lifetime unchanged. Callbacks that accept only bytes remain valid. Distinguish replay fact and selected-reference; recovery connection/route, detached baseline, frame table, post-N pinned reference versus copy, sent ledger; and preview transfer. No new accounting map or production state. Direct tests wrap the real retained-byte account, capture `(tag, bytes, acquire/release)` receipts, and compare the sum against the account snapshot and zero after cleanup; include reserve denial and existing copy/pin distinctions. No wire/status changes.

## Checks and freeze

Use pinned Node 26.10.0 and pnpm 12.6.0. Run scoped TypeScript build plus only direct pure worker tests impacted by S1/S2, then scoped formatting/lint. Preserve first failure raw logs and diagnose before any retest. No native/PTY/OS pipe, browser, full check, CI, devbox or old 26-case independent oracle. Freeze exact H/T, identity, source blobs, raw results, manifest hashes and remaining independent source-review/finite-QA gates off-tree in `w2-testability-implementation-r1`; release the checkout clean.
