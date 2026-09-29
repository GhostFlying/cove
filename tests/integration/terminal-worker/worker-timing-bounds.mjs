export const TIMING_CYCLES = 4;
export const TIMING_EXCHANGES = 8;
export const FIFO_REQUESTS_PER_CYCLE = 320;
const UUID_BYTES = 36;

export const MAX_TIMING_OUTPUT_BYTES =
  TIMING_CYCLES *
  Array.from({ length: TIMING_EXCHANGES }, (_, index) =>
    Buffer.byteLength(`OUT:${"x".repeat(UUID_BYTES)}:${index}\n`),
  ).reduce((sum, bytes) => sum + bytes, 0);

// One native callback per emitted byte, one write per encoded FIFO response frame.
export const MAX_TIMING_TRACE_POINTS =
  2 *
  (MAX_TIMING_OUTPUT_BYTES +
    TIMING_CYCLES * TIMING_EXCHANGES +
    TIMING_CYCLES +
    TIMING_CYCLES * FIFO_REQUESTS_PER_CYCLE);
