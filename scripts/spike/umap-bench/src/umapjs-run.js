import { UMAP } from 'umap-js';
import { mulberry32, yieldToEventLoop } from './knn.js';

// umap-js で kNN グラフから 3 次元 UMAP を計算する。時間は performance.now() で分けて返す。
// idx/dist は行優先の Int32Array / Float32Array（count * n）。
// yieldEvery > 0 のとき、そのエポック数ごとにイベントループへ戻る（中断・進捗のため）。0 なら同期のまま最後まで回す。
export async function runUmapJs({ count, n, idx, dist, nEpochs, seed, minDist, yieldEvery = 0, onProgress, shouldCancel }) {
  const t0 = performance.now();
  const knnIndices = new Array(count);
  const knnDistances = new Array(count);
  for (let i = 0; i < count; i++) {
    knnIndices[i] = Array.from(idx.subarray(i * n, (i + 1) * n));
    knnDistances[i] = Array.from(dist.subarray(i * n, (i + 1) * n));
  }
  // umap-js は X.length（点数）しか使わない（kNN を与えた場合）ので、空の配列を渡す
  const X = new Array(count);
  for (let i = 0; i < count; i++) X[i] = [];
  const t1 = performance.now();

  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: n,
    minDist,
    nEpochs, // 0 のとき umap-js の既定（点数から決まる）
    random: mulberry32(seed),
  });
  umap.setPrecomputedKNN(knnIndices, knnDistances);
  const epochs = umap.initializeFit(X);
  const t2 = performance.now();

  let done = 0;
  let cancelled = false;
  let firstStepMs = 0;
  while (done < epochs) {
    const s = performance.now();
    done = umap.step();
    if (done === 1) firstStepMs = performance.now() - s;
    if (onProgress && (done % 10 === 0 || done === epochs)) onProgress(done, epochs);
    if (yieldEvery > 0 && done % yieldEvery === 0) {
      await yieldToEventLoop();
      if (shouldCancel && shouldCancel()) { cancelled = true; break; }
    }
  }
  const t3 = performance.now();

  const emb = umap.getEmbedding();
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = emb[i][0];
    out[i * 3 + 1] = emb[i][1];
    out[i * 3 + 2] = emb[i][2];
  }
  return {
    embedding: out,
    epochs,
    epochsDone: done,
    cancelled,
    timings: { convertMs: t1 - t0, initMs: t2 - t1, optimizeMs: t3 - t2, firstStepMs },
  };
}
