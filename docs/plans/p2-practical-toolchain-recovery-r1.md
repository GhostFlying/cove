# P2 practical toolchain recovery R1

## Ownership and objective

- Owner: sole implementation/registration writer and repository registrar, SID
  `01a0f11f-a0b7-77b0-969e-bd252701b574`, requested `gpt-5.6-sol` / high through
  TraeX and the local warmpool. Backend mapping and warm-hit status are not
  independently visible in this session.
- Base revision: `29cb3637810c646db607389601b7a81bb7ef910d` on
  `p/luchengxuan/m0-18-server-control`.
- Checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-probes-verify`.
- Objective: establish the repository-pinned Node 26.10.0 and pnpm 12.6.0 at a
  normal supported command boundary, register the already-authored private
  `@cove/server` package in the workspace lockfile, and freeze a buildable
  candidate for separate independent validation and review.
- Direction change: the human instruction that authorized this practical
  recovery supersedes the prior checkpoint's waiting/cancellation phase and
  makes the historical bespoke provenance/controller path non-blocking for this
  ordinary toolchain operation. Frozen historical results remain unchanged.

## Owned files and inherited bytes

The task inherits and preserves the following exact eight dirty registration
paths. They were present before this plan and are owned by this allocation:

- `scripts/ci-test-gate.mjs`
- `tests/tooling/ci-test-gate.test.mjs`
- `tests/tooling/package-boundaries.test.ts`
- `tests/tooling/project-references.test.ts`
- `tsconfig.json`
- `vitest.config.ts`
- `apps/server/package.json`
- `apps/server/tsconfig.json`

This allocation may additionally write `pnpm-lock.yaml`, this plan,
`docs/handoff.md`, `docs/tasks/m0-execution.md`, `docs/plans/m0-protocol.md`, and
`docs/development.md` when a durable setup correction is warranted. Evidence is
written only under
`/Users/luchengxuan/WORKSPACE/cove-evidence/p2-practical-toolchain-recovery-r1`.

## Contract dependencies

- Root pins remain exactly Node `26.10.0`, pnpm `12.6.0`, TypeScript `7.0.2`,
  and `@types/node` `26.6.2`; no pin or architecture decision changes.
- The private server registration depends only on `@cove/protocol` through
  `workspace:*`, participates in the root TypeScript reference graph, and adds
  its three existing author suites to the server Vitest project and fail-closed
  inventory.
- The server remains private and publishes no `exports` or `bin`; this task does
  not add product behavior or broaden the P2-A boundary.
- `pnpm-lock.yaml` must change only as mechanically required to add the
  `apps/server` importer while preserving unrelated resolutions.

## Implementation sequence

1. Record the inherited eight-path hashes and confirm the repository and
   toolchain pins.
2. Diagnose executable resolution without exposing secrets: compare shell
   `command -v` results with the explicitly selected binaries, inspect the
   project registry/config keys relevant to runtime selection, and prove the
   effective Node/pnpm versions.
3. Use an explicit PATH whose first entry is the verified Node 26.10.0 `bin`
   directory and invoke the verified standalone pnpm 12.6.0 executable. Use a
   task-owned store/cache, generate only the approved lockfile importer change,
   and inspect the resulting diff before any frozen install.
4. Run a frozen install, package-scoped server build and author tests, affected
   tooling tests, compiled-artifact smoke coverage, and the root `pnpm check`.
   Preserve every actual result; do not blind-rerun failures.
5. Update only current governance/setup facts, inspect the final diff and
   identity, create coherent Conventional Commit(s) if hooks pass, then freeze
   exact report/handoff evidence for independent validation and review.

## Validation

- Exact executable hashes, paths, versions, architecture, and relevant
  non-secret project configuration.
- Lockfile diff limited to the `apps/server` importer and any unavoidable
  pnpm-format metadata proven by the generated diff.
- `pnpm install --frozen-lockfile` with a task-owned store.
- `pnpm --filter @cove/server build` and `pnpm --filter @cove/server test`.
- A direct smoke invocation against compiled server artifacts where the existing
  author suite supports it; source-only success is not delivery evidence.
- Affected tooling tests and full `pnpm check` because root tooling/config files
  are part of the inherited registration.
- Final Git status/diff, commit/tree identity if committed, changed-file hashes,
  and confirmation that task-owned processes completed.

## Exclusions and stop conditions

- No custom bridge, T3/R5/R6 reuse, provenance controller, exact environment-map
  assertion, new review loop, browser/devbox/PTY/product-runtime probe, or W2
  observer-capability claim.
- No global profile, security, identity, pool-service, root `AGENTS.md`, other
  checkout, frozen evidence, or unrelated source change.
- No push, merge, deployment, release, M0 completion, or M1 entry. Independent
  verification and independent review remain mandatory after the candidate is
  frozen.
- If an ordinary command encounters the known W2 EPERM boundary, record it and
  stop only that dependent check. Unexpected file scope or material unrelated
  local changes are preserved and reported rather than reset, stashed, cleaned,
  or overwritten.

## Final integration status

The practical toolchain and registration work is complete, and the separately
owned minimal server source/test correction has passed its pinned server build,
31 compiled author tests, and bounded format/lint checks. Root `pnpm check`
passed through native preparation, format, lint, build, environment and
discovery, then stopped before runtime tests at the existing clean-source guard
because the composed bytes were not yet committed. The remaining gates are a
coherent commit, a full check on its clean exact head, and independent
validation/review; no full P2, W2 observer, H1, M0-exit or M1-entry acceptance is
claimed.
