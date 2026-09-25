// Synthetic parser probe; no PTYs, agent processes, or client rendering.
const { fork } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const os = require('node:os');
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const mib = bytes => bytes / 1024 / 1024;
function payload(profile, bytes) {
  const parts = []; let size = 0, row = 1;
  while (size < bytes) {
    const text = `\x1b[32magent output: 分析代码 file.ts:120\x1b[0m ${'abcdefghij'.repeat(6)}`;
    const part = Buffer.from(profile === 'redraw' ? `\x1b[${row};1H\x1b[2K${text}` : `${text}\r\n`);
    parts.push(part); size += part.length; row = row % 40 + 1;
  }
  return Buffer.concat(parts);
}
async function shard(config) {
  const { Terminal } = require('@xterm/headless');
  const { SerializeAddon } = require('@xterm/addon-serialize');
  const terms = Array.from({ length: config.count }, () => {
    const terminal = new Terminal({ cols: 120, rows: 40, scrollback: config.history, allowProposedApi: true });
    const serialize = new SerializeAddon(); terminal.loadAddon(serialize);
    return { terminal, serialize, pending: 0 };
  });
  const write = (term, data) => new Promise(resolve => term.write(data, resolve));
  if (config.profile === 'redraw') await Promise.all(terms.map(x => write(x.terminal, '\x1b[?1049h')));
  global.gc?.();
  const baseRss = process.memoryUsage().rss;
  process.send({ type: 'ready' });
  const startAt = await new Promise(resolve => process.once('message', m => resolve(m.startAt)));
  await sleep(startAt - Date.now());
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
  const latencies = []; const batch = payload(config.profile, config.kibps * 1024 / 20);
  let completed = 0, outstanding = 0, peakPending = 0, peakRss = baseRss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  const started = performance.now(), cpuStart = process.cpuUsage();
  for (let tick = 0; tick < config.seconds * 20; tick++) {
    await sleep(started + tick * 50 - performance.now());
    for (const state of terms) {
      if (state.pending + batch.length > 1024 * 1024) throw new Error('Per-terminal 1 MiB queue budget exceeded');
      state.pending += batch.length; outstanding++; peakPending = Math.max(peakPending, state.pending);
      const sent = performance.now();
      state.terminal.write(batch, () => {
        state.pending -= batch.length; completed += batch.length; outstanding--;
        latencies.push(performance.now() - sent);
      });
    }
  }
  while (outstanding) {
    if (performance.now() - started > 30000) throw new Error('Drain timeout');
    await sleep(5);
  }
  await sleep(started + config.seconds * 1000 - performance.now());
  const elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuStart);
  clearInterval(sample); eventLoop.disable(); global.gc?.();
  const rssAfter = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rssAfter);
  const snapshotMs = []; let snapshotBytes = 0;
  for (const state of terms) {
    const before = performance.now(); const vt = state.serialize.serialize();
    snapshotMs.push(performance.now() - before); snapshotBytes += Buffer.byteLength(vt);
  }
  const result = { count: config.count, elapsedMs, completedBytes: completed,
    cpuMs: (cpu.user + cpu.system) / 1000, baseRssMiB: mib(baseRss), peakRssMiB: mib(peakRss),
    rssAfterMiB: mib(rssAfter), peakPendingBytesPerTerminal: peakPending,
    loopP99Ms: eventLoop.percentile(99) / 1e6, loopMaxMs: eventLoop.max / 1e6,
    latencies, snapshotMs, snapshotBytes,
    historyRows: terms.map(x => x.terminal.buffer.normal.length) };
  for (const state of terms) state.terminal.dispose();
  process.send({ type: 'result', result }, () => process.exit(0));
}
async function runCase(config) {
  const children = []; const readings = []; const ready = [];
  const watchdog = setTimeout(() => { for (const c of children) c.kill('SIGKILL'); }, 45000);
  try {
    for (let i = 0; i < config.shards; i++) {
      const child = fork(__filename, ['--shard', JSON.stringify({ ...config, count: config.total / config.shards })],
        { execArgv: ['--expose-gc', '--max-old-space-size=1024'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      ready.push(new Promise((resolve, reject) => {
        child.on('message', m => { if (m.type === 'ready') resolve(); });
        child.on('error', reject); child.on('exit', code => { if (code) reject(new Error(`Shard exited ${code}`)); });
      }));
      readings.push(new Promise((resolve, reject) => {
        let result;
        child.on('message', m => { if (m.type === 'result') result = m.result; });
        child.on('error', reject);
        child.on('exit', code => result && code === 0 ? resolve(result) : reject(new Error(`Missing result: ${code}`)));
      }));
    }
    await Promise.all(ready);
    const startAt = Date.now() + 200; for (const child of children) child.send({ startAt });
    const results = await Promise.all(readings);
    const sum = key => results.reduce((n, r) => n + r[key], 0);
    const elapsedMs = Math.max(...results.map(r => r.elapsedMs));
    const latencies = results.flatMap(r => r.latencies), snapshots = results.flatMap(r => r.snapshotMs);
    return { ...config, elapsedMs, completedMiB: mib(sum('completedBytes')),
      achievedMiBps: mib(sum('completedBytes')) / (elapsedMs / 1000),
      cpuCoreEquivalents: sum('cpuMs') / elapsedMs,
      sumPeakRssMiB: sum('peakRssMiB'), sumBaseRssMiB: sum('baseRssMiB'), sumRssAfterMiB: sum('rssAfterMiB'),
      parseCallbackP50Ms: quantile(latencies, .5), parseCallbackP95Ms: quantile(latencies, .95),
      parseCallbackP99Ms: quantile(latencies, .99), parseCallbackMaxMs: Math.max(...latencies),
      worstShardLoopP99Ms: Math.max(...results.map(r => r.loopP99Ms)),
      worstShardLoopMaxMs: Math.max(...results.map(r => r.loopMaxMs)),
      maxPendingBytesPerTerminal: Math.max(...results.map(r => r.peakPendingBytesPerTerminal)),
      snapshotP95Ms: quantile(snapshots, .95), snapshotTotalCpuWallMs: snapshots.reduce((a, b) => a + b, 0),
      snapshotTotalMiB: mib(sum('snapshotBytes')),
      minBufferRows: Math.min(...results.flatMap(r => r.historyRows)),
      maxBufferRows: Math.max(...results.flatMap(r => r.historyRows)) };
  } finally {
    clearTimeout(watchdog);
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  }
}
(async () => {
  if (process.argv[2] === '--shard') return shard(JSON.parse(process.argv[3]));
  const mode = process.argv[2] || 'standard';
  const cases = [];
  if (mode === 'history') {
    cases.push({ profile: 'append', kibps: 500, shards: 4, history: 5000, seconds: 5, total: 100 });
  } else if (mode === 'stress') {
    for (const shards of [1, 4]) cases.push({ profile: 'append', kibps: 1024, shards, history: 1000, seconds: 5, total: 100 });
  } else {
    for (const kibps of [50, 250]) for (const profile of ['append', 'redraw']) for (const shards of [1, 4])
      cases.push({ profile, kibps, shards, history: 1000, seconds: 5, total: 100 });
  }
  console.log(JSON.stringify({ type: 'host', at: new Date().toISOString(), node: process.version,
    cpu: os.cpus()[0].model, cpus: os.availableParallelism(), totalMemoryMiB: mib(os.totalmem()), load: os.loadavg() }));
  for (const config of cases) {
    const beforeLoad = os.loadavg(); const result = await runCase(config);
    console.log(JSON.stringify({ type: 'case', at: new Date().toISOString(), beforeLoad, afterLoad: os.loadavg(), ...result }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
