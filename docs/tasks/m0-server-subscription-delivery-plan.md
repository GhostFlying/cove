# M0 P2-B1 private subscription delivery plan

Owner: `/root/p2_subscription_delivery_impl`, allocation
`p2-subscription-delivery-implementation-r1`, native GPT-6.1 Sol/high. No delegation.
Source checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-probes-verify`.
Branch: `p/luchengxuan/m0-18-subscription-delivery`.
Base H `082ae77b7836c08debb342f7596635b8f6930c96`, tree
`4f4bc8392a3d6e4f1c51f8e66c55a96f667d45e7`. The original clean
`p/luchengxuan/m0-18-server-control` / `327ac7bad43f854610b590086647aff906d994f7`
ref is preserved. Root supplied actual-base GO and final-main independent/dual-OS
acceptance in `w1-completion/p2-practical-final-main-acceptance-r1.json`.
Frozen author dispatch SHA-256:
`accd29beb43bf31c43247e29c1c6df1e634e69fbd949c7a33b81965aae4c1bc1`.

## Scope and dependencies

Write only three new private modules `terminal-subscriptions.ts`,
`terminal-connection-delivery.ts`, `terminal-delivery-credit.ts` under
`apps/server/src/terminal`; authored `terminal-subscriptions.test.mjs`,
`terminal-connection-delivery.test.mjs` and optional passive
`subscription-byte-peer.mjs` under `apps/server/tests/author`; this plan and
`m0-server-subscription-delivery-results.md`. Evidence is in the allocated
`/Users/luchengxuan/WORKSPACE/cove-evidence/p2-subscription-delivery-implementation-r1`.
Existing core and shared registration/handoff/config remain read-only. A concrete
seam deficiency goes to root for a narrow file lease. The sole registrar owns
shared CI discovery, floors, task/handoff updates and later composition.

Accepted inputs are P2 allocation R2 section 5 and F06-F11/F16, the independent
accepted-plan decision and next-ready S2. Reuse accepted W1, P2-A and P3a-d.
Read local AGENTS, handoff, design/server/protocol/terminal documents and stable
recovery clarification. Server uses compiled `@cove/protocol` exports and the
existing LocalRuntime/WorkerPipeSession synchronous `ResultHandoff`; no public
export, entry, wire, dependency or budget change. Caller provides an already
authenticated/negotiated connection. Constructor composition identity and budgets
must match the LocalRuntime and connection delivery.

Orca comparative input: inspected current local revision
`322c1839888f4a462e2d68839deafb1fe616c685`,
`src/main/runtime/rpc/terminal-subscribe-mount-replay.test.ts` (mount replay)
and terminal RPC stream paths. Existing Cove recovery plan pins comparison
`5534462b50c660888487a2108700d4cf284270db`: separate stream allocation and
same-stream resync are useful lifecycle contrasts; integer stream IDs and
transport/drop ACK credit do not meet Cove's full refs or client-parsed credit.
The accepted Cove contracts, not Orca, determine this implementation.

## Implementation and finite accounting

1. `TerminalConnectionDelivery` owns one bounded external queue plus handed-off
   records, encodes/validates existing terminal3 frames and retains full backing
   allocations through the common RuntimeRetainedBytes. One 2*MAX_FRAME_BYTES +
   6*MAX_METADATA_BYTES scratch arena bounds synchronous encoding; reentrant
   encode is refused. Each queued/callback record reserves 512 bytes before
   encoding, plus ref-counted backing `buffer.byteLength + 256`. Total ordinary
   encoded ownership <= outboundConnectionBytes; control ownership uses the
   existing additional reservedControlBytes. Finite item cap is injected, <=
   postNEvents + pendingWorkerCommands + 4; ordinary positions leave four control
   positions. Scheduling can bypass a credit-blocked route only for a different
   route; no same-route event/control marker passes its predecessor. Recover
   cancels unsent old-attempt records; handed-off records settle once and remain
   physically charged across recovery/close. write(false) means handed off and
   is never resent. Drain and callbacks are generation-fenced.
2. `TerminalDeliveryCredit` owns a finite current-attempt encoded-byte/item
   ledger, not physical backing. Reserve 256 bytes per event proof; bound items
   by postNEvents + baselineChunks + 2 and queued logical bytes by connection
   ordinary capacity. Handoff consumes subscriptionCreditBytes. Socket callback
   returns no parsed credit. Only sent exact sequence/ordinal boundaries can
   release charges. Baseline-start plus parsed chunks retire on progress; end
   and remaining baseline debt retire on final ACK N, only after a validated
   complete transfer is handed off. At least one maximum frame fits the minimum
   valid credit window; bounded progress allows a larger transfer. Old attempt
   ledgers retire without touching handed-off backing ownership. Equal N is not
   proof of a new baseline. Duplicate/stale ACK/progress releases zero; future,
   unrecorded boundary/wrong baseline rejects. Replay starts at the full offered
   cursor, and empty replay can ACK its recorded marker boundary.
3. `TerminalSubscriptions` owns current refs, stable route attempts, correlation,
   and per-route serialized commands. Constructor reserves 4096 bytes and runtime
   listener; each lifetime subscription/tombstone reserves 8192 bytes. Injected
   identity limit <=4096 bounds all lifetime IDs; no eviction or reuse. Internal
   request/correlation/tombstone records reserve 6*MAX_METADATA_BYTES + 2048,
   with existing control memory for ACK/progress/unsubscribe; at most four
   effective control commands and effective pendingWorkerCommands ordinary
   commands, finite request IDs and per-route queues. Reserve before side
   effects. Internal IDs use a SHA-256 namespace of the complete connection plus checked
   monotonic suffix; the supplier is validated and subscription IDs also use a
   checked suffix. Namespacing prevents independent connection suppliers colliding;
   external request IDs cannot be reused on this connection. Fresh attach assigns
   a never-used ID; complete resume validates profile/encoding/effective geometry
   against current run before translating only its appliedSeq. Absent resume
   requests baseline. Prebind correlation before runtime dispatch. Synchronous
   ResultHandoff admits a correlated attach/recover marker before activating the
   attempt; same-chunk N+1 then enters its ordered route. Promise continuation
   never supplies activation. Recover waits for preceding ACK/progress, cancels
   unsent old events, retires credit and reserves a checked new attempt. Detach
   retires before unsubscribe/result; close sends only owned unsubscribe, no stop
   or control write. First route failure survives until a correlated next command.
   Recovery deadline uses an injected monotonic clock and existing effective
   recoveryDeadlineMs; tick fences expired attempts, not execution status.

Managed retained bytes are existing core records plus the above arenas, routes,
request records, proof records and ref-counted encoded backing/callback records.
No allocation is accounted by a second memory authority. Refusals preserve all
previous identity proofs and leave no new worker command/frame.

## Validation and exclusions

SOURCE_ONLY while P3e owns the heavy lane. Root additionally allocated the
independent tester disjoint files in this same tree; stage only author-owned
files and do not claim checkout cleanliness until both writers freeze. After root grants the lane, select
Node26.10.0/pnpm12.6.0 through the fixed toolchain PATH and approved cache, build
`pnpm exec tsc -b apps/server packages/client`, and run the two owned test files
once with `pnpm exec vitest run --project server`. Necessary correction retakes
must name the concrete failure. Format/lint only owned files, then normal hooked
atomic Conventional Commit with the existing user Git identity; no push/PR/full
check. Independent tester/reviewer follow the frozen source H/T. Authored cases
use compiled private modules, production pipe parser/LocalRuntime and real public
protocol/client artifacts with passive synthetic worker bytes and held callbacks.
Cover F06-F11 contrasts and the B1-only public client parse/install path; inspect
external frame order, exact length ledger and common retained account. Include
violating marker/credit contrasts; no fake server handler as oracle.

Excluded: B2 focus/control/input/preview, real HTTP/WS/native/process/browser,
full W2/D/Q/H1/P3 or M0 exit/M1 entry, new dependencies/config/lock/wire/defaults,
CI workflow and shared gate edits, old provenance/probe/devbox retry/pool changes.

## F11 close correction before final source freeze

After the first normal author atom, source inspection identified a concrete
counterexample: closing five owned routes concurrently can fill the existing
worker's four progress slots and refuse the fifth unsubscribe before handoff.
Keep existing core read-only. Add a finite teardown queue bounded by the already
reserved lifetime route records, with one first-send unsubscribe at a time after
this service's preceding effective commands settle. Its route/request ownership
remains charged until the continuation completes. No uncertain command retry,
new public seam, timer/default or worker cap change. Add one real-parser close
cap-plus-one regression in the owned subscription test file, preserve its failing
run on the original atom, then validate this narrow correction and final scope.

## F1 predispatch attach identity correction

Allocation `p2-subscription-delivery-f1-source-fix-r1`, source owner
`/root/p2_subscription_delivery_impl`, native GPT-6.1 Sol/high. Base is the
preserved independent red regression atom `2bf37bdb98b933dfa59973bcef396374ed7a9d62`,
tree `d206980e838dc143ef2f718fbb3f7f70702fd319`, in the same assigned primary
checkout. Root grants exclusive scoped build and sole primary index ownership.
Independent raw invalid/throw third-ID witnesses show no subscribe, unintended
unsubscribe, one phantom route/tombstone and 34816 retained bytes after the
correlated external error settles. Do not rerun or alter that frozen counterexample.

Before publishing an attach route, obtain and validate subscription, teardown and
request identities, and recheck service/delivery closure after supplier callbacks.
Release unpublished request/route reservations directly on failure; do not retire
or unsubscribe an unpublished route. Prevent later supplier calls once closed.
Keep already dispatched unknown-outcome owned teardown unchanged. No ID/public
interface, wire, budget, core, independent-test or shared registration change.

Writable files remain only terminal-subscriptions.ts, the owned subscription
author test and optional passive peer, and these two task plan/results docs. Add
production-parser author contrasts for invalid/throw third identity and supplier
closure of service/delivery. Assert no new worker command, no route publication,
zero retained growth after error callback settlement (or expected service closure
release), and final cleanup zero. Use fixed Node26.10.0/pnpm12.6.0 and approved
cache for scoped tsc server/client and coherent owned two-file tests, then owned
format/lint/diff checks. Normal user-hooked separate atomic commit; no push, full
check, browser/native/CI or network action. Seal actual logs, final H/T/module
hashes and handoff, then release lane/index for independent coherent postfix
testing and minimal-diff review.

## Subsequent accepted source and practical composition

The preceding source-author/scoped checkpoints are historical. Root accepted R2
independent source approval/F1 closure and scoped47/47 at original3ab5d80; final
authored cases are20+7=27, independent cases42+5=47. The sole registrar replays
all five atoms without source/test byte changes onto independently accepted
P3e actual main5ac9e808. The [current composition record](m0-server-subscription-main-integration.md)
binds mappings, actual static declaration floors14/7/30/5, eight exact finite
expansions and the next independent composed full gate. Neither old scoped
evidence nor registration establishes composed runtime, hosted/main acceptance
or full B1/P2/W2/P3/H1/M0. All historical failures and cleanup limits remain.
