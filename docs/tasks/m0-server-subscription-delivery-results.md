# M0 P2-B1 private subscription delivery results

Source author `/root/p2_subscription_delivery_impl`, native GPT-6.1 Sol/high,
allocation `p2-subscription-delivery-implementation-r1`. Assigned checkout and
branch are recorded in [the pre-code plan](m0-server-subscription-delivery-plan.md).
Base H `082ae77b7836c08debb342f7596635b8f6930c96`, tree
`4f4bc8392a3d6e4f1c51f8e66c55a96f667d45e7`. Existing original refs remain
preserved; no core/public/config/manifest/lock/workflow file was changed.

## Implemented private boundary

`TerminalSubscriptions` takes the same RuntimeComposition, actual LocalRuntime,
TerminalConnectionDelivery and finite ID/request limits, supplier and monotonic
clock. `handle()` serializes attach/recover/ACK/progress/detach per owned route;
`handoff` binds the existing synchronous pipe ResultHandoff. The LocalRuntime's
injected closure must route a result to the corresponding connection service
before worker receive starts. `tick`, `close` and `snapshot` provide deterministic
private lifecycle/observability seams. No capability or server entry is advertised.

`TerminalConnectionDelivery` encodes validated terminal3 result/event/error frames,
owns bounded queued/handed records and full ref-counted backing leases, preserves
same-route FIFO and four reserved control positions, and makes write(false) a
single handoff. Credit-blocked routes permit another eligible route to proceed.
`TerminalDeliveryCredit` records exact external header/metadata/payload charges;
socket callbacks return physical ownership only. Progress releases exact sent
baseline ordinals; final ACK N requires the complete validated handed-off end.
Stable-ref recovery cancels unsent frames, retires only old logical credit and
fences old callbacks with a standalone token. Close preserves callback ownership
and unresolved runtime continuation records, and issues only owned unsubscribe.

Internal request IDs are namespaced by SHA-256 of the full connection ID and
generation plus a checked monotonic suffix, so separate connection ID suppliers
cannot collide. Fresh subscription IDs and retired tombstones are finite and
never reused; exhaustion refuses ownership. Route overflow/expiry preserves the
first correlated failure, unsubscribes that ownership and leaves healthy routes
and authoritative run capacity intact. B1 sends no stop/control/input command.

## Checks actually run

Fixed tools: Node26.10.0, pnpm12.6.0, macOS/arm64; selected binaries in
`/private/tmp/cove-engineering-toolchain`, approved XDG cache. Existing task-owned
installation was usable; no frozen install or native preparation was needed.
Root released the exclusive author scoped lane after P3e's actual full-check exit.

- An initial PATH error selected the empty fixed pnpm/bin directory and fell
  through to the user pnpm wrapper. It failed registry acquisition before tsc or
  tests. Corrected to the exact directory containing the pinned binary; no
  registry/config/dependency change. The failed log is preserved.
- First actual scoped `tsc -b apps/server packages/client` exited 2 for new-file
  type errors: literal history-limit argument, exact optional properties and the
  correlated marker union. Corrected only owned files; scoped tsc retake exited 0.
  The public descriptor validator is used at its fixed maximum followed by the
  effective-history check; existing protocol source remains unchanged.
- First owned Vitest invocation exited 1: delivery/credit **7/7 passed**, while
  subscription had an import-time failure with zero executed cases because the
  server importer has no client dependency. An import-only export cannot be
  resolved with createRequire either; that attempted binding failure is retained.
  The fixture now reads the selected client manifest's public import export and
  imports that compiled entry using URL resolution, without src aliases.
- First actual subscription run executed **11 cases: 8 passed, 3 failed**. Two
  passive fixture responses arrived before the preceding command's serialized
  await boundary; those fixtures now wait deterministic microtasks before
  replying. The public client intentionally omits resume for gap recovery; the
  retained-model contrast now uses its valid expired recovery path. No server
  behavior was weakened to satisfy either fixture. The affected subscription
  retake exited 0 with **11/11 passed**. The owned linter initially rejected conditional expectations in the baseline
  loop; the fixture now separates the first chunk from subsequent progress
  steps, retaining every boundary assertion. Owned lint retake exited 0. After
  formatting and this fixture correction, a final scoped tsc exited 0 and one
  coherent two-file authored run exited 0 with **18/18 passed**, zero skipped or
  timeout. This is not a composed full-suite claim.

Author cases execute compiled private modules, real WorkerPipeSession.receive and
LocalRuntime, decode actual external/pipe bytes, inspect the common retained
account and current logical ledger, and hold real injected carrier callbacks.
Contrasts cover dual connections/cursors, full ref rejection, absent/valid resume,
coalesced marker+event, reentrant close, old unsent versus handed recovery frames,
ACK serialization/forgery/duplicates, baseline progress larger than minimum credit,
expiry isolation, finite tombstones/control positions, detach without stop and
idempotent late callbacks. The public client case holds controlled finishBaseline:
no ACK N before installation, then legal stable-ref recovery and detach through
captured production B1 frames/uplink. No network/browser/native worker was used.

Raw logs and final source H/T/hash/command receipts are sealed off-tree under
`/Users/luchengxuan/WORKSPACE/cove-evidence/p2-subscription-delivery-implementation-r1`.
Owned formatter/linter passed. Ordinary hooked atomic commit identity and
outcome are recorded there after this file is frozen. Stage only author paths: the independent tester
has disjoint same-tree write ownership and its unfinished files are excluded.

## Remaining gates and limits

This is authored private B1 implementation evidence, not independent acceptance.
The independent contract/client files, source review, sole registration,
composition/full/normal dual-OS CI/protected rebase/final-main review remain with
assigned separate owners. Full W2/P2/P3/H1/M0 and real HTTP/WS/worker/carrier
qualification remain open; B2 control/input, preview and M1 are excluded.
No public integration, PR, push, full check, native/browser/network/process probe,
old provenance pipeline or additional user approval was performed here.

## Final F11 close correction

Initial hooked atom `40d23aa` is preserved as a nonfinal implementation snapshot.
A concrete five-live-route close regression failed against that snapshot: four
unsubscribe frames were emitted concurrently and the fifth was refused by the
existing worker progress cap. The focused diagnostic executed one failure and
intentionally filtered eleven cases; it is not a gate pass. Its log is preserved.

Root authorized the narrow correction within existing owned files. The service
now keeps a finite teardown queue in already-reserved lifetime route records,
waits its preceding effective runtime work, and sends one owned unsubscribe at
a time. It performs first sends only, does not retry uncertain or refused commands,
and preserves unresolved continuation and external physical backing charges.
No worker cap/core/public/shared file changed. The new real-parser case verifies
all five unique routes reach unsubscribe in order while authoritative run capacity
remains owned and no stop command is sent.

Scoped compiled server/client build exited 0. The final corrected two-file
run exited 0 with **19/19 authored cases passed**, zero skipped/timeout. Formatting,
lint, normal hooked correction commit and final head/tree/module hashes are in the
sealed author evidence. Independent testing/review and composition gates remain
open; the root owns the next exclusive build allocation.

## F1 unpublished attach identity correction

Allocation `p2-subscription-delivery-f1-source-fix-r1` follows the independently
committed red atom `2bf37bdb98b933dfa59973bcef396374ed7a9d62` and preserves its
invalid/throw third-ID failure witnesses. The source now obtains and validates
all three attach IDs before route publication. Failure releases unpublished
route/request reservations directly, with no retire/tombstone or worker
unsubscribe. The ID path checks service/delivery closure before invoking later
supplier callbacks; publication checks closure again after the final callback.
Already dispatched effective requests and unknown-outcome owned teardown retain
their existing behavior. No core, public, shared or independent test changed.

Author passive peer accepts an optional ID supplier. Two production-parser
contrasts verify invalid and throwing third IDs yield the correlated error, no
worker command/route/request identity, zero external physical backing after its
callback and no common retained growth. Six closure contrasts cover service or
delivery closure at each of the three ID calls, with no later supplier call or
route/worker side effect. All fixture final cleanups reach retained total zero.

Fixed Node26.10.0/pnpm12.6.0 scoped server/client tsc exited 0 on the first run.
One coherent owned two-file Vitest run exited 0 with **27/27 authored cases
passed**, no skipped/timeout. Owned format/lint/diff checks and the normal
user-hooked separate correction atom are sealed with final head/tree/module
hashes under the fresh off-tree F1 source-fix allocation. No old independent
counterexample rerun, full check, install, native/browser, network, push or CI
action ran. Independent coherent 47-case postfix validation and minimal-diff
review remain separate gates; this result is author evidence only.

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
