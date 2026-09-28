# W1b corrected qualification matrix (pre-execution)

| Row                                  | Inherited evidence                                                            | Required new oracle                                                                                    | Disposition   |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| Public delivery/declarations         | Prior 1-file installed link/bin/ESM and v2 ready/EOF                          | Recheck scoped compiled delivery if dependency changed                                                 | Pending       |
| Canonical real command/bytes         | Prior accepted command/input/query/window/status/exit; emitted output missing | Child nonce/PID-bound emitted bytes and parent public parsed bytes/digest agree                        | Pending       |
| Item backpressure/fairness           | Prior 768 KiB fault at 256 items; 192 KiB retake below boundary               | Fixed >256 KiB two-PTY workload, actual native item pause/resume, exact bytes and peer progress        | Pending       |
| Stream failure                       | Prior real EPIPE uncaught stack incorrectly passed                            | Real installed-bin handled reason, completed disposal diagnostic, no uncaught stack, physical PTY exit | Pending       |
| Physical stdout stall                | Prior PassThrough pause showed no blocked bytes                               | OS pipe held open with writer retained/blocked, then drain FIFO exact replies                          | Pending       |
| EOF/SIGTERM/parent loss/forced death | Prior finite real qualification exact fixture blobs                           | Retain if unchanged; audit dependent source changes before reuse                                       | Pending audit |
| Compiled fake controls               | Author 101 scoped assertions at source H; not independent                     | Small causal P1/P2 fake drivers through compiled public seams                                          | Pending       |

No coherent full, browser, hosted CI, devbox or shared suite registration is in this tester allocation.

## Source gate at initial corrected candidate

Formal source review at H `f4df4eb25adaed9fdd32390bd92adfc0ad067e49` is **CHANGES_REQUESTED**: callback-error shutdown retains one 423-byte transport frame after actual Writable close. The independent compiled fake diagnostic reproduces public snapshot `closed` with `responseItems=1`, `transportBytes=423`, `ordinaryAccountedBytes=423`; its strict retirement assertion fails. Therefore every real/native and physical OS-pipe row remains unexecuted at this source. Prepared fixtures below are not evidence of passing real behavior. The source correction and renewed formal approval must precede retakes.

## r2 source and tester allocation

At corrected source H `8ae8fc513401e978443bada0d14adc9ea5d219ba` / T `54ae4dcafd48d984cd786308248d69f099bee310`, formal independent source rereview is APPROVED. The unchanged strict 423-byte finite assertion passes; held-open and late-callback controls pass after the fixture waits for actual `close` event rather than the Writable `closed` property alone. The first timing failure remains raw evidence.

Affected real canonical and installed-bin EPIPE cases pass with nonce/PID emission receipt and handled `stdout-write-failed`/complete disposal diagnostic. A 768 KiB two-PTY pressure run crosses the former 256 small-callback boundary, observes three native pause/resume cycles at 192/64 items, exact child-emission/public-parsed digest, peer progress and closure-proven cleanup. No broader throughput or 100-PTY claim follows.

The distinct OS-pipe stall/drain row remains **open**. Attempts with 200 requests did not fill the real pipe; 320 unpaced requests closed the endpoint after reservation pressure; 320 in two 160-request waves did positively observe an actual held-open reader and `blocked=true` with retained transport. Its probe was admitted into a queued response while transport dequeue stayed stopped. The fixture mistakenly asserted no request admission and stopped before releasing the reader, so drain/FIFO was not verified. All three failure receipts remain off-tree; the corrected transport-dequeue assertion is prepared but unexecuted, and this branch is not a passing qualification.
