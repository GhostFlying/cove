# M0 bounded server preview cache implementation

Owner: `/root/p2_preview_cache_impl`, native GPT-6.1 Sol/high; sole source,
index and scoped-output writer. Base `b5715e615ed7cc4a72aed4654e06a3af4a603e5b`,
tree `0059b56a1fe7e22387454f63311756dd4aa5585b`, clean assigned checkout
`/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-probes-verify`. Old
`p/luchengxuan/m0-18-control-input-practical` is preserved. Work uses ordinary
`p/luchengxuan/m0-18-preview-cache-practical` from accepted B2 main.

## Bindings and scope

Allocation: `cove-evidence/p2-preview-cache-source-implementation-r1/allocation.json`;
prepared plan/author/QA packets and final B2 acceptance are its frozen dependencies.
Applicable WORKSPACE common/Codex instructions, Cove AGENTS, handoff, design,
server/terminal/protocol architecture, engineering 6/8/9 and M0 terminal/protocol
tasks govern this work. Practical user steering supersedes historical model and
one-use environment machinery. Current handoff still contains historical B2 pending
text; the allocation binds the later accepted actual main.

Writable: `apps/server/src/terminal/{preview-cache,preview-refresh,preview-transfer,
worker-pipe-session,local-runtime,terminal-subscriptions,terminal-command-service}.ts`,
`apps/server/tests/author/{preview-cache.test,preview-byte-peer}.mjs`, this plan and
`m0-server-preview-cache-results.md`. All public protocol/client/worker/engine,
registry/pool/composition/retained account/delivery, inherited tests and shared
handoff/registration are read-only. No listener, entry adapter, native process,
browser, new worktree, reset/stash/clean, push or CI operation is allocated.

## Pre-code implementation

1. Add `PreviewCache`, containing one owned finite picture per complete run/worker,
   private atSeq/geometry and stale metadata, with `acquire` reader ownership and
   bounded `getRecord`/`list` projections. A replacement reserves metadata before
   atomically exchanging the current entry; old readers retain the old backing.
2. Add `PreviewCollector` and `publishPreview`. The collector accepts exactly
   start/ordinal-0 chunk/end with full identity, geometry, count, byte and sequence
   agreement. `WorkerPipeSession.requestPreview(command, seal)` stores a dedicated
   private `PreviewResultSeal` and invokes it at correlated result ingress before
   settling the Promise or parsing subsequent frames. B1 ResultHandoff is untouched.
3. Add `PreviewRefresh` owned by LocalRuntime, shared across connections, one active
   job per run. `LocalRuntime.previews` lazily constructs it; `tickPreviews()` is the
   cooperating domain-clock drive seam (entry/timer adapter is deferred D). Tick
   enumerates registry, regardless of subscription/visibility. No recursive refill
   on settlement: one staggered admission per tick, respecting effective active cap.
4. Fetch real accepted status before capture. Reuse only an owned complete picture
   with matching worker, geometry and `version === atSeq === current parsedSeq`,
   current live/exited proof. Otherwise knownVersion is sent only for owned bytes;
   no-frame accepted unchanged requires the same current evidence. Missing proof,
   partial transfer or failed capture preserves last good bytes and marks stale.
5. Add narrow preview handling in TerminalSubscriptions after existing common
   request-ID/pending validation. It uses externalIds/requestLeases/id(), ordinary
   pending capacity and connection lifetime; no second ID table or subscription.
   Publish fresh external transfer IDs via existing DeliveryFence/FIFO. Closing
   a connection cancels its waiters and unsent frames only; shared jobs continue.

## Finite policy and ownership equations

Internal defaults: cadence 1000ms, stagger 50ms, expiry effective recoveryDeadlineMs,
waiters min(16,pendingWorkerCommands), identity budget 4096. Injectable monotonic
`now` and diagnostic `wallNow` are safe nonnegative integers; monotonic regressions
or overflow close the preview owner. Values are validated finite positive integers,
expiry <= recoveryDeadlineMs, stagger <= cadence; no freshness SLA is claimed.
Time is advanced by explicit bounded ticks; wall timestamp subtraction is never
used as duration evidence. One due run is selected round-robin per stagger turn;
admission is refused rather than creating an unbounded queue. Same-run callers share
the existing job up to the waiter limit. Expiry seals failure but keeps the run/job
slot until the actual correlated terminal result or session-close barrier returns.

Charges use the same RuntimeRetainedBytes: owner/listener arena, run schedule
record 1024B, job/collector metadata 8192B, waiter 512B, reader 4096B,
transfer identity tombstone 2048B (including its complete identity key).
Before copying N payload bytes reserve N+256 scratch, then retain the exact new
backing (N+256 account overhead) before releasing scratch. Committed metadata
4096B and exact backings remain charged; logical committed occupancy is sum(N)
<=previewGlobalBytes, each N<=previewBytesPerRun and entry count<=maxRuns. Exchange
debt includes old+new+stage+readers+encoded publication concurrently. Idempotent
reader/collector/cache disposal releases only its owner; delivery physically held
encoded frames remain charged until its existing callback/release receipt.
Clock suppliers, ID suppliers and carriers may reenter; check lifetime afterwards.
Request/attempt proofs are never evicted to admit work.

## Validation and limits

Use pinned Node26.10.0/pnpm12.6.0 through existing explicit toolchain PATH; no profile,
pin or install mutation. Build `pnpm exec tsc -b apps/server packages/client`, scoped
Prettier/Oxlint/whitespace, new compiled author suite and affected inherited server
B1/B2/pipe/admission suites. Preserve numeric exits and raw failures off-tree under
the allocation directory. Author tests feed actual encoded bytes to production
WorkerPipeSession and production mapper/cache/delivery; passive peers supply only
bytes/clocks/callbacks. Independent QA owns its oracle and later source/output lease.

Orca comparison is frozen in prepared plan: H322c1839888f4a462e2d68839deafb1fe616c685,
terminal-preview and terminal-preview-output-stream supply bounded disposal ideas
but use a live subscription and lack Cove all-run/identity/account contracts.
Primary worker still returns CAPABILITY_UNAVAILABLE. This implements deterministic
C core only; real W2 producer, installed pipes/PTYs, D, full P2/M0, historical 28/43
qualification and EPERM cause remain unproved. Ordinary atomic Conventional user
commits/hook execution precede exact clean H/T and compiled evidence handoff.

## Boundary correction pre-code plan

Owner remains `/root/p2_preview_cache_impl`, native GPT-6.1 Sol/high. Allocation
`cove-evidence/p2-preview-cache-boundary-source-correction-r1/allocation.json`
grants the sole source/test/docs/index/scoped-output lease in the same checkout.
Verified clean base `86f231d2545a88df1495ebba2ea65cde01f73164`, tree
`0d56593adb83bc65513a6698baeba01b523c50f7`; the independent QA atom and its three
file hashes are intact. Read-only triage is separately sealed in
`p2-preview-cache-expiry-boundary-triage-r1/{findings,handoff,manifest}-r2`.
The original QA 133/136 rows and 16/19 declarations remain failed-subject evidence.

1. In `preview-refresh.ts`, refuse result ingress and accepted post-status proof
   only strictly after the numerical deadline. At equality the actual first
   valid seal wins; tick still expires at `>=`. Preserve first outcome, current
   incarnation, correlation, invalid clocks, retirement barriers and typed errors.
2. In `terminal-subscriptions.ts`, synchronously snapshot complete owned cache
   metadata and worker before calling the ID/refresh clock suppliers or awaiting.
   A matching admission version may authorize unchanged only if the final reader
   still matches that worker and geometry, with the existing fresh status checks.
   No admission picture means the newly captured bytes require full publication.
   Preserve the original hint for the future-version refusal. Metadata proof fits
   the existing request lease; no backing is held while awaiting and no public
   signature, default, budget or wire change is needed.
3. Add direct author regressions for equal result-first and tick-first, strict late
   without a tick, cached post-status equality/tick-first/strict-late, empty and
   concurrent pre-picture admission full transfer, and later owned unchanged.
   Retain no-frame refusal, FIFO IDs and physical callback cleanup counterparts.
4. Run pinned scoped server/client tsc, changed-file format/lint/whitespace and
   compiled author plus affected inherited B1/B2/pipe/admission suites. Record raw
   numeric results separately; normal atomic user/hook commit and exact clean
   source/compiled/test bindings precede lease release and independent QA rerun.

Only those two production files, author preview suite/passive peer if necessary,
and the existing two task documents are writable. The independent three files and
136-row oracle are read-only; this author does not execute new independent C tests.
Original 6de author194 results remain historical. No full/CI/push, native producer,
entry timer, browser, device, probe, profile or new worktree work is allocated.
