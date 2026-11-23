/**
 * 計算した座標から、空間の構造（全体の範囲・密度・主成分軸・ラベルごとのまとまり）を作り直す。DOM と WebGL に依存しない。
 *
 * 範囲・密度・主成分軸は scripts/precompute/add_structure.py と同じ定義・同じ丸め（小数第 6 位）で計算するので、
 * 事前計算の座標から計算すると manifest の値と一致する（`structure.test.ts`）。
 * クラスタ（HDBSCAN）はブラウザでは計算しない。ラベルのあるデータセットでは、ラベルごとのまとまりを粗い階層の
 * クラスタとして作る（目印と現在地の表示に使う）。ラベルのないデータセットでは作らない（クラスタなし）。
 */
import { SpatialIndex } from '../spatial/SpatialIndex';
import type {
  ClusterInfo, ManifestBounds, ManifestClusters, ManifestDensity, ManifestOverview, Vec3,
} from '../data/manifest';
import { symmetricEigen3, type Mat3 } from './align';

/** 密度に使う近傍の数（add_structure.py の KNN_K） */
export const DENSITY_K = 8;
/** ラベルのまとまりを表す、点ごとの値でまとまりに属さない点（add_structure.py の NOISE） */
export const LABEL_GROUP_NOISE = 65535;

const DIGITS = 6;
const SCALE = 10 ** DIGITS;
/** Python の round(x, 6)（2 進の値を正しく丸める。toFixed も同じ規則） */
export const round6 = (x: number): number => Number(x.toFixed(DIGITS));
export const ceil6 = (x: number): number => Math.ceil(x * SCALE) / SCALE;
export const floor6 = (x: number): number => Math.floor(x * SCALE) / SCALE;

/** numpy の percentile（既定の linear）と同じ補間。`sorted` は昇順。 */
export function percentileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (q / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const f = pos - lo;
  const a = sorted[lo] as number, b = sorted[hi] as number;
  return a + (b - a) * f;
}

const at = (p: ArrayLike<number>, i: number): Vec3 => [p[3 * i] as number, p[3 * i + 1] as number, p[3 * i + 2] as number];

/** 全点を含む球。中心はバウンディングボックスの中心（丸めた値）、半径は丸めた中心から最も遠い点までの距離を切り上げた値。 */
export function computeBoundsSphere(p: ArrayLike<number>): ManifestBounds {
  const n = Math.floor(p.length / 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const v = p[3 * i + a] as number;
    if (v < min[a]!) min[a] = v;
    if (v > max[a]!) max[a] = v;
  }
  const center = [0, 1, 2].map((a) => round6((min[a]! + max[a]!) / 2)) as Vec3;
  let far = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot((p[3 * i] as number) - center[0], (p[3 * i + 1] as number) - center[1], (p[3 * i + 2] as number) - center[2]);
    if (d > far) far = d;
  }
  let radius = ceil6(far);
  if (radius < far) radius = round6(radius + 1 / SCALE); // 浮動小数の誤差で切り上げが足りなかったとき
  return { center, radius };
}

/** 各点の 8 近傍（自分自身を除く）までの距離の平均の、全点での 5・50・95 パーセンタイル。近傍は空間索引で探す。 */
export function computeDensity(p: Float32Array, index: SpatialIndex = new SpatialIndex(p)): ManifestDensity {
  const n = Math.floor(p.length / 3);
  const means = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = p[3 * i] as number, y = p[3 * i + 1] as number, z = p[3 * i + 2] as number;
    const r = index.kNearest(x, y, z, DENSITY_K + 1);
    // 先頭は自分自身（または同じ位置の点。距離 0 なのでどちらでも同じ）。距離は倍精度で計算し直す（索引は Float32 で返す）
    let sum = 0;
    for (let j = 1; j < r.indices.length; j++) {
      const k = r.indices[j] as number;
      sum += Math.hypot((p[3 * k] as number) - x, (p[3 * k + 1] as number) - y, (p[3 * k + 2] as number) - z);
    }
    means[i] = sum / Math.max(1, r.indices.length - 1);
  }
  means.sort();
  return {
    k: DENSITY_K,
    knnDistP05: round6(percentileSorted(means, 5)),
    knnDistP50: round6(percentileSorted(means, 50)),
    knnDistP95: round6(percentileSorted(means, 95)),
  };
}

/**
 * 座標の主成分分析の第 1〜第 3 軸。第 1・第 2 軸は絶対値が最大の成分が正、第 3 軸は第 1 軸 × 第 2 軸（右手系）。
 */
export function computeOverview(p: ArrayLike<number>): ManifestOverview {
  const n = Math.floor(p.length / 3);
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) mean[a]! += p[3 * i + a] as number;
  for (let a = 0; a < 3; a++) mean[a]! /= n;
  const cov: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = [0, 1, 2].map((a) => (p[3 * i + a] as number) - mean[a]!);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[3 * r + c] += d[r]! * d[c]!;
  }
  for (let k = 0; k < 9; k++) cov[k] /= Math.max(1, n - 1);
  const { vectors } = symmetricEigen3(cov);
  const axes: Vec3[] = [];
  for (const v0 of vectors.slice(0, 2)) {
    let v = [...v0];
    let big = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(v[a]!) > Math.abs(v[big]!)) big = a;
    if (v[big]! < 0) v = v.map((x) => -x);
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    axes.push([v[0]! / l, v[1]! / l, v[2]! / l]);
  }
  const [a, b] = axes as [Vec3, Vec3];
  axes.push([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  return { axes: axes.map((v) => v.map(round6) as Vec3) as [Vec3, Vec3, Vec3] };
}

/**
 * medoid を厳密に計算する点数の上限。これ以下のまとまりは総当たり（点数の 2 乗）で、MNIST 1 万点の
 * ラベルごとのまとまり（最大 1135 点）はすべて厳密のまま。これを超えるまとまりは近似する（`medoidOf`）。
 */
export const MEDOID_EXACT_MAX = 2048;
/** 近似するときの、代表点の候補に使う点の数 */
export const MEDOID_CANDIDATES = 512;
/** 近似するときの、候補から各点までの距離の合計を測る相手の点の数 */
export const MEDOID_REFERENCES = 2048;
/** 近似で点を選ぶ乱数の種（結果が決まるように固定する） */
export const MEDOID_SEED = 0x6d65_6431;

/** 32 ビットの乱数（mulberry32）。種が同じなら同じ列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `members` から `k` 個を無作為に選び、番号の昇順で返す（部分的な Fisher–Yates。`members` は変えない）。 */
function sampleSorted(members: ArrayLike<number>, k: number, rand: () => number): Int32Array {
  const m = members.length;
  const a = Int32Array.from(members as ArrayLike<number>);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (m - i));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a.slice(0, k).sort();
}

/** `candidates` のうち、`references` の各点への距離の合計が最小の点（同値なら番号の小さいもの。`candidates` は昇順）。 */
function bestByDistanceSum(p: ArrayLike<number>, candidates: ArrayLike<number>, references: ArrayLike<number>): number {
  let best = -1, bestSum = Infinity;
  for (let a = 0; a < candidates.length; a++) {
    const i = candidates[a] as number;
    const x = p[3 * i] as number, y = p[3 * i + 1] as number, z = p[3 * i + 2] as number;
    let sum = 0;
    for (let b = 0; b < references.length && sum < bestSum; b++) {
      const j = references[b] as number;
      sum += Math.hypot((p[3 * j] as number) - x, (p[3 * j + 1] as number) - y, (p[3 * j + 2] as number) - z);
    }
    if (sum < bestSum) { bestSum = sum; best = i; }
  }
  return best;
}

/**
 * 点の集合の medoid（他の全点への距離の合計が最小の点。同値なら番号の小さいもの。`members` は番号の昇順）。
 *
 * `MEDOID_EXACT_MAX` 点以下では、すべての点を総当たりで比べる（厳密。点数の 2 乗）。それを超えると、計算量に上限を設けるため近似する：
 * 無作為に選んだ `MEDOID_CANDIDATES` 点を候補とし、各候補から、無作為に選んだ `MEDOID_REFERENCES` 点（`members` が少なければ全点）への
 * 距離の合計が最小の候補を返す。乱数の種は固定なので、同じ入力なら結果は同じ。計算量は高々 候補数 × 相手の数。
 */
export function medoidOf(p: ArrayLike<number>, members: ArrayLike<number>): number {
  const m = members.length;
  if (m <= MEDOID_EXACT_MAX) return bestByDistanceSum(p, members, members);
  const rand = mulberry32(MEDOID_SEED);
  const candidates = sampleSorted(members, MEDOID_CANDIDATES, rand);
  const references = m <= MEDOID_REFERENCES ? members : sampleSorted(members, MEDOID_REFERENCES, rand);
  return bestByDistanceSum(p, candidates, references);
}

export interface LabelGroups {
  clusters: ManifestClusters;
  /** 点ごとのまとまりの id（ラベルの番号を、点数のあるまとまりの添字に詰めたもの） */
  ids: Uint16Array;
}

/**
 * ラベルごとのまとまりを、粗い階層のクラスタの形（manifest の `clusters`）で作る。
 * 代表点は medoid、`radius` は medoid から各点までの距離の 90 パーセンタイル、`bbox` は点の範囲、`size` は点数。
 * 点のないラベルは作らない。`id` はラベルの順に 0 から振る（`majorityLabel` が元のラベルの番号で、純度は 1）。
 */
export function labelGroups(p: ArrayLike<number>, labels: ArrayLike<number>, names: readonly string[]): LabelGroups {
  const n = labels.length;
  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const l = labels[i] as number;
    let a = byLabel.get(l);
    if (!a) byLabel.set(l, (a = []));
    a.push(i);
  }
  const ids = new Uint16Array(n).fill(LABEL_GROUP_NOISE);
  const clusters: ClusterInfo[] = [];
  for (const label of [...byLabel.keys()].sort((a, b) => a - b)) {
    const members = byLabel.get(label)!;
    const id = clusters.length;
    for (const i of members) ids[i] = id;
    const medoid = medoidOf(p, members);
    const center = at(p, medoid);
    const dist = Float64Array.from(members, (i) => Math.hypot((p[3 * i] as number) - center[0], (p[3 * i + 1] as number) - center[1], (p[3 * i + 2] as number) - center[2]));
    dist.sort();
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const i of members) for (let a = 0; a < 3; a++) {
      const v = p[3 * i + a] as number;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
    clusters.push({
      id,
      name: names[label] ?? String(label),
      size: members.length,
      medoid,
      center: center.map(round6) as Vec3,
      radius: ceil6(percentileSorted(dist, 90)),
      bbox: [min.map(floor6) as Vec3, max.map(ceil6) as Vec3],
      majorityLabel: label,
      purity: 1,
      parent: null,
    });
  }
  return {
    clusters: {
      method: 'labels',
      noise: LABEL_GROUP_NOISE,
      levels: [{
        name: 'coarse',
        params: { minClusterSize: 1, minSamples: 1, maxClusterSize: null, selectionMethod: 'labels' },
        pointFile: '',
        clusters,
      }],
    },
    ids,
  };
}

/** 空間の構造と、それを求める途中で作った空間索引。 */
export interface StructureResult {
  bounds: ManifestBounds;
  density: ManifestDensity;
  overview: ManifestOverview;
  /** ラベルごとのまとまり（ラベルとその名前を渡したときだけ） */
  groups: LabelGroups | null;
  /** `positions` の空間索引（密度の計算に使ったもの。表示側の索引として使い回す） */
  index: SpatialIndex;
}

/**
 * 座標から空間の構造（範囲・密度・主成分軸・ラベルごとのまとまり）を計算する。空間索引は 1 回だけ構築し、結果に含める。
 * 点数に比例して時間がかかる（7 万点で数百ミリ秒〜1 秒ほど）ので、メインスレッドでなく Worker の中で呼ぶ（`structureWorker.ts`）。
 */
export function computeStructure(
  positions: Float32Array, labels: ArrayLike<number> | null, names: readonly string[] | null,
): StructureResult {
  const index = new SpatialIndex(positions);
  return {
    bounds: computeBoundsSphere(positions),
    density: computeDensity(positions, index),
    overview: computeOverview(positions),
    groups: labels && names ? labelGroups(positions, labels, names) : null,
    index,
  };
}
