// 組み込みやすさの確認項目（途中の座標の読み出し・中断・初期座標の指定）を Node で実際に試す。
//   node features.mjs  → results/features.json
// 1万点・n=15・少ないエポック数で行う（挙動の確認が目的で、速度は測らない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UMAP } from 'umap-js';
import { createUMAPFromKNN } from './node_modules/embedding-atlas/dist/umap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const count = 10000, K = 50, n = 15;
const rd = (f, T) => { const b = fs.readFileSync(path.join(HERE, '.cache', f)); return new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const ia = rd('knn_idx_k50.i32', Int32Array), da = rd('knn_dist_k50.f32', Float32Array);
const idx = new Int32Array(count * n), dist = new Float32Array(count * n);
for (let i = 0; i < count; i++) for (let j = 0; j < n; j++) { idx[i * n + j] = ia[i * K + j]; dist[i * n + j] = da[i * K + j]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s = Math.max(s, Math.abs(a[i] - b[i])); return s; };
const out = {};

// --- embedding-atlas ---
{
  const r = {};
  // 1. epoch 0 の座標（スペクトル初期化）を読める
  const u = await createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), { seed: 42, minDist: 0.1, nEpochs: 40 });
  const init = new Float32Array(u.embedding);
  r.epoch0EmbeddingReadable = init.some((v) => v !== 0);
  r.epoch0Range = [Math.min(...init), Math.max(...init)];

  // 2. run() 中: progress コールバックと embedding の読み出し
  const calls = []; let changed = 0; let last = null;
  let u2 = null;
  u2 = await createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), {
    seed: 42, minDist: 0.1, nEpochs: 40,
    progress: (p, stage) => {
      calls.push([p, stage]);
      const e = u2 ? new Float32Array(u2.embedding) : null;
      if (e && last && diff(e, last) > 0) changed++;
      if (e) last = e;
    },
  });
  const tickTimes = []; const timer = setInterval(() => tickTimes.push(performance.now()), 10);
  const t0 = performance.now();
  await u2.run();
  clearInterval(timer);
  const wall = performance.now() - t0;
  r.run_timerTicksDuringRun = tickTimes.length;
  r.run_progressCalls = calls.length;
  r.run_progressSeries = calls.map((c) => c[0].toFixed(2) + ' ' + c[1]).filter((x, i, a) => i === 0 || x !== a[i - 1]).slice(0, 12);
  r.run_embeddingChangedDuringRun = changed;
  r.run_wallMs = wall;
  r.run_note = 'run() は wasm 内で一括実行され、実行中はイベントループが止まる（Worker では cancel メッセージも届かない）';

  // 3. step() は 1 チャンクごとにイベントループへ戻る
  const u3 = await createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), { seed: 42, minDist: 0.1 });
  const tt = []; const tm = setInterval(() => tt.push(performance.now()), 10);
  const snaps = [];
  for (let e = 0; e < 40; e += 5) { await u3.step(5); snaps.push(new Float32Array(u3.embedding)); }
  clearInterval(tm);
  r.step_snapshotsDiffer = snaps.slice(1).every((s, i) => diff(s, snaps[i]) > 0);
  r.step_timerTicksDuringEightAwaitedSteps = tt.length;
  r.step_epochAfter = u3.epoch;

  // 4. progress コールバックから例外を投げて run() を中断できるか
  let aborted = null;
  const u4 = await createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), {
    seed: 42, minDist: 0.1, nEpochs: 200,
    progress: (p) => { if (p > 0.1) throw new Error('abort'); },
  });
  try { const t = performance.now(); await u4.run(); aborted = { settled: 'resolved', ms: performance.now() - t, epoch: u4.epoch }; }
  catch (e) { aborted = { settled: 'rejected', message: String(e).slice(0, 80), epoch: u4.epoch }; }
  r.abortByThrowingInProgress = aborted;

  // 5. 実行中の destroy()
  const u5 = await createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), { seed: 42, minDist: 0.1, nEpochs: 100 });
  const p5 = u5.run(); const t5 = performance.now();
  await sleep(0); u5.destroy();
  await p5; r.destroyDuringRun_settledAfterMs = performance.now() - t5;
  r.destroyDuringRun_note = 'destroy() は実行中の run()/step() の完了後に適用される（途中で止まらない）';

  // 6. 初期座標を外から与える API があるか（型定義と実装の公開メンバーで確認）
  r.initialCoordinatesOption = 'なし（UMAPOptions に該当項目なし。initializeMethod は "spectral" | "random" のみ）';
  r.reset = 'reset("spectral" | "random") で epoch 0 に戻せる';
  r.embeddingIsReadOnlyCopy = 'embedding は Wasm 側の座標のコピー（書き込んでも Wasm 側へ反映されない）';
  const probe = await createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), { seed: 42, minDist: 0.1, nEpochs: 20 });
  const e0 = new Float32Array(probe.embedding);
  probe.embedding.fill(7);
  await probe.step(3);
  // もし書き込みが Wasm 側へ届いていれば、全点が 7 の近くに残るはず
  r.writeToEmbeddingAffectsWasm = Array.from(probe.embedding).every((v) => Math.abs(v - 7) < 0.5);
  // 7. min_dist だけ変えるとき: グラフを作り直さず setParameters + reset で足りるか（新規に作った結果とビット単位で比べる）
  const mk2 = async (md) => createUMAPFromKNN(count, 3, idx.slice(), dist.slice(), { seed: 42, minDist: md, nEpochs: 30 });
  const fresh = await mk2(0.5); await fresh.run(); const freshEmb = new Float32Array(fresh.embedding);
  const reuse = await mk2(0.1); reuse.setParameters({ minDist: 0.5 }); reuse.reset('spectral'); await reuse.run();
  const reuseEmb = new Float32Array(reuse.embedding);
  r.minDistChangeViaSetParametersAndReset = { bitIdenticalToFreshInstance: diff(freshEmb, reuseEmb) === 0, maxAbsDiff: diff(freshEmb, reuseEmb), epochAfter: reuse.epoch };
  out.atlas = r;
}

// --- umap-js ---
{
  const r = {};
  const ki = Array.from({ length: count }, (_, i) => Array.from(idx.subarray(i * n, (i + 1) * n)));
  const kd = Array.from({ length: count }, (_, i) => Array.from(dist.subarray(i * n, (i + 1) * n)));
  const X = Array.from({ length: count }, () => []);
  const mk = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const u = new UMAP({ nComponents: 3, nNeighbors: n, minDist: 0.1, nEpochs: 20, random: mk(42) });
  u.setPrecomputedKNN(ki, kd);
  u.initializeFit(X);
  const e0 = u.getEmbedding().map((v) => v.slice());
  let mn = Infinity, mx = -Infinity;
  for (const v of e0) for (const c of v) { mn = Math.min(mn, c); mx = Math.max(mx, c); }
  r.initialEmbeddingRange = [mn, mx];
  r.initialEmbeddingKind = 'ランダム一様 [-10, 10]（スペクトル初期化はない）';
  // 途中の座標
  const flat = (e) => Float32Array.from(e.flat());
  // 最初の step() は、どの辺もまだサンプルの時期に達していないため座標を動かさない（epochOfNextSample = epochsPerSample >= 1）。数エポック進めて比べる
  const a = flat(u.getEmbedding()); for (let i = 0; i < 4; i++) u.step(); const b = flat(u.getEmbedding());
  r.stepEmbeddingReadable = diff(a, b) > 0;
  r.firstStepMovesNothing = (() => { const v = new UMAP({ nComponents: 3, nNeighbors: n, minDist: 0.1, nEpochs: 20, random: mk(1) }); v.setPrecomputedKNN(ki, kd); v.initializeFit(X); const x0 = flat(v.getEmbedding()); v.step(); return diff(x0, flat(v.getEmbedding())) === 0; })();
  r.getEmbeddingIsLiveReference = u.getEmbedding() === u.getEmbedding();
  // 中断: step() を呼ばなければ止まる（同期の step が 1 エポック単位）
  r.cancel = 'step() を 1 エポックずつ呼ぶ側のループで止める（1 エポック = 数十 ms）。fit() の同期実行は途中で止められない';

  // 初期座標を外から差し込めるか（private の embedding を initializeFit の後に書き換える）
  const u2 = new UMAP({ nComponents: 3, nNeighbors: n, minDist: 0.1, nEpochs: 20, random: mk(42) });
  u2.setPrecomputedKNN(ki, kd);
  u2.initializeFit(X);
  const emb = u2.getEmbedding();
  for (let i = 0; i < count; i++) { emb[i][0] = 100; emb[i][1] = 100; emb[i][2] = 100; }
  // 全点を (100,100,100) に置いたあと数エポック進める。座標が書き換え後の値から動き始めれば、初期座標の差し込みが効いている
  for (let i = 0; i < 6; i++) u2.step();
  const after = flat(u2.getEmbedding());
  const near = after.filter((v) => Math.abs(v - 100) < 60).length / after.length;
  r.overwriteInitialAfterInitializeFit = { effective: near > 0.9 && after.some((v) => Math.abs(v - 100) > 1e-9), fractionNear100: near, sampleAfter: Array.from(after.slice(0, 3)) };
  out.umapjs = r;
}

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results/features.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
