# M0 R1 routed stable-recovery integration

## G0-accepted-base replay allocation, 2026-09-27

This section supersedes the older base-specific execution steps below without changing their historical record. G0 was accepted on main `3472ea99773c34f4b05efb2e940cad1524fcbd60` (tree `66a6976c2db994d668d3e024259e5d7c1d16d14f`) after PR45's 13-commit single-parent/full-message/tree mapping and final-main dual-OS 37/310 artifact check; independent report `/tmp/cove-m0-browser-graceful-close-final-main-verify/report.md`, SHA-256 `0b9ac1685e0fc0c46e37d005d61a63c5a3810c2d1e0913d1e2d0c80548a5ee96`. This releases R1 integration, not N1b/N2. The branch here is `p/luchengxuan/m0-19-routed-protocol-g0-integration` in the existing clean recovery checkout, created from exact accepted main. Old author `7e7cbeb6496b8eff6d86afe6bf1f86045fadd864`, old PR43 head `49f49164d33cc402cd5b9864f2272440522159f9`, and both old branches remain unchanged. PR43's hosted macOS V1-L4 close-timeout failure remains historical evidence; do not force-push, rebase, or merge that published branch.

Replay old integration commits `2c5f297..49f4916` in order, excluding only the stale shared-handoff commit `56e567d`. The first task-local allocation commit has already mapped to `558858f` on this new base. Preserve full messages and atomic commits when conflict-free; inspect any conflict by source path, not by whole-side selection. The old handoff's R1 facts must instead be reconciled into current G0/N1 handoff in a separate commit, including the user's settled no-maintenance policy for experimental versions before the first formal versioned release. Keep N1 native patch/lock/registrations, G0 browser evidence/floor30 and shared contracts exactly intact; no N1b changes enter this branch. Compare replayed commit changed objects, full messages, stable patch IDs and final protocol source/test/fixture blobs to the reviewed old series, with any task-plan textual conflict recorded.

Run pinned scoped protocol checks and one combined `pnpm check` after a buildable freeze. Independent integration review and test must confirm source equality and current shared-state reconciliation before a new draft PR. That PR requires exact-head macOS/Linux artifacts, rebase-only merge with full commit/message/tree/single-parent audit, then final-main artifacts. Only a reviewable replacement may supersede old PR43. This package proves pure R1 contracts, not W2/P2/P3 runtime, N1b, N2, or real agents. Root schedules independent roles; the integration owner writes this branch and GitHub state.

### G0-base replay result, before combined gates

At replay head `b312a8d1f50ce10ddadc142ee7a6518f520bcb13`, ten old integration commits map in original order with identical full messages and changed-path sets. Nine pairs have identical changed-file Git objects. The final pair differs only in this task-local integration document, where the G0-base allocation above was retained together with the historical PR43 evidence below; `docs/tasks/m0-supported-protocol-plan.md` and every production/test/fixture blob remain identical. The only replay conflict was that exact document; it was resolved by retaining both the new G0-base allocation and the old checkpoint facts, rather than taking either whole side. Old shared-handoff commit `56e567d` was deliberately skipped and its current R1 facts are reconciled separately against accepted G0 main.

| Old PR43 integration                       | New G0-base replay                         | Changed-file objects                                                |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------- |
| `2c5f297c8401ffb43911ec0e7edc451663f80fa4` | `558858fa0cc2e8e7a639dfb814014efffd6d2a96` | Equal                                                               |
| `67abace32b90aa134a480057db2aba9e16291204` | `92baa9d1026a8404d2685cedd4475a7851d440ef` | Equal                                                               |
| `d76fee73a0b4fd799e13a061410dd8387fc9fcbd` | `a17f6b374297429b23d1ad8551967ab0ab64a667` | Equal                                                               |
| `e0b90cc15241984c7e34bde67a8a38d45054c672` | `3d90998aa787922f2b24221b039ef4e51de87cb7` | Equal                                                               |
| `833e5c718c60ce6fbbce15d540458b4fb1fbba12` | `26d43d86807a3fec4d17e8a9f8f4f0650d211c8e` | Equal                                                               |
| `1faf77f59e1430426f49e28d277f5ef8ba1973f0` | `0cc419a32b0293ff27ed1354d3ffe39ff5caa6d1` | Equal                                                               |
| `6c76ebcaa7de1fc129ce8101255a297ae191996b` | `a8de0b44910c1e3fbd2dcd269054e06a1fbac741` | Equal                                                               |
| `69e8909a1039226f107eea0bd06ab050ea5877b7` | `0cda88dcd565d784957ec9f18b3ba874cce0f269` | Equal                                                               |
| `00fa6f1a572863e7a0ab6cae035cd40c8a7e30f7` | `25413e451085704e462837aaa4e8f1506ef297e9` | Equal                                                               |
| `49f49164d33cc402cd5b9864f2272440522159f9` | `b312a8d1f50ce10ddadc142ee7a6518f520bcb13` | This integration document differs; the other changed blob is equal. |

Final source/test/fixture Git trees match old reviewed PR43 exactly: `packages/protocol/src` `f26914707235f148ebd5c17f4b8795916d31efda`, `packages/protocol/tests` `3bcd846e4c64a23b885fb1f2c1b99044f9f0058b`, and `tests/fixtures/protocol/m0` `fc07fcc3127aac76a4677575c91cae6ff05bcfbf`. The accepted G0/N1 lock, native patch, and required-suite gate are unchanged from main `3472ea9`. This mapping is replay evidence, not a combined runtime or hosted acceptance claim.

Status: frozen local integration checkpoint, 2026-09-27. Accepted-main base `77de10a2f91fb3eb0fc42c7fc27dd5270ce56704` was integrated on branch `p/luchengxuan/m0-19-routed-protocol-integration`. The exact functionally tested parent is `56e567d85fade02d1baedc5dc0dcf6229ed8640c`, tree `28f7791f7ae23022ca9148eb4f57ef31e788739f`; its complete binary diff from the accepted base has SHA-256 `acbdf19be59bce75d36ea3489082a5c668b03a77990ce0cb4f4e27c6572cb77b`. The immediate successor is documentation-only and is identified by exact head/tree in the external correction report so this commit does not contain a self-reference. The completed author branch remains at `7e7cbeb6496b8eff6d86afe6bf1f86045fadd864` and must not be rewritten.

## Transplant mapping and conflict record

The integration starts with task-local allocation commit `2c5f297c8401ffb43911ec0e7edc451663f80fa4`, then preserves these six original author commits in order:

| Original author commit                     | Integrated commit                          | Provenance                                                                  |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| `197eb0183d2ff28fde726fe38e5eb43ee9b6968b` | `67abace32b90aa134a480057db2aba9e16291204` | Same message and stable patch ID `6a912f6b5d897621349eaba85ccb6b4d975842cf` |
| `b42119ff8c1ff2397cf335f8586016b3b8b6579e` | `d76fee73a0b4fd799e13a061410dd8387fc9fcbd` | Same message and stable patch ID `e144379281b062dbb79f7e72654fb500ed250381` |
| `9cc9ac105ed2f7b7b4237221a5300f53137bd7fc` | `e0b90cc15241984c7e34bde67a8a38d45054c672` | Same message; documentation-only task-plan conflict described below         |
| `ee3553ba917a37c5da052c681f889d68eeb79665` | `833e5c718c60ce6fbbce15d540458b4fb1fbba12` | Same message and stable patch ID `0753ca807172d10afb127368bf0d6b19ba4fd6e4` |
| `c33f7f1cf22c0099b1beb30e52ec09ace081b97a` | `1faf77f59e1430426f49e28d277f5ef8ba1973f0` | Same message and stable patch ID `b045ff48fdfe5240758b0be88695d04de29fc0fb` |
| `7e7cbeb6496b8eff6d86afe6bf1f86045fadd864` | `6c76ebcaa7de1fc129ce8101255a297ae191996b` | Same message and stable patch ID `dad070841429e0ba25d917d7f1ae9dac2f5c68d3` |

The sole transplant conflict was append-only text in `docs/tasks/m0-routed-stable-recovery-contract-plan.md`: accepted main already contained the earlier six-line R1 execution allocation. The integration retained it and appended the original bounded correction allocation. The resulting plan blob `26f38ced75678245cfd3a5bb7b87691360c7f9c4` is exactly equal to the original author's final `7e7cbeb` plan blob; no source, test or fixture conflict occurred.

At original corrected source `c33f7f1`, mapped source `1faf77f` and tested integrated parent `56e567d`, the critical subtrees are byte-identical:

| Path                         | Git tree                                   |
| ---------------------------- | ------------------------------------------ |
| `packages/protocol/src`      | `f26914707235f148ebd5c17f4b8795916d31efda` |
| `packages/protocol/tests`    | `3bcd846e4c64a23b885fb1f2c1b99044f9f0058b` |
| `tests/fixtures/protocol/m0` | `fc07fcc3127aac76a4677575c91cae6ff05bcfbf` |

The mapped initial R1, replay correction and bootstrap correction retain their reviewed binary patch SHA-256 values `5f4bbf8b73905d75904c55910a479c8a56e50ead7a777df45c8053ca1c10f939`, `c991d3159f5059e17d67a2854c69ef125872a9dfb15abd55995cf5e710098df1` and `42dae6d6cfc28e4de4240256097d05e7e8d5813befd310b29ee153feea3e86e9`. The package manifests are unchanged by the transplant. The lock object `99f20931bdcfda4fd6ba417ef13023f3928ec9a2` is identical to accepted main and remains outside R1 changes.

## Post-transplant documentation and current contract

Three documentation commits follow the mapped author series: `69e8909a1039226f107eea0bd06ab050ea5877b7` corrects the task-results candidate tree provenance; `00fa6f1a572863e7a0ab6cae035cd40c8a7e30f7` aligns the relay protocol, client-controller plan and supported-protocol plan with stable recovery and the pre-formal-release policy; `56e567d85fade02d1baedc5dc0dcf6229ed8640c` refreshes the shared handoff. This documentation-only successor closes the remaining stale statements in the supported-protocol plan and finalizes this checkpoint; its exact commit and tree are recorded externally.

The current contract uses external protocol version 2, terminal lane 3 revision 2, and pipe hello/version plus lane 4 revision 2. Bootstrap remains stable version 1; bounded bootstrap failures truthfully advertise peer-supported versions without authorizing an unsupported business protocol. A live subscription keeps the same complete `SubscriptionRef` through replay or baseline recovery. A genuinely new attach after retirement, reconnect or unknown recovery outcome gets a fresh non-reused identity. Experimental versions before the first formal versioned release do not create maintained compatibility lines; current schema correctness and future formal-release/same-version commitments remain intact. Historical v1 records and the immutable old reader's `[2]` rejection remain historical negative evidence, not a passing symmetric gate.

## Evidence and pending gates

The original corrected functional source was independently reviewed at `c33f7f1` in `/tmp/cove-m0-p3-r1-corrected-review/report.md`, SHA-256 `dfcceee5a155be3814505bdb536462239f6fe37d0d29ba39e809c0fafb38c16b`, and independently compiled/tested in `/tmp/cove-m0-p3-r1-corrected-verify/report.md`, SHA-256 `5daf764f3708f080c3ba4ac8cba525a4988970360f2ac104beee16c3bf4a7bb0`. Those are inherited evidence for the byte-identical functional objects, not tests of the accepted-main combination.

The accepted-main combination itself was independently verified at exact `56e567d` in `/tmp/cove-m0-p3-r1-integration-verify/report.md`, SHA-256 `0cb3f4f4497f04c823eb61d4aa8f3a3b24db271714fe4db31283de8f546f3dcc`. Its pinned Node 26.10.0/pnpm 12.6.0 offline install and one full macOS `pnpm check` passed 31 suites / 283 tests, including 87 protocol tests. The subsequent change is documentation-only; no full functional test was rerun or attributed to its head. Source/test/fixture object equality to the tested parent is checked separately.

Independent integration review `/tmp/cove-m0-p3-r1-integration-review/report.md`, whole-file SHA-256 `fc307e268cfadb9d4e0e7021becbce265fc2d6beb535149728063481a867c47a`, approved transplant integrity but requested the two documentation corrections recorded here. A fresh independent review of this documentation-only successor, PR creation, exact-head hosted macOS/Linux CI, merge, and final-main CI/acceptance remain pending under registrar ownership. No integration or milestone acceptance is claimed.

R1 proves schemas, codecs, fixtures and scripted contract traces. It does not implement or prove W2/P2 producer barriers and ordered queues, P3 local attempt fencing, runtime subscription allocation, replay retention, baseline capture, ACK/credit ledgers, live negotiation, UI mismatch presentation, real PTY behavior or real agent workloads. N1 remains separately owned and is not part of this candidate.
