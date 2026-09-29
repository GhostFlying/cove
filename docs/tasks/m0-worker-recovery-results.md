# W2 worker recovery author result

The source branch starts at accepted W1 `8707a760d45643e855178a19e43d442bbddac51b`. The implementation is limited to the granted engine model/preview seams, worker modules and tests. The registrar still owns package registration, shared documentation and final composition.

## Source checkpoints

- A/B atom `03fd8fcf0dd6f6deeddbc35527337ac448604dc4`: bounded replay and per-route retention, ordered public baseline capture with exact pre-copy reservation, subscription ACK/credit/fence and endpoint marker/physical FIFO accounting. The temporary C wiring was removed before this commit; its standalone scoped build and four-file author run passed (84 runtime tests).
- C atom adds the preview service and public worker wiring. Preview holds its final-result reservation through complete start/chunk/end admission before the result, preserves the active slot and lease through a timed-out model promise, and fences shutdown/reentrant delivery. A capture throw/rejection returns a correlated unavailable result. One slow route is explicitly tested against a healthy peer.

## Bounded author checks

The final scoped worker `tsc -b` succeeded. Six explicit engine/worker test files passed with 96 runtime cases. Direct `test(` declarations total 88; the existing parameterized declarations expand to eight further runtime cases. The W1 worker execution and pipe endpoint files are included. The W1 256 KiB, two-run pressure budget and byte/cleanup assertions remain in place after public subscription-ready setup migration. The limited touched-file Prettier check, oxlint with denied warnings, and `git diff --check` passed. Raw results, earlier failing counterexamples, and the offline frozen, ignore-scripts workspace dependency repair are in the off-tree W2 implementation evidence directory.

These checks use fake native adapters and in-memory streams only. They do not establish real PTY, OS-pipe, installed-bin, browser, full suite, CI, or composed-main qualification. The independent source reviewer, consumer finite QA, registrar integration and subsequent gates remain required.
