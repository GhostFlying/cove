# C1 CI inventory and fail-closed gates

- Owner: C1 root/CI writer, Issue #9. M0 entry was approved by the user on 2026-09-26; older milestone and handoff status text is coordinator-owned and pending update.
- Objective: keep the required `check (ubuntu-latest)` and `check (macos-latest)` jobs while making the current tooling suite an explicit, nonzero, executed CI requirement with reproducible environment evidence. Later capability PRs extend the inventory as real suites land.
- Base: `a902ee0bae0e6539afab6555c0585ff6745261d5`; checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-ci-gates`; branch: `p/luchengxuan/m0-9-ci-gates`.
- Writable files: `.github/workflows/check.yml`, concrete tooling gate scripts/config/tests, root `package.json` test/check scripts as needed, `vitest.config.ts` as needed, `docs/development.md`, and this plan. No lockfile/dependency changes or application/PTY suite placeholders.
- Contract dependencies: Node 26.10.0, pnpm 12.6.0, frozen install, existing Vitest `tooling` project and `tests/tooling/project-references.test.ts` two tests. Current workflow and ruleset keep both exact job names. No dependency on unimplemented B0/P/T/C capabilities.
- Source comparison: `docs/plans/m0-ci.md` pins Orca fork `322c1839888f4a462e2d68839deafb1fe616c685` and upstream main `646e9a5b02514795af5139961ccca225dfa01b12`, with `.github/workflows/pr.yml` and terminal smoke paths. Orca's explicit verifier dependency checks support a required inventory; its path-filtered and nonblocking E2E policy is unsuitable for the small M0 gate. Cove currently has only tooling tests, so C1 does not claim native/runtime coverage.
- Implementation: define the required suite in one concrete inventory; compare discovered test files and Vitest projects to that inventory; run Vitest with machine-readable results; reject missing output, absent suite, zero executed tests, skipped/pending tests, or failed tests. Record command/status and Node/pnpm/ABI/OS/arch evidence in task-local CI output. Keep workflow matrix steps blocking and upload bounded synthetic tooling evidence on both success and failure.
- Validation: isolated frozen install; `pnpm check`; failure-path probes for missing suite, excluded suite, skipped tests, and absent result; format/lint/build; inspect produced inventory and environment evidence. Hosted macOS/Linux runs and ruleset state are coordinator integration evidence, not a local claim.
- Exclusions: no new package, lockfile, PTY, app test, native ABI claim, external deployment, push, PR, merge, or changes to shared handoff/milestone/module plans.

## Local verification

- Frozen install succeeded with Node 26.10.0 and pnpm 12.6.0 in this checkout.
- `pnpm check` passed on macOS arm64: Prettier, Oxlint, `tsc -b`, and 2 tooling files / 6 tests. The gate produced nonempty Vitest JSON and JUnit plus environment, execution, and inventory records in `.cache/ci`.
- Gate failure-path tests reject a missing required suite, an excluded test file, a skipped assertion despite a successful summary, an absent result, and zero passed tests. One local discovery probe exposed a Vitest 5 static-list false positive for a variable named `tests`; the fixture variable was renamed and the final discovery/execution counts both equal 6.
- `actions/upload-artifact` v7.0.1 was verified against the official Git tag `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` before pinning. Hosted matrix checks and live ruleset state remain integration evidence for the coordinator.
