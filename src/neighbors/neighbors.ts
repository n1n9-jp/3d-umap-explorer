/**
 * 「元の空間で本当に近い点」の計算（DOM と WebGL に依存しない）。
 *
 * - 元の空間での近傍: 配信している kNN グラフ（manifest の `knn`。自分自身を含まない、近い順）の、点の行の先頭 n 個。
 * - 3 次元の地図での近傍: 表示している埋め込みの座標での、同じ数の近傍（空間索引の kNearest。自分自身を除く）。
 * - 一致: 元の空間での近傍のそれぞれが、3 次元での近傍に含まれるか。その数を要約の文にする。
 */
import type { KnnGraph } from '../data/knn';

/** 一覧に出す近傍の数の既定値 */
export const DEFAULT_NEIGHBOR_COUNT = 10;

/** 元の空間での近傍（近い順）。 */
export interface OriginalNeighbors {
  indices: number[];
  distances: number[];
}

/** 点 `index` の、元の空間での近傍を近い順に最大 `n` 個（グラフの k を超える分は返さない）。 */
export function originalNeighbors(graph: Pick<KnnGraph, 'count' | 'k' | 'indices' | 'distances'>, index: number, n: number): OriginalNeighbors {
  if (!Number.isInteger(index) || index < 0 || index >= graph.count) throw new RangeError(`点の番号 ${index} が範囲外です`);
  const m = Math.max(0, Math.min(Math.floor(n), graph.k));
  const indices: number[] = [];
  const distances: number[] = [];
  const base = index * graph.k;
  for (let j = 0; j < m; j++) {
    indices.push(graph.indices[base + j] as number);
    distances.push(graph.distances[base + j] as number);
  }
  return { indices, distances };
}

/** 近傍検索（`SpatialIndex` の kNearest と同じ形。近い順、同距離は番号の小さい順）。 */
export interface KNearestSearch {
  kNearest(x: number, y: number, z: number, k: number): { indices: ArrayLike<number> };
}

/**
 * 点 `index` の、3 次元の座標 `positions` での近傍を近い順に `n` 個（自分自身を除く）。
 * 同じ位置に重なった点があっても、自分自身だけを番号で除く（n + 1 個を求めて、自分を外して先頭 n 個）。
 */
export function mapNeighbors(search: KNearestSearch, positions: ArrayLike<number>, index: number, n: number): number[] {
  const x = positions[3 * index] as number, y = positions[3 * index + 1] as number, z = positions[3 * index + 2] as number;
  const res = search.kNearest(x, y, z, n + 1).indices;
  const out: number[] = [];
  for (let k = 0; k < res.length && out.length < n; k++) {
    const j = res[k] as number;
    if (j !== index) out.push(j);
  }
  return out;
}

/** 元の空間での近傍と、地図での近傍の比べた結果。 */
export interface NeighborComparison {
  /** 元の空間での近傍のそれぞれが、地図での近傍に含まれるか（`original` と同じ並び） */
  inMap: boolean[];
  /** 含まれる数 */
  matches: number;
}

/** 元の空間での近傍 `original` のそれぞれが、地図での近傍 `map` に含まれるか。 */
export function compareNeighbors(original: readonly number[], map: readonly number[]): NeighborComparison {
  const set = new Set(map);
  const inMap = original.map((j) => set.has(j));
  return { inMap, matches: inMap.reduce((a, b) => a + (b ? 1 : 0), 0) };
}

/** 地図がどの程度当てになるかの目安（一致の割合から）。 */
export type MapReliability = 'high' | 'medium' | 'low';

/** 一致の割合から、目安を決める（7 割以上で high、4 割以上で medium、それ未満で low）。 */
export function mapReliability(matches: number, total: number): MapReliability {
  if (total <= 0) return 'low';
  const r = matches / total;
  if (r >= 0.7) return 'high';
  if (r >= 0.4) return 'medium';
  return 'low';
}

/** 要約の 1 文目（例: 「元のデータで近い10点のうち、地図でも近くにあるのは3点」）。 */
export function summaryCountText(matches: number, total: number): string {
  return `元のデータで近い${total}点のうち、地図でも近くにあるのは${matches}点`;
}

/** 要約の 2 文目（この点の周りの地図が、どの程度当てになるか）。 */
export function summaryHintText(matches: number, total: number): string {
  switch (mapReliability(matches, total)) {
    case 'high': return 'この辺りの地図は、元のデータの近さをよく表しています。';
    case 'medium': return 'この辺りの地図は、元のデータの近さを一部だけ表しています。';
    default: return '地図で近く見える点も、元のデータでは近いとは限りません。';
  }
}

/** 要約の全文（読み上げにも使う）。 */
export function summaryText(matches: number, total: number): string {
  return `${summaryCountText(matches, total)}。${summaryHintText(matches, total)}`;
}

/** 一覧の項目の読み上げの名前（例: 「2 番目に近い: queen、地図でも近い」）。 */
export function neighborItemLabel(rank: number, title: string, inMap: boolean): string {
  return `${rank} 番目に近い: ${title}、${inMap ? '地図でも近い' : '地図では離れている'}`;
}
