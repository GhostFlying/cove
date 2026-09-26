# M0 T2 terminal engine adapter: author evidence

Status: first compiled source candidate; independent verification, review, merge and dual-OS CI remain open. This record describes the author checkout, not T2 acceptance or a live PTY/agent integration.

## Source and ownership

- Assigned checkout: `/Users/luchengxuan/WORKSPACE/cove-worktrees/m0-terminal-recovery`, branch `p/luchengxuan/m0-15-terminal-engine`; allocation base `226d8f4c8083921af31944d8f51c66a1af726ee7`, accepted P1b predecessor `2e8e2be7cce58399c8313c315cc6649285abfd54`.
- Implementation source: `cfe5fa13ace44eeb4f1c1e7a4f96276ff4fd8b53`, tree `266ee96e50ff1f47b8d24adb9bb03e6ee3bced67`. The pre-code execution entry is `b5d2706fc149306d3d0e2d20b41894bbca4b0709`.
- Pinned Node 26.10.0, pnpm 12.6.0, macOS arm64; `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0 remain unchanged. Lock SHA-256: `4173cbfdbc0c169a7d5d3780461276e6ae77791ab98c2662fe1cc071dbacdc0f`; P1b fixture manifest SHA-256: `8d60932b86a0ac0ec0a56c202b1004e4e43dbae05ac66b1c838c1385885a39f6`.
- Existing `packages/terminal-engine/probes/**` and `tests/fixtures/terminal/engine/**` had zero diff against the allocation base. No protocol source, pin or lockfile changed.

## Public adapter and boundaries

The package root now exports `createTerminalModel({run, geometry, appearance?, effectiveBudgets?, onAutomaticOutput})` and `TerminalModel`. One instance owns one headless model. Its methods are `apply(RunEvent, payload?)`, `continueUnpublishedOutput(bytes)`, `barrier()`, `captureBaseline()`, `capturePreview()` and idempotent `dispose()`. `apply` and the barrier return a local `EngineResult<EngineState>`; captures return detached bounded result unions. The automatic-output sink receives `{atSeq, kind: 'query' | 'focus', bytes}` only from live parsing and control transitions. W1 remains the sole event-sequence allocator, control arbiter and PTY reply router.

The source uses the approved read-only, pinned private-state boundary to make practical logical-grid VT checkpoints. `EngineBaseline` contains profile/encoding, checkpoint and parsed sequence, equal capture/current geometry, coverage, VT, exact raw tail and local effective appearance. It has no subscription or transfer ID. A real resize invalidates an older checkpoint; an incomplete parser at that geometry yields waiting until a later safe checkpoint. A bounded fixed buffer retains at most 64 KiB of raw tail; overflow reports unavailable until a valid replacement. Preview is generated from active viewport cells with a 64 KiB cap, without normal history or raw parser tail. Live appearance and nine advertised query families use one sink; focus reports require mode 1004 and a presence transition. The adapter owns no PTY, subscriber, runtime cache, browser view or second restoration engine.

`EngineState.resources` reports queue bytes/count, checkpoint bytes, raw-tail retained/allocated bytes and peak accounted adapter bytes. These are local allocation counters, not xterm internal-memory or process-RSS measurements; the later worker/runtime gates measure those. The compiled root declaration and runtime exports pass the isolated ES-only consumer guard. Probe exports remain separate and unchanged.

## Author checks at `cfe5fa1`

With the pinned PATH, `pnpm format:check`, `pnpm lint`, `pnpm --filter @cove/terminal-engine --fail-if-no-match build`, `pnpm exec vitest run --project terminal-engine --project terminal-engine-probes`, and the affected two tooling suites all exited 0. Engine plus historical probes: 14 files, 112/112; affected tooling: 26/26.

The final author `pnpm check` exited 0 after native preparation, formatting, lint, full TypeScript/browser build and required inventory. It executed 27 files, 238/238: protocol 80, tooling 31, new engine 37, historical engine probes 75, browser probes 15. The five new suite IDs/floors are `terminal-model` 9, `engine-recovery` 8, `engine-parser` 6, `engine-query` 8 and `engine-preview` 6. The parser suite includes 138 interior cuts and seven C0-in-CSI controls; the recovery suite includes 3/1000 retained-history cases and 20 sustained printable checkpoints. The required inventory accepts no skipped/pending tests. The local JSON report SHA-256 is `b63cf504ad5e7f704f8f3b552b5a4e8f1fdb0f42bc404978536655bbe8adac4d`; JUnit SHA-256 is `b8cd03c6e1e4cc73c71112ddc11e1c2c09e40efbf2cd286c46d4be2a2fb6c3fe`. These ignored `.cache/ci` artifacts are evidence from this checkout, not committed source.

Independent tester strategy was frozen before this candidate (strategy SHA-256 `db407bd105699292b76b9974a5cee0105c4c01827b601b1dca4b4191265e6859`, sentinel digest `1a638fd670af20314678dcfdb9e8bd9f053e3051c627ae13943afc45f361f55e`). It has not yet been run against this source. The independent reviewer is examining the frozen source. A review counterexample is already open: OSC 110/111/104 currently reset to static default appearance, whereas a later explicit appearance replacement may need to be the reset target. The author gate above does not close that issue. Root coordinates any bounded correction and then renews affected evidence before merge.

No live PTY, real Codex/TraeX/Claude Code flow, browser installation, SSH host or Linux CI was exercised by this T2 author run. Those are downstream and coordinator gates, not implied by the local green tests.
