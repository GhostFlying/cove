# M0 P3c client control/input source result

Author source slice, 2026-09-28. This is a candidate for independent source and finite verification, not P3c acceptance. Accepted base: actual main `d033b51a30628ea5338d8ba4316eb0bc303ea9aa`, tree `2e3feed1c20918beec65e4dd4d479cb5b423eb53`. Branch: `p/luchengxuan/m0-19-client-control-input`. The source tip is `cfa6c5785c83001d87e7dbe4ecbc757d6b991fc8`, tree `dd1b7ffea31260d58704cecde8060c13fb8b06d4`.

The pre-code record is `8bc684b7722411f54f110558deffca1e2f69e370`; the focus/authority slice is `7329673a1ee0a8bc4efe460bd5981f84ef11c670`; the input slice is `cfa6c5785c83001d87e7dbe4ecbc757d6b991fc8`. All commits used the existing user Git identity. Source ownership was limited to client code and this task's documents; shared registration remains pending with the sole registrar.

## What is present

- Explicit host input target, generation-bound view focus intents, focus/blur receipts, resize/appearance proposals, current applied holder/epoch readiness, immediate higher-epoch revocation and exact handoff fences. A late accepted focus after local blur gets a captured-epoch cleanup blur; a later current grant is not withdrawn by it.
- Typed input receipts with local ID and written/unknown/not-sent byte counts. Genuine bytes are copied before asynchronous work, sent as protocol payload, bounded by the negotiated input queue and the existing encoded outbound ledger. The lane reserves 32 of its 256 local pending slots for control and bounds input to 224; the old ACK/progress path stays in the same ordered lane. One input intent keeps its byte order, no uncertain or short-written suffix is retried, and a received loss of authority blocks queued input before handoff.
- The baseline/replay parser remains the accepted P3b parser. A recovery baseline does not contain holder/epoch, so it cannot restore input permission; an explicit new focus intent is needed. Foreground reconnect keeps one host desire only, and ordinary recovery cannot generate a focus loop.

## Author checks

Installed pinned Node 26.10.0 and pnpm 12.6.0 were used with command-scoped `PATH`, without install or mirror fetch. `pnpm --dir packages/client build` passed. `pnpm exec vitest run --project client` passed with 4 files and 119 tests; this includes 16 newly discovered public fake-transport cases in `packages/client/tests/terminal-control-input.test.mjs` and the accepted P3b recovery tests. Targeted `oxlint --deny-warnings` and Prettier on owned source/test files passed; `git diff --check` passed. The exact new-test identity discovery is frozen at `/Users/luchengxuan/WORKSPACE/cove-evidence/p3c-implementation/discovery.json` SHA-256 `7a8ebfe4b8f51e44dd532e1002cf110f09684d258c26134c7e40da80846f5bb0`.

An initial new staged-input test failed because a focus-result could settle before the input continuation reached its authority wait. The fix accepts that already-correlated provisional grant as a reason to wait for the ordered control fact, never as input permission. The earlier failure was observed and corrected before the final 119-test run. The tests do not cover every allocation row: independent verification still owes the 224/256 two-route fairness boundary, callback/result permutations, and broader deliberate negative controls.

## Integration proposal and boundary

Existing `@cove/client` root export resolves to the compiled `client.ts` declarations and implementation; the new suite is discovered by the client Vitest project without a new package dependency. Sole registrar should independently verify the full exact discovery manifest and update shared suite counts, gate inventory or required floor where applicable when composing onto the then-accepted main. No package manifest, exports, lockfile, root test config, CI, tooling inventory or global handoff was changed here.

No native/browser/PTY, real transport/server/worker, full repository gate or hosted CI ran in this author slice. Client fake outcomes do not prove server arbitration or producer-barrier behavior. Independent source review and finite QA must use this frozen source H/T before registrar composition; normal candidate and actual-main gates follow the accepted P3c allocation. P3/M0 and M1 remain unaccepted.
