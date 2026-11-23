/**
 * kNN グラフから 3 次元の UMAP を計算する手順（Worker の中で使う。DOM に依存しないので Node のテストでも動く）。
 *
 * 計算は embedding-atlas の Wasm UMAP（`./vendor/embedding-atlas/`）で行う。一括の `run()` は中断できず途中の座標も
 * 読めないので、`step(チャンク)` を繰り返し、チャンクごとに学習率を `1 − 完了エポック / 全エポック` へ線形に下げる
 * （`run()` の焼きなましと同じ形。学習率を一定のままにすると質が大きく落ちる）。チャンクの間で `yieldFn` を呼んで
 * イベントループへ制御を戻し、中断の指示（Worker の onmessage）を受けられるようにする。
 * 計測と方式の選定は scripts/spike/umap-bench/README.md。
 */
import { createUMAPFromKNN } from './vendor/embedding-atlas/umap.js';
import { UMAP_CHUNK_EPOCHS, UMAP_EPOCHS, type UmapParams } from './params';

export type { UmapParams } from './params';

/**
 * kNN グラフ（自分自身を含まない、k 列）から、UMAP へ渡す n 列（列 0 が自分自身で距離 0、続けて近い順に n−1 個）を作る。
 * umap-learn の n_neighbors と同じく、近傍数は自分自身を含めて数える。
 */
export function knnInput(
  indices: ArrayLike<number>, distances: ArrayLike<number>, count: number, k: number, nNeighbors: number,
): { idx: Int32Array; dist: Float32Array } {
  if (!Number.isInteger(nNeighbors) || nNeighbors < 2) throw new RangeError(`近傍数 ${nNeighbors} は 2 以上の整数です`);
  if (nNeighbors - 1 > k) throw new RangeError(`近傍数 ${nNeighbors} は、kNN グラフの列数 ${k} + 1 以下です`);
  const n = nNeighbors;
  const idx = new Int32Array(count * n);
  const dist = new Float32Array(count * n);
  for (let i = 0; i < count; i++) {
    const s = i * k;
    const d = i * n;
    idx[d] = i;
    dist[d] = 0;
    for (let j = 1; j < n; j++) {
      idx[d + j] = indices[s + j - 1] as number;
      dist[d + j] = distances[s + j - 1] as number;
    }
  }
  return { idx, dist };
}

export interface UmapRunOptions {
  count: number;
  idx: Int32Array;
  dist: Float32Array;
  params: UmapParams;
  nEpochs?: number;
  chunkEpochs?: number;
  /** チャンクが終わるたびに呼ぶ（`embedding` は再利用されるバッファなので、残すならコピーする） */
  onChunk?(epoch: number, total: number, embedding: Float32Array): void;
  /** 初期化（グラフの構築とスペクトル初期化）が終わったとき */
  onReady?(initMs: number): void;
  /** true を返すと、次のチャンクの前で止める */
  shouldCancel?(): boolean;
  /** チャンクの間で呼ぶ（Worker ではイベントループへ戻す） */
  yieldFn?(): Promise<void>;
}

export interface UmapRunResult {
  /** 計算した座標（長さ 3 * count。止めたときは null） */
  embedding: Float32Array | null;
  cancelled: boolean;
  /** 進めたエポック数 */
  epochs: number;
  initMs: number;
  optimizeMs: number;
}

/** UMAP を計算する。 */
export async function runUmap(o: UmapRunOptions): Promise<UmapRunResult> {
  const total = o.nEpochs ?? UMAP_EPOCHS;
  const chunk = Math.max(1, o.chunkEpochs ?? UMAP_CHUNK_EPOCHS);
  const { minDist, seed } = o.params;
  const t0 = performance.now();
  const umap = await createUMAPFromKNN(o.count, 3, o.idx, o.dist, { seed, minDist, nEpochs: total });
  const t1 = performance.now();
  o.onReady?.(t1 - t0);
  let done = 0;
  let cancelled = false;
  try {
    while (done < total) {
      if (o.shouldCancel?.()) { cancelled = true; break; }
      const c = Math.min(chunk, total - done);
      // 5 項目をまとめて渡す（spike で測った構成）。minDist・spread は出力の曲線の当てはめに使われる
      umap.setParameters({ learningRate: 1 - done / total, repulsionStrength: 1, negativeSampleRate: 5, minDist, spread: 1 });
      await umap.step(c);
      done += c;
      o.onChunk?.(done, total, umap.embedding);
      if (o.yieldFn) await o.yieldFn();
    }
    const embedding = cancelled ? null : new Float32Array(umap.embedding); // 再利用されるバッファなのでコピーする
    return { embedding, cancelled, epochs: done, initMs: t1 - t0, optimizeMs: performance.now() - t1 };
  } finally {
    umap.destroy();
  }
}

/** マクロタスクへ制御を戻す（Worker が onmessage を処理できるようにする）。`await` だけ（マイクロタスク）では届かない。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); resolve(); };
    c.port2.postMessage(0);
  });
}
