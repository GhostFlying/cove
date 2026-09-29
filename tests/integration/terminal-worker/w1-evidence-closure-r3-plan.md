# W1 timing finalizer correction plan

Owner: original Sol fixture author. Base H `9f3d5e0773f0e10a8987cb7446e8afbacbc0a460`, T `af303b8102f8872e81ed44567876593e514ed650`, clean recovery checkout on `p/luchengxuan/m0-16-worker-evidence-closure`. The independent r2 source review is CHANGES_REQUESTED at report SHA256 `ad1035d8e7a2610447936eac2a4202c489bf04f17a54688571c7c370f635e30b` and manifest SHA256 `ae971f13cc16f6be7bdd181791920d1640ab1b442e58c82fc6c04d7d3a6742d8`.

Objective: close only the remaining F4 outer-finalizer failure paths. Preserve r1/r2 commits and evidence. F1-F3, shared submit/shutdown wrappers, A/B fixtures, production, package/lock/build/CI and shared registration remain unchanged.

Writable scope: this plan, `worker-timing.test.mjs`, and one narrowly named timing finalizer support file under `tests/integration/terminal-worker/`. The PTY and FIFO outer summaries must each attempt evidence preservation and installed-delivery cleanup independently. The FIFO per-cycle finalizer must retain its directory on a failed evidence write, retain the original cycle cause, and try directory removal only after a clean preservation; directory-removal errors must join the result. All accumulated errors preserve primary-then-finalizer causal order.

Use one timing-specific finalizer function in all three real paths. A controlled oracle calls this same function with throwing evidence/cleanup actions and checks attempt order, unchanged primary object position, aggregated secondary errors, and directory-retention behavior. This is source-only: do not run the oracle in this allocation.

Validation: pinned Prettier, Oxlint, syntax and Git diff checks only. No fixture tests, compile/build, native/PTY/FIFO, installation, browser, full gate, CI or devbox. Append one atomic correction commit with the plan and controlled oracle, then freeze a new off-tree author report/manifest and release the recovery writer lease for independent source rereview.
