/**
 * 元の高次元空間での k 近傍グラフ（manifest の `knn`）の読み込みと検証。DOM に依存しない。
 * ブラウザでの UMAP の再計算（src/compute/）を開いたときにだけ取得する（起動時の読み込みには含めない）。
 */
import { decodeFloat32LE, decodeUint16LE, decodeUint32LE } from './binary';
import { resolveDataUrl, type FetchLike } from './loader';
import type { DatasetManifest, ManifestKnn } from './manifest';

export interface KnnGraph {
  count: number;
  /** 点ごとの近傍の数（自分自身を含まない） */
  k: number;
  metric: ManifestKnn['metric'];
  /** 長さ count * k。行優先で、点 i の近傍が [i*k, (i+1)*k) に近い順に入る */
  indices: Uint16Array | Uint32Array;
  /** indices と同じ並びの距離 */
  distances: Float32Array;
}

/** 読み込んだ配列を検証する（番号が範囲内で自分自身を含まない、距離が有限・非負で行の中で非減少）。不正ならエラーを投げる。 */
export function validateKnnGraph(g: KnnGraph, labels = { indices: 'knn indices', distances: 'knn distances' }): void {
  const { count, k, indices, distances } = g;
  if (indices.length !== count * k) throw new Error(`${labels.indices}: 長さ ${indices.length} が ${count} × ${k} と一致しません`);
  if (distances.length !== count * k) throw new Error(`${labels.distances}: 長さ ${distances.length} が ${count} × ${k} と一致しません`);
  for (let i = 0; i < count; i++) {
    let prev = 0;
    for (let j = 0; j < k; j++) {
      const t = i * k + j;
      const idx = indices[t] as number;
      if (idx >= count) throw new Error(`${labels.indices}: 点 ${i} の近傍の番号 ${idx} が範囲外です`);
      if (idx === i) throw new Error(`${labels.indices}: 点 ${i} の近傍に自分自身が含まれています（includesSelf は false）`);
      const d = distances[t] as number;
      if (!Number.isFinite(d) || d < 0) throw new Error(`${labels.distances}: 点 ${i} の距離 ${d} が 0 以上の有限な数ではありません`);
      if (d < prev) throw new Error(`${labels.distances}: 点 ${i} の距離が近い順に並んでいません`);
      prev = d;
    }
  }
}

/** manifest の `knn` のファイルを取得して検証する。`knn` のないデータセットではエラー。 */
export async function loadKnnGraph(baseUrl: string, manifest: DatasetManifest, fetchImpl: FetchLike = fetch): Promise<KnnGraph> {
  const knn = manifest.knn;
  if (!knn) throw new Error('このデータセットには kNN グラフ（manifest の knn）がありません');
  const fetchBuffer = async (file: string) => {
    const url = resolveDataUrl(baseUrl, file);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${res.status}）`);
    return res.arrayBuffer();
  };
  const [ib, db] = await Promise.all([fetchBuffer(knn.indices.file), fetchBuffer(knn.distances.file)]);
  const n = manifest.count * knn.k;
  const indices = knn.indices.dtype === 'uint16' ? decodeUint16LE(ib, n, knn.indices.file) : decodeUint32LE(ib, n, knn.indices.file);
  const distances = decodeFloat32LE(db, n, knn.distances.file);
  const graph: KnnGraph = { count: manifest.count, k: knn.k, metric: knn.metric, indices, distances };
  validateKnnGraph(graph, { indices: knn.indices.file, distances: knn.distances.file });
  return graph;
}
