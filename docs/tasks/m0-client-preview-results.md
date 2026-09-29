# P3d client preview source results

This is source-author evidence for the allocated M0 P3d slice. It is not independent QA, an integrated main result, or P3/M0 acceptance. Source base is accepted M0 commit `76dbc017215a517f5c0bf199c821f57873e472be` (tree `7d37dce441c3f4c7502b290058fe2ae1b04e6de0`). The original P3c branch remains at `57e75e5047400a388ae645a12016fbe49d141e51` (tree `c103c57d2c324208e6710a841768e0565bd1c386`). The branch is `p/luchengxuan/m0-19-client-preview` in the primary checkout. The final source head/tree and exact diff are frozen in the task evidence report outside the repository, avoiding a status-only self-reference commit.

## Authored behavior

Commit `12880dfa20f81e49c8e4fe35b3578642bd02e174` adds a public preview transaction, lane routing and single-deadline result/transfer join. It validates full run and knownVersion, binds to the negotiated capability and attempt, preserves opaque VT bytes, reserves the shared ingress aggregate before retaining transfer bytes, and releases ownership before timer and adapter callbacks. One full run has at most one pending preview. A bounded 256-entry retired preview ledger fences recognized late IDs; an ambiguous incomplete possibly-sent request quarantines that run until explicit reconnect. Preview joins input under the existing 224 ordinary command ceiling and cannot use 32 reserved progress/control slots. No live view/recovery cursor, ACK, focus or input path is entered by getPreview.

The second source unit adds only finite tests: actual lane-held 224/256 command saturation with a declared white-box fixture, reentrant two-route queue selection, MAX_SAFE_INTEGER request counter refusal, preview plus controlled shared ingress debt, and preview with view disposal. The existing recovery and control/input files remain unchanged and retain their own parser/lifecycle identities. The white-box lane tests do not claim that 224 inputs naturally reach the lane through serialized public controllers. No scheduler production defect was demonstrated by source inspection, so no conditional controller/control source edits were made.

## Checks actually run

- Type: local installed `./node_modules/.bin/tsc -p packages/client/tsconfig.json --noEmit` exited 0.
- Lint: local installed `./node_modules/.bin/oxlint --deny-warnings` on the three edited client source files and two new test files exited 0.
- Format: local installed Prettier check on edited source, tests and task plan exited 0.
- Syntax: `node --check` on both new `.mjs` files exited 0; `git diff --check` exited 0.

The shell's `pnpm` launcher attempted to install pinned pnpm 12.6.0 from the configured internal registry and failed because that registry advertised only 11.28.2 as latest. Existing local static tools were used without changing package pins, registry or installation. The active shell Node was v24.14.0, while the project pins v26.10.0. No Vitest, build, native, browser, network, CI or devbox execution was performed by this author under the source allocation; new test declarations have only static/syntax validation. Independent tester and reviewer must execute and inspect the compiled public path at the frozen head before shared registration or integration.

## Boundaries and next gate

The two new physical test files contain 14 preview declarations (one has two finite order variants) and three explicitly white-box lane declarations. These are authored static inventory, not runtime counts or the registrar's final required-suite floor. Existing recovery/control tests provide separate inherited identities; the registrar must map exact blobs and actual registered inventory after independent review/QA. Full P3 still depends on W1/W2, P2 server production ordering, H1 host adapters and real C3 integration. The current wire has no preview event requestId; a producer that reuses an indistinguishable old transfer tuple cannot be disambiguated in this client, so P2 must serialize and retire producer transfers. No wire or protocol change is made here.
