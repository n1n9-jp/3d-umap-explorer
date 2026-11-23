/**
 * 点の色の決め方（色の番号）。描画（src/render/pointCloud.ts）・ミニマップ・目印・情報パネルが同じ規則で色を引く。
 *
 * - ラベルがあるデータセット（MNIST）: ラベルの番号。クラスタの目印は多数派ラベルの色。
 * - ラベルがなく、粗い階層のクラスタがあるデータセット（word2vec）: クラスタの番号。どのクラスタにも属さない点は灰色。
 *   クラスタが 10 個を超えると、10 色を繰り返す（隣り合うクラスタが同じ色になる場合がある）。
 * - どちらもない: すべて同じ色。
 *
 * 色の番号は 0 以上ならパレット（`LABEL_COLORS`）を 10 で割った余りで引き、`NOISE_COLOR_INDEX`（-1）なら `NOISE_COLOR`。
 */
import { LABEL_COLORS, hexToRgb } from './palette';

/** どのクラスタにも属さない点の色。目立たない中間の灰色（背景とのコントラスト比はパレットの 10 色より低い）。 */
export const NOISE_COLOR = '#686d78';
/** 色の番号で NOISE_COLOR を表す値。 */
export const NOISE_COLOR_INDEX = -1;
/** ラベルもクラスタもないデータセットで、全点に使う色の番号（青）。 */
export const UNIFORM_COLOR_INDEX = 6;

export type ColorSource = 'label' | 'cluster' | 'uniform';

export interface PointColoring {
  source: ColorSource;
  /** 長さ count。点ごとの色の番号（`colorIndexRgb` で色にする） */
  indices: Float32Array;
}

export interface ColoringInput {
  count: number;
  labels?: Uint8Array | undefined;
  /** 粗い階層の点ごとのクラスタ id と、クラスタなしの値 */
  coarse?: { ids: Uint16Array; noise: number } | null | undefined;
}

/** 点ごとの色の番号を決める。 */
export function pointColoring({ count, labels, coarse }: ColoringInput): PointColoring {
  const indices = new Float32Array(count);
  if (labels) {
    for (let i = 0; i < count; i++) indices[i] = labels[i] ?? 0;
    return { source: 'label', indices };
  }
  if (coarse) {
    for (let i = 0; i < count; i++) {
      const id = coarse.ids[i];
      indices[i] = id === undefined || id === coarse.noise ? NOISE_COLOR_INDEX : id;
    }
    return { source: 'cluster', indices };
  }
  indices.fill(UNIFORM_COLOR_INDEX);
  return { source: 'uniform', indices };
}

/** 色の番号の色（'#rrggbb'）。 */
export function colorIndexHex(index: number): string {
  if (index < 0) return NOISE_COLOR;
  const n = LABEL_COLORS.length;
  return LABEL_COLORS[((Math.round(index) % n) + n) % n]!;
}

/** 色の番号の色（0..1 の sRGB）。 */
export function colorIndexRgb(index: number): [number, number, number] {
  return hexToRgb(colorIndexHex(index));
}

/**
 * クラスタの目印の色の番号。ラベルで色分けするデータセットでは多数派ラベル（なければクラスタの番号）、
 * クラスタで色分けするデータセットではクラスタの番号（点の色と一致する）。
 */
export function clusterColorIndex(cluster: { id: number; majorityLabel: number | null }, source: ColorSource = 'label'): number {
  if (source === 'cluster') return cluster.id;
  return cluster.majorityLabel ?? cluster.id;
}
