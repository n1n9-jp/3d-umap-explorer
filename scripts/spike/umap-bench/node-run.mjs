// Node で同じ計算を 1 回行い、JSON を標準出力へ出す（ブラウザとの相対比較用）。
//   node node-run.mjs <atlas|umapjs> <10k|70k> <n> <nEpochs(0=既定)> [saveName]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UMAP } from 'umap-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [engine, dataset, nStr, epStr, saveName] = process.argv.slice(2);
const n = Number(nStr), nEpochs = Number(epStr);
const D = { '10k': [10000, 'knn_idx_k50.i32', 'knn_dist_k50.f32'], '70k': [70000, 'knn_idx_k50_70k.i32', 'knn_dist_k50_70k.f32'] }[dataset];
const [count, fi, fd] = D;
const K = 50;
const rd = (f, T) => { const b = fs.readFileSync(path.join(HERE, '.cache', f)); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const idxAll = rd(fi, Int32Array), distAll = rd(fd, Float32Array);
const idx = new Int32Array(count * n), dist = new Float32Array(count * n);
for (let i = 0; i < count; i++) for (let j = 0; j < n; j++) { idx[i * n + j] = idxAll[i * K + j]; dist[i * n + j] = distAll[i * K + j]; }

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// 同期処理でイベントループが止まるため、サンプリングではなく OS が記録するプロセスの最大 RSS を使う。
// 読み込み前の最大 RSS との差を「この計算で増えた量」とする（kNN グラフの読み込みを含む）。
const baseRss = process.resourceUsage().maxRSS * 1024;
let out;
if (engine === 'atlas') {
  const t00 = performance.now();
  const { createUMAPFromKNN } = await import(path.join(HERE, 'node_modules/embedding-atlas/dist/umap.js'));
  const importMs = performance.now() - t00;
  const t0 = performance.now();
  const opts = { seed: 42, minDist: 0.1 };
  if (nEpochs > 0) opts.nEpochs = nEpochs;
  const u = await createUMAPFromKNN(count, 3, idx, dist, opts);
  const t1 = performance.now();
  await u.run();
  const t2 = performance.now();
  const emb = new Float32Array(u.embedding);
  out = { engine, importMs, initMs: t1 - t0, optimizeMs: t2 - t1, epochs: u.epoch, emb };
} else {
  const t0 = performance.now();
  const ki = new Array(count), kd = new Array(count), X = new Array(count);
  for (let i = 0; i < count; i++) { ki[i] = Array.from(idx.subarray(i * n, (i + 1) * n)); kd[i] = Array.from(dist.subarray(i * n, (i + 1) * n)); X[i] = []; }
  const tc = performance.now();
  const umap = new UMAP({ nComponents: 3, nNeighbors: n, minDist: 0.1, nEpochs, random: mulberry32(42) });
  umap.setPrecomputedKNN(ki, kd);
  const epochs = umap.initializeFit(X);
  const t1 = performance.now();
  let done = 0;
  while (done < epochs) done = umap.step();
  const t2 = performance.now();
  const e = umap.getEmbedding();
  const emb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { emb[i * 3] = e[i][0]; emb[i * 3 + 1] = e[i][1]; emb[i * 3 + 2] = e[i][2]; }
  out = { engine, convertMs: tc - t0, initMs: t1 - tc, optimizeMs: t2 - t1, epochs, emb };
}
const peakRss = process.resourceUsage().maxRSS * 1024;
const hash = crypto.createHash('sha256').update(Buffer.from(out.emb.buffer, out.emb.byteOffset, out.emb.byteLength)).digest('hex');
if (saveName) {
  fs.mkdirSync(path.join(HERE, '.cache/results'), { recursive: true });
  fs.writeFileSync(path.join(HERE, '.cache/results', saveName + '.f32'), Buffer.from(out.emb.buffer, out.emb.byteOffset, out.emb.byteLength));
}
delete out.emb;
console.log(JSON.stringify({ ...out, dataset, n, nEpochs, hash, rssBaseMB: baseRss / 2 ** 20, rssPeakMB: peakRss / 2 ** 20, rssDeltaMB: (peakRss - baseRss) / 2 ** 20, node: process.version }));
