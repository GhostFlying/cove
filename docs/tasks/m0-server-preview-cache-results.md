# M0 bounded server preview cache source results

Owner `/root/p2_preview_cache_impl`, native GPT-6.1 Sol/high. Source author evidence;
independent QA/review, registration, full/CI/main acceptance remain later gates.
Base `b5715e615ed7cc4a72aed4654e06a3af4a603e5b`, tree
`0059b56a1fe7e22387454f63311756dd4aa5585b`. Assigned checkout and ordinary branch
are bound in [the implementation plan](m0-server-preview-cache-plan.md).

## Implemented core and private bindings

The seven allocated source paths contain a real bounded cache, staggered refresh
scheduler, ingress collector and external FIFO mapper. Public protocol and
worker/client/engine contracts, pool/registry/composition/retained ledger and
connection delivery stayed unchanged. Only the declared author suite/passive
peer and two task documents were added. No independent QA source was inspected
or changed by this author.

- `LocalRuntime` accepts optional fifth `Partial<PreviewPolicy>` argument;
  `previews` lazily owns one `PreviewRefresh`, `tickPreviews()` drives one bounded
  scheduling turn. `requestPreviewSealed(input, seal)` forwards through the
  existing placement/session and observes optional result status at ingress.
- `WorkerPipeSession.requestPreview(command, PreviewResultSeal)` stores a private
  per-request callback. After existing full result correlation, the callback runs
  synchronously before Promise settlement and later coalesced frames. The B1
  activation handoff and shared progress/status/stop admission are retained.
- `PreviewRefresh.request(run)` returns `{promise,cancel}`; `refresh(run)` returns
  `Promise<PreviewOutcome>`, where the outcome is `{ok:true}` or `{ok:false,error}`.
  A cancelled connection waiter does not cancel the shared producer job. One job
  per run and the effective active cap are enforced. Expiry settles failure but
  retains the job/run slot until its actual result/session-close barrier returns.
- `PreviewCollector.event` checks full run/worker/incarnation, transfer ID, version,
  atSeq, geometry, byte count and one ordinal-0 chunk. `seal` commits only complete
  result-last transfers. Subscription-bearing previews reach this collector and
  are refused, including when their subscription route is inactive.
- `PreviewCache.acquire` returns a physically retained reader, `getRecord` returns
  truthful existing RunRecord metadata and `list({limit,afterRunId})` returns
  schema-valid stable pages. Metadata reads issue no worker command or VT clone.
- Preview commands use TerminalSubscriptions' existing external IDs, request
  leases, ordinary pending cap and connection generation/lifetime. Each transfer
  receives a fresh external preview ID and one existing DeliveryFence. Only
  unsent frames/waiters belonging to that connection are cancelled on close.

Status is fetched through the actual pipe before every refresh. Owned bytes are
reused only with exact current parsed boundary/version/geometry/worker proof.
Changing geometry omits knownVersion and demands bytes. Missing picture/version
alone cannot yield unchanged; impossible future external versions are refused.
Actual unknown/error causes survive; contact loss is unverifiable and known exit
cannot be resurrected by a delayed status result. Cache replacement reserves
before exchange and retains old backing until its readers release it.

## Policy and accounting

Internal defaults: cadence1000ms, stagger50ms, expiry effective recoveryDeadlineMs,
waiters min(16,pendingWorkerCommands), identity budget4096. Values are finite,
positive validated integers; expiry cannot exceed recoveryDeadlineMs and stagger
cannot exceed cadence. Injected monotonic `now` cannot regress/overflow. Diagnostic
wall `wallNow` is a nonnegative safe integer and is not a duration clock.
Scheduling is explicitly tick-driven: no timer/entry adapter or freshness SLA is
claimed. Deferred D must drive ticks. Tick admits at most one due run per stagger,
round-robin among all registered runs regardless of visibility/subscription; it
never recursively refills on completion. The existing per-worker status cap1 is
preserved, so status replies must settle before another status is admitted on that
worker. Failed admissions retain finite cadence and cannot grow a hidden queue.

All debt uses RuntimeRetainedBytes: owner arena4096, schedule1024, job8192,
waiter512, reader4096, complete transfer identity tombstone2048, cache metadata4096.
Before an N-byte copy, N+256 scratch is reserved, the exact copied backing is then
retained for N+256, and scratch is released. Logical committed occupancy obeys
per-run/global/maxRuns limits. Old/new/staged/readers/encoded frames overlap in
the common account. Tombstone/request proofs are retained without eviction;
finite identity exhaustion refuses admission. Delivery's encoded backings remain
charged through actual callbacks/release receipts, including after logical close.
Disposal is idempotent; uncertain in-flight jobs retain their arena until their
session barrier settles. Each author fixture ends with zero total retained bytes
only after its own runtime/session/connection transport-release receipts.

## Actual scoped validation

Pinned toolchain: Node v26.10.0 from the existing explicit toolchain bin;
pnpm12.6.0 is its supplied standalone executable. Checkout-local TypeScript
Project References built `apps/server` and `packages/client`. No dependency,
profile, pin, full check, native process, browser, devbox, push or CI change ran.
Raw commands, numeric exits, logs, JSON assertions and exact source/compiled
bindings are in `cove-evidence/p2-preview-cache-source-implementation-r1`.

Final changed-subject `affected-r2`: **194/194 PASS in ten files**, zero failed,
pending, skipped or todo. Actual discovered per-file inventory:

| Suite                                      | Runtime cases |
| ------------------------------------------ | ------------: |
| New author preview cache                   |            19 |
| Existing runtime admission                 |            17 |
| Existing connection delivery               |             7 |
| Existing author control                    |            14 |
| Existing author subscriptions              |            20 |
| Existing worker pipe                       |            11 |
| Existing independent subscription client   |             5 |
| Existing independent subscription contract |            42 |
| Existing independent control client        |             8 |
| Existing independent control contract      |            51 |

This supplements the affected inherited B1/B2 oracles; it does not stand in for
new independent C tests. The 19 new declarations are explicit, with no dynamic
runtime expansion or predicted registered full count. Final build-r4 and lint-r2
exited0; scoped format and Git whitespace checks are recorded before freeze.

Preserved non-green evidence: default shell Node24 was observed and its pnpm
launcher attempted the unavailable corporate-registry package; no profile was
changed. An incorrect attempted pnpm.cjs path failed before the standalone
executable was identified. Initial TypeScript build failed on an unexported RPC
schema and readonly registry list sort; source uses public RPC_METHODS and a
copied bounded status list. Author-r1 was **15/16**, exit1: its fairness fixture
held the first status request, and the unchanged cap1 refused later status work.
The fixture now acknowledges each status then holds preview, preserving the cap.
Lint-r1 exited1 for a new conditional assertion; the fixture now has unconditional
BUSY comparison. Affected-r1 was191/191 before three further actual regressions
and corresponding current-proof/future-version source corrections. These raw
failures/passes keep their original names and are not relabelled as final evidence.

## Remaining gates and release

This is deterministic compiled C core from synthetic producer bytes. Primary
worker preview production still returns CAPABILITY_UNAVAILABLE. Installed real
worker/pipe/socket/PTY observation, W2 original28/43 qualification, historical
EPERM/EOF cause, D entry adapter, full P2/W2/M0 and milestone transition are
unproved. Independent C QA/review and registrar/final ordinary full/CI/main gates
must bind this frozen subject. No independent or final-main approval is claimed.
The off-tree handoff binds the actual clean commit/tree, compiled payload hashes,
check identities and source/Git/output lease release after the normal user commit.

## Boundary correction on independent QA atom

Correction base is QA's clean `86f231d2545a88df1495ebba2ea65cde01f73164`, tree
`0d56593adb83bc65513a6698baeba01b523c50f7`, parent source6de. Its unchanged
independent three-file test atom and frozen136-row oracle remain intact. QA R1
actually recorded133/136 semantic rows and16/19 declarations passing, with
C-11/M3, C-06/V1 and CC-02/M2 failing. Those historical boundary conflicts and
raw failures remain sealed; a real complete worker capture/commit succeeded in
the knownVersion cases. This correction does not describe those as empty or
fabricated-picture failures, or rewrite original author194 evidence.

Only `preview-refresh.ts` and `terminal-subscriptions.ts` changed in production.
Result ingress and accepted post-status continuation now refuse strictly after
the numerical deadline. At equality a valid first seal may succeed; tick still
expires at `>=`, and an earlier terminal outcome remains immutable. Current
incarnation, correlation, invalid clock, status proof, collector and physical
retirement guards retain their behavior.

External unchanged eligibility snapshots an owned matching picture before ID or
clock suppliers and before any await. A temporary ordinary reader/backing ref is
charged through the common retained account and released immediately. Only small
version/worker/geometry metadata remains under the existing request lease. Final
publication requires the same worker/geometry and fresh status support; missing
admission ownership forces the existing full FIFO transfer, even when a new
capture happens to match the hint. The original hint still rejects impossible
future versions. Wire/private signatures, budgets, policy defaults and shared
request-ID authority did not change; the passive author peer is unchanged.

Pinned Node26.10.0/pnpm12.6.0 build-r1, lint-r1, scoped format and whitespace all
exited0. Compiled `affected-r1` actually passed **202/202 in ten files**:27 author
preview declarations plus175 inherited B1/B2/pipe/admission/delivery/client cases.
All eight new explicit author regressions passed: equal result-first, equal
tick-first preserving old bytes, strict-late result without a tick, cached
post-status equality, tick between status ingress and asynchronous cache seal,
strict-late cached proof, empty-admission matching hint full bytes, and concurrent
empty admissions followed by valid owned unchanged. Every author fixture asserts
zero retained total after its owned transport/session/runtime release receipts.
There were no failed, pending, skipped or todo cases in this correction run.

These are source-author results. This author did not execute the new independent
C tests; their unchanged oracle rerun, independent review/registration and final
ordinary full/CI/main gates remain pending. No installed producer/real-process,
W2, D timer/entry, fullP2/M0 or historical EPERM conclusion is added. Separate
`cove-evidence/p2-preview-cache-boundary-source-correction-r1` evidence binds the
normal atomic correction commit, clean H/T,11 original source/task/author paths,
the unchanged independent atom, exact compiled payloads and released leases.
