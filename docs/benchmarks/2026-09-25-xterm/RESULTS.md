# devbox: 100 concurrent xterm/headless models

Measured 2026-09-25 Asia/Singapore (raw timestamps are UTC on September 24).

## Scope and method

This is a synthetic headless parser probe, not a 100-PTY/100-agent or end-to-end Cove benchmark. No real PTYs, agents, WebSocket/Tailscale traffic, client rendering, persistence, or full reconnect correctness were exercised. The result does not establish a production capacity guarantee.

- Host: Intel Xeon Platinum 8260 @ 2.40 GHz, 32 available logical CPUs, 64,145.9 MiB RAM; Node v22.16.0. Effective CPU quota was unlimited through the observed cgroup ancestry.
- Shared host: initial 1-second sample showed 69.3% idle CPU. Load averages were roughly 17–21 during tests. No workloads were stopped and no CPU affinity was imposed.
- Dependencies: `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`; exact artifact integrity in package-lock.json. Installed in a fresh temporary directory with lifecycle scripts disabled.
- 100 models, 120 columns × 40 rows. 1,000 scrollback rows except the history case. One process hosts 100 models; four processes host 25 each.
- Append profile: repeated colored text including CJK with CRLF, fills history. Redraw profile: alternate screen, cursor-addressed row replacement; no growing normal history. These are repetitive synthetic inputs, not recorded agent traces.
- Each case schedules 100 batches at 50 ms intervals (5 seconds of intended production). Payloads round up to complete VT/text units, so byte rates differ slightly from labels. Standard cases ran twice, serially; history and stress cases ran once.
- Each process produces its own input. CPU starvation delays the synthetic producer as well as parsing. Achieved throughput includes that delay; parse-callback latency alone does not show missed source scheduling deadlines. This is not an external open-loop load generator.
- A per-terminal 1 MiB pending-input guard and process timeouts bound each case. Every case finished without hitting these guards. The standard and stress probes are short, not sustained-load tests.

## Standard cases

Ranges are the two independent passes, not confidence intervals. CPU is process user+system CPU divided by elapsed wall time, summed across shards; it includes runtime helper/GC threads and can exceed one core even for a single process.

| Profile | Target KiB/s per terminal | Processes | Achieved MiB/s | Parse callback p95 ms | Parse callback p99 ms | CPU core equivalents | Sum of peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| append | 50 | 1 | 5.04–5.04 | 15.10–15.46 | 25.22–26.96 | 0.47–0.49 | 297.88–301.01 |
| append | 50 | 4 | 5.03–5.04 | 5.88–9.13 | 13.94–30.63 | 0.67–0.81 | 462.07–464.82 |
| append | 250 | 1 | 23.32–24.55 | 48.18–58.43 | 66.80–84.74 | 1.23–1.34 | 337.62–339.16 |
| append | 250 | 4 | 24.55–24.55 | 15.36–16.62 | 29.34–36.19 | 1.36–1.46 | 534.53–536.82 |
| redraw | 50 | 1 | 4.98–4.98 | 12.69–13.31 | 16.10–16.64 | 0.27–0.30 | 103.82–103.85 |
| redraw | 50 | 4 | 4.97–4.98 | 4.51–5.01 | 7.04–16.25 | 0.39–0.45 | 262.55–263.05 |
| redraw | 250 | 1 | 24.34–24.46 | 45.98–51.94 | 59.43–61.80 | 0.89–0.95 | 114.55–114.72 |
| redraw | 250 | 4 | 24.46–24.46 | 15.30–15.54 | 22.17–23.35 | 1.11–1.17 | 270.46–270.92 |

Parse latency runs from `terminal.write()` to its completion callback; it is not keystroke-to-screen latency. Event-loop measurements and maxima are in the raw files. RSS is the sum of each shard's sampled peak before serialization (plus the final memory reading), not simultaneous PSS; shared pages can be counted more than once. The coordinator, agents, transport and clients are excluded. Explicit GC occurs before and after the load, outside the timed throughput interval.

## Stress: target 1 MiB/s per terminal, about 100 MiB/s aggregate

| Processes | Input completed | Elapsed | Achieved | Parse p95 | CPU cores | Sum peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 500.39 MiB | 16.80 s | 29.79 MiB/s | 179.10 ms | 1.25 | 364.48 MiB |
| 4 | 500.39 MiB | 5.14 s | 97.36 MiB/s | 52.24 ms | 3.93 | 559.17 MiB |

Neither completed within the exact 5-second target; the single-process case clearly fails to sustain the offered schedule. The four-process case is close but not evidence of a safe 100 MiB/s production budget, especially once real I/O and IPC are added.

## History and serialization

Four processes, 100 models, 5,000 history rows, target 500 KiB/s each: 48.88 MiB/s achieved, 3.45 CPU core equivalents, sum peak RSS 1,451.27 MiB, parse p95 31.19 ms. All normal buffers reached 5,040 rows.

After output drained, serialize was called synchronously for each terminal, sequentially within each shard. The 5,000-row case generated 52.86 MiB of VT recovery data for 100 terminals. Per-terminal serialize p95 was 252.48 ms; the sum of individual call durations was 13.43 seconds across the four processes. This is not CPU time and not the wall time of the whole parallel batch. The raw field `snapshotTotalCpuWallMs` holds this sum despite its imprecise name.

The 1,000-row append cases produced 10.90 MiB of recovery data across 100 terminals, with per-terminal serialize p95 around 18–28 ms. The history case also had a higher input rate than standard cases, so the RSS difference is not a controlled history-only causal estimate. It does show the footprint of that concrete filled-history workload.

## Implications for Cove

1. 100 frequently producing terminals is a mandatory target, not a justification to place 100 parsers on the control process event loop. Separate domain/API control from parsing and serialization.
2. A Node control server remains plausible. Start evaluation with a bounded pool of terminal subprocesses, each owning PTYs and headless models for a shard. Four processes are a measured candidate, not a frozen default or capacity limit. Avoid one process per terminal.
3. Go control + the same Node terminal pool pays similar parser costs. Changing only the control language does not remove the measured bottleneck. A/B should now compare control/transport/IPC costs and operations rather than assume parser performance changes.
4. Enforce per-terminal and global history/queue budgets. Serialize only on demand; throttle reconnect bursts. Synchronous serialization of long history must not stall the control process. Cold history storage and recovery limits need separate design.
5. A slow client must fall behind into an explicit resync state without stopping all PTYs. Actual host overload still requires bounded backpressure to producers; VT bytes cannot be silently discarded while claiming valid terminal state.
6. These subprocesses remain part of the server lifecycle, not independent PTY keepers. Restart impact remains explicit. `node-pty` is not worker-thread-safe; do not distribute instances across JS worker threads casually.
7. Before claiming the target, test real PTYs plus recorded agent workloads, hot/cold skew, concurrent transfer, reconnect/resize bursts, long runs, and target mobile renderers. Account separately for CPU/RAM of the 100 agent processes themselves.

## Reproduction and artifacts

In an isolated directory with the recorded dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
timeout --signal=TERM --kill-after=5s 120s node headless-probe.cjs
timeout --signal=TERM --kill-after=5s 45s node headless-probe.cjs history
timeout --signal=TERM --kill-after=5s 90s node headless-probe.cjs stress
```

Files: headless-probe.cjs, package.json, package-lock.json, environment.json, standard.ndjson, repeat.ndjson, history.ndjson, stress.ndjson. Remote benchmark processes were checked after execution; results copied to this directory. No application services were changed.

References: [xterm flow control](https://xtermjs.org/docs/guides/flowcontrol/), [node-pty thread safety](https://github.com/microsoft/node-pty#thread-safety).
