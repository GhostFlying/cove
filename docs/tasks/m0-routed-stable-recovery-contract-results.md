# M0 P3 R1 routed stable-recovery protocol correction: author results

Status: functional author candidate committed unchanged as `197eb0183d2ff28fde726fe38e5eb43ee9b6968b` after the external execution sandbox prevented Git administrative writes. The author's full browser gate was blocked by Chromium launch. Independent testing, independent review, a browser-capable full gate, hosted macOS/Linux CI and the later W2/P2/P3 runtime barriers remain separate gates.

## Source and scope

The implementation started from allocation commit `6ccd5641bdc74eb4ada6b4a429b57a1cf2c1eaca`, tree `c10dfabcbbab36b0e7c0ce6cd648382a91b87eef`, on `p/luchengxuan/m0-19-routed-protocol`. The integrated plan parent is `c32a775b7e1ca297b2b60d6061a91200063172f3`. The reviewed Astra source plan SHA-256 is `81d057816b92f1368a56a6b3af14355c2ecf0f0e6d168ccf3b828a454c014203`; the independent plan review SHA-256 is `a7739c8084efab4d51ae1e57c5042eba15b0bb8b5a437056a2038447192e1175`. Author routing was local TraeX GPT-5.6 Sol xhigh with no subagents, remote workers or production services.

The candidate changes seven protocol sources, four protocol test files and the four current M0 fixture/manifest files. The binary Git diff over only `packages/protocol/src`, `packages/protocol/tests` and `tests/fixtures/protocol/m0` has SHA-256 `5f4bbf8b73905d75904c55910a479c8a56e50ead7a777df45c8053ca1c10f939`. The results document is deliberately excluded from that review handle because it records the handle itself. Package manifests, exports, pins, lockfile, root configuration, CI inventory, T2/V1 production, worker/server/client runtime, shared plans/design/handoff and other checkouts were not edited. The lockfile remains SHA-256 `4173cbfdbc0c169a7d5d3780461276e6ae77791ab98c2662fe1cc071dbacdc0f`.

## Corrected public contract

- External ordinary delivery is `{type: "run-event", subscription: SubscriptionRef, event: RunEvent}`. `ExternalTerminalEventSchema`, `RunEventDeliverySchema`, `validateExternalEventBinding`, `externalEventSubscription` and their types are exported from `@cove/protocol/terminal`. `validateTerminalFrame` accepts the negotiated `ConnectionRef` used to bind routed delivery.
- The inner `RunEventSchema`/`RunEvent` and renderer `TerminalEventSchema`/`TerminalEvent` are unchanged. T2 and V1 continue to consume the existing inner events without a transport envelope. Baseline events retain their embedded complete reference; preview remains run/version scoped and rejects a live subscription route.
- `PipeEvent` carries an outer `subscription` route for ordinary and baseline delivery. Semantic validation requires it for those events, requires exact equality with a baseline's embedded ref, forbids it for preview, and binds worker, run and subscription identities.
- Recover commands/results no longer contain `replacement`. A terminal recover result must return the command's original complete subscription ref. New attach/reconnect remains a distinct operation and the fixture/tests require a fresh subscription ID.
- Accepted pipe subscribe/recover results require `recoveryMode: "replay" | "baseline"` and `atSeq`; validation binds worker, run, request ID and method and refuses a cursor below the requested subscribe/recover floor. Inapplicable or rejected recovery modes are refused.
- External protocol and server-status version are 2, terminal lane revision is 2, pipe hello version and lane revision are 2, and capabilities are `terminal-framing-v2` and `worker-pipe-v2`. Bootstrap stays version 1; profile and baseline encoding stay `pragmatic-logical-grid-v1` and `vt-checkpoint-tail-v1`. External protocol v1 and pipe/revision 1 are explicitly refused.
- Both terminal and pipe semantic validators enforce the existing 4096-byte metadata and 65,536-byte payload bounds. Tests cover opaque output, empty non-output payloads, wrapping overhead, outer/inner run/ref/connection mismatch, baseline route mismatch, two subscriptions at different cursors, fresh attach identity, stable same-ref recovery, result correlation and a scripted late-delivery/old-ACK oracle.

This is a schema, fixture and scripted-trace correction only. It does not prove the later W2 producer barrier, P2 connection queue, P3 client attempt fencing, a real two-channel exchange or runtime acceptance.

## Fixtures

The current fixtures are schema v2 while their historical v1 revisions remain available in Git history. SHA-256 values are:

| File                    | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `profile.json`          | `85bdb168027df1e796d106ede7dccf255f565218b7f3fc42ff561969b8c61987` |
| `terminal-journey.json` | `b606cb587a9fe82844df9affc837ad55ea81d096a60b7e1096162aecb352479f` |
| `pipe-journey.json`     | `e952080f0d51e5b1ed4805badbb7eb4cae5ab3a6436eb0f489434f24eb23986e` |
| `admission-rpc.json`    | `1c0cd269e0d61babcb7785fb1c6c35a6515379148a8f2a3fe2da8f7e7b511b16` |
| `manifest.json`         | `dd82f2de6b5840bbf5bf2ba11b56e3085c9b6a95efdffe1fec3356502ed68b99` |

## Validation evidence

Validation ran on macOS 26.3 arm64 (`Darwin 25.3.0`) with the repository-pinned Node 26.10.0 and pnpm 12.6.0. The Node archive was checked against Node's published SHA-256 `751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9`. A frozen install completed without lockfile changes.

| Check                                                                                                                  | Result                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped Prettier, oxlint and `git diff --check`                                                                         | Pass                                                                                                                                              |
| `pnpm --filter @cove/protocol --fail-if-no-match build`                                                                | Pass                                                                                                                                              |
| `pnpm --filter @cove/protocol --fail-if-no-match test`                                                                 | Pass: 7 files, 84/84 tests                                                                                                                        |
| `pnpm --filter @cove/terminal-engine --fail-if-no-match build`                                                         | Pass                                                                                                                                              |
| `pnpm --filter @cove/terminal-web --fail-if-no-match build`                                                            | Pass, including both Vite browser bundles                                                                                                         |
| `pnpm --filter @cove/terminal-engine --fail-if-no-match test`                                                          | Pass: 14 files, 121/121 tests                                                                                                                     |
| `pnpm exec vitest run --project protocol --project tooling --project terminal-engine --project terminal-engine-probes` | Pass: 25 files, 241/241 tests                                                                                                                     |
| `pnpm --filter @cove/terminal-web --fail-if-no-match test`                                                             | Environment failure: 1/33 passed; 32 Chromium-dependent cases could not launch Chromium                                                           |
| `pnpm check`                                                                                                           | Formatting, lint and complete build passed; gate ran 30 files / 274 tests with 242 passed and 32 failed in the same five Chromium-dependent files |

Every browser failure has the same pre-test launch cause: Playwright reports `Protocol error (Browser.getVersion): Internal server error, session closed. Failed to launch browser`; Chromium exits with `SIGABRT`, and the sandbox denies Playwright's cleanup signal with `kill EPERM`. The pinned binary itself reports Chromium `153.0.8010.12`. No browser assertion reached R1 behavior, so this is not accepted browser evidence and must be rerun outside this restricted process sandbox. The non-browser integrated run includes the isolated compiled-declaration/package-boundary consumer and all protocol and engine suites.

Preserved setup failures: the initial unpinned shell was Node 24.14.0/pnpm 11.25.0; a first pnpm invocation tried to write its tool cache outside the sandbox; the first pinned offline install lacked optional Linux package metadata; one online registry attempt was interrupted after a slow `node-pty` download; a later frozen mirror install succeeded. The first full-gate launch used pnpm's shebang-less fallback and failed `spawnSync pnpm ENOEXEC`; rerunning with pnpm's actual native binary reached the tests and produced the browser result above. A final test-only addition initially omitted a `TerminalResultSchema` import; the next scoped run passed after adding it. None of these failures was treated as passing evidence.

## Commit and handoff

The external author could not commit in its sandbox: this linked worktree's Git administrative directory is `/Users/luchengxuan/WORKSPACE/cove/.git/worktrees/m0-terminal-recovery`, outside that sandbox's writable roots. Its `git add` failed before staging with `fatal: Unable to create '.../index.lock': Operation not permitted`. After explicit ownership transfer, the integration owner verified the scoped binary diff SHA-256 above and committed those exact 15 source, test and fixture files without implementation edits as `197eb0183d2ff28fde726fe38e5eb43ee9b6968b` (`fix(protocol): route subscriptions across stable recovery barriers`), parent `6ccd5641bdc74eb4ada6b4a429b57a1cf2c1eaca`, tree `c3cc3e9745c256757b3f40b1c9f90e6c4ac8a8bf`. This results document is a separate provenance commit. The browser-capable full gate and independent review/testing must target the eventual integrated candidate; this commit alone does not establish runtime acceptance.
