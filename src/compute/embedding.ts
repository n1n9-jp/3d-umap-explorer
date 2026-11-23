/**
 * ブラウザで計算した座標から、表示に使うデータ（`DatasetArrays`）を作る。DOM と WebGL に依存しない。
 *
 * 読み込んだデータ（事前計算）の arrays を土台に、座標・境界・manifest の空間の構造（bounds・density・overview・clusters）
 * を差し替える。ラベル・単語・画像はそのまま使う。
 * - ラベルのあるデータセット（MNIST）: ラベルごとのまとまりを粗い階層のクラスタにする（目印と現在地に使う）。点の色はラベル。
 * - ラベルのないデータセット（word2vec）: クラスタはなし（目印と現在地は無効）。点の色は、事前計算のクラスタの番号による色を、
 *   点に付いたものとしてそのまま引き継ぐ（`coloring`）。
 */
import type { DatasetArrays } from '../data/loader';
import type { DatasetManifest } from '../data/manifest';
import { pointColoring, type PointColoring } from '../render/colorScheme';
import { SpatialIndex } from '../spatial/SpatialIndex';
import { computeBoundsSphere, computeDensity, computeOverview, labelGroups } from './structure';
import { UMAP_EPOCHS, type UmapParams } from './params';

/** 計算に使ったライブラリ（manifest の umap.library に書く） */
export const BROWSER_UMAP_LIBRARY = 'embedding-atlas 0.26.0 (browser)';

export interface EmbeddingData {
  arrays: DatasetArrays;
  /** 点の色の上書き（ラベルのないデータセットで、事前計算のクラスタの色を引き継ぐ）。なければ arrays から決める */
  coloring: PointColoring | null;
}

/** 事前計算の色（ラベル、なければ粗い階層のクラスタ）。 */
export function precomputedColoring(base: DatasetArrays): PointColoring {
  const { manifest } = base;
  const coarseIds = base.clusterAssignments?.[0]?.ids;
  const coarse = manifest.clusters && coarseIds ? { ids: coarseIds, noise: manifest.clusters.noise } : null;
  return pointColoring({ count: manifest.count, labels: base.labels, coarse });
}

/**
 * 計算した座標（正規化・位置合わせの済んだもの）から、表示に使うデータを作る。`base` は読み込んだ事前計算のデータ。
 */
export function buildEmbeddingData(base: DatasetArrays, positions: Float32Array, params: UmapParams): EmbeddingData {
  const { manifest } = base;
  const count = manifest.count;
  if (positions.length !== count * 3) throw new RangeError(`座標の長さ ${positions.length} が 3 × ${count} と一致しません`);
  const sphere = computeBoundsSphere(positions);
  const density = computeDensity(positions, new SpatialIndex(positions));
  const overview = computeOverview(positions);
  const groups = base.labels && manifest.labels ? labelGroups(positions, base.labels, manifest.labels.names) : null;

  const next: DatasetManifest = { ...manifest, bounds: sphere, density, overview };
  delete next.clusters;
  delete (next as { quality?: unknown }).quality;
  next.umap = {
    library: BROWSER_UMAP_LIBRARY, nComponents: 3, nNeighbors: params.nNeighbors, minDist: params.minDist,
    metric: manifest.knn?.metric ?? manifest.umap?.metric, randomState: params.seed, nEpochs: UMAP_EPOCHS,
  };
  if (groups) next.clusters = groups.clusters;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {
    const v = positions[3 * i + a] as number;
    if (v < min[a]!) min[a] = v;
    if (v > max[a]!) max[a] = v;
  }
  const arrays: DatasetArrays = {
    manifest: next,
    positions,
    bounds: { min, max, center: [...sphere.center], radius: sphere.radius },
  };
  if (base.labels) arrays.labels = base.labels;
  if (base.text) arrays.text = base.text;
  if (groups) arrays.clusterAssignments = [{ level: 'coarse', ids: groups.ids }];
  // ラベルがあれば色はラベルで決まる（arrays から同じ色になる）。なければ事前計算の色を引き継ぐ
  const coloring = base.labels ? null : precomputedColoring(base);
  return { arrays, coloring };
}
