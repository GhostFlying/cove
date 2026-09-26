# G0 evidence integration

Status: integrated candidate awaiting hosted gates, 2026-09-27. The original G0 candidate remains at `366c37debf55271de9f4e3ae3136f55b9fca2d1b` on `p/luchengxuan/m0-43-browser-graceful-close-evidence`. Its last source review (`/tmp/cove-m0-browser-graceful-close-last-delta-review/report.md`, SHA-256 `de36d44ead74e41ec6afae340f0d7961fe296b6165baa11b05e7daac5410c916`) and independent bounded negative validation (`/tmp/cove-m0-browser-graceful-close-native-verify/last-delta-report.md`, SHA-256 `444b19beb6fc903c268ca2ad61b7ce35138d65a87bd489af9277584a351c3ee2`) approved that source. This does not prove the cause of PR43's macOS browser-close timeout.

Integration owner: `/root/m0_t1_impl`, sole writer for the G0 source, CI gate and registration paths. This clean branch `p/luchengxuan/m0-43-browser-graceful-close-integration` begins at accepted N1 main `410e6f397b58440394667a4b1ba2c9f0f3e2a4e0` (tree `bcdceba2770ceaee7233a01854fb1f610245f6c0`). The N1 and original G0 refs remain intact. N1b work on primary is separate.

Transfer the nine original G0 commits in order without squashing or rewriting their source refs. For each replayed commit, record original and integrated SHA, parent, full commit-message equality, and changed-object equality; inspect any conflict before resolving it narrowly. The shared CI gate may have N1 additions, which must remain registered. Preserve G0's exact executed-test identities, legitimate multiple browser invocations, phase budget and final-snapshot checks. Do not change the accepted two-second graceful allowance or the t0+4.5/6/7-second caps, B0 defaults, renderer behavior, or N1 native proof.

After a clean source mapping, run one combined pinned Node 26.10/pnpm 12.6 `pnpm check` and capture numeric exit, suite inventory, browser cleanup artifacts and owned process/port cleanup. Freeze and send exact integrated source SHA for independent integration review. Only then create a draft PR and require exact-head macOS/Linux hosted artifacts. The previous G0 check at e7f17b1 and final targeted checks at 366 remain historical evidence; this integration requires its own full gate. Do not merge or claim PR43's browser-close root cause from diagnostic artifacts.

## Replay and author result, 2026-09-27

The nine original source commits replayed in order as:

| Original                                   | Integrated                                 |
| ------------------------------------------ | ------------------------------------------ |
| `fe2cd011b66d619f56e272c08cc05a3fca8b86bf` | `ef8dd781b37092e50a90cc84cbde3ab380acf8df` |
| `b39b336121012aa9faa2f390b2967b1091ce3f27` | `597847dfa56099294a92c9bbe0fea0b74fa24c14` |
| `870848263d5fab5a52c821239c99e940d578823b` | `f3083ed76dfc3995636ea14afe13fd0c8c5c7695` |
| `e97d87077ff707eeccd106cf0da0ca750545c0f1` | `ad3a6be98ae9cf3d6097383ee28368685dfa4929` |
| `96e121ee8be65e8fee1c532f77eb71542e90f3ed` | `fb0a38f35505a6154f8473cae0f9e922c0f18772` |
| `a2e029fbf2970672a2c53d082b0c781537feb059` | `b5c3c848996ade95f1ef0105c3e919e0382a1363` |
| `e7f17b1a6f4575732e9db2394b4802789022ce1f` | `f4a8e95bd585055e9ab1d96bed1c61e4fb3cccf4` |
| `62d7bf2a7e65a98303fde08cf07aacb9b22f824f` | `33c2df0343e4ccaaad825d81a751cefe735a8558` |
| `366c37debf55271de9f4e3ae3136f55b9fca2d1b` | `d93353a278e07b4fa75d28c78d45d89a785ed90d` |

Every pair has an identical full commit message and changed-path set. The original G0 plan and all three `terminal-web` source/test files have identical final Git objects. The sole cherry-pick conflict was the tooling-suite minimum: main410 had 28, and G0's first functional replay `597847d` added both new top-level tooling controls. The conflict resolution initially set the floor to 29; correction `a64115e` raised it to 30, matching all 30 actual tooling tests. The only final differences from G0's original shared gate and tooling test are N1's six accepted `terminal-worker` suite registrations and their disappearance control; none was removed or reduced.

Pinned offline frozen install exited 0; log `/tmp/cove-m0-g0-integrated-install.log` SHA-256 `40deefde6320fcd2f11e98a658b8e961f3b94a1103f74848863209793dd1bd03`. At integrated source `d93353a`, one `pnpm check` exited 0: native prepare, format, lint, TypeScript/browser builds, required suite discovery and 37/37 test files, 310/310 tests. Full log `/tmp/cove-m0-g0-integrated-check.log` SHA-256 `a61cf77e77ccf5602bc7adb30f911b2c98878a4cfffc399c8b981ff0b9b4ffb7`; the gate produced 26 browser-cleanup JSON records and passed its identity/evidence validator. This is author evidence; independent integration review, hosted macOS/Linux and final-main checks remain pending. The file-count difference from earlier G0 checks includes accepted N1 worker suites; it is not a rewritten earlier result.

## Bounded integration correction plan

Independent integration review of `d93353a` (`/tmp/cove-m0-browser-graceful-close-integration-review/report.md`, SHA-256 `83ee0d45de5ae065d84073dbc6186a16b24bf02cd5f203ed4ae057a2b290d841`) found that the tooling suite has 30 actual tests but its minimum is 29. Commit `a64115e023d87b8613be4d3c3ad07611dedde986` raised the floor to 30 and now proves that all 30 pass while removing any one fails the gate. Its focused tooling suite passed 30/30; `/tmp/cove-m0-g0-integration-floor.log` SHA-256 `8a006f66210edfb9f009e1bd9ff30a39ea51994d64564e23e71fa928112d8187`. Independent source delta review approved the change (`/tmp/cove-m0-browser-graceful-close-integration-floor-review/report.md`, SHA-256 `d0b50287cec925fa7a399a8089c11f03f53f5dc12182f1ac1355d2de281e5e7f`). The 37/310 full check above remains evidence for `d93353a`, not a claimed check of the corrected SHA.

Independent combined verification of exact code head `a64115e` exited 0 under pinned Node 26.10/pnpm 12.6/ABI 147 on macOS in 199.047 seconds: all four CI stages passed, 37/37 suites and 310/310 tests passed with zero failed/pending/todo. Its 30-case tooling floor accepted 30 and rejected 29. All 22 executed V1 test identities corresponded to 25 final browser invocation records, including three distinct V1-L6 invocations; the verifier directly observed ESRCH for all 25 recorded browser PIDs and refused connections for their 25 listener ports. It separately confirmed the source-built N1 native patch/binary and absence of recorded smoke child/helper processes. This is the bounded local report `/tmp/cove-m0-browser-graceful-close-integration-verify/report.md`, SHA-256 `b14b33a21991f367f6bd3fe573a33c0d42ed0152ca5c1a403fb9d6833b71de1c`. Hosted checks and final-main verification remain pending; the independent run does not diagnose the older PR43 timeout.
