import { sliceKnn } from './knn.js';

const logEl = document.getElementById('log');
const log = (s) => { logEl.textContent += '\n' + s; };

const DATASETS = {
  '10k': { count: 10000, idx: 'knn_idx_k50.i32', dist: 'knn_dist_k50.f32', kAll: 50 },
  '70k': { count: 70000, idx: 'knn_idx_k50_70k.i32', dist: 'knn_dist_k50_70k.f32', kAll: 50 },
};
const dataCache = new Map();

async function getData(name) {
  if (dataCache.has(name)) return dataCache.get(name);
  const d = DATASETS[name];
  const [i, f] = await Promise.all([
    fetch('/data/' + d.idx).then((r) => r.arrayBuffer()),
    fetch('/data/' + d.dist).then((r) => r.arrayBuffer()),
  ]);
  const v = { ...d, idxAll: new Int32Array(i), distAll: new Float32Array(f) };
  dataCache.set(name, v);
  return v;
}

function stats(a) {
  if (a.length === 0) return { count: 0, median: null, p95: null, max: null, mean: null };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { count: a.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: a.reduce((x, y) => x + y, 0) / a.length };
}

// requestAnimationFrame の間隔を記録する
function rafRecorder() {
  const deltas = [];
  let last = null;
  let id = 0;
  let running = true;
  const tick = (t) => {
    if (!running) return;
    if (last !== null) deltas.push(t - last);
    last = t;
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return { stop() { running = false; cancelAnimationFrame(id); return stats(deltas); }, deltas };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256(f32) {
  const h = await crypto.subtle.digest('SHA-256', f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function save(name, f32) {
  await fetch('/save?name=' + encodeURIComponent(name), { method: 'POST', body: f32 });
}

function spawn(engine) {
  // Vite がワーカーをバンドルできるよう、new URL を直接書く
  const w = engine === 'atlas'
    ? new Worker(new URL('./worker-atlas.js', import.meta.url), { type: 'module' })
    : new Worker(new URL('./worker-umapjs.js', import.meta.url), { type: 'module' });
  return w;
}

function once(worker, type) {
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      if (ev.data.type === type) { worker.removeEventListener('message', on); resolve(ev.data); }
      else if (ev.data.type === 'error') { worker.removeEventListener('message', on); reject(new Error(ev.data.message)); }
    };
    worker.addEventListener('message', on);
  });
}

async function runInWorker(worker, params, data, extra = {}) {
  // 先頭 n 列の切り出しはメインスレッドで行うが、rAF の計測区間の外（呼び出し側で先に行う）に置く
  const { idx, dist } = extra.sliced || sliceKnn(data.idxAll, data.distAll, data.count, data.kAll, params.n);
  const wait = once(worker, 'result');
  const snapshots = [];
  const progress = [];
  const onMsg = (ev) => {
    if (ev.data.type === 'snapshot') snapshots.push({ t: performance.now(), emb: ev.data.emb });
    if (ev.data.type === 'progress') progress.push({ t: performance.now(), done: ev.data.done });
  };
  worker.addEventListener('message', onMsg);
  const t0 = performance.now();
  worker.postMessage({ type: 'run', params, idx, dist }, [idx.buffer, dist.buffer]);
  if (extra.cancelAfterMs) {
    setTimeout(() => { extra.cancelAt = performance.now(); worker.postMessage({ type: 'cancel' }); }, extra.cancelAfterMs);
  }
  const res = await wait;
  const t1 = performance.now();
  worker.removeEventListener('message', onMsg);
  return { res, wallMs: t1 - t0, snapshots, progress, cancelAt: extra.cancelAt, doneAt: t1, t0 };
}

// 1 回の試行: 新しい Worker を作り、1 回目（コールド）を計算し、必要なら同じ Worker で 2 回目（ウォーム）を計算する
async function trial(cfg) {
  const data = await getData(cfg.dataset);
  const params = {
    count: data.count, n: cfg.n, nEpochs: cfg.nEpochs, seed: cfg.seed ?? 42, minDist: cfg.minDist ?? 0.1,
    initializeMethod: cfg.initializeMethod ?? 'spectral', mode: cfg.mode ?? 'run', chunk: cfg.chunk ?? 10,
    snapshots: !!cfg.snapshots, gpu: !!cfg.gpu, yieldEvery: cfg.yieldEvery ?? 0,
  };
  // 計算前のアイドル時のフレーム間隔（比較用）
  const idleRec = rafRecorder();
  await sleep(cfg.idleMs ?? 600);
  const idle = idleRec.stop();

  const sliced1 = sliceKnn(data.idxAll, data.distAll, data.count, data.kAll, params.n);
  await sleep(50);
  const rec = rafRecorder();
  const tSpawn = performance.now();
  const worker = spawn(cfg.engine);
  const ready = await once(worker, 'ready');
  const tReady = performance.now();
  const startupMs = tReady - tSpawn;

  const run1 = await runInWorker(worker, params, data, { cancelAfterMs: cfg.cancelAfterMs, sliced: sliced1 });
  const raf1 = rec.stop();
  const wallFromSpawnMs = run1.doneAt - tSpawn;
  const out = {
    cfg,
    startupMs,
    workerEvalMs: ready.evalMs,
    run1: {
      ...run1.res.timings,
      totalMs: startupMs + (run1.res.timings.convertMs ?? 0) + run1.res.timings.initMs + run1.res.timings.optimizeMs,
      wallFromSpawnMs,
      epochs: run1.res.epochs,
      epochsDone: run1.res.epochsDone,
      cancelled: run1.res.cancelled,
      mem: run1.res.mem,
      hash: await sha256(run1.res.embedding),
    },
    idle,
    raf: raf1,
  };
  if (run1.snapshots.length) {
    out.snapshots = { count: run1.snapshots.length, firstAtMs: run1.snapshots[0].t - run1.t0, lastAtMs: run1.snapshots[run1.snapshots.length - 1].t - run1.t0 };
  }
  if (cfg.cancelAfterMs) {
    out.cancel = { requestedAfterMs: cfg.cancelAfterMs, cancelAtMs: run1.cancelAt - run1.t0, resultAtMs: run1.doneAt - run1.t0, epochsDone: run1.res.epochsDone, cancelled: run1.res.cancelled };
  }
  if (cfg.save) await save(cfg.save + '_run1', run1.res.embedding);

  if (cfg.warmRun) {
    const run2 = await runInWorker(worker, params, data);
    out.run2 = {
      ...run2.res.timings,
      totalMs: (run2.res.timings.convertMs ?? 0) + run2.res.timings.initMs + run2.res.timings.optimizeMs,
      epochsDone: run2.res.epochsDone,
      hash: await sha256(run2.res.embedding),
    };
    out.sameWorkerBitIdentical = out.run1.hash === out.run2.hash;
  }
  worker.terminate();
  return out;
}

// ベースライン: アイドル時と、メインスレッドを 200ms 止めたときの rAF の間隔（計測が止まりを検出できるかの確認）
async function baseline() {
  const idle = rafRecorder();
  await sleep(2000);
  const idleStats = idle.stop();
  const blocked = rafRecorder();
  await sleep(300);
  const t = performance.now();
  while (performance.now() - t < 200) { /* busy */ }
  await sleep(300);
  const blockedStats = blocked.stop();
  return { idle: idleStats, blocked200ms: blockedStats };
}

window.bench = {
  trial,
  baseline,
  info: () => ({ ua: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, memory: !!performance.memory }),
};
log('ready');
window.benchReady = true;
