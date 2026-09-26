# N1b public bounded-spawn contract integration

## Pre-code allocation, 2026-09-27

- Owner: `/root/m0_t1_impl`, interactive GPT-6 Sol high; the root coordinates independent review and verification. Checkout: primary `/Users/luchengxuan/WORKSPACE/cove`, new branch `p/luchengxuan/m0-16-public-spawn-integration` at accepted main `b010c58939949cde3428326f70bc4880a54dfa7b` (tree `3ee4946754173b747e7f4858321b258f8e9b9205`). Preserve the completed source branch `p/luchengxuan/m0-16-public-spawn-contract` at `bc413b1e81e28b851fb890b235da2c95ff2a461d` and N2 blocked branch/ref; do not rewrite either.
- Objective: transplant the reviewed N1b public preflight and typed no-handle cleanup receipt onto main after N1, G0, and R1. Source review `/tmp/cove-m0-w1-n1b-adoption-test-review/report.md` SHA-256 `07ee3fbdea1ac67337d65a55bb634f12693d008623943f154813c38fcebd7e52`; independent adoption failure-path verification `/tmp/cove-m0-w1-n1b-native-verify/adoption-bc4/report.md` SHA-256 `08bc2ae715723954686484bab0227d5652bda7817f753e14985de6d20647b3e5`. These approve the source candidate for integration, not the combined checkout or hosted release.
- Replay the ten commits from accepted N1 `410e6f397b58440394667a4b1ba2c9f0f3e2a4e0` through `bc413b1` in original order, retaining atomic boundaries and full messages. Read-only path comparison found overlap only in `scripts/ci-test-gate.mjs` and `tests/tooling/ci-test-gate.test.mjs`. Resolve any actual conflict by retaining G0's tooling floor 30 and all R1 registrations while adding the real N1b spawn-contract suite floor 11. No protocol, browser, or N2 implementation edits. Keep the native patch and lock registration paired without changing dependency pins.
- Writable integration scope: the N1b source commit paths (`patches/node-pty@1.1.0.patch`, its package-local registered tests, `pnpm-lock.yaml`, CI gate and affected tooling tests, N1b task plan/results), this integration record, and `docs/handoff.md` for reconciled current state. Only actual replay conflicts may alter shared files, and every resolution must be documented. The root owns other coordination and GitHub records.
- Audit old-to-new commit parentage, full messages, changed paths, and trees, including any unavoidable plan/current-state conflict. Verify the final native patch, lock, package tests and source objects against the approved source; explain any differing object. Freeze the combined source SHA before independent integration review. Use pinned Node 26.10.0/pnpm 12.6.0, frozen install, native source build and marker 2, scoped worker/tooling tests, then one combined `pnpm check` once the integrated candidate is coherent. Independent combined verification and review, exact-head dual-OS CI artifacts, rebase-only merge mapping, and final-main artifacts are required before N2 can resume.
- N2 production adapter remains held. This integration does not start W1a, W2, P2, or M1, does not change the no-handle cleanup contract, and does not maintain pre-release experimental protocol versions. Preserve the prior independent finite results and the old branch as provenance rather than declaring N1b complete from cherry-pick success.

## Source replay checkpoint, 2026-09-27

The pre-code plan is `d61f95ccaf5feb40c0cf9c9c39b7790ca4131b25`. All ten source commits replayed in order without a textual conflict. Git auto-merged the two shared gate files while retaining G0's tooling suite minimum 30 and N1b's spawn-contract suite minimum 11; R1's protocol registrations remain present. Original → mapped commits:

| Original  | Integrated | Scope                                                    |
| --------- | ---------- | -------------------------------------------------------- |
| `26ee4c8` | `5f2a881`  | Initial N1b plan                                         |
| `547abcb` | `ca2753f`  | Public contract, native patch, lock, tests, registration |
| `5024658` | `27066f6`  | Initial author evidence                                  |
| `7bd3c4d` | `b01441a`  | Rollback correction plan                                 |
| `627d97b` | `17c8395`  | Bounded rollback correction and registered tests         |
| `8328130` | `566e857`  | Corrected author evidence                                |
| `1cb211a` | `5c4fdbd`  | Late-watcher test correction plan                        |
| `357a296` | `b70c5f8`  | Late-watcher callback test                               |
| `2dc1748` | `ce7183c`  | Adoption fixture correction plan                         |
| `bc413b1` | `c291a0c`  | Adoption fixture cleanup test                            |

Each mapped commit has one parent, an identical full message and changed-path list to its original. Full Git tree IDs differ because main advanced through G0 and R1; the final native patch, lockfile, registered spawn-contract test, and isolated TypeScript consumer blobs exactly match their reviewed `bc413b1` counterparts. The combined candidate still requires its own independent review, full gate, hosted dual-OS readback and final-main acceptance. The handoff's current section is reconciled separately from its retained historical records.
