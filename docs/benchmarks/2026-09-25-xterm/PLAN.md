# xterm/headless capacity probe on devbox

Purpose: evaluate 100 concurrently producing terminal models on the intended Linux host before selecting the server runtime. This is a synthetic parser/memory probe, not proof of full Cove capacity or real-agent throughput.

1. Record host CPU, RAM, current load, Node version and effective CPU availability.
2. Use an isolated remote temporary directory and pinned xterm packages, without changing existing services or repositories.
3. Feed 100 headless terminals with two profiles: colored scrolling text with CJK, and alternate-screen cursor-addressed redraws. Compare 1 and 4 Node processes at 50 and 250 KiB/s per terminal, over 5 seconds per case. Bound pending input and total execution time.
4. Record completed throughput, CPU core equivalents, write completion latency, event-loop delay, RSS, and serialization cost. Record target versus achieved load; do not infer user-input or rendered latency from parser timing.
5. Measure filled history separately. Retain the harness, exact dependency versions, raw results and interpretation. Terminate only benchmark-owned processes; verify cleanup.
6. Exclusions: real PTYs/agents, WebSocket/Tailscale, client rendering, disk persistence and end-to-end recovery correctness. These require a later integrated capacity test.

Follow-up after the first pass: repeat the standard cases once to expose shared-host variance; add 1 MiB/s per terminal stress cases to check where target rate stops being met. Run cases serially across experiments so they do not compete with each other.
