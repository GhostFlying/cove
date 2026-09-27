# P3a browser-close diagnostic source-review repair

Status: pre-code addendum, 2026-09-27. This addendum applies to the clean primary checkout `/Users/luchengxuan/WORKSPACE/cove` at `8094480a8870f7ccd00174fbfc501b3a33fd4a9c` (tree `bfc32e0b738d72cafc7f10f15425064a958e01b8`). It preserves the immutable approved plan and its original review hashes. It does not allocate the hosted browser run.

## Allocation and evidence

- The original approved plan SHA-256 `a25749c20188b47ebc1d317958c60cb39f7f8797d253c5441cf5b5a61b2e2d65` proposed separate implementation and registration owners. The committed pre-code allocation at `c9ff9df82d9b9d0600abb5f44fe4faf0c3e4d96c` named `/root/m0_t1_impl` as both author and registrar. That agent wrote the plan allocation but did not start implementation before interruption.
- After the interruption, `/root/browser_diagnostic_impl` performed the `8094480` source and workflow implementation as one interactive native GPT-6 Sol high author/sole registrar. On 2026-09-27, the root coordinator explicitly accepted this combined bounded allocation as a deviation from the original separation proposal, while retaining independent QA and source review. The original plan review did not approve this changed role assignment; this addendum records the later coordinator decision without rewriting the plan or its hash.
- Independent source review of `8094480`, SHA-256 `86edb7b92e03ade88011a488625a983cd2cfccda28134df2e508e3b3de460c70`, requested three corrections. A byte-identical copy is at `/Users/luchengxuan/WORKSPACE/cove-evidence/browser-close-diagnostic-source-review/report.md`. The separate candidate QA report for `8094480` passed bounded checks but did not close these findings.

## Repair objective and writable scope

The same sole author/registrar will fix only the review findings in `scripts/ci-test-gate.mjs`, `tests/tooling/ci-test-gate.test.mjs`, and the minimum `packages/terminal-web/probes/node/managed-browser.ts` evidence field needed for already observed browser version. Update `docs/tasks/m0-p3a-browser-close-diagnostic-results.md`, `docs/handoff.md`, this addendum, and the off-tree handoff report for accurate provenance. `.github/workflows/check.yml` may change only if failure artifact handling requires it. The existing V1-L4 workload and assertions, product/client/renderer/worker/protocol/native source, dependency manifests, lockfile, pins, and other checkouts are excluded.

1. Separate exact selected-case execution-shape validation from pass acceptance. After a nonzero Vitest exit, still validate the JSON when present, final cleanup/timeline schema and binding, exactly one invocation, and artifact hashes. Preserve the nonzero test verdict; missing or invalid files produce an explicit no-conclusion failure record. Do not retry or run an extra browser case.
2. Record installed Playwright and playwright-core versions, Chromium manifest revision/version, and the browser-reported version already checked by the managed invocation. Bind the bounded provenance to the same source commit/tree/run/attempt and include it in a success or failure hash manifest. A pre-browser failure must truthfully show the browser version as unobserved.
3. Correct the role and revision narrative as described above. Keep the reviewed `8094480` and original approved plan intact in history; add new atomic commits instead of rewriting them.

## Validation and release boundary

Use the pinned Node 26.10.0 and pnpm 12.6.0 already available. Add browser-free counterexamples for a nonzero selected V1-L4 result with valid cleanup, absent/malformed/multiple failure artifacts, reporter selection mismatch, and missing/unobserved browser-version provenance. Run only the affected controlled tests, TypeScript build, lint and formatting. Do not run a real local browser, full gate, hosted CI, retry, push, merge, or devbox. Freeze the new clean SHA/tree, test counts, inventory, report hash and exact trigger for the root; another independent source review is required before the one hosted allocation.
