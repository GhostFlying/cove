#!/usr/bin/env node
// D6 latency probe (docs/milestones/m1.md D6). Run separately on a quiet machine, after
// `pnpm build`; it is not a Vitest suite and is not part of `pnpm test` or the CI gate:
//
//   node apps/cli/tests/m1/d6-latency-probe.mjs [--phase-seconds 30] [--rounds 3] [--out FILE]
//   node apps/cli/tests/m1/d6-latency-probe.mjs --reanalyze FILE   (verdict from saved raw data)
//
// Keep the host awake and otherwise idle (e.g. under `caffeinate -i` on macOS): a phase in which
// the probe or the server stalled as a whole (host sleep) is reported as disturbed, which makes the
// verdict UNRESOLVED.
//
// It starts the compiled server through the compiled CLI on a temporary data directory, with
// COVE_D6_PROBE_DIR set so the server records the synchronous interval of every store transaction,
// samples its event-loop delay and accepts the control-mode switch (apps/server/src/entry/d6-probe.ts).
//
// Bounded workload: 8 terminals each print 64 KiB/s from a fixed script, all subscribed by one
// client; another client sends one keystroke every 50 ms to a terminal whose line discipline echoes
// it and measures the round trip; in write phases a third client sends 20 complete `config.set`
// operations per second. Each round runs three 30 s phases: no writes; writes on SQLite; control
// writes (the same RPC, validation, receipt and response path, with receipts and configuration in
// memory). The probe prints its verdict and writes all raw measurements to --out.
//
// Verdict (D6): B (move the database off the main thread) when the delayed echoes (above the same
// round's no-write p99) concentrate in round trips that overlap a transaction, or when the write
// phases' latency is higher than the control phases' in every round. A only when neither holds and
// both write phases match the no-write phase in every round. Anything else, or any disturbed or
// incomplete measurement, is UNRESOLVED and needs a rerun or an investigation; it is not a
// confirmation of A.
//
// Concentration is tested against the control: a delayed round trip is long and overlaps one of
// the 20 writes per second almost regardless of its cause. Delayed echoes concentrate around SQLite
// transactions when (1) in the write phases they are delayed more often when they overlap a
// transaction than when they do not, and (2) round trips overlapping a transaction are delayed more
// often than round trips in the control phases overlapping an in-memory write, which runs at the
// same moment of the same request without SQLite. Raw data without control write intervals is
// judged by (1) alone and says so.

import { spawnSync } from "node:child_process";
import { cpus, release, totalmem } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_APPEARANCE } from "@cove/protocol/profile";
import { createSessionClient } from "../../dist/session.js";
import { createM1Fixture } from "./fixtures.mjs";

const TERMINALS = 8;
// Output terminals with a subscribed client. The M0 worker pipe admits at most
// PIPE_ROUTE_CONTROL_COMMANDS (4) progress commands at once across all subscriptions of a worker,
// and the client fails a subscription whose ACK is refused with BUSY; with one worker per server,
// more than four continuously streaming subscriptions (here 8 outputs plus the echo terminal) make
// subscriptions fail within seconds. Three subscribed outputs plus the echo terminal stay within
// the bound; the other five terminals still print through the worker without WebSocket delivery.
const SUBSCRIBED_OUTPUTS = 3;
const OUTPUT_BYTES_PER_SECOND = 64 * 1024;
const KEY_INTERVAL_MS = 50;
const WRITES_PER_SECOND = 20;
const ECHO_TIMEOUT_MS = 5_000;
// A shift counts as a difference only when it is both significant (p < ALPHA) and at least this
// large, so that a sub-millisecond shift found by a large sample is not read as blocking.
const ALPHA = 0.01;
const MIN_P50_SHIFT_MS = 0.5;
const MIN_P99_SHIFT_MS = 2;
// Concentration: delayed echoes are at least this many times as frequent among round trips that
// overlap a transaction as among those that do not (one-sided Fisher p < ALPHA, at least 3).
const CONCENTRATION_RATIO = 2;
// Transactions at least this long are listed individually with the echoes around them.
const LONG_TRANSACTION_MS = 2;

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function options(argv) {
  const values = { phaseSeconds: 30, rounds: 3, out: undefined, reanalyze: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (name === "--phase-seconds") values.phaseSeconds = Number(value);
    else if (name === "--rounds") values.rounds = Number(value);
    else if (name === "--out") values.out = resolve(value);
    else if (name === "--reanalyze") values.reanalyze = resolve(value);
    else throw new Error(`unknown option ${name}`);
  }
  if (!(values.phaseSeconds > 0) || !Number.isInteger(values.rounds) || values.rounds < 1)
    throw new Error("--phase-seconds and --rounds must be positive");
  return values;
}

// ---- statistics -----------------------------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
  };
}

function normalUpper(z) {
  // Upper tail of the standard normal (Abramowitz–Stegun 7.1.26 via erfc).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc =
    t *
    Math.exp(-x * x) *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

// Mann–Whitney U with tie correction (normal approximation); p that `a` is stochastically greater.
function mannWhitneyGreater(a, b) {
  const all = [...a.map((value) => [value, 0]), ...b.map((value) => [value, 1])].sort(
    (x, y) => x[0] - y[0],
  );
  const ranks = new Array(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const rank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    i = j + 1;
  }
  let rankSum = 0;
  for (let i = 0; i < all.length; i++) if (all[i][1] === 0) rankSum += ranks[i];
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return 1;
  const u = rankSum - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const variance = ((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1)));
  if (variance <= 0) return 1;
  return normalUpper((u - (n1 * n2) / 2 - 0.5) / Math.sqrt(variance));
}

function logFactorial(n) {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

// One-sided Fisher exact p that cell `a` of [[a, b], [c, d]] is at least as large as observed.
function fisherGreater(a, b, c, d) {
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  const fixed =
    logFactorial(row1) +
    logFactorial(n - row1) +
    logFactorial(col1) +
    logFactorial(n - col1) -
    logFactorial(n);
  let p = 0;
  for (let x = a; x <= Math.min(row1, col1); x++)
    p += Math.exp(
      fixed -
        logFactorial(x) -
        logFactorial(row1 - x) -
        logFactorial(col1 - x) -
        logFactorial(n - row1 - col1 + x),
    );
  return Math.min(1, p);
}

// Whether `a` is higher than `b` by a significant and material amount.
function higher(a, b) {
  const da = describe(a);
  const db = describe(b);
  const p = mannWhitneyGreater(a, b);
  return {
    p,
    p50Shift: da.p50 - db.p50,
    p99Shift: da.p99 - db.p99,
    different:
      p < ALPHA && (da.p50 - db.p50 >= MIN_P50_SHIFT_MS || da.p99 - db.p99 >= MIN_P99_SHIFT_MS),
  };
}

function differs(a, b) {
  const up = higher(a, b);
  const down = higher(b, a);
  return { higher: up, lower: down, different: up.different || down.different };
}

// ---- workload -------------------------------------------------------------------------------

function discardView(counter) {
  const subscribe = () => () => ({ dispose() {} });
  return {
    async initialize() {},
    async beginBaseline() {},
    async writeBaselineChunk() {},
    async finishBaseline() {},
    async applyEvent(_event, payload) {
      if (payload) counter.bytes += payload.byteLength;
    },
    measureGrid: () => ({ cols: 120, rows: 40 }),
    setAppearance() {},
    setVisibility() {},
    onInputIntent: subscribe(),
    onFocusIntent: subscribe(),
    onFailure: subscribe(),
    dispose() {},
  };
}

// Kernel-echoed keystrokes come back in order; each echoed letter settles the oldest pending key.
function echoView(echo) {
  const view = discardView({ bytes: 0 });
  view.applyEvent = async (_event, payload) => {
    if (!payload) return;
    const at = now();
    for (const byte of payload) {
      if (byte < 0x61 || byte > 0x7a) continue;
      const key = echo.pending.shift();
      if (!key) {
        echo.unmatched++;
        continue;
      }
      if (key.byte !== byte) echo.mismatched++;
      key.receivedAt = at;
    }
  };
  return view;
}

const OUTPUT_SCRIPT = `
const chunkBytes = Math.round(${OUTPUT_BYTES_PER_SECOND} / 20);
const line = "x".repeat(62) + "\\n";
const chunk = line.repeat(Math.ceil(chunkBytes / line.length)).slice(0, chunkBytes - 1) + "\\n";
const started = Date.now();
let sent = 0;
// Paced against the wall clock so that a late timer catches up instead of drifting.
setInterval(() => {
  const due = Math.floor(((Date.now() - started) / 1000) * ${OUTPUT_BYTES_PER_SECOND});
  while (sent + chunk.length <= due) {
    process.stdout.write(chunk);
    sent += chunk.length;
  }
}, 10);
`;

async function main() {
  const config = options(process.argv.slice(2));
  if (config.reanalyze) {
    const saved = JSON.parse(await readFile(config.reanalyze, "utf8"));
    const raw = saved.raw;
    const report = analyze({
      config: raw.config ?? { phaseSeconds: 30, rounds: 3 },
      phases: raw.phases,
      echo: {
        keys: raw.keys,
        mismatched: raw.mismatched ?? saved.report.echoes.mismatched,
        unmatched: raw.unmatched ?? saved.report.echoes.unmatched,
      },
      writes: raw.writes,
      serverDump: raw.server,
      unavailable: raw.unavailable ?? saved.report.unavailableSubscriptions,
    });
    report.environment = saved.report.environment;
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const fixture = await createM1Fixture();
  const clients = [];
  let server;
  try {
    const probeDirectory = join(fixture.root, "probe");
    await mkdir(probeDirectory);
    fixture.env.COVE_D6_PROBE_DIR = probeDirectory;
    const script = join(fixture.root, "output.cjs");
    await writeFile(script, OUTPUT_SCRIPT);
    const home = fixture.home("home");
    server = await fixture.startServer(home);
    const create = async (command) =>
      fixture.coveJson(
        [
          "terminal",
          "create",
          "--cwd",
          fixture.root,
          "--cols",
          "120",
          "--rows",
          "40",
          "--",
          ...command,
        ],
        { home },
      );

    const connect = async () => {
      const client = createSessionClient(server.record);
      clients.push(client);
      const connected = await client.connect();
      if (!connected.ok) throw new Error(`connect failed: ${JSON.stringify(connected.error)}`);
      return client;
    };
    const watcher = await connect();
    const typist = await connect();
    const writer = await connect();

    const output = { bytes: 0 };
    const watched = [];
    for (let i = 0; i < TERMINALS; i++) {
      const run = await create([process.execPath, script]);
      if (i >= SUBSCRIBED_OUTPUTS) continue;
      const opened = watcher.openTerminal({
        run,
        viewId: `output-${i}`,
        view: discardView(output),
        initialAppearance: DEFAULT_APPEARANCE,
      });
      if (!opened.ok) throw new Error("open output terminal failed");
      const attached = await opened.value.attach();
      if (!attached.ok) throw new Error("attach output terminal failed");
      watched.push(opened.value);
    }
    const echo = { pending: [], keys: [], unmatched: 0, mismatched: 0 };
    const echoRun = await create(["/bin/sh", "-c", "stty -icanon; exec cat > /dev/null"]);
    const opened = typist.openTerminal({
      run: echoRun,
      viewId: "echo",
      view: echoView(echo),
      initialAppearance: DEFAULT_APPEARANCE,
    });
    if (!opened.ok) throw new Error("open echo terminal failed");
    const controller = opened.value;
    if (!(await controller.attach()).ok) throw new Error("attach echo terminal failed");
    controller.setInputTarget(true, true);
    if (!(await controller.requestFocus()).ok) throw new Error("focus echo terminal failed");

    // Typing runs for the whole measurement; each key is labelled by the phase it was sent in.
    let phase = null;
    let typing = true;
    let letter = 0;
    const typingDone = (async () => {
      let next = now();
      while (typing) {
        const byte = 0x61 + (letter++ % 26);
        const key = { byte, sentAt: now(), receivedAt: null, phase, refused: false };
        echo.pending.push(key);
        echo.keys.push(key);
        const sent = await controller.sendInput({ source: "keyboard", bytes: Uint8Array.of(byte) });
        if (!sent.ok || sent.value.unknownBytes !== 0 || sent.value.notSentBytes !== 0) {
          key.refused = sent.ok ? sent.value : sent.error;
          echo.pending.splice(echo.pending.indexOf(key), 1);
        }
        next += KEY_INTERVAL_MS;
        await sleep(Math.max(0, next - now()));
      }
    })();

    const writes = [];
    let writeSeq = 0;
    const writePhase = async (label, until) => {
      const pendingWrites = [];
      let next = now();
      while (now() < until) {
        const operationId = `d6-${label}-${writeSeq++}`;
        const entry = { phase: label, sentAt: now(), doneAt: null, state: null };
        writes.push(entry);
        pendingWrites.push(
          writer
            .call("config.set", {
              operationId,
              patch: { workspaceRoot: join(fixture.root, `workspaces-${writeSeq % 2}`) },
            })
            .then((outcome) => {
              entry.doneAt = now();
              entry.state = outcome.ok ? outcome.value.operation.state : `error:${outcome.kind}`;
            }),
        );
        next += 1000 / WRITES_PER_SECOND;
        await sleep(Math.max(0, next - now()));
      }
      await Promise.all(pendingWrites);
    };

    // Warm up the paths and let the output terminals reach their steady rate.
    await sleep(3_000);
    const phases = [];
    for (let round = 1; round <= config.rounds; round++) {
      for (const kind of ["none", "write", "control"]) {
        process.kill(server.pid, kind === "control" ? "SIGUSR2" : "SIGUSR1");
        await sleep(500);
        const label = `${round}-${kind}`;
        const bytesBefore = output.bytes;
        const start = now();
        const end = start + config.phaseSeconds * 1000;
        phase = label;
        if (kind === "none") await sleep(end - now());
        else await writePhase(label, end);
        phase = null;
        phases.push({
          label,
          round,
          kind,
          start,
          end: now(),
          outputBytes: output.bytes - bytesBefore,
        });
      }
    }
    process.kill(server.pid, "SIGUSR1");
    typing = false;
    await typingDone;
    await sleep(ECHO_TIMEOUT_MS);

    // Every subscription must have stayed ready through the measurement.
    const unavailable = [controller, ...watched]
      .map((terminal) => terminal.snapshot().phase)
      .filter((value) => value !== "ready").length;
    for (const client of clients.splice(0)) client.dispose();
    await fixture.stopServer(server);
    const serverDump = JSON.parse(
      await readFile(join(probeDirectory, `server-${server.pid}.json`), "utf8"),
    );
    const report = analyze({ config, phases, echo, writes, serverDump, unavailable });
    report.environment = environment();
    const out = config.out ?? join(process.cwd(), `d6-probe-${process.pid}.json`);
    await writeFile(
      out,
      JSON.stringify(
        {
          report,
          raw: {
            config: { phaseSeconds: config.phaseSeconds, rounds: config.rounds },
            mismatched: echo.mismatched,
            unmatched: echo.unmatched,
            unavailable,
            phases,
            keys: echo.keys,
            writes,
            server: serverDump,
          },
        },
        null,
        1,
      ),
    );
    console.log(JSON.stringify(report, null, 2));
    console.log(`raw measurements: ${out}`);
  } finally {
    for (const client of clients) client.dispose();
    await fixture.cleanup();
  }
}

function environment() {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  });
  return {
    revision: git.stdout.trim() || null,
    dirty: dirty.stdout.trim() !== "",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
  };
}

function intervals(flat) {
  const list = [];
  for (let i = 0; i < flat.length; i += 2) list.push([flat[i], flat[i + 1]]);
  return list.sort((a, b) => a[0] - b[0]);
}

// Whether [start, end] intersects an interval of the sorted, non-overlapping list.
function overlapsAny(list, start, end) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid][1] < start) low = mid + 1;
    else high = mid;
  }
  return low < list.length && list[low][0] <= end;
}

// Delayed echoes (above the threshold) against round trips that overlap an interval of `list`.
function concentration(entries, threshold, list) {
  const table = { delayedOverlap: 0, delayedClear: 0, onTimeOverlap: 0, onTimeClear: 0 };
  for (const { latency, sentAt, receivedAt } of entries) {
    const overlap = overlapsAny(list, sentAt, receivedAt);
    table[
      latency > threshold
        ? overlap
          ? "delayedOverlap"
          : "delayedClear"
        : overlap
          ? "onTimeOverlap"
          : "onTimeClear"
    ]++;
  }
  return table;
}

function concentrationTest(table) {
  const { delayedOverlap: a, delayedClear: b, onTimeOverlap: c, onTimeClear: d } = table;
  const overlapRate = a + c > 0 ? a / (a + c) : 0;
  const clearRate = b + d > 0 ? b / (b + d) : 0;
  const fisherP = fisherGreater(a, b, c, d);
  return {
    ...table,
    delayedRateOverlapping: overlapRate,
    delayedRateClear: clearRate,
    fisherP,
    significant:
      a >= 3 &&
      fisherP < ALPHA &&
      (clearRate === 0 ? overlapRate > 0 : overlapRate / clearRate >= CONCENTRATION_RATIO),
  };
}

function analyze({ config, phases, echo, writes, serverDump, unavailable }) {
  const transactions = intervals(serverDump.transactions);
  // The control phase's writes, timed the same way without SQLite (absent from older raw data).
  const memoryWrites = serverDump.memoryWrites ? intervals(serverDump.memoryWrites) : null;
  const overlaps = (start, end) => overlapsAny(transactions, start, end);
  const samples = [];
  for (let i = 0; i < serverDump.samples.length; i += 3)
    samples.push({
      at: serverDump.samples[i],
      max: serverDump.samples[i + 1],
      p99: serverDump.samples[i + 2],
    });

  const byPhase = new Map(phases.map((phase) => [phase.label, phase]));
  const latencies = new Map(phases.map((phase) => [phase.label, []]));
  const echoes = new Map(phases.map((phase) => [phase.label, []]));
  let lost = 0;
  let refused = 0;
  for (const key of echo.keys) {
    if (!key.phase) continue;
    if (key.refused) {
      refused++;
      continue;
    }
    if (key.receivedAt === null) {
      lost++;
      continue;
    }
    const latency = key.receivedAt - key.sentAt;
    latencies.get(key.phase).push(latency);
    echoes.get(key.phase).push({
      latency,
      sentAt: key.sentAt,
      receivedAt: key.receivedAt,
      overlap: overlaps(key.sentAt, key.receivedAt),
    });
  }

  const rounds = [];
  const writeTables = [];
  const controlTables = [];
  let persistentlyHigher = true;
  let writesMatchNone = true;
  for (let round = 1; round <= config.rounds; round++) {
    const none = latencies.get(`${round}-none`);
    const write = latencies.get(`${round}-write`);
    const control = latencies.get(`${round}-control`);
    const threshold = describe(none).p99;
    const table = concentration(echoes.get(`${round}-write`), threshold, transactions);
    writeTables.push(table);
    const controlTable = memoryWrites
      ? concentration(echoes.get(`${round}-control`), threshold, memoryWrites)
      : null;
    if (controlTable) controlTables.push(controlTable);
    const writeVsControl = higher(write, control);
    const writeVsNone = differs(write, none);
    const controlVsNone = differs(control, none);
    if (!writeVsControl.different) persistentlyHigher = false;
    if (writeVsNone.different || controlVsNone.different) writesMatchNone = false;
    const phaseInfo = (kind) => {
      const phase = byPhase.get(`${round}-${kind}`);
      const inPhase = samples.filter(
        (sample) => sample.at >= phase.start && sample.at <= phase.end,
      );
      const phaseWrites = writes.filter((entry) => entry.phase === phase.label);
      const phaseTransactions = transactions.filter(
        ([start]) => start >= phase.start && start <= phase.end,
      );
      return {
        echo: describe(latencies.get(phase.label)),
        eventLoopDelayMaxMs: describe(inPhase.map((sample) => sample.max)),
        eventLoopDelayP99Ms: describe(inPhase.map((sample) => sample.p99)),
        transactions: phaseTransactions.length,
        transactionMs: describe(phaseTransactions.map(([start, end]) => end - start)),
        writes: {
          sent: phaseWrites.length,
          succeeded: phaseWrites.filter((entry) => entry.state === "succeeded").length,
          rpcMs: describe(
            phaseWrites.filter((entry) => entry.doneAt).map((entry) => entry.doneAt - entry.sentAt),
          ),
        },
        // Delivered to the subscribing client, per subscribed terminal (PTY output includes the
        // CR that the line discipline adds before each LF).
        deliveredKiBPerSecondPerTerminal:
          phase.outputBytes / 1024 / ((phase.end - phase.start) / 1000) / SUBSCRIBED_OUTPUTS,
      };
    };
    rounds.push({
      round,
      delayedThresholdMs: threshold,
      none: phaseInfo("none"),
      write: phaseInfo("write"),
      control: phaseInfo("control"),
      writeOverlapTable: table,
      controlOverlapTable: controlTable,
      writeVsControl,
      writeVsNone,
      controlVsNone,
    });
  }
  const sum = (tables) =>
    tables.reduce(
      (total, table) => {
        for (const key of Object.keys(total)) total[key] += table[key];
        return total;
      },
      { delayedOverlap: 0, delayedClear: 0, onTimeOverlap: 0, onTimeClear: 0 },
    );
  // A delayed round trip is long, and a long round trip overlaps one of 20 writes per second
  // almost regardless of cause; write handling outside SQLite also runs then. The control phase
  // has the same writes at the same rate and timing, so the concentration counts against the
  // database only when overlapping round trips are delayed more often around SQLite transactions
  // than around the control phase's in-memory writes (one-sided Fisher on the overlapping round
  // trips of both phase kinds).
  const writeConcentration = concentrationTest(sum(writeTables));
  const controlConcentration = memoryWrites ? concentrationTest(sum(controlTables)) : null;
  const versusControlP = controlConcentration
    ? fisherGreater(
        writeConcentration.delayedOverlap,
        writeConcentration.onTimeOverlap,
        controlConcentration.delayedOverlap,
        controlConcentration.onTimeOverlap,
      )
    : null;
  const concentrated =
    writeConcentration.significant && (versusControlP === null || versusControlP < ALPHA);

  // Observations only (not verdict inputs). Most write-phase round trips overlap some transaction
  // (20 per second against round trips of up to tens of milliseconds), so the overlap base rate is
  // reported beside the concentration test. Long transactions are listed with the echoes whose
  // round trip contains them, and event-loop stalls are compared between phase kinds.
  const writeEchoes = phases
    .filter((phase) => phase.kind === "write")
    .flatMap((phase) => echoes.get(phase.label));
  const longTransactions = transactions
    .filter(([start, end]) => end - start >= LONG_TRANSACTION_MS)
    .map(([start, end]) => ({
      phase: phases.find((item) => start >= item.start && start <= item.end)?.label ?? null,
      ms: end - start,
      echoLatenciesMs: echo.keys
        .filter((key) => key.receivedAt !== null && key.sentAt <= end && key.receivedAt >= start)
        .map((key) => key.receivedAt - key.sentAt),
    }));
  const stallThreshold = describe(
    samples
      .filter((sample) =>
        phases.some(
          (item) => item.kind === "none" && sample.at >= item.start && sample.at <= item.end,
        ),
      )
      .map((sample) => sample.max),
  ).p99;
  const stalls = Object.fromEntries(
    ["none", "write", "control"].map((kind) => {
      const inKind = samples.filter((sample) =>
        phases.some(
          (item) => item.kind === kind && sample.at >= item.start && sample.at <= item.end,
        ),
      );
      return [
        kind,
        {
          windows: inKind.length,
          aboveNoWriteP99: inKind.filter((sample) => sample.max > stallThreshold).length,
          maxMs: describe(inKind.map((sample) => sample.max)).max,
        },
      ];
    }),
  );

  // A phase is disturbed when the probe could not keep its own schedule: it overran, sent too few
  // keys or writes, or paused for over a second (as when the host sleeps). Its numbers do not
  // describe the server under the bounded workload.
  const expectedKeys = (config.phaseSeconds * 1000) / KEY_INTERVAL_MS;
  const expectedWrites = config.phaseSeconds * WRITES_PER_SECOND;
  const disturbedPhases = phases
    .filter((phase) => {
      const sent = echo.keys.filter((key) => key.phase === phase.label).map((key) => key.sentAt);
      let gap = 0;
      for (let i = 1; i < sent.length; i++) gap = Math.max(gap, sent[i] - sent[i - 1]);
      const written = writes.filter((entry) => entry.phase === phase.label).length;
      return (
        phase.end - phase.start > config.phaseSeconds * 1000 * 1.1 ||
        sent.length < expectedKeys * 0.9 ||
        gap > 1000 ||
        (phase.kind !== "none" && written < expectedWrites * 0.9)
      );
    })
    .map((phase) => phase.label);
  const incomplete =
    lost > 0 ||
    refused > 0 ||
    echo.mismatched > 0 ||
    echo.unmatched > 0 ||
    unavailable > 0 ||
    disturbedPhases.length > 0;
  const verdict = incomplete
    ? "UNRESOLVED"
    : concentrated || persistentlyHigher
      ? "B"
      : writesMatchNone
        ? "A"
        : "UNRESOLVED";
  return {
    verdict,
    reasons: {
      delayedEchoesConcentrateInTransactions: concentrated,
      writePhasesHigherThanControlInEveryRound: persistentlyHigher,
      writeAndControlMatchNoWriteInEveryRound: writesMatchNone,
      incompleteMeasurement: incomplete,
    },
    criteria: {
      alpha: ALPHA,
      minP50ShiftMs: MIN_P50_SHIFT_MS,
      minP99ShiftMs: MIN_P99_SHIFT_MS,
      concentrationRatio: CONCENTRATION_RATIO,
    },
    workload: {
      terminals: TERMINALS,
      subscribedOutputTerminals: SUBSCRIBED_OUTPUTS,
      outputBytesPerSecondPerTerminal: OUTPUT_BYTES_PER_SECOND,
      keyIntervalMs: KEY_INTERVAL_MS,
      writesPerSecond: WRITES_PER_SECOND,
      phaseSeconds: config.phaseSeconds,
      rounds: config.rounds,
    },
    echoes: { lost, refused, mismatched: echo.mismatched, unmatched: echo.unmatched },
    unavailableSubscriptions: unavailable,
    disturbedPhases,
    concentration: {
      aroundTransactions: writeConcentration,
      aroundControlWrites: controlConcentration ?? "not recorded",
      // p that round trips overlapping a transaction are delayed more often than those
      // overlapping a control write.
      transactionsVersusControlP: versusControlP,
    },
    observations: {
      writeEchoOverlapRate: writeEchoes.length
        ? writeEchoes.filter((item) => item.overlap).length / writeEchoes.length
        : null,
      longTransactions,
      eventLoopStalls: { windowMs: 100, noWriteP99Ms: stallThreshold, ...stalls },
    },
    rounds,
  };
}

await main();
