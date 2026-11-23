/**
 * 点の大きさ（ビルボード 1 辺、ワールド単位）の既定値。データの点の間隔（manifest の `density.knnDistP50`）に比例させる。
 *
 * 比例の係数は、MNIST で調整してきた値（大きさ 0.004、`knnDistP50` 0.015665）から決める。MNIST では従来どおり 0.004 になり、
 * 点の間隔が約 2.4 倍の word2vec（0.037867）では 0.00967 になる。点の間隔に対する大きさの割合が同じなので、
 * どちらのデータセットでも、クラスタの内部での点の重なり方は変わらない
 * （word2vec の丸い点の直径は最近傍点間距離の中央値 0.0187 の約半分で、隣の点との間に直径ほどのすき間が空く）。
 */
export const REFERENCE_POINT_SIZE = 0.004;
export const REFERENCE_KNN_DIST_P50 = 0.015665;
export const POINT_SIZE_RANGE: readonly [number, number] = [0.0005, 0.1];

/** 有効数字 3 桁に丸める（HUD の表示と URL の値をそろえる）。 */
function round3(v: number): number {
  return Number(v.toPrecision(3));
}

/** 点の大きさの既定値。`density` がなければ REFERENCE_POINT_SIZE。 */
export function defaultPointSize(density?: { knnDistP50: number } | null): number {
  const d = density?.knnDistP50;
  if (d === undefined || !Number.isFinite(d) || d <= 0) return REFERENCE_POINT_SIZE;
  const raw = (REFERENCE_POINT_SIZE * d) / REFERENCE_KNN_DIST_P50;
  return Math.min(POINT_SIZE_RANGE[1], Math.max(POINT_SIZE_RANGE[0], round3(raw)));
}
