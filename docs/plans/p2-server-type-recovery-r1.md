# P2 server type recovery R1

## Owner and objective

Owner: native `/root/p2_server_type_recovery`, GPT-6.1 Sol high implementation.
Base HEAD: `29cb3637810c646db607389601b7a81bb7ef910d`. Checkout:
`/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-probes-verify`.

The registrar released this checkout after normal pinned installation and
registration. Root authorized this bounded source correction and serialized
author checks. Resolve the server build's inferred payload type mismatch and
existing formatting/lint failures without changing product behavior, compiler
rules or toolchain pins. Independent validation and source review follow the
final composed bytes; author checks do not satisfy those gates.

## Writable scope and dependencies

- `apps/server/src/operations/operation-receipts.ts`
- `apps/server/src/operations/terminal-operations.ts`
- `apps/server/src/terminal/local-runtime.ts`
- `apps/server/src/terminal/run-registry.ts`
- `apps/server/src/terminal/runtime-retained-bytes.ts`
- `apps/server/src/terminal/worker-pipe-session.ts`
- `apps/server/src/terminal/worker-pool.ts`
- `apps/server/tests/author/operation-receipts.test.mjs`
- `apps/server/tests/author/runtime-admission.test.mjs`
- `apps/server/tests/author/worker-pipe-session.test.mjs`
- This task plan.

Preserve all fourteen registrar dirty paths exactly, including manifests, lock,
shared tooling/config and governance documents. Their inherited hashes and the
registrar handoff hash are verified in the off-tree before-source manifest.
Use Node 26.10.0, pnpm 12.6.0 and installed TypeScript 7.0.2 without reinstalling
or changing pins. Internal dependencies remain consumed through built package
exports and TypeScript Project References.

## Implementation and rationale

1. Annotate `WorkerPipeSession.request` in
   `apps/server/src/terminal/worker-pipe-session.ts` with
   `payload: Uint8Array = new Uint8Array()`. The current initializer infers
   `Uint8Array<ArrayBuffer>`; runtime and protocol consumers accept general
   `Uint8Array` views. The protocol encoder already copies payload bytes into
   its own bounded frame, and the session preserves full-backing admission
   checks. No assertion, extra copy, protocol change or compiler relaxation is
   needed. The provisional `packages/terminal-worker/src/pipe-session.ts` path
   does not exist and is not part of this correction.
2. Add the concrete `Invalid session limits` expectation to the existing
   insufficient-reserve constructor test. Its fixture fails the control-reserve
   check before arena allocation; do not claim later arena-exhaustion coverage.
3. Run pinned Prettier only on the ten allocated source/test files and this plan.
   All other edits in those source/tests are formatting only.

This is an existing declaration and tooling correction; no architecture decision
or Orca behavior is being adopted.

## Author validation and handoff

- Run the server build and package test against compiled modules. Existing
  tests cover omitted payloads, input, budgets, ordering and admission failures;
  do not add a test that merely mirrors the type annotation.
- Check formatting and lint only on the allocated paths, then inspect the diff.
- Read the root check chain before execution. Normal `pnpm check` runs native
  preparation, format, lint, build and the registered test gate. The gate's
  historical browser-close diagnostic is a separate explicit argv branch;
  normal execution must not enter it or an old W2 observer capability probe.
  Ordinary registered W1 native and browser checks are within the author gate
  allocation. Record failures once and correct only evidence-backed failures
  within owned scope; coordinate any expanded scope with root.
- Preserve command output and actual numeric exits off-tree under
  `/Users/luchengxuan/WORKSPACE/cove-evidence/p2-server-type-recovery-r1`.
  Freeze final owned-source and composed-candidate manifests, report, handoff
  and progress; verify registrar hashes remain unchanged before releasing.

No commits, pushes, merges, global/profile/pool changes, custom bridge,
browser-close diagnostic, devbox retry, W2 observer/real producer capability
probe or reuse of consumed R5/R6 authority is allocated. Historical evidence
remains intact. M0 completion and M1 entry remain separate user gates.
