import { createUMAPFromKNN } from '@atlas-umap';
import { yieldToEventLoop } from './knn.js';

// embedding-atlas の Wasm UMAP で kNN グラフから 3 次元 UMAP を計算する。
// mode: 'run'（run() で最後まで）、'step'（step(chunk) を繰り返す。学習率は一定）、
//       'stepdecay'（step(chunk) を繰り返し、チャンクごとに学習率を線形に下げて run() の焼きなましを模す）
export async function runAtlas({ count, n, idx, dist, nEpochs, seed, minDist, initializeMethod, gpu, mode, chunk, yieldEvery = 0, onProgress, shouldCancel, onSnapshot }) {
  const t0 = performance.now();
  const opts = { seed, minDist, initializeMethod };
  if (gpu) opts.gpu = true;
  if (nEpochs > 0) opts.nEpochs = nEpochs;
  const umap = await createUMAPFromKNN(count, 3, idx, dist, opts);
  const t1 = performance.now();

  let epochsTotal = nEpochs;
  let cancelled = false;
  let snapshots = 0;
  if (mode === 'step' || mode === 'stepdecay') {
    // 既定のエポック数は run() の内部で決まるため、step モードでは明示したエポック数だけ進める
    let done = 0;
    while (done < nEpochs) {
      const c = Math.min(chunk, nEpochs - done);
      if (mode === 'stepdecay') {
        umap.setParameters({ learningRate: 1 - done / nEpochs, repulsionStrength: 1, negativeSampleRate: 5, minDist, spread: 1 });
      }
      await umap.step(c);
      done += c;
      if (onSnapshot) { onSnapshot(umap.embedding); snapshots++; }
      if (onProgress) onProgress(done, nEpochs);
      // step() の await はマイクロタスクだけで進むため、明示的に戻さないと Worker は cancel を受け取れない
      if (yieldEvery > 0) await yieldToEventLoop();
      if (shouldCancel && shouldCancel()) { cancelled = true; break; }
    }
  } else {
    await umap.run();
    epochsTotal = umap.epoch;
  }
  const t2 = performance.now();
  const embedding = new Float32Array(umap.embedding); // 再利用バッファなのでコピーする
  const epochsDone = umap.epoch;
  umap.destroy();
  return {
    embedding,
    epochs: epochsTotal,
    epochsDone,
    cancelled,
    snapshots,
    timings: { initMs: t1 - t0, optimizeMs: t2 - t1 },
  };
}
